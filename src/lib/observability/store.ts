import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { redactSensitive } from "@/lib/security/context";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
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
  sloEligibleEvents: number;
  sloExcludedEvents: number;
  syntheticEvents: number;
  byLevel: Record<string, number>;
  byCategory: Record<string, number>;
  authFailures: number;
  authenticationChallenges: number;
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

export function createRequestTelemetry(request?: Request, prefix = "obs") {
  const requestId = request?.headers.get("x-vercel-id") || undefined;
  const correlationId =
    request?.headers.get("x-omni-correlation-id") ||
    request?.headers.get("x-vercel-id") ||
    `${prefix}:${randomUUID()}`;
  const syntheticMetadata = getSyntheticRequestMetadata(request);

  return { requestId, correlationId, syntheticMetadata };
}

export function getSyntheticRequestMetadata(request?: Request): Record<string, unknown> {
  const configuredSecret = process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim();
  const providedSecret = request?.headers.get("x-omni-synthetic-auth")?.trim();

  if (!configuredSecret || !providedSecret || configuredSecret !== providedSecret) {
    return {};
  }

  return {
    synthetic: true,
    syntheticSource: normalizeSyntheticSource(request?.headers.get("x-omni-synthetic-source")),
    sloExcluded: request?.headers.get("x-omni-slo-excluded") !== "false",
  };
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
    tenantId: normalizeTenantId(
      input.tenantId ||
        getDatabaseTenantContext() ||
        process.env.OMNIAGENT_DEFAULT_TENANT ||
        "default",
    ),
    actorId: input.actorId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    message: String(redactSensitive(input.message)).slice(0, 2_000),
    metadata: boundedRedactedMetadata(input.metadata),
    createdAt: new Date().toISOString(),
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await runWithDatabaseTenantScope(record.tenantId!, () => getSql()`
        INSERT INTO omni_observability_events (
          id, level, category, action, route, method, status_code, duration_ms,
          request_id, correlation_id, tenant_id, actor_id, resource_type,
          resource_id, message, metadata, created_at
        )
        VALUES (
          ${record.id}, ${record.level}, ${record.category}, ${record.action},
          ${record.route || null}, ${record.method || null}, ${record.statusCode ?? null},
          ${record.durationMs ?? null}, ${record.requestId || null}, ${record.correlationId},
          ${record.tenantId}, ${record.actorId || null},
          ${record.resourceType || null}, ${record.resourceId || null},
          ${record.message}, ${record.metadata}::jsonb, ${record.createdAt}
        )
      `);
    return record;
  }

  await mutateObservabilityLedger((ledger) => {
    ledger.events.unshift(record);
    return trimObservabilityLedger(ledger);
  });
  return record;
}

function boundedRedactedMetadata(metadata?: Record<string, unknown>) {
  const redacted = (redactSensitive(metadata || {}) || {}) as Record<
    string,
    unknown
  >;
  try {
    const serialized = JSON.stringify(redacted);
    if (serialized.length <= 64_000) {
      return redacted;
    }
    return {
      truncated: true,
      originalCharacters: serialized.length,
      keys: Object.keys(redacted).slice(0, 50),
    };
  } catch {
    return { invalidMetadata: true };
  }
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
  sql: providedSql,
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
  sql?: ReturnType<typeof getSql>;
} = {}) {
  const boundedLimit = Math.min(Math.max(limit, 1), 500);

  if (hasDatabaseUrl()) {
    if (!providedSql) {
      await ensureDatabaseSchema();
    }
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
      filters.push(`tenant_id = $${params.length}`);
    }
    params.push(boundedLimit);
    const rows = await (providedSql || getSql()).query(
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

export async function getObservabilityStats(
  options: {
    tenantId?: string;
    sql?: ReturnType<typeof getSql>;
    windowHours?: number;
  } = {},
): Promise<ObservabilityStats> {
  const windowHours = Math.min(
    Math.max(Math.round(options.windowHours || 24), 1),
    24 * 7,
  );
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1_000);
  const tenantId = normalizeTenantId(
    options.tenantId || getDatabaseTenantContext(),
  );
  if (hasDatabaseUrl()) {
    if (!options.sql) {
      await ensureDatabaseSchema();
    }
    const rows = await (options.sql || getSql()).query(
      `
        WITH windowed AS (
          SELECT events.*,
            NOT (
              events.metadata->>'sloExcluded' = 'true'
              OR (
                events.metadata->>'synthetic' = 'true'
                AND NULLIF(events.metadata->>'syntheticSource', '') IS NOT NULL
              )
              OR events.action = 'observability.slo_eval_failure_marker'
              OR events.metadata->>'policyFixture' = 'true'
              OR (
                (
                  events.action IN ('security.auth_failed', 'security.context_failed')
                  OR events.metadata->>'failureType' = 'security_context_failure'
                )
                AND (
                  events.message LIKE '%omni_tenant_isolation%'
                  OR events.message LIKE '%tuple concurrently updated%'
                  OR events.message LIKE '%duplicate key value violates unique constraint%'
                )
              )
              OR (
                events.metadata ? 'smoke'
                AND COALESCE(events.metadata->>'smoke', '') NOT IN ('', 'false', '0')
              )
            ) AS slo_eligible
          FROM omni_observability_events AS events
          WHERE events.tenant_id = $1
            AND events.created_at >= $2
        ),
        eligible AS (
          SELECT * FROM windowed WHERE slo_eligible
        )
        SELECT
          (SELECT COUNT(*)::int FROM windowed) AS total,
          (SELECT COUNT(*)::int FROM eligible) AS slo_eligible_events,
          (SELECT COUNT(*)::int FROM windowed WHERE NOT slo_eligible) AS slo_excluded_events,
          (
            SELECT COUNT(*)::int FROM windowed
            WHERE metadata->>'synthetic' = 'true'
          ) AS synthetic_events,
          (
            SELECT COUNT(*)::int FROM eligible
            WHERE (
              metadata->>'failureType' = 'auth_failure'
              OR action = 'security.auth_failed'
            )
              AND NOT (
                action = 'security.auth_failed'
                AND status_code = 401
                AND message = 'Authentication required.'
                AND route IS DISTINCT FROM '/api/auth/login'
              )
          ) AS auth_failures,
          (
            SELECT COUNT(*)::int FROM eligible
            WHERE action = 'security.auth_failed'
              AND status_code = 401
              AND message = 'Authentication required.'
              AND route IS DISTINCT FROM '/api/auth/login'
          ) AS authentication_challenges,
          (
            SELECT COUNT(*)::int FROM eligible
            WHERE metadata->>'failureType' = 'policy_block'
              OR action = 'security.policy_blocked'
          ) AS policy_blocks,
          (
            SELECT COUNT(*)::int FROM eligible
            WHERE metadata->>'failureType' = 'connector_failure'
              OR (
                category = 'connector'
                AND (level = 'error' OR RIGHT(action, 7) = '_failed')
              )
          ) AS connector_failures,
          (
            SELECT COUNT(*)::int FROM eligible
            WHERE route IS NOT NULL
              AND (level = 'error' OR status_code >= 500)
          ) AS route_failures,
          (
            SELECT COUNT(*)::int FROM eligible
            WHERE level = 'error' OR status_code >= 500
          ) AS failure_count,
          (
            SELECT COUNT(*)::int FROM eligible WHERE route IS NOT NULL
          ) AS route_count,
          COALESCE((
            SELECT ROUND(AVG(duration_ms))::int FROM eligible
            WHERE duration_ms IS NOT NULL
          ), 0) AS average_duration_ms,
          COALESCE((
            SELECT ROUND(
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)
            )::int
            FROM eligible
            WHERE duration_ms IS NOT NULL
          ), 0) AS p95_duration_ms,
          COALESCE((
            SELECT jsonb_object_agg(level, count)
            FROM (
              SELECT level, COUNT(*)::int AS count
              FROM windowed GROUP BY level
            ) AS level_counts
          ), '{}'::jsonb) AS by_level,
          COALESCE((
            SELECT jsonb_object_agg(category, count)
            FROM (
              SELECT category, COUNT(*)::int AS count
              FROM windowed GROUP BY category
            ) AS category_counts
          ), '{}'::jsonb) AS by_category,
          COALESCE((
            SELECT jsonb_agg(to_jsonb(recent) ORDER BY recent.created_at DESC)
            FROM (
              SELECT * FROM windowed
              ORDER BY created_at DESC
              LIMIT 10
            ) AS recent
          ), '[]'::jsonb) AS latest,
          COALESCE((
            SELECT jsonb_agg(to_jsonb(recent_error) ORDER BY recent_error.created_at DESC)
            FROM (
              SELECT * FROM eligible
              WHERE level = 'error' OR status_code >= 500
              ORDER BY created_at DESC
              LIMIT 5
            ) AS recent_error
          ), '[]'::jsonb) AS recent_errors
      `,
      [tenantId, since],
    );
    return observabilityStatsFromAggregate(rows[0] || {});
  }

  const ledger = await readObservabilityLedger();
  const events = ledger.events.filter(
    (event) =>
      normalizeTenantId(event.tenantId) === tenantId &&
      Date.parse(event.createdAt) >= since.getTime(),
  );
  return summarizeObservabilityEvents(events);
}

function observabilityStatsFromAggregate(
  row: Record<string, unknown>,
): ObservabilityStats {
  const total = Number(row.total || 0);
  const sloEligibleEvents = Number(row.slo_eligible_events || 0);
  const failureCount = Number(row.failure_count || 0);
  const routeCount = Number(row.route_count || 0);
  const routeFailures = Number(row.route_failures || 0);
  const errorRate = sloEligibleEvents
    ? failureCount / sloEligibleEvents
    : 0;
  const availability = routeCount
    ? 1 - routeFailures / routeCount
    : 1;
  const p95DurationMs = Number(row.p95_duration_ms || 0);
  const latest = Array.isArray(row.latest)
    ? row.latest.map((event) =>
        observabilityEventFromRow(event as Record<string, unknown>),
      )
    : [];
  const recentErrors = Array.isArray(row.recent_errors)
    ? row.recent_errors.map((event) =>
        observabilityEventFromRow(event as Record<string, unknown>),
      )
    : [];
  return {
    total,
    sloEligibleEvents,
    sloExcludedEvents: Number(row.slo_excluded_events || 0),
    syntheticEvents: Number(row.synthetic_events || 0),
    byLevel: numericRecord(row.by_level),
    byCategory: numericRecord(row.by_category),
    authFailures: Number(row.auth_failures || 0),
    authenticationChallenges: Number(row.authentication_challenges || 0),
    policyBlocks: Number(row.policy_blocks || 0),
    connectorFailures: Number(row.connector_failures || 0),
    routeFailures,
    averageDurationMs: Number(row.average_duration_ms || 0),
    p95DurationMs,
    latest,
    recentErrors,
    slo: {
      healthy: errorRate <= 0.02 && p95DurationMs <= 8_000,
      availability,
      errorRate,
      errorBudgetRemaining: Math.max(0, 0.02 - errorRate),
      latencyP95Ms: p95DurationMs,
    },
  };
}

export function summarizeObservabilityEvents(
  events: ObservabilityEventRecord[],
): ObservabilityStats {
  const sloEvents = events.filter((event) => !isSloExcludedEvent(event));
  const durations = sloEvents
    .map((event) => event.durationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
  const failures = sloEvents.filter((event) => event.level === "error" || (event.statusCode || 0) >= 500);
  const routeEvents = sloEvents.filter((event) => event.route);
  const routeFailures = routeEvents.filter((event) => event.level === "error" || (event.statusCode || 0) >= 500).length;
  const authFailureEvents = sloEvents.filter(
    (event) => event.metadata.failureType === "auth_failure" || event.action === "security.auth_failed",
  );
  const authenticationChallenges = authFailureEvents.filter(isAuthenticationChallenge).length;
  const authFailures = authFailureEvents.length - authenticationChallenges;
  const policyBlocks = sloEvents.filter(
    (event) => event.metadata.failureType === "policy_block" || event.action === "security.policy_blocked",
  ).length;
  const connectorFailures = sloEvents.filter(
    (event) =>
      event.metadata.failureType === "connector_failure" ||
      (event.category === "connector" && (event.level === "error" || event.action.endsWith("_failed"))),
  ).length;
  const errorRate = sloEvents.length ? failures.length / sloEvents.length : 0;
  const availability = routeEvents.length ? 1 - routeFailures / routeEvents.length : 1;
  const p95DurationMs = percentile(durations, 0.95);

  return {
    total: events.length,
    sloEligibleEvents: sloEvents.length,
    sloExcludedEvents: events.length - sloEvents.length,
    syntheticEvents: events.filter((event) => event.metadata.synthetic === true).length,
    byLevel: events.reduce<Record<string, number>>((acc, event) => {
      acc[event.level] = (acc[event.level] || 0) + 1;
      return acc;
    }, {}),
    byCategory: events.reduce<Record<string, number>>((acc, event) => {
      acc[event.category] = (acc[event.category] || 0) + 1;
      return acc;
    }, {}),
    authFailures,
    authenticationChallenges,
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

function isSloExcludedEvent(event: ObservabilityEventRecord) {
  if (event.metadata.sloExcluded === true) {
    return true;
  }

  if (event.metadata.synthetic === true && event.metadata.syntheticSource) {
    return true;
  }

  if (event.action === "observability.slo_eval_failure_marker" || event.metadata.policyFixture) {
    return true;
  }

  if (isSchemaConcurrencyContextFailure(event)) {
    return true;
  }

  return Boolean(event.metadata.smoke);
}

function isAuthenticationChallenge(event: ObservabilityEventRecord) {
  return event.action === "security.auth_failed" &&
    event.statusCode === 401 &&
    event.message === "Authentication required." &&
    event.route !== "/api/auth/login";
}

function isSchemaConcurrencyContextFailure(event: ObservabilityEventRecord) {
  return (
    event.action === "security.auth_failed" ||
    event.action === "security.context_failed" ||
    event.metadata.failureType === "security_context_failure"
  ) && isSchemaConcurrencyFailure(event.message);
}

function isSchemaConcurrencyFailure(message: string) {
  return message.includes("omni_tenant_isolation") ||
    message.includes("tuple concurrently updated") ||
    message.includes("duplicate key value violates unique constraint");
}

async function readObservabilityLedger() {
  return readJsonFile<ObservabilityLedger>(getObservabilityFile(), { events: [] });
}

async function mutateObservabilityLedger(mutator: (ledger: ObservabilityLedger) => ObservabilityLedger) {
  await updateJsonFile<ObservabilityLedger>(
    getObservabilityFile(),
    { events: [] },
    (ledger) => trimObservabilityLedger(mutator(ledger)),
  );
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

function numericRecord(value: unknown) {
  return Object.fromEntries(
    Object.entries(parseObject(value) || {}).map(([key, count]) => [
      key,
      Number(count || 0),
    ]),
  );
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

function normalizeSyntheticSource(value: string | null | undefined) {
  return (value || "synthetic")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "synthetic";
}

function getObservabilityFile() {
  return getDataPath("observability-events.json");
}
