import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import type { IncidentSeverity } from "@/lib/diagnostics/incidents";
import { redactSensitive } from "@/lib/security/context";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

export type SloMetric = "errorRate" | "availability" | "latencyP95Ms" | "routeFailures";
export type SloComparator = "greater_than" | "greater_than_or_equal" | "less_than" | "less_than_or_equal";

export type ObservabilitySloPolicy = {
  id: string;
  name: string;
  description: string;
  metric: SloMetric;
  comparator: SloComparator;
  warningThreshold: number;
  criticalThreshold: number;
  warningSeverity: IncidentSeverity;
  criticalSeverity: IncidentSeverity;
  unit: "ratio" | "ms" | "count";
  componentId: string;
  enabled: boolean;
  alertTargetIds: string[];
  suppressionMinutes: number;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

type SloPolicyLedger = {
  policies: ObservabilitySloPolicy[];
};

let policyFileWriteQueue: Promise<void> = Promise.resolve();

export function getDefaultObservabilitySloPolicies(): ObservabilitySloPolicy[] {
  return [
    {
      id: "error_budget",
      name: "Error budget burn",
      description: "Runtime error events must stay within a 2% operating budget across the recent event window.",
      metric: "errorRate",
      comparator: "greater_than",
      warningThreshold: 0.02,
      criticalThreshold: 0.1,
      warningSeverity: "warning",
      criticalSeverity: "critical",
      unit: "ratio",
      componentId: "observability",
      enabled: true,
      alertTargetIds: [],
      suppressionMinutes: 120,
      metadata: { source: "default" },
    },
    {
      id: "availability_floor",
      name: "Availability floor",
      description: "Route-level availability should stay at or above 99.5% across the recent event window.",
      metric: "availability",
      comparator: "less_than",
      warningThreshold: 0.995,
      criticalThreshold: 0.98,
      warningSeverity: "warning",
      criticalSeverity: "critical",
      unit: "ratio",
      componentId: "observability",
      enabled: true,
      alertTargetIds: [],
      suppressionMinutes: 120,
      metadata: { source: "default" },
    },
    {
      id: "route_failures",
      name: "Route failure budget",
      description: "Any route failure is surfaced immediately; five or more recent failures escalate to critical.",
      metric: "routeFailures",
      comparator: "greater_than_or_equal",
      warningThreshold: 1,
      criticalThreshold: 5,
      warningSeverity: "warning",
      criticalSeverity: "critical",
      unit: "count",
      componentId: "observability",
      enabled: true,
      alertTargetIds: ["dashboard", "ops"],
      suppressionMinutes: 60,
      metadata: { source: "default" },
    },
    {
      id: "latency_p95",
      name: "P95 latency ceiling",
      description: "The recent runtime event P95 latency should stay below eight seconds.",
      metric: "latencyP95Ms",
      comparator: "greater_than",
      warningThreshold: 8000,
      criticalThreshold: 15000,
      warningSeverity: "warning",
      criticalSeverity: "critical",
      unit: "ms",
      componentId: "observability",
      enabled: true,
      alertTargetIds: [],
      suppressionMinutes: 180,
      metadata: { source: "default" },
    },
  ];
}

export async function listObservabilitySloPolicies({
  includeDisabled = true,
}: {
  includeDisabled?: boolean;
} = {}) {
  await ensureDefaultSloPolicies();

  if (hasDatabaseUrl()) {
    const rows = includeDisabled
      ? await getSql()`
          SELECT *
          FROM omni_observability_slo_policies
          ORDER BY updated_at DESC, id ASC
        `
      : await getSql()`
          SELECT *
          FROM omni_observability_slo_policies
          WHERE enabled = TRUE
          ORDER BY updated_at DESC, id ASC
        `;
    return rows.map(sloPolicyFromRow);
  }

  const ledger = await readSloPolicyLedger();
  return ledger.policies
    .filter((policy) => includeDisabled || policy.enabled)
    .sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""));
}

export async function getObservabilitySloPolicy(policyId: string) {
  await ensureDefaultSloPolicies();

  if (hasDatabaseUrl()) {
    const rows = await getSql()`
      SELECT *
      FROM omni_observability_slo_policies
      WHERE id = ${policyId}
      LIMIT 1
    `;
    return rows[0] ? sloPolicyFromRow(rows[0]) : null;
  }

  const ledger = await readSloPolicyLedger();
  return ledger.policies.find((policy) => policy.id === policyId) || null;
}

export async function saveObservabilitySloPolicy(policy: ObservabilitySloPolicy) {
  const now = new Date().toISOString();
  const existing = await getObservabilitySloPolicy(policy.id);
  const record = normalizePolicy({
    ...policy,
    createdAt: existing?.createdAt || policy.createdAt || now,
    updatedAt: now,
  });

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_observability_slo_policies (
        id, name, description, metric, comparator, warning_threshold,
        critical_threshold, warning_severity, critical_severity, unit,
        component_id, enabled, alert_target_ids, suppression_minutes,
        metadata, created_at, updated_at
      )
      VALUES (
        ${record.id}, ${record.name}, ${record.description}, ${record.metric},
        ${record.comparator}, ${record.warningThreshold}, ${record.criticalThreshold},
        ${record.warningSeverity}, ${record.criticalSeverity}, ${record.unit},
        ${record.componentId}, ${record.enabled}, ${record.alertTargetIds},
        ${record.suppressionMinutes}, ${JSON.stringify(record.metadata)}::jsonb,
        ${record.createdAt}, ${record.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        metric = EXCLUDED.metric,
        comparator = EXCLUDED.comparator,
        warning_threshold = EXCLUDED.warning_threshold,
        critical_threshold = EXCLUDED.critical_threshold,
        warning_severity = EXCLUDED.warning_severity,
        critical_severity = EXCLUDED.critical_severity,
        unit = EXCLUDED.unit,
        component_id = EXCLUDED.component_id,
        enabled = EXCLUDED.enabled,
        alert_target_ids = EXCLUDED.alert_target_ids,
        suppression_minutes = EXCLUDED.suppression_minutes,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at
    `;
    return record;
  }

  await mutateSloPolicyLedger((ledger) => {
    ledger.policies = [record, ...ledger.policies.filter((item) => item.id !== record.id)];
    return ledger;
  });
  return record;
}

export async function resetObservabilitySloPolicies() {
  const defaults = getDefaultObservabilitySloPolicies().map((policy) => normalizePolicy(policy));

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`DELETE FROM omni_observability_slo_policies`;
    for (const policy of defaults) {
      await insertDefaultPolicy(policy);
    }
    return defaults;
  }

  await writeSloPolicyLedger({ policies: defaults });
  return defaults;
}

export async function deleteObservabilitySloPolicy(policyId: string) {
  await ensureDefaultSloPolicies();

  if (hasDatabaseUrl()) {
    await getSql()`
      DELETE FROM omni_observability_slo_policies
      WHERE id = ${policyId}
    `;
    return true;
  }

  await mutateSloPolicyLedger((ledger) => ({
    policies: ledger.policies.filter((policy) => policy.id !== policyId),
  }));
  return true;
}

async function ensureDefaultSloPolicies() {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    for (const policy of getDefaultObservabilitySloPolicies()) {
      await insertDefaultPolicy(normalizePolicy(policy));
    }
    return;
  }

  const ledger = await readSloPolicyLedger();
  if (!ledger.policies.length) {
    await writeSloPolicyLedger({ policies: getDefaultObservabilitySloPolicies().map((policy) => normalizePolicy(policy)) });
    return;
  }

  const existingIds = new Set(ledger.policies.map((policy) => policy.id));
  const missing = getDefaultObservabilitySloPolicies()
    .filter((policy) => !existingIds.has(policy.id))
    .map((policy) => normalizePolicy(policy));
  if (missing.length) {
    await writeSloPolicyLedger({ policies: [...ledger.policies, ...missing] });
  }
}

async function insertDefaultPolicy(policy: ObservabilitySloPolicy) {
  await getSql()`
    INSERT INTO omni_observability_slo_policies (
      id, name, description, metric, comparator, warning_threshold,
      critical_threshold, warning_severity, critical_severity, unit,
      component_id, enabled, alert_target_ids, suppression_minutes,
      metadata, created_at, updated_at
    )
    VALUES (
      ${policy.id}, ${policy.name}, ${policy.description}, ${policy.metric},
      ${policy.comparator}, ${policy.warningThreshold}, ${policy.criticalThreshold},
      ${policy.warningSeverity}, ${policy.criticalSeverity}, ${policy.unit},
      ${policy.componentId}, ${policy.enabled}, ${policy.alertTargetIds},
      ${policy.suppressionMinutes}, ${JSON.stringify(policy.metadata)}::jsonb,
      ${policy.createdAt}, ${policy.updatedAt}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

async function readSloPolicyLedger() {
  return readJsonFile<SloPolicyLedger>(getSloPolicyFile(), { policies: [] });
}

async function mutateSloPolicyLedger(mutator: (ledger: SloPolicyLedger) => SloPolicyLedger) {
  policyFileWriteQueue = policyFileWriteQueue.then(
    async () => {
      await writeSloPolicyLedger(mutator(await readSloPolicyLedger()));
    },
    async () => {
      await writeSloPolicyLedger(mutator(await readSloPolicyLedger()));
    },
  );
  await policyFileWriteQueue;
}

async function writeSloPolicyLedger(ledger: SloPolicyLedger) {
  await writeJsonFile(getSloPolicyFile(), { policies: ledger.policies.slice(0, 100) });
}

function normalizePolicy(policy: ObservabilitySloPolicy): ObservabilitySloPolicy {
  const now = new Date().toISOString();
  return {
    id: policy.id.trim(),
    name: policy.name.trim() || policy.id,
    description: policy.description.trim(),
    metric: normalizeMetric(policy.metric),
    comparator: normalizeComparator(policy.comparator),
    warningThreshold: Number(policy.warningThreshold),
    criticalThreshold: Number(policy.criticalThreshold),
    warningSeverity: normalizeSeverity(policy.warningSeverity, "warning"),
    criticalSeverity: normalizeSeverity(policy.criticalSeverity, "critical"),
    unit: normalizeUnit(policy.unit),
    componentId: policy.componentId.trim() || "observability",
    enabled: Boolean(policy.enabled),
    alertTargetIds: [...new Set((policy.alertTargetIds || []).map((target) => target.trim()).filter(Boolean))],
    suppressionMinutes: Math.min(Math.max(Math.round(Number(policy.suppressionMinutes || 0)), 0), 10080),
    metadata: (redactSensitive(policy.metadata || {}) || {}) as Record<string, unknown>,
    createdAt: policy.createdAt || now,
    updatedAt: policy.updatedAt || now,
  };
}

function sloPolicyFromRow(row: Record<string, unknown>): ObservabilitySloPolicy {
  return normalizePolicy({
    id: String(row.id),
    name: String(row.name),
    description: String(row.description || ""),
    metric: normalizeMetric(row.metric),
    comparator: normalizeComparator(row.comparator),
    warningThreshold: Number(row.warning_threshold),
    criticalThreshold: Number(row.critical_threshold),
    warningSeverity: normalizeSeverity(row.warning_severity, "warning"),
    criticalSeverity: normalizeSeverity(row.critical_severity, "critical"),
    unit: normalizeUnit(row.unit),
    componentId: String(row.component_id || "observability"),
    enabled: Boolean(row.enabled),
    alertTargetIds: parseStringArray(row.alert_target_ids),
    suppressionMinutes: Number(row.suppression_minutes || 0),
    metadata: parseObject(row.metadata) || {},
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  });
}

function normalizeMetric(value: unknown): SloMetric {
  const metric = String(value || "errorRate");
  return metric === "availability" || metric === "latencyP95Ms" || metric === "routeFailures"
    ? metric
    : "errorRate";
}

function normalizeComparator(value: unknown): SloComparator {
  const comparator = String(value || "greater_than");
  if (comparator === "greater_than_or_equal" || comparator === "less_than" || comparator === "less_than_or_equal") {
    return comparator;
  }
  return "greater_than";
}

function normalizeUnit(value: unknown): ObservabilitySloPolicy["unit"] {
  const unit = String(value || "ratio");
  return unit === "ms" || unit === "count" ? unit : "ratio";
}

function normalizeSeverity(value: unknown, fallback: IncidentSeverity): IncidentSeverity {
  const severity = String(value || fallback);
  if (severity === "critical" || severity === "warning" || severity === "info") {
    return severity;
  }
  return fallback;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
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

function getSloPolicyFile() {
  return getDataPath("observability-slo-policies.json");
}
