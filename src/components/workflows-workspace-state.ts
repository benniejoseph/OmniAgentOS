import { workflowControlSignals } from "@/lib/workflows/client-controls";
import type { WorkflowRunStatus, WorkflowSignalType } from "@/lib/workflows/types";

export type WorkflowObject = Record<string, unknown>;
export type WorkflowOwner = { tenantId: string; actorId: string };
export type WorkflowRead = { status: "loading" | "ready" | "error"; data?: WorkflowObject; error?: string };
export const workflowSources = {
  runs: { label: "Workflow runs", path: "/api/workflows?limit=16", bound: 16 },
  plans: { label: "Workflow plans", path: "/api/workflows/plan?limit=12", bound: 12 },
  triggers: { label: "Schedules and triggers", path: "/api/triggers?limit=12", bound: 12 },
  operations: { label: "Operations", path: "/api/operations", bound: 20 },
} as const;
export type WorkflowSource = keyof typeof workflowSources;
export const object = (v: unknown): v is WorkflowObject => Boolean(v) && typeof v === "object" && !Array.isArray(v);
export const text = (v: unknown, fallback = "Unavailable") => typeof v === "string" && v.length ? v : fallback;
export const child = (v: unknown, key: string): WorkflowObject | undefined => object(v) && object(v[key]) ? v[key] : undefined;
export const rows = (v: unknown, key: string): WorkflowObject[] => object(v) && Array.isArray(v[key]) ? v[key].filter(object) : [];
export const number = (v: unknown): number | undefined => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : undefined;
export const titleCase = (v: unknown) => text(v).replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export const exactJson = (value: unknown): string => JSON.stringify(value, null, 2) ?? "Unavailable";
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 500 && v.trim() === v;
const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const member = (v: unknown, choices: readonly string[]) => typeof v === "string" && choices.includes(v);
const statuses = ["queued", "running", "waiting_approval", "paused", "completed", "failed", "canceled"] as const;
function requireData(valid: unknown): asserts valid {
  if (!valid) throw new Error("The service returned an incomplete or mismatched record. The outcome is unconfirmed; refresh its source before reviewing another action.");
}
function records(v: unknown, maximum?: number): asserts v is WorkflowObject[] {
  requireData(Array.isArray(v) && (maximum === undefined || v.length <= maximum) && v.every(object));
}
function unique(v: WorkflowObject[]) { requireData(v.every((item) => id(item.id)) && new Set(v.map((item) => item.id)).size === v.length); }
function owner(v: WorkflowObject, expected: WorkflowOwner, exact = false) {
  requireData((!exact && v.tenantId === undefined) || v.tenantId === expected.tenantId);
  if (exact || v.ownerActorId !== undefined) requireData(v.ownerActorId === expected.actorId);
}
export function parseWorkflowRun(value: unknown, expected: WorkflowOwner): WorkflowObject {
  requireData(object(value) && id(value.id) && typeof value.goal === "string" && member(value.status, statuses) && date(value.updatedAt) && date(value.createdAt));
  owner(value, expected);
  requireData(object(value.input) && value.input.goal === value.goal && typeof value.approvalRequired === "boolean" && number(value.attempt) !== undefined && number(value.maxAttempts) !== undefined);
  return value;
}
export function parseWorkflowPlan(value: unknown, expected: WorkflowOwner): WorkflowObject {
  requireData(object(value) && id(value.id) && typeof value.goal === "string" && member(value.status, ["planned", "failed"]) && date(value.updatedAt));
  owner(value, expected);
  const plan = child(value, "plan"); const validation = child(value, "validation");
  requireData(plan && member(plan.mode, ["orchestrate", "research", "execute", "learn"]) && typeof plan.summary === "string" && validation && typeof validation.isDag === "boolean");
  records(plan.nodes); unique(plan.nodes);
  requireData(typeof value.approvalRequired === "boolean" && [0, 1, 2, 3].includes(Number(value.highestRiskLevel)) && typeof value.highestRiskLevel === "number");
  requireData(typeof value.confidence === "number" && Number.isFinite(value.confidence));
  for (const field of ["missingDependencies", "unreachableNodes", "policyWarnings"]) requireData(Array.isArray(validation[field]) && validation[field].every((v: unknown) => typeof v === "string"));
  return value;
}
export function parseWorkflowTrigger(value: unknown, expected: WorkflowOwner): WorkflowObject {
  requireData(object(value) && id(value.id) && typeof value.name === "string" && member(value.triggerKind, ["webhook", "schedule"]) && member(value.status, ["active", "paused"]) && date(value.updatedAt));
  owner(value, expected, value.triggerKind === "schedule");
  if (value.triggerKind === "schedule") {
    const schedule = child(value, "schedule"); const config = child(schedule, "config"); const state = child(schedule, "state");
    const pin = child(config, "procedurePin"); const agent = child(config, "agentIdentityPin");
    requireData(config?.schemaVersion === 1 && digest(config.configSha256) && typeof config.timezone === "string" && typeof config.rrule === "string" && date(config.startsAt) && (!config.endsAt || date(config.endsAt)));
    requireData(member(config.missedPolicy, ["skip", "run_once"]) && number(config.maxOccurrences) !== undefined && number(config.failureLimit) !== undefined && config.failureLimit !== 0);
    requireData(pin?.schemaVersion === 1 && id(pin.procedureId) && digest(pin.snapshotSha256) && digest(pin.reviewedSnapshotSha256) && date(pin.reviewedAt));
    requireData(agent && id(agent.logicalAgentId) && digest(config.policyPinSha256) && object(config.occurrenceBudget));
    requireData(state && member(state.circuitState, ["closed", "open", "half_open"]) && number(state.occurrenceCount) !== undefined && number(state.consecutiveFailureCount) !== undefined);
    requireData(config.authorityMode === undefined || member(config.authorityMode, ["read_only", "reviewed_mutation"]));
    if (config.authorityMode === "reviewed_mutation") {
      const policy = child(config, "mutationPolicy");
      requireData(policy?.schemaVersion === 1 && policy.policyKind === "reviewed_static_mutation" && digest(policy.policySha256));
      records(policy.bindings);
    }
  }
  return value;
}
function parseOccurrence(value: WorkflowObject, expected: WorkflowOwner, triggerId?: string) {
  owner(value, expected, true);
  requireData(id(value.id) && id(value.triggerId) && (!triggerId || value.triggerId === triggerId) && member(value.status, ["claimed", "enqueued", "completed", "skipped", "failed"]) && date(value.scheduledFor) && digest(value.authoritySha256));
}
function parseOccurrenceReceipt(value: WorkflowObject, expected: WorkflowOwner, triggerId?: string) {
  owner(value, expected, true);
  requireData(id(value.id) && id(value.occurrenceId) && id(value.triggerId) && (!triggerId || value.triggerId === triggerId) && digest(value.receiptSha256) && date(value.recordedAt));
}
export function parseWorkflowSource(source: WorkflowSource, value: unknown, expected: WorkflowOwner): WorkflowObject {
  requireData(object(value));
  if (source === "runs") { records(value.runs, 16); unique(value.runs); value.runs.forEach((v) => parseWorkflowRun(v, expected)); }
  if (source === "plans") { records(value.plans, 12); unique(value.plans); value.plans.forEach((v) => parseWorkflowPlan(v, expected)); }
  if (source === "triggers") {
    records(value.triggers, 12); unique(value.triggers); value.triggers.forEach((v) => parseWorkflowTrigger(v, expected));
    for (const field of ["procedures", "agents", "occurrences", "receipts", "events"]) records(value[field]);
    unique(value.procedures as WorkflowObject[]); unique(value.agents as WorkflowObject[]);
    requireData((value.procedures as WorkflowObject[]).every((v) => typeof v.schedulable === "boolean"));
    (value.occurrences as WorkflowObject[]).forEach((v) => parseOccurrence(v, expected));
    (value.receipts as WorkflowObject[]).forEach((v) => parseOccurrenceReceipt(v, expected));
    requireData(object(value.scheduleDefaults) && object(value.scheduleDefaults.occurrenceBudget));
  }
  if (source === "operations") {
    requireData(object(value.summary) && object(value.latest));
    for (const [field, maximum] of [["operationJobs", 20], ["quarantinedJobs", 10], ["recoveryEvents", 10]] as const) records(value.latest[field], maximum);
    unique(value.latest.quarantinedJobs as WorkflowObject[]);
    requireData((value.latest.quarantinedJobs as WorkflowObject[]).every((v) => typeof v.type === "string"));
  }
  return value;
}
export function parseWorkflowDetail(value: unknown, runId: string, expected: WorkflowOwner): WorkflowObject {
  requireData(object(value)); const run = parseWorkflowRun(value.run, expected); requireData(run.id === runId);
  for (const field of ["steps", "events"]) {
    records(value[field]); unique(value[field]);
    for (const row of value[field]) { owner(row, expected); requireData(row.workflowRunId === runId); }
  }
  return value;
}
export function parseWorkflowScheduleDetail(value: unknown, triggerId: string, expected: WorkflowOwner): WorkflowObject {
  requireData(object(value)); const trigger = parseWorkflowTrigger(value.trigger, expected); const config = child(child(trigger, "schedule"), "config");
  const preview = child(value, "preview");
  requireData(trigger.id === triggerId && preview?.triggerId === triggerId && preview.configurationSha256 === config?.configSha256);
  requireData(Array.isArray(preview.occurrences) && preview.occurrences.length <= 6 && preview.occurrences.every(date));
  records(value.occurrences, 30); unique(value.occurrences); value.occurrences.forEach((v) => parseOccurrence(v, expected, triggerId));
  records(value.receipts, 60); unique(value.receipts); value.receipts.forEach((v) => parseOccurrenceReceipt(v, expected, triggerId));
  const leases = child(value, "policyLeases");
  requireData(leases?.version === "scheduled-policy-lease-outcomes:1" && typeof leases.available === "boolean" && leases.contentIncluded === false);
  records(leases.outcomes, 100);
  requireData(leases.available || leases.outcomes.length === 0);
  requireData(leases.outcomes.every((lease) => id(lease.leaseId) && lease.triggerId === triggerId && id(lease.occurrenceId) && digest(lease.leaseSha256) && member(lease.status, ["issued", "consumed", "expired"]) && lease.contentIncluded === false && lease.leaseGrantsAuthority === false));
  return value;
}
export type WorkflowActionKind = "plan" | "start" | "signal" | "schedule-create" | "schedule-control" | "inspect" | "tick" | "quarantine";
export type WorkflowReview = Readonly<{ kind: WorkflowActionKind; label: string; path: string; body: WorkflowObject; source: WorkflowSource; version: string; target?: WorkflowObject; idempotent?: boolean }>;
export function workflowReview(input: WorkflowReview): WorkflowReview {
  // Freeze the reviewed body/target, including nested policy and budget fields.
  const snapshot = JSON.parse(JSON.stringify(input)) as WorkflowReview;
  const freeze = (value: unknown): void => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(snapshot); return snapshot;
}
export function workflowReviewCurrent(review: WorkflowReview, read: WorkflowRead): boolean {
  return read.status === "ready" && stable(read.data) === review.version;
}
export function workflowSignals(value: unknown): WorkflowSignalType[] {
  return member(value, statuses) ? workflowControlSignals(value as WorkflowRunStatus) : [];
}
export function parseWorkflowReceipt(value: unknown, review: WorkflowReview, expected: WorkflowOwner): WorkflowObject {
  requireData(object(value)); const body = review.body; const target = review.target;
  if (review.kind === "plan") {
    const plan = parseWorkflowPlan(value.plan, expected);
    requireData(plan.goal === body.goal && child(plan, "plan")?.mode === body.mode);
  } else if (review.kind === "start") {
    const run = parseWorkflowRun(value.run, expected); const input = child(run, "input");
    requireData(input && run.goal === body.goal && input.mode === body.mode && input.planId === body.planId && (!body.requireApproval || run.approvalRequired));
    parseWorkflowDetail(value, String(run.id), expected);
  } else if (review.kind === "signal") {
    const run = parseWorkflowRun(value.run, expected); requireData(run.id === target?.id);
    const states: Record<string, string[]> = { pause: ["paused"], cancel: ["canceled"], resume: ["queued", "running"], approve: ["queued", "running"], retry: ["queued", "running"] };
    requireData(states[String(body.signal)]?.includes(String(run.status)));
    parseWorkflowDetail(value, String(run.id), expected);
  } else if (review.kind === "schedule-create") {
    const trigger = parseWorkflowTrigger(value.trigger, expected); const config = child(child(trigger, "schedule"), "config");
    requireData(trigger.name === body.name && trigger.replacesTriggerId === body.replacesTriggerId && config && child(config, "procedurePin")?.procedureId === body.procedureId && child(config, "agentIdentityPin")?.logicalAgentId === body.agentId);
    for (const field of ["timezone", "rrule", "maxOccurrences", "missedPolicy", "failureLimit", "authorityMode"]) requireData(config[field] === body[field]);
    requireData(Date.parse(String(config.startsAt)) === Date.parse(String(body.startsAt)) && stable(config.occurrenceBudget) === stable(body.occurrenceBudget));
    requireData((!config.endsAt && !body.endsAt) || Date.parse(String(config.endsAt)) === Date.parse(String(body.endsAt)));
  } else if (review.kind === "schedule-control") {
    if (body.action === "run_once") {
      requireData(object(value.occurrence)); parseOccurrence(value.occurrence, expected, String(target?.id));
      requireData(Date.parse(String(value.occurrence.scheduledFor)) === Math.floor(Date.parse(String(body.scheduledFor)) / 60_000) * 60_000);
    } else {
      const trigger = parseWorkflowTrigger(value.trigger, expected);
      requireData(trigger.id === target?.id && trigger.status === (body.action === "pause" ? "paused" : "active"));
      requireData(child(child(trigger, "schedule"), "config")?.configSha256 === child(child(target, "schedule"), "config")?.configSha256);
    }
  } else if (review.kind === "quarantine") {
    const job = child(value, "job"); requireData(job && job.id === target?.id && value.outcome === (body.action === "release" ? "released" : "discarded") && job.status === (body.action === "release" ? "queued" : "canceled"));
  } else if (review.kind === "inspect") {
    const report = child(value, "recovery"); requireData(report?.mode === "inspect" && date(report.inspectedAt) && report.limit === body.limit); records(report.staleWorkflows);
    requireData(report.expiredLeasesRepaired === 0 && report.requeuedWorkflows === 0 && report.failedWorkflows === 0);
  } else if (review.kind === "tick") {
    const queue = child(value, "queue"); requireData(queue && number(queue.leased) !== undefined && value.count === queue.leased && Number(queue.leased) <= Number(body.limit));
    for (const key of ["completed", "failed", "requeued"]) requireData(number(queue[key]) !== undefined);
  }
  return value;
}

export type WorkflowAttempt = { generation: number; review: WorkflowReview; idempotencyKey?: string };
/** Local exclusion and same-request retries. This does not invent server CAS for legacy controls. */
export function createWorkflowGate(key = () => crypto.randomUUID()) {
  let generation = 0; let mounted = true; let available = true; let active: WorkflowAttempt | undefined;
  const reads = new Map<string, AbortController>(); const retries = new Map<string, string>();
  const invalidateReads = () => { reads.forEach((controller) => controller.abort()); reads.clear(); };
  const fingerprint = (review: WorkflowReview) => stable([review.path, review.body]);
  return {
    mount() { mounted = true; },
    available(value: boolean) { available = value; if (!value) { invalidateReads(); active = undefined; generation += 1; } },
    read(name: string) { if (!mounted || !available || active) return undefined; reads.get(name)?.abort(); const controller = new AbortController(); reads.set(name, controller); return controller; },
    readCurrent(name: string, controller: AbortController) { return mounted && available && !controller.signal.aborted && reads.get(name) === controller; },
    readOwned(name: string, controller: AbortController) { return mounted && available && reads.get(name) === controller; },
    stopRead(name: string) { reads.get(name)?.abort(); reads.delete(name); },
    begin(review: WorkflowReview): WorkflowAttempt | undefined {
      if (!mounted || !available || active) return undefined;
      const identity = fingerprint(review); let idempotencyKey: string | undefined;
      if (review.idempotent) {
        idempotencyKey = retries.get(identity);
        if (!idempotencyKey) {
          if (retries.size >= 30) throw new Error("Thirty requests still have unconfirmed receipts. Retry an exact request or reconcile its status before starting another.");
          idempotencyKey = key(); retries.set(identity, idempotencyKey);
        }
      }
      invalidateReads(); active = { generation: ++generation, review, idempotencyKey }; return active;
    },
    current(attempt: WorkflowAttempt) { return mounted && available && active === attempt; },
    finish(attempt: WorkflowAttempt, confirmed = false) { if (!mounted || active !== attempt) return false; if (confirmed && attempt.idempotencyKey) retries.delete(fingerprint(attempt.review)); active = undefined; return true; },
    dispose() { mounted = false; active = undefined; generation += 1; invalidateReads(); },
  };
}
export async function workflowJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, cache: "no-store", headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(object(value) ? text(value.message, text(value.error, `Request failed (${response.status}).`)) : `Request failed (${response.status}).`);
  return value;
}
