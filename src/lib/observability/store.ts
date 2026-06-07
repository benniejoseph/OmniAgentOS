import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { redactSensitive } from "@/lib/security/context";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

export type ObservabilityLevel = "info" | "warn" | "error";
export type ObservabilityCategory =
  | "api"
  | "workflow"
  | "alert"
  | "diagnostics"
  | "evaluation"
  | "connector"
  | "security"
  | "system";

export type ObservabilityEventRecord = {
  id: string;
  level: ObservabilityLevel;
  category: ObservabilityCategory;
  action: string;
  route?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  requestId?: string;
  correlationId: string;
  tenantId?: string;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ObservabilityStats = {
  total: number;
  byLevel: Record<string, number>;
  byCategory: Record<string, number>;
  authFailures: number;
  policyBlocks: number;
  connectorFailures: number;
  routeFailures: number;
  averageDurationMs: number;
  p95DurationMs: number;
  latest: ObservabilityEventRecord[];
  recentErrors: ObservabilityEventRecord[];
  slo: {
    healthy: boolean;
    availability: number;
    errorRate: number;
    errorBudgetRemaining: number;
    latencyP95Ms: number;
  };
};

type ObservabilityLedger = {
  events: ObservabilityEventRecord[];
};

let observabilityFileWriteQueue: Promise<void> = Promise.resolve();

export function createRequestTelemetry(request?: Request, prefix = "obs") {
  const requestId = request?.headers.get("x-vercel-id") || undefined;
  const correlationId =
    request?.headers.get("x-omni-correlation-id") ||
    request?.headers.get("x-vercel-id") ||
    `${prefix}:${randomUUID()}`;

  return { requestId, correlationId };
}

export async function recordRuntimeEvent(input: {
  level?: ObservabilityLevel;
  category: ObservabilityCategory;
  action: string;
  route?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  requestId?: string;
  correlationId?: string;
  tenantId?: string;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}) {
  const record: ObservabilityEventRecord = {
    id: randomUUID(),
    level: input.level || (input.statusCode && input.statusCode >= 500 ? "error" : "info"),
    category: input.category,
    action: input.action,
    route: input.route,
    method: input.method,
    statusCode: input.statusCode,
    durationMs: input.durationMs,
    requestId: input.requestId,
    correlationId: input.correlationId || `${input.category}:${randomUUID()}`,
    tenantId: input.tenantId ? normalizeTenantId(input.tenantId) : undefined,
    actorId: input.actorId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    message: input.message,
    metadata: (redactSensitive(input.metadata || {}) || {}) as Record<string, unknown>,
    createdAt: new Date().toISOString(),
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_observability_events (
        id, level, category, action, route, method, status_code, duration_ms,
        request_id, correlation_id, tenant_id, actor_id, resource_type,
        resource_id, message, metadata, created_at
      )
      VALUES (
        ${record.id}, ${record.level}, ${record.category}, ${record.action},
        ${record.route || null}, ${record.method || null}, ${record.statusCode ?? null},
        ${record.durationMs ?? null}, ${record.requestId || null}, ${record.correlationId},
        ${record.tenantId || null}, ${record.actorId || null},
        ${record.resourceType || null}, ${record.resourceId || null},
        ${record.message}, ${JSON.stringify(record.metadata)}::jsonb, ${record.createdAt}
      )
    `;
    return record;
  }

  await mutateObservabilityLedger((ledger) => {
    ledger.events.unshift(record);
    return trimObservabilityLedger(ledger);
  });
  return record;
}

export async function recordRuntimeEventSafely(input: Parameters<typeof recordRuntimeEvent>[0]) {
  try {
    return await recordRuntimeEvent(input);
  } catch (error) {
    console.warn("Observability event write failed.", error instanceof Error ? error.message : error);
    return undefined;
  }
}

export async function listObservabilityEvents({
  level,
  category,
  action,
  correlationId,
  resourceType,
  resourceId,
  route,
  tenantId,
  limit = 50,
}: {
  level?: ObservabilityLevel | "all";
  category?: ObservabilityCategory | "all";
  action?: string;
  correlationId?: string;
  resourceType?: string;
  resourceId?: string;
  route?: string;
  tenantId?: string;
  limit?: number;
} = {}) {
  const boundedLimit = Math.min(Math.max(limit, 1), 200);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (level && level !== "all") {
      params.push(level);
      filters.push(`level = $${params.length}`);
    }
    if (category && category !== "all") {
      params.push(category);
      filters.push(`category = $${params.length}`);
    }
    if (action) {
      params.push(action);
      filters.push(`action = $${params.length}`);
    }
    if (correlationId) {
      params.push(correlationId);
      filters.push(`correlation_id = $${params.length}`);
    }
    if (resourceType) {
      params.push(resourceType);
      filters.push(`resource_type = $${params.length}`);
    }
    if (resourceId) {
      params.push(resourceId);
      filters.push(`resource_id = $${params.length}`);
    }
    if (route) {
      params.push(route);
      filters.push(`route = $${params.length}`);
    }
    if (tenantId) {
      params.push(normalizeTenantId(tenantId));
      filters.push(`COALESCE(tenant_id, 'default') = $${params.length}`);
    }
    params.push(boundedLimit);
    const rows = await getSql().query(
      `
        SELECT *
        FROM omni_observability_events
        ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
        ORDER BY created_at DESC
        LIMIT $${params.length}
      `,
      params,
    );
    return rows.map(observabilityEventFromRow);
  }

  const ledger = await readObservabilityLedger();
  return ledger.events
    .filter((event) => !level || level === "all" || event.level === level)
    .filter((event) => !category || category === "all" || event.category === category)
    .filter((event) => !action || event.action === action)
    .filter((event) => !correlationId || event.correlationId === correlationId)
    .filter((event) => !resourceType || event.resourceType === resourceType)
    .filter((event) => !resourceId || event.resourceId === resourceId)
    .filter((event) => !route || event.route === route)
    .filter((event) => !tenantId || normalizeTenantId(event.tenantId) === normalizeTenantId(tenantId))
    .slice(0, boundedLimit);
}

export async function getObservabilityStats(options: { tenantId?: string } = {}): Promise<ObservabilityStats> {
  const events = await listObservabilityEvents({ limit: 500, tenantId: options.tenantId });
  const durations = events
    .map((event) => event.durationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
  const failures = events.filter((event) => event.level === "error" || (event.statusCode || 0) >= 500);
  const routeEvents = events.filter((event) => event.route);
  const routeFailures = routeEvents.filter((event) => event.level === "error" || (event.statusCode || 0) >= 500).length;
  const authFailures = events.filter(
    (event) => event.metadata.failureType === "auth_failure" || event.action === "security.auth_failed",
  ).length;
  const policyBlocks = events.filter(
    (event) => event.metadata.failureType === "policy_block" || event.action === "security.policy_blocked",
  ).length;
  const connectorFailures = events.filter(
    (event) =>
      event.metadata.failureType === "connector_failure" ||
      (event.category === "connector" && (event.level === "error" || event.action.endsWith("_failed"))),
  ).length;
  const errorRate = events.length ? failures.length / events.length : 0;
  const availability = routeEvents.length ? 1 - routeFailures / routeEvents.length : 1;
  const p95DurationMs = percentile(durations, 0.95);

  return {
    total: events.length,
    byLevel: events.reduce<Record<string, number>>((acc, event) => {
      acc[event.level] = (acc[event.level] || 0) + 1;
      return acc;
    }, {}),
    byCategory: events.reduce<Record<string, number>>((acc, event) => {
      acc[event.category] = (acc[event.category] || 0) + 1;
      return acc;
    }, {}),
    authFailures,
    policyBlocks,
    connectorFailures,
    routeFailures,
    averageDurationMs: durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : 0,
    p95DurationMs,
    latest: events.slice(0, 10),
    recentErrors: failures.slice(0, 5),
    slo: {
      healthy: errorRate <= 0.02 && p95DurationMs <= 8000,
      availability,
      errorRate,
      errorBudgetRemaining: Math.max(0, 0.02 - errorRate),
      latencyP95Ms: p95DurationMs,
    },
  };
}

async function readObservabilityLedger() {
  return readJsonFile<ObservabilityLedger>(getObservabilityFile(), { events: [] });
}

async function mutateObservabilityLedger(mutator: (ledger: ObservabilityLedger) => ObservabilityLedger) {
  observabilityFileWriteQueue = observabilityFileWriteQueue.then(
    async () => {
      const ledger = mutator(await readObservabilityLedger());
      await writeObservabilityLedger(ledger);
    },
    async () => {
      const ledger = mutator(await readObservabilityLedger());
      await writeObservabilityLedger(ledger);
    },
  );
  await observabilityFileWriteQueue;
}

async function writeObservabilityLedger(ledger: ObservabilityLedger) {
  await writeJsonFile(getObservabilityFile(), trimObservabilityLedger(ledger));
}

function trimObservabilityLedger(ledger: ObservabilityLedger): ObservabilityLedger {
  return {
    events: ledger.events.slice(0, 1000),
  };
}

function observabilityEventFromRow(row: Record<string, unknown>): ObservabilityEventRecord {
  return {
    id: String(row.id),
    level: String(row.level) as ObservabilityLevel,
    category: String(row.category) as ObservabilityCategory,
    action: String(row.action),
    route: row.route ? String(row.route) : undefined,
    method: row.method ? String(row.method) : undefined,
    statusCode: row.status_code === null || row.status_code === undefined ? undefined : Number(row.status_code),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
    requestId: row.request_id ? String(row.request_id) : undefined,
    correlationId: String(row.correlation_id),
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    actorId: row.actor_id ? String(row.actor_id) : undefined,
    resourceType: row.resource_type ? String(row.resource_type) : undefined,
    resourceId: row.resource_id ? String(row.resource_id) : undefined,
    message: String(row.message),
    metadata: parseObject(row.metadata) || {},
    createdAt: normalizeDate(row.created_at),
  };
}

function percentile(values: number[], quantile: number) {
  if (!values.length) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1));
  return values[index];
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeTenantId(value?: string) {
  return (value || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

function getObservabilityFile() {
  return getDataPath("observability-events.json");
}
