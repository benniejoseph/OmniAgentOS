/** Browser-only projections. These checks narrow presentation; routes remain authority. */
export type RecordValue = Record<string, unknown>;
export type OperationalScope = { tenantId: string; actorId: string };
export type SourceKey = "evaluations" | "feedback" | "release" | "events" | "slo" | "incidents" | "alerts" | "context" | "audits" | "isolation" | "retention";
export type ActionKind = "run" | "review" | "replay" | "monitor" | "marker" | "retention";
export type DraftValues = Record<string, string | boolean>;
export type Submission = { kind: ActionKind; path: string; body: Readonly<RecordValue>; key: string; scope: OperationalScope; target?: Readonly<RecordValue> };
export type Receipt = { title: string; status: string; details: Array<[string, string]>; caveat?: string };
export const retentionKeys = ["pendingApprovalDays", "pendingAccessRequestDays", "reviewedAccessRequestDays", "episodeMemoryDays", "consolidatedMemoryDays", "retrievalTraceDays", "workflowDays", "triggerEventDays", "operationJobDays", "runContentDays", "toolPayloadDays", "aiUsageDays", "domainEventDays", "observabilityDays", "healthHistoryDays", "evaluationHistoryDays", "graphBuildHistoryDays", "securityAuditDays"] as const;
export function record(value: unknown): RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
export function at(value: unknown, path: string): unknown { return path.split(".").reduce<unknown>((current, part) => record(current)[part], value); }
export function text(value: unknown, fallback = "Unavailable"): string { return typeof value === "string" && value.length ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : fallback; }
export function rows(value: unknown): RecordValue[] { return Array.isArray(value) ? value.map(record) : []; }
export function count(value: unknown): string { return Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : "Unavailable"; }
export function isIdentity(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 1_024 && !/[\u0000-\u001f\u007f]/.test(value); }
const timestamp = (value: unknown) => typeof value === "string" && value.length <= 80 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const oneOf = (value: unknown, options: readonly string[]) => typeof value === "string" && options.includes(value);
function requireValue(condition: unknown, message = "The returned data could not be verified."): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown) { requireValue(value !== null && typeof value === "object" && !Array.isArray(value)); return value as RecordValue; }
function array(value: unknown, max: number, scope?: OperationalScope, identity = "id") {
  requireValue(Array.isArray(value) && value.length <= max);
  const identities = new Set<string>();
  for (const raw of value) {
    const row = object(raw);
    if (identity) { requireValue(isIdentity(row[identity]) && !identities.has(row[identity])); identities.add(row[identity]); }
    if (scope && row.tenantId !== undefined) requireValue(row.tenantId === scope.tenantId, "The returned tenant does not match this workspace.");
  }
  return value as RecordValue[];
}
function policy(value: unknown) { const result = object(value); requireValue(retentionKeys.every((key) => integer(result[key]))); return result; }
function validateSlo(value: unknown, scope?: OperationalScope) {
  const result = object(value);
  requireValue(typeof result.healthy === "boolean" && timestamp(result.checkedAt));
  const policies = array(result.policies, 200, scope);
  const evaluations = array(result.evaluations, 200, undefined, "");
  const breaches = array(result.breaches, 200, undefined, "");
  requireValue(result.healthy === (breaches.length === 0));
  requireValue(evaluations.length === policies.length);
  const measuredIds = new Set<string>();
  for (const item of [...evaluations, ...breaches]) {
    requireValue(isIdentity(record(item.policy).id) && typeof item.breached === "boolean");
    if (item.insufficientSamples !== undefined) {
      const sample = object(item.insufficientSamples);
      requireValue(integer(sample.samples) && integer(sample.minimumSamples));
    }
  }
  for (const item of evaluations) {
    const id = record(item.policy).id as string;
    requireValue(!measuredIds.has(id) && policies.some((policy) => policy.id === id));
    measuredIds.add(id);
  }
  const breached = evaluations.filter((item) => item.breached === true);
  requireValue(breaches.length === breached.length && new Set(breaches.map((item) => record(item.policy).id)).size === breaches.length && breaches.every((item) => item.breached === true && breached.some((candidate) => record(candidate.policy).id === record(item.policy).id)));
  return result;
}
export function parseSource(key: SourceKey, value: unknown, scope: OperationalScope): RecordValue {
  const body = object(value);
  switch (key) {
    case "evaluations": array(body.runs, 12, scope); array(body.cases, 500); array(body.jobs, 12); object(body.stats); break;
    case "feedback": array(body.clusters, 50, scope); array(body.proposals, 50, scope); object(body.summary); break;
    case "events": array(body.events, 24, scope); object(body.stats); break;
    case "slo": validateSlo(body, scope); break;
    case "incidents": array(body.incidents, 12, scope); object(body.stats); break;
    case "alerts": array(body.deliveries, 12, scope); object(body.stats); break;
    case "audits": array(body.records, 24, scope); object(body.stats); break;
    case "context": {
      const context = object(body.context);
      requireValue(context.tenantId === scope.tenantId && context.actorId === scope.actorId, "Security context does not match this workspace.");
      object(object(body.policy).rbacRules); break;
    }
    case "release": {
      const report = object(body.report); const gate = object(report.releaseGate);
      requireValue(report.tenantId === scope.tenantId && timestamp(report.checkedAt) && typeof gate.approved === "boolean" && oneOf(gate.status, ["passed", "warning", "blocked"]));
      array(report.gates, 200); object(gate.summary); break;
    }
    case "isolation": {
      const report = object(body.report);
      requireValue(report.tenantId === scope.tenantId && timestamp(report.checkedAt) && oneOf(report.status, ["passing", "degraded", "not_configured"]));
      array(report.tables, 2_000, undefined, "tableName"); object(report.summary); break;
    }
    case "retention": policy(body.policy); requireValue(oneOf(body.backend, ["postgres", "bounded_local"]) && typeof body.automaticSweep === "boolean"); break;
  }
  return body;
}
export function sloLabel(value: unknown): string {
  const body = record(value);
  if (typeof body.healthy !== "boolean" || !Array.isArray(body.evaluations)) return "Unavailable";
  if (body.evaluations.length === 0) return "No enabled policy measurements";
  const insufficient = body.evaluations.some((row) => record(row).insufficientSamples !== undefined);
  if (!body.healthy) return insufficient ? "Breaches · incomplete samples" : "Breaches reported";
  return insufficient ? "Insufficient samples" : "No breaches reported";
}
export function makeSubmission(kind: ActionKind, values: DraftValues, scope: OperationalScope, key: string, target?: RecordValue): Submission {
  requireValue(isIdentity(scope.tenantId) && isIdentity(scope.actorId) && isIdentity(key), "Workspace identity is unavailable.");
  const field = (name: string, min: number, max: number) => { const value = typeof values[name] === "string" ? values[name].trim() : ""; requireValue(value.length >= min && value.length <= max, `${name} must contain ${min}–${max} characters.`); return value; };
  let path: string; let body: RecordValue;
  switch (kind) {
    case "run": {
      const mode = field("maxSafetyMode", 1, 32); requireValue(["read_only", "synthetic", "mutation_allowed"].includes(mode), "Choose a supported safety limit.");
      path = "/api/evaluations"; body = { suite: field("suite", 1, 80), maxSafetyMode: mode }; break;
    }
    case "review": {
      const decision = field("decision", 1, 20); requireValue(decision === "approved" || decision === "rejected");
      path = "/api/evaluations/failure-feedback"; body = { action: "review", proposalId: field("proposalId", 1, 240), decision, reason: field("reason", 12, 500) }; break;
    }
    case "replay": path = "/api/evaluations/failure-feedback"; body = { action: "replay", clusterId: field("clusterId", 1, 240) }; break;
    case "monitor": path = "/api/observability/slo"; body = { action: "run_monitor", queueAlerts: values.queueAlerts === true, dispatchAlerts: values.dispatchAlerts === true }; break;
    case "marker": {
      const level = field("level", 1, 16); const category = field("category", 1, 32);
      requireValue(["info", "warn", "error"].includes(level) && ["system", "workflow", "connector", "security", "evaluation"].includes(category));
      path = "/api/observability"; body = { action: "record_marker", message: field("message", 1, 240), level, category }; break;
    }
    case "retention": path = "/api/security/retention"; body = { scope: "tenant" }; break;
  }
  return Object.freeze({ kind, path, body: Object.freeze(body), key, scope: Object.freeze({ ...scope }), ...(target ? { target: Object.freeze(JSON.parse(JSON.stringify(target)) as RecordValue) } : {}) });
}
export function retrySupported(kind: ActionKind) { return kind === "run" || kind === "replay" || kind === "review"; }
function jobReceipt(value: unknown) {
  const job = object(value);
  requireValue(isIdentity(job.id) && job.type === "evaluation.run" && oneOf(job.status, ["queued", "running", "completed", "failed", "canceled"]) && timestamp(job.createdAt) && timestamp(job.updatedAt));
  return job;
}
export function parseReceipt(submission: Submission, value: unknown): Receipt {
  const body = object(value); const details: Receipt["details"] = [];
  const add = (label: string, value: unknown) => { if (value !== undefined) details.push([label, text(value)]); };
  if (submission.kind === "run" || submission.kind === "replay") {
    const job = jobReceipt(body.job);
    add("Job ID", job.id); add("Job type", job.type); add("Job status", job.status); add("Created", job.createdAt); add("Updated", job.updatedAt); add("Attempt", job.attempt); add("Last error", job.lastError);
    for (const name of ["evalRunId", "runId", "reportId"]) add(`Result ${name}`, record(job.result)[name]);
    if (submission.kind === "replay") {
      const replay = object(body.replayCase);
      requireValue(body.mutationAuthorityInherited === false && replay.schemaVersion === 1 && replay.lane === "governed_evaluation" && isIdentity(replay.caseId) && sha(replay.caseDefinitionSha256) && record(replay.replay).mutationAuthority === "not_inherited");
      const expected = record(submission.target?.replayCase);
      if (expected.caseId !== undefined) requireValue(replay.caseId === expected.caseId && replay.caseDefinitionSha256 === expected.caseDefinitionSha256);
      add("Replay case", replay.caseId); add("Case definition SHA-256", replay.caseDefinitionSha256);
    }
    return { title: "Evaluation request accepted", status: String(job.status), details, caveat: "The job receipt does not prove the evaluation passed. The server returns job identity separately from the submitted suite or cluster." };
  }
  if (submission.kind === "review") {
    const proposal = object(body.proposal);
    requireValue(body.applied === false && proposal.id === submission.body.proposalId && proposal.tenantId === submission.scope.tenantId && proposal.status === submission.body.decision && proposal.reviewedBy === submission.scope.actorId && proposal.reviewReason === submission.body.reason && integer(proposal.version) && Number(proposal.version) > 0 && sha(proposal.proposalSha256) && timestamp(proposal.reviewedAt));
    if (submission.target) requireValue(proposal.version === submission.target.version && proposal.proposalSha256 === submission.target.proposalSha256);
    for (const name of ["id", "clusterId", "version", "proposalSha256", "reviewedBy", "reviewedAt", "reviewReason"]) add(name, proposal[name]);
    return { title: "Proposal review recorded", status: String(proposal.status), details, caveat: "The harness change remains inactive until separately implemented and released." };
  }
  if (submission.kind === "marker") {
    const event = object(body.event);
    requireValue(isIdentity(event.id) && event.tenantId === submission.scope.tenantId && event.actorId === submission.scope.actorId && event.action === "observability.marker" && event.level === submission.body.level && event.category === submission.body.category && typeof event.message === "string" && timestamp(event.createdAt));
    for (const name of ["id", "correlationId", "requestId", "tenantId", "actorId", "level", "category", "message", "createdAt"]) add(name, event[name]);
    return { title: "Marker recorded", status: String(event.level), details, caveat: "The recorded message may be redacted by the server." };
  }
  if (submission.kind === "monitor") {
    const result = validateSlo(body.result, submission.scope);
    requireValue(result.trigger === "operator.api" && result.actorId === submission.scope.actorId && integer(result.queuedAlerts));
    const actions = array(result.incidentActions, 200, undefined, "");
    add("Checked", result.checkedAt); add("Actor", result.actorId); add("Queued alerts", result.queuedAlerts);
    for (const action of actions) {
      requireValue(isIdentity(action.policyId));
      add("Policy ID", action.policyId); add("Incident ID", record(action.incident).id); add("Incident status", record(action.incident).status); add("Incident event ID", record(action.event).id);
      for (const delivery of array(action.alertDeliveries, 500, submission.scope)) { add("Alert delivery ID", delivery.id); add("Delivery status", delivery.status); }
    }
    if (submission.body.dispatchAlerts === true) {
      const dispatch = object(body.dispatch); array(dispatch.processed, 10, submission.scope);
      for (const key of ["delivered", "skipped", "failed"]) { requireValue(integer(dispatch[key])); add(`Dispatch ${key}`, dispatch[key]); }
      for (const row of rows(dispatch.processed)) { add("Dispatched delivery ID", row.id); add("Delivery status", row.status); add("Delivery error", row.lastError); }
    } else requireValue(body.dispatch === undefined);
    return { title: "SLO monitor returned", status: sloLabel(result), details, caveat: "Health describes this measured snapshot. Queued alerts and delivery outcomes are separate." };
  }
  const result = object(body.result);
  requireValue(result.scope === "tenant" && result.tenantId === submission.scope.tenantId && oneOf(result.backend, ["postgres", "bounded_local"]) && integer(result.batchLimit) && typeof result.moreAvailable === "boolean" && timestamp(result.completedAt));
  const returnedPolicy = policy(result.policy); const deleted = object(result.deleted);
  requireValue(Object.keys(deleted).length > 0 && Object.keys(deleted).length <= 100 && Object.values(deleted).every(integer));
  add("Tenant", result.tenantId); add("Scope", result.scope); add("Backend", result.backend); add("Completed", result.completedAt); add("Batch limit", result.batchLimit); add("More eligible work", result.moreAvailable ? "Yes" : "No");
  for (const [name, amount] of Object.entries(deleted)) add(`Deleted · ${name}`, amount);
  for (const name of retentionKeys) add(`Applied policy · ${name}`, `${returnedPolicy[name]} days`);
  return { title: "Retention sweep returned", status: result.moreAvailable ? "Bounded batch completed · more available" : "Bounded batch completed", details, caveat: "Only the returned deletion counts are confirmed. The applied server policy may differ from the earlier read-only review." };
}
