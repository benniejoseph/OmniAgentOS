import { createHash } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import type { IncidentSeverity } from "@/lib/diagnostics/incidents";
import { redactSensitive } from "@/lib/security/context";
import type { SecurityRole } from "@/lib/security/types";
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

export type SloPolicyChangeAction =
  | "upsert_policy"
  | "toggle_policy"
  | "delete_policy"
  | "reset_defaults"
  | "rollback_policy";
export type SloPolicyChangeStatus = "pending" | "applied" | "rejected";
export type SloPolicyApprovalDecision = "approved" | "rejected";

export type SloPolicyApprovalPolicy = {
  quorum: number;
  requiredRoles: SecurityRole[];
  allowRequesterApproval: boolean;
  attestationRequired: boolean;
  description: string;
};

export type SloPolicyApprovalEvidence = {
  id: string;
  decision: SloPolicyApprovalDecision;
  actorId: string;
  actorRole: SecurityRole;
  tenantId?: string;
  reason?: string;
  createdAt: string;
  previousHash?: string;
  evidenceHash: string;
  signature: string;
};

export type SloPolicyApprovalProgress = {
  approvals: number;
  required: number;
  remaining: number;
  approvedBy: string[];
  rejected: number;
  canApply: boolean;
};

export type ObservabilitySloPolicyChange = {
  id: string;
  policyId: string;
  action: SloPolicyChangeAction;
  status: SloPolicyChangeStatus;
  riskLevel: number;
  tenantId?: string;
  requestedBy?: string;
  reviewedBy?: string;
  reason?: string;
  reviewReason?: string;
  beforePolicy?: ObservabilitySloPolicy | null;
  afterPolicy?: ObservabilitySloPolicy | null;
  rollbackChangeId?: string;
  approvalPolicy: SloPolicyApprovalPolicy;
  approvals: SloPolicyApprovalEvidence[];
  evidenceHash: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  appliedAt?: string;
};

type SloPolicyLedger = {
  policies: ObservabilitySloPolicy[];
};

type SloPolicyChangeLedger = {
  changes: ObservabilitySloPolicyChange[];
};

let policyFileWriteQueue: Promise<void> = Promise.resolve();
let policyChangeFileWriteQueue: Promise<void> = Promise.resolve();

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

export async function listObservabilitySloPolicyChanges({
  policyId,
  status,
  limit = 50,
}: {
  policyId?: string;
  status?: SloPolicyChangeStatus;
  limit?: number;
} = {}) {
  const cappedLimit = Math.min(Math.max(Math.round(limit), 1), 200);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_observability_slo_policy_changes
      ORDER BY created_at DESC
      LIMIT ${Math.max(cappedLimit, 100)}
    `;
    return rows
      .map(sloPolicyChangeFromRow)
      .filter((change) => !policyId || change.policyId === policyId)
      .filter((change) => !status || change.status === status)
      .slice(0, cappedLimit);
  }

  const ledger = await readSloPolicyChangeLedger();
  return ledger.changes
    .filter((change) => !policyId || change.policyId === policyId)
    .filter((change) => !status || change.status === status)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, cappedLimit);
}

export async function getObservabilitySloPolicyChange(changeId: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_observability_slo_policy_changes
      WHERE id = ${changeId}
      LIMIT 1
    `;
    return rows[0] ? sloPolicyChangeFromRow(rows[0]) : null;
  }

  const ledger = await readSloPolicyChangeLedger();
  return ledger.changes.find((change) => change.id === changeId) || null;
}

export async function requestObservabilitySloPolicyChange(input: {
  policyId: string;
  action: SloPolicyChangeAction;
  tenantId?: string;
  requestedBy?: string;
  reason?: string;
  beforePolicy?: ObservabilitySloPolicy | null;
  afterPolicy?: ObservabilitySloPolicy | null;
  rollbackChangeId?: string;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  const riskLevel = changeRiskLevel(input.action);
  const change = normalizePolicyChange({
    id: createSloPolicyChangeId(),
    policyId: input.policyId,
    action: input.action,
    status: "pending",
    riskLevel,
    tenantId: input.tenantId,
    requestedBy: input.requestedBy,
    reason: input.reason,
    beforePolicy: input.beforePolicy,
    afterPolicy: input.afterPolicy,
    rollbackChangeId: input.rollbackChangeId,
    approvalPolicy: defaultSloApprovalPolicy(input.action, riskLevel),
    approvals: [],
    evidenceHash: "",
    metadata: input.metadata || {},
    createdAt: now,
    updatedAt: now,
  });
  await saveObservabilitySloPolicyChange(change);
  return change;
}

export async function recordAppliedObservabilitySloPolicyChange(input: {
  policyId: string;
  action: SloPolicyChangeAction;
  tenantId?: string;
  requestedBy?: string;
  reason?: string;
  beforePolicy?: ObservabilitySloPolicy | null;
  afterPolicy?: ObservabilitySloPolicy | null;
  rollbackChangeId?: string;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  const riskLevel = changeRiskLevel(input.action);
  const change = normalizePolicyChange({
    id: createSloPolicyChangeId(),
    policyId: input.policyId,
    action: input.action,
    status: "applied",
    riskLevel,
    tenantId: input.tenantId,
    requestedBy: input.requestedBy,
    reviewedBy: input.requestedBy,
    reason: input.reason,
    reviewReason: input.reason,
    beforePolicy: input.beforePolicy,
    afterPolicy: input.afterPolicy,
    rollbackChangeId: input.rollbackChangeId,
    approvalPolicy: defaultSloApprovalPolicy(input.action, riskLevel),
    approvals: [],
    evidenceHash: "",
    metadata: input.metadata || {},
    createdAt: now,
    updatedAt: now,
    reviewedAt: now,
    appliedAt: now,
  });
  await saveObservabilitySloPolicyChange(change);
  return change;
}

export async function applyObservabilitySloPolicyChange(
  changeId: string,
  review: {
    reviewedBy?: string;
    reviewedRole?: SecurityRole;
    tenantId?: string;
    reviewReason?: string;
  } = {},
) {
  const pending = await getObservabilitySloPolicyChange(changeId);
  if (!pending) {
    throw new Error(`SLO policy change ${changeId} was not found.`);
  }
  if (pending.status !== "pending") {
    throw new Error(`SLO policy change ${changeId} is ${pending.status}.`);
  }

  const approval = createApprovalEvidence(pending, {
    decision: "approved",
    actorId: review.reviewedBy || "system",
    actorRole: review.reviewedRole || "admin",
    tenantId: review.tenantId,
    reason: review.reviewReason,
  });
  const now = new Date().toISOString();
  const approved = normalizePolicyChange({
    ...pending,
    approvals: [...pending.approvals, approval],
    reviewedBy: approval.actorId,
    reviewReason: approval.reason || pending.reviewReason,
    updatedAt: now,
  });

  const progress = getSloPolicyApprovalProgress(approved);
  if (!progress.canApply) {
    await saveObservabilitySloPolicyChange(approved);
    return { change: approved, policies: [], approvalProgress: progress };
  }

  const policies = await applySloPolicyChangePayload(approved);
  const change = normalizePolicyChange({
    ...approved,
    status: "applied",
    reviewedAt: now,
    appliedAt: now,
    updatedAt: now,
  });
  await saveObservabilitySloPolicyChange(change);
  return { change, policies, approvalProgress: getSloPolicyApprovalProgress(change) };
}

export async function rejectObservabilitySloPolicyChange(
  changeId: string,
  review: {
    reviewedBy?: string;
    reviewedRole?: SecurityRole;
    tenantId?: string;
    reviewReason?: string;
  } = {},
) {
  const pending = await getObservabilitySloPolicyChange(changeId);
  if (!pending) {
    throw new Error(`SLO policy change ${changeId} was not found.`);
  }
  if (pending.status !== "pending") {
    throw new Error(`SLO policy change ${changeId} is ${pending.status}.`);
  }

  const now = new Date().toISOString();
  const rejection = createApprovalEvidence(pending, {
    decision: "rejected",
    actorId: review.reviewedBy || "system",
    actorRole: review.reviewedRole || "admin",
    tenantId: review.tenantId,
    reason: review.reviewReason,
  });
  const change = normalizePolicyChange({
    ...pending,
    status: "rejected",
    approvals: [...pending.approvals, rejection],
    reviewedBy: rejection.actorId,
    reviewReason: rejection.reason || pending.reviewReason,
    reviewedAt: now,
    updatedAt: now,
  });
  await saveObservabilitySloPolicyChange(change);
  return change;
}

export async function rollbackObservabilitySloPolicyChange(
  changeId: string,
  input: {
    tenantId?: string;
    requestedBy?: string;
    reason?: string;
    autoApply?: boolean;
  } = {},
) {
  const source = await getObservabilitySloPolicyChange(changeId);
  if (!source) {
    throw new Error(`SLO policy change ${changeId} was not found.`);
  }

  const restorePolicies = parsePolicyArray(source.metadata.beforePolicies);
  const currentPolicy = source.policyId !== "defaults"
    ? await getObservabilitySloPolicy(source.policyId)
    : null;
  const change = await requestObservabilitySloPolicyChange({
    policyId: source.policyId,
    action: "rollback_policy",
    tenantId: input.tenantId,
    requestedBy: input.requestedBy,
    reason: input.reason || `Rollback SLO policy change ${source.id}.`,
    beforePolicy: currentPolicy,
    afterPolicy: restorePolicies.length ? null : source.beforePolicy || null,
    rollbackChangeId: source.id,
    metadata: {
      sourceAction: source.action,
      restorePolicies,
      deleteOnApply: !source.beforePolicy && !restorePolicies.length,
    },
  });

  if (!input.autoApply) {
    return { change, policies: [] };
  }

  return applyObservabilitySloPolicyChange(change.id, {
    reviewedBy: input.requestedBy,
    reviewedRole: "system",
    reviewReason: input.reason,
  });
}

export function getSloPolicyApprovalProgress(change: ObservabilitySloPolicyChange): SloPolicyApprovalProgress {
  const approvedEvidence = change.approvals.filter((approval) => approval.decision === "approved");
  const approvedBy = [...new Set(approvedEvidence.map((approval) => approval.actorId))];
  const approvals = approvedBy.length;
  const required = change.approvalPolicy.quorum;
  const rejected = change.approvals.filter((approval) => approval.decision === "rejected").length;

  return {
    approvals,
    required,
    remaining: Math.max(required - approvals, 0),
    approvedBy,
    rejected,
    canApply: rejected === 0 && approvals >= required,
  };
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

async function readSloPolicyChangeLedger() {
  return readJsonFile<SloPolicyChangeLedger>(getSloPolicyChangeFile(), { changes: [] });
}

async function mutateSloPolicyChangeLedger(mutator: (ledger: SloPolicyChangeLedger) => SloPolicyChangeLedger) {
  policyChangeFileWriteQueue = policyChangeFileWriteQueue.then(
    async () => {
      await writeSloPolicyChangeLedger(mutator(await readSloPolicyChangeLedger()));
    },
    async () => {
      await writeSloPolicyChangeLedger(mutator(await readSloPolicyChangeLedger()));
    },
  );
  await policyChangeFileWriteQueue;
}

async function writeSloPolicyChangeLedger(ledger: SloPolicyChangeLedger) {
  await writeJsonFile(getSloPolicyChangeFile(), { changes: ledger.changes.slice(0, 500) });
}

async function saveObservabilitySloPolicyChange(change: ObservabilitySloPolicyChange) {
  const record = normalizePolicyChange(change);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_observability_slo_policy_changes (
        id, policy_id, action, status, risk_level, tenant_id,
        requested_by, reviewed_by, reason, review_reason,
        before_policy, after_policy, rollback_change_id, approval_policy,
        approvals, evidence_hash, metadata,
        created_at, updated_at, reviewed_at, applied_at
      )
      VALUES (
        ${record.id}, ${record.policyId}, ${record.action}, ${record.status},
        ${record.riskLevel}, ${record.tenantId || null}, ${record.requestedBy || null},
        ${record.reviewedBy || null}, ${record.reason || null}, ${record.reviewReason || null},
        ${JSON.stringify(record.beforePolicy || null)}::jsonb,
        ${JSON.stringify(record.afterPolicy || null)}::jsonb,
        ${record.rollbackChangeId || null},
        ${JSON.stringify(record.approvalPolicy)}::jsonb,
        ${JSON.stringify(record.approvals)}::jsonb,
        ${record.evidenceHash},
        ${JSON.stringify(record.metadata)}::jsonb,
        ${record.createdAt}, ${record.updatedAt}, ${record.reviewedAt || null},
        ${record.appliedAt || null}
      )
      ON CONFLICT (id) DO UPDATE SET
        policy_id = EXCLUDED.policy_id,
        action = EXCLUDED.action,
        status = EXCLUDED.status,
        risk_level = EXCLUDED.risk_level,
        tenant_id = EXCLUDED.tenant_id,
        requested_by = EXCLUDED.requested_by,
        reviewed_by = EXCLUDED.reviewed_by,
        reason = EXCLUDED.reason,
        review_reason = EXCLUDED.review_reason,
        before_policy = EXCLUDED.before_policy,
        after_policy = EXCLUDED.after_policy,
        rollback_change_id = EXCLUDED.rollback_change_id,
        approval_policy = EXCLUDED.approval_policy,
        approvals = EXCLUDED.approvals,
        evidence_hash = EXCLUDED.evidence_hash,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at,
        reviewed_at = EXCLUDED.reviewed_at,
        applied_at = EXCLUDED.applied_at
    `;
    return record;
  }

  await mutateSloPolicyChangeLedger((ledger) => ({
    changes: [record, ...ledger.changes.filter((item) => item.id !== record.id)],
  }));
  return record;
}

async function applySloPolicyChangePayload(change: ObservabilitySloPolicyChange) {
  if (change.action === "reset_defaults") {
    return resetObservabilitySloPolicies();
  }

  if (change.action === "delete_policy") {
    await deleteObservabilitySloPolicy(change.policyId);
    return [];
  }

  if (change.action === "rollback_policy") {
    const restorePolicies = parsePolicyArray(change.metadata.restorePolicies);
    if (restorePolicies.length) {
      const saved: ObservabilitySloPolicy[] = [];
      for (const policy of restorePolicies) {
        saved.push(await saveObservabilitySloPolicy(policy));
      }
      return saved;
    }

    if (change.afterPolicy) {
      return [await saveObservabilitySloPolicy(change.afterPolicy)];
    }

    if (change.metadata.deleteOnApply) {
      await deleteObservabilitySloPolicy(change.policyId);
      return [];
    }
  }

  if (change.afterPolicy) {
    return [await saveObservabilitySloPolicy(change.afterPolicy)];
  }

  throw new Error(`SLO policy change ${change.id} cannot be applied without an after snapshot.`);
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

function normalizePolicyChange(
  change: Omit<ObservabilitySloPolicyChange, "approvalPolicy" | "approvals" | "evidenceHash"> &
    Partial<Pick<ObservabilitySloPolicyChange, "approvalPolicy" | "approvals" | "evidenceHash">>,
): ObservabilitySloPolicyChange {
  const now = new Date().toISOString();
  const beforePolicy = parsePolicySnapshot(change.beforePolicy);
  const afterPolicy = parsePolicySnapshot(change.afterPolicy);
  const action = normalizeChangeAction(change.action);
  const riskLevel = Math.min(Math.max(Math.round(Number(change.riskLevel || changeRiskLevel(action))), 0), 3);
  const approvalPolicy = normalizeApprovalPolicy(change.approvalPolicy, action, riskLevel);
  const approvals = parseApprovalEvidenceList(change.approvals);
  const normalized = {
    id: change.id.trim() || createSloPolicyChangeId(),
    policyId: change.policyId.trim() || afterPolicy?.id || beforePolicy?.id || "unknown",
    action,
    status: normalizeChangeStatus(change.status),
    riskLevel,
    tenantId: change.tenantId?.trim() || undefined,
    requestedBy: change.requestedBy?.trim() || undefined,
    reviewedBy: change.reviewedBy?.trim() || undefined,
    reason: change.reason?.trim() || undefined,
    reviewReason: change.reviewReason?.trim() || undefined,
    beforePolicy,
    afterPolicy,
    rollbackChangeId: change.rollbackChangeId?.trim() || undefined,
    approvalPolicy,
    approvals,
    evidenceHash: change.evidenceHash || "",
    metadata: (redactSensitive(change.metadata || {}) || {}) as Record<string, unknown>,
    createdAt: change.createdAt || now,
    updatedAt: change.updatedAt || now,
    reviewedAt: change.reviewedAt,
    appliedAt: change.appliedAt,
  };
  return {
    ...normalized,
    evidenceHash: hashSloPolicyChange(normalized),
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

function sloPolicyChangeFromRow(row: Record<string, unknown>): ObservabilitySloPolicyChange {
  return normalizePolicyChange({
    id: String(row.id),
    policyId: String(row.policy_id || ""),
    action: normalizeChangeAction(row.action),
    status: normalizeChangeStatus(row.status),
    riskLevel: Number(row.risk_level || 2),
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    requestedBy: row.requested_by ? String(row.requested_by) : undefined,
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : undefined,
    reason: row.reason ? String(row.reason) : undefined,
    reviewReason: row.review_reason ? String(row.review_reason) : undefined,
    beforePolicy: parsePolicySnapshot(row.before_policy),
    afterPolicy: parsePolicySnapshot(row.after_policy),
    rollbackChangeId: row.rollback_change_id ? String(row.rollback_change_id) : undefined,
    approvalPolicy: parseApprovalPolicy(row.approval_policy),
    approvals: parseApprovalEvidenceList(row.approvals),
    evidenceHash: row.evidence_hash ? String(row.evidence_hash) : "",
    metadata: parseObject(row.metadata) || {},
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
    reviewedAt: row.reviewed_at ? normalizeDate(row.reviewed_at) : undefined,
    appliedAt: row.applied_at ? normalizeDate(row.applied_at) : undefined,
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

function createApprovalEvidence(
  change: ObservabilitySloPolicyChange,
  input: {
    decision: SloPolicyApprovalDecision;
    actorId: string;
    actorRole: SecurityRole;
    tenantId?: string;
    reason?: string;
  },
): SloPolicyApprovalEvidence {
  const actorId = input.actorId.trim() || "system";
  const actorRole = normalizeSecurityRole(input.actorRole);
  const reason = input.reason?.trim();

  assertApprovalAllowed(change, {
    decision: input.decision,
    actorId,
    actorRole,
    reason,
  });

  const createdAt = new Date().toISOString();
  const previousHash = change.approvals.at(-1)?.signature || change.evidenceHash;
  const evidenceCore = {
    changeId: change.id,
    policyId: change.policyId,
    action: change.action,
    decision: input.decision,
    actorId,
    actorRole,
    tenantId: input.tenantId,
    reason,
    previousHash,
    createdAt,
  };
  const evidenceHash = hashValue(evidenceCore);
  return {
    id: `sloapproval_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    decision: input.decision,
    actorId,
    actorRole,
    tenantId: input.tenantId?.trim() || undefined,
    reason,
    createdAt,
    previousHash,
    evidenceHash,
    signature: hashValue({ ...evidenceCore, evidenceHash }),
  };
}

function assertApprovalAllowed(
  change: ObservabilitySloPolicyChange,
  input: {
    decision: SloPolicyApprovalDecision;
    actorId: string;
    actorRole: SecurityRole;
    reason?: string;
  },
) {
  if (!change.approvalPolicy.requiredRoles.includes(input.actorRole)) {
    throw new Error(
      `SLO policy change ${change.id} requires approver role ${change.approvalPolicy.requiredRoles.join(" or ")}.`,
    );
  }

  if (!change.approvalPolicy.allowRequesterApproval && change.requestedBy === input.actorId) {
    throw new Error(`Requester ${input.actorId} cannot approve SLO policy change ${change.id}.`);
  }

  if (change.approvals.some((approval) => approval.actorId === input.actorId)) {
    throw new Error(`Approver ${input.actorId} already recorded a decision for SLO policy change ${change.id}.`);
  }

  if (
    input.decision === "approved" &&
    change.approvalPolicy.attestationRequired &&
    (!input.reason || input.reason.length < 12)
  ) {
    throw new Error(`SLO policy change ${change.id} requires an approval attestation.`);
  }
}

function normalizeChangeAction(value: unknown): SloPolicyChangeAction {
  const action = String(value || "upsert_policy");
  if (
    action === "toggle_policy" ||
    action === "delete_policy" ||
    action === "reset_defaults" ||
    action === "rollback_policy"
  ) {
    return action;
  }
  return "upsert_policy";
}

function normalizeChangeStatus(value: unknown): SloPolicyChangeStatus {
  const status = String(value || "pending");
  if (status === "applied" || status === "rejected") {
    return status;
  }
  return "pending";
}

function changeRiskLevel(action: SloPolicyChangeAction) {
  return action === "delete_policy" || action === "reset_defaults" || action === "rollback_policy" ? 3 : 2;
}

function defaultSloApprovalPolicy(action: SloPolicyChangeAction, riskLevel: number): SloPolicyApprovalPolicy {
  if (riskLevel >= 3) {
    return {
      quorum: 2,
      requiredRoles: ["admin", "system"],
      allowRequesterApproval: false,
      attestationRequired: action === "rollback_policy",
      description: action === "rollback_policy"
        ? "High-risk rollback requires two distinct admin/system approvers and an explicit rollback attestation."
        : "High-risk SLO policy changes require two distinct admin/system approvers.",
    };
  }

  return {
    quorum: 1,
    requiredRoles: ["operator", "admin", "system"],
    allowRequesterApproval: true,
    attestationRequired: false,
    description: "SLO policy changes require one operator, admin, or system approval.",
  };
}

function normalizeApprovalPolicy(
  value: unknown,
  action: SloPolicyChangeAction,
  riskLevel: number,
): SloPolicyApprovalPolicy {
  const fallback = defaultSloApprovalPolicy(action, riskLevel);
  const raw = parseObject(value) || {};
  const quorum = Number(raw.quorum || fallback.quorum);
  const requiredRoles = Array.isArray(raw.requiredRoles)
    ? raw.requiredRoles.map(normalizeSecurityRole).filter((role) => role !== "viewer")
    : fallback.requiredRoles;

  return {
    quorum: Math.min(Math.max(Math.round(quorum), 1), 5),
    requiredRoles: requiredRoles.length ? [...new Set(requiredRoles)] : fallback.requiredRoles,
    allowRequesterApproval: typeof raw.allowRequesterApproval === "boolean"
      ? raw.allowRequesterApproval
      : fallback.allowRequesterApproval,
    attestationRequired: typeof raw.attestationRequired === "boolean"
      ? raw.attestationRequired
      : fallback.attestationRequired,
    description: typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim().slice(0, 500)
      : fallback.description,
  };
}

function parseApprovalPolicy(value: unknown): SloPolicyApprovalPolicy | undefined {
  const raw = parseObject(value);
  if (!raw) {
    return undefined;
  }

  return {
    quorum: Number(raw.quorum || 1),
    requiredRoles: Array.isArray(raw.requiredRoles) ? raw.requiredRoles.map(normalizeSecurityRole) : ["admin"],
    allowRequesterApproval: Boolean(raw.allowRequesterApproval),
    attestationRequired: Boolean(raw.attestationRequired),
    description: String(raw.description || ""),
  };
}

function parseApprovalEvidenceList(value: unknown): SloPolicyApprovalEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const raw = item as Record<string, unknown>;
      const decision = String(raw.decision || "approved") === "rejected" ? "rejected" : "approved";
      return {
        id: String(raw.id || `sloapproval_${Date.now()}`),
        decision,
        actorId: String(raw.actorId || raw.actor_id || "system"),
        actorRole: normalizeSecurityRole(raw.actorRole || raw.actor_role),
        tenantId: raw.tenantId || raw.tenant_id ? String(raw.tenantId || raw.tenant_id) : undefined,
        reason: raw.reason ? String(raw.reason) : undefined,
        createdAt: raw.createdAt || raw.created_at ? normalizeDate(raw.createdAt || raw.created_at) : new Date().toISOString(),
        previousHash: raw.previousHash || raw.previous_hash ? String(raw.previousHash || raw.previous_hash) : undefined,
        evidenceHash: String(raw.evidenceHash || raw.evidence_hash || ""),
        signature: String(raw.signature || ""),
      };
    });
}

function normalizeSecurityRole(value: unknown): SecurityRole {
  const role = String(value || "admin").toLowerCase();
  if (role === "viewer" || role === "operator" || role === "admin" || role === "system") {
    return role;
  }
  return "admin";
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

function parsePolicySnapshot(value: unknown): ObservabilitySloPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return normalizePolicy(value as ObservabilitySloPolicy);
}

function parsePolicyArray(value: unknown): ObservabilitySloPolicy[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(parsePolicySnapshot)
    .filter((policy): policy is ObservabilitySloPolicy => Boolean(policy));
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function createSloPolicyChangeId() {
  return `slochg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function hashSloPolicyChange(change: ObservabilitySloPolicyChange) {
  return hashValue({
    id: change.id,
    policyId: change.policyId,
    action: change.action,
    status: change.status,
    riskLevel: change.riskLevel,
    requestedBy: change.requestedBy,
    beforePolicy: change.beforePolicy,
    afterPolicy: change.afterPolicy,
    rollbackChangeId: change.rollbackChangeId,
    approvalPolicy: change.approvalPolicy,
    approvals: change.approvals.map((approval) => ({
      id: approval.id,
      decision: approval.decision,
      actorId: approval.actorId,
      actorRole: approval.actorRole,
      tenantId: approval.tenantId,
      reason: approval.reason,
      createdAt: approval.createdAt,
      previousHash: approval.previousHash,
      evidenceHash: approval.evidenceHash,
      signature: approval.signature,
    })),
    metadata: change.metadata,
    createdAt: change.createdAt,
    updatedAt: change.updatedAt,
    reviewedAt: change.reviewedAt,
    appliedAt: change.appliedAt,
  });
}

function hashValue(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return value === undefined ? "null" : JSON.stringify(value);
}

function getSloPolicyFile() {
  return getDataPath("observability-slo-policies.json");
}

function getSloPolicyChangeFile() {
  return getDataPath("observability-slo-policy-changes.json");
}
