import { describe, expect, it } from "vitest";
import { createWorkflowGate, number, parseWorkflowDetail, parseWorkflowReceipt, parseWorkflowScheduleDetail, parseWorkflowSource, stable, workflowReview, workflowReviewCurrent, workflowSignals, type WorkflowObject, type WorkflowReview } from "./workflows-workspace-state";

const owner = { tenantId: "tenant-test", actorId: "actor-test" };
const stamp = "2026-10-04T10:00:00.000Z";
const sha = "a".repeat(64);
function run(id = "run-exact", status = "queued") {
  return { id, tenantId: owner.tenantId, goal: "Inspect source evidence", status, input: { goal: "Inspect source evidence", mode: "orchestrate" }, approvalRequired: true, attempt: 0, maxAttempts: 3, createdAt: stamp, updatedAt: stamp };
}
function plan() { return { id: "plan-exact", tenantId: owner.tenantId, goal: "Inspect source evidence", status: "planned", plan: { mode: "orchestrate", summary: "Typed plan", nodes: [{ id: "node-exact", policy: "approval_required" }] }, validation: { isDag: true, missingDependencies: [], unreachableNodes: [], policyWarnings: [] }, approvalRequired: true, highestRiskLevel: 2, confidence: .8, updatedAt: stamp }; }
function trigger() {
  return { id: "schedule-exact", tenantId: owner.tenantId, ownerActorId: owner.actorId, name: "Morning check", triggerKind: "schedule", status: "active", updatedAt: stamp, schedule: { config: { schemaVersion: 1, timezone: "Asia/Kolkata", rrule: "FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0", startsAt: stamp, maxOccurrences: 20, missedPolicy: "skip", procedurePin: { schemaVersion: 1, procedureId: "procedure-exact", snapshotSha256: sha, reviewedSnapshotSha256: sha, reviewedAt: stamp }, agentIdentityPin: { logicalAgentId: "atlas", definitionVersion: 2 }, policyPinSha256: sha, occurrenceBudget: { toolCalls: 3 }, failureLimit: 3, authorityMode: "read_only", configSha256: sha }, state: { occurrenceCount: 0, consecutiveFailureCount: 0, circuitState: "closed" } } };
}
function detail() { const schedule = trigger(); return { trigger: schedule, preview: { triggerId: schedule.id, configurationSha256: sha, occurrences: [stamp] }, occurrences: [], receipts: [], policyLeases: { version: "scheduled-policy-lease-outcomes:1", available: false, outcomes: [], contentIncluded: false } }; }
function review(overrides: Partial<WorkflowReview> = {}) { return workflowReview({ kind: "start", label: "Start workflow", path: "/api/workflows", body: { goal: "Inspect source evidence", mode: "orchestrate", requireApproval: true }, source: "plans", version: stable({ plans: [plan()] }), idempotent: true, ...overrides }); }

describe("workflow operations read and receipt boundaries", () => {
  it("preserves successful empty separately from missing or malformed inventories", () => {
    expect(parseWorkflowSource("runs", { runs: [] }, owner).runs).toEqual([]);
    expect(() => parseWorkflowSource("runs", {}, owner)).toThrow();
    expect(() => parseWorkflowSource("plans", { plans: [null] }, owner)).toThrow();
    expect(number(undefined)).toBeUndefined(); expect(number("0")).toBeUndefined(); expect(number(0)).toBe(0);
  });
  it("rejects duplicated IDs, oversized windows, foreign tenant and non-primitive statuses", () => {
    expect(() => parseWorkflowSource("runs", { runs: [run(), run()] }, owner)).toThrow();
    expect(() => parseWorkflowSource("runs", { runs: Array.from({ length: 17 }, (_, n) => run(`r-${n}`)) }, owner)).toThrow();
    expect(() => parseWorkflowSource("runs", { runs: [{ ...run(), tenantId: "other" }] }, owner)).toThrow();
    expect(() => parseWorkflowSource("runs", { runs: [{ ...run(), status: ["queued"] }] }, owner)).toThrow();
  });
  it("binds every detail step and event to the exact run", () => {
    expect(parseWorkflowDetail({ run: run(), steps: [], events: [] }, "run-exact", owner).run).toEqual(run());
    expect(() => parseWorkflowDetail({ run: run(), steps: [], events: [{ id: "event", workflowRunId: "different" }] }, "run-exact", owner)).toThrow();
    expect(() => parseWorkflowDetail({ run: run(), steps: [], events: [] }, "other", owner)).toThrow();
  });
  it("keeps current controls tied to legacy state rather than claimed outcome", () => {
    expect(workflowSignals("waiting_approval")).toEqual(["approve", "cancel"]);
    expect(workflowSignals("failed")).toEqual(["retry"]);
    expect(workflowSignals("completed")).toEqual([]);
    expect(workflowSignals(["running"])).toEqual([]);
  });
  it("validates schedule owner and exact preview configuration", () => {
    expect(parseWorkflowScheduleDetail(detail(), "schedule-exact", owner).policyLeases).toMatchObject({ available: false, outcomes: [] });
    expect(() => parseWorkflowScheduleDetail({ ...detail(), trigger: { ...trigger(), ownerActorId: "other" } }, "schedule-exact", owner)).toThrow();
    expect(() => parseWorkflowScheduleDetail({ ...detail(), preview: { ...detail().preview, configurationSha256: "b".repeat(64) } }, "schedule-exact", owner)).toThrow();
  });
  it("does not treat a lease read failure as empty or accept foreign lease bindings", () => {
    const value = detail();
    expect(() => parseWorkflowScheduleDetail({ ...value, policyLeases: { ...value.policyLeases, outcomes: [{ leaseId: "lease", triggerId: "other", occurrenceId: "occurrence", leaseSha256: sha, status: "issued", contentIncluded: false, leaseGrantsAuthority: false }] } }, "schedule-exact", owner)).toThrow();
    expect(() => parseWorkflowScheduleDetail({ ...value, policyLeases: undefined }, "schedule-exact", owner)).toThrow();
  });
  it("requires exact plan goal and mode without claiming its success as execution", () => {
    const preview = review({ kind: "plan", path: "/api/workflows/plan", idempotent: false });
    expect(parseWorkflowReceipt({ plan: plan() }, preview, owner)).toHaveProperty("plan");
    expect(() => parseWorkflowReceipt({ plan: { ...plan(), goal: "Another goal" } }, preview, owner)).toThrow();
  });
  it("binds a started run to the reviewed goal, plan and approval posture", () => {
    const target = review({ body: { ...review().body, planId: "plan-exact" } });
    const started = { ...run(), input: { ...run().input, planId: "plan-exact" } };
    expect(parseWorkflowReceipt({ run: started, steps: [], events: [] }, target, owner)).toHaveProperty("run");
    expect(() => parseWorkflowReceipt({ run: { ...started, approvalRequired: false }, steps: [], events: [] }, target, owner)).toThrow();
    expect(() => parseWorkflowReceipt({ run: run(), steps: [], events: [] }, target, owner)).toThrow();
  });
  it("rejects a different run or unconfirmed signal state", () => {
    const target = review({ kind: "signal", path: "/api/workflows/run-exact/signal", body: { signal: "pause" }, target: run() });
    expect(parseWorkflowReceipt({ run: run("run-exact", "paused"), steps: [], events: [] }, target, owner)).toHaveProperty("run");
    expect(() => parseWorkflowReceipt({ run: run("other", "paused"), steps: [], events: [] }, target, owner)).toThrow();
    expect(() => parseWorkflowReceipt({ run: run(), steps: [], events: [] }, target, owner)).toThrow();
  });
  it("matches exact schedule creation timing, replacement and budget", () => {
    const stored = trigger(); const config = stored.schedule.config;
    const target = review({ kind: "schedule-create", body: { name: stored.name, procedureId: "procedure-exact", agentId: "atlas", timezone: config.timezone, rrule: config.rrule, startsAt: stamp, maxOccurrences: 20, missedPolicy: "skip", failureLimit: 3, occurrenceBudget: { toolCalls: 3 }, authorityMode: "read_only" } });
    expect(parseWorkflowReceipt({ trigger: stored }, target, owner)).toHaveProperty("trigger");
    expect(() => parseWorkflowReceipt({ trigger: { ...stored, schedule: { ...stored.schedule, config: { ...config, occurrenceBudget: { toolCalls: 4 } } } } }, target, owner)).toThrow();
    expect(() => parseWorkflowReceipt({ trigger: { ...stored, replacesTriggerId: "other" } }, target, owner)).toThrow();
  });
  it("checks run-once receipt minute normalization and exact schedule", () => {
    const target = review({ kind: "schedule-control", body: { action: "run_once", scheduledFor: "2026-10-04T10:00:35.000Z" }, target: trigger() });
    const occurrence = { id: "occurrence", tenantId: owner.tenantId, ownerActorId: owner.actorId, triggerId: "schedule-exact", status: "enqueued", scheduledFor: stamp, authoritySha256: sha };
    expect(parseWorkflowReceipt({ occurrence }, target, owner)).toHaveProperty("occurrence");
    expect(() => parseWorkflowReceipt({ occurrence: { ...occurrence, scheduledFor: "2026-10-04T10:01:00.000Z" } }, target, owner)).toThrow();
  });
  it("does not upgrade a quarantine error, inspect repair, or unrelated tick to success", () => {
    const quarantine = review({ kind: "quarantine", body: { action: "release" }, target: { id: "job" } });
    expect(parseWorkflowReceipt({ outcome: "released", job: { id: "job", status: "queued" } }, quarantine, owner)).toHaveProperty("job");
    expect(() => parseWorkflowReceipt({ outcome: "owned_by_run", job: { id: "job", status: "quarantined" } }, quarantine, owner)).toThrow();
    const inspect = review({ kind: "inspect", body: { action: "inspect_recovery", limit: 10 } });
    expect(() => parseWorkflowReceipt({ recovery: { mode: "repair", inspectedAt: stamp, limit: 10, staleWorkflows: [] } }, inspect, owner)).toThrow();
    const tick = review({ kind: "tick", body: { limit: 1 } });
    expect(() => parseWorkflowReceipt({ count: 2, queue: { leased: 2, completed: 0, failed: 0, requeued: 0 } }, tick, owner)).toThrow();
  });
});

describe("workflow reviewed action lifecycle", () => {
  it("deep-freezes reviewed payloads and invalidates stale/unavailable sources", () => {
    const budget = { toolCalls: 3 }; const target = review({ body: { budget } }); budget.toolCalls = 90;
    expect((target.body.budget as WorkflowObject).toolCalls).toBe(3);
    expect(Object.isFrozen(target.body.budget)).toBe(true);
    const read = { status: "ready" as const, data: { plans: [plan()] } };
    expect(workflowReviewCurrent(target, read)).toBe(true);
    expect(workflowReviewCurrent(target, { ...read, status: "error" })).toBe(false);
    expect(workflowReviewCurrent(target, { ...read, data: { plans: [] } })).toBe(false);
  });
  it("fences replaced reads, timeouts, effects and disposed scopes", () => {
    const gate = createWorkflowGate(); const first = gate.read("runs")!; const second = gate.read("runs")!;
    expect(first.signal.aborted).toBe(true); expect(gate.readCurrent("runs", first)).toBe(false);
    second.abort(); expect(gate.readCurrent("runs", second)).toBe(false); expect(gate.readOwned("runs", second)).toBe(true);
    const third = gate.read("runs")!; const action = gate.begin(review())!;
    expect(third.signal.aborted).toBe(true); expect(gate.read("plans")).toBeUndefined(); expect(gate.begin(review())).toBeUndefined();
    gate.dispose(); expect(gate.current(action)).toBe(false); expect(gate.finish(action, true)).toBe(false); expect(gate.readOwned("runs", third)).toBe(false);
  });
  it("reuses an uncertain exact-request key and never lets old completions release the new slot", () => {
    let n = 0; const gate = createWorkflowGate(() => `key-${++n}`); const a = gate.begin(review())!;
    gate.finish(a); const b = gate.begin(review())!; expect(b.idempotencyKey).toBe(a.idempotencyKey);
    expect(gate.finish(a, true)).toBe(false); expect(gate.current(b)).toBe(true);
    gate.finish(b, true); const c = gate.begin(review())!; expect(c.idempotencyKey).not.toBe(a.idempotencyKey);
  });
  it("retains every uncertain key at capacity and frees a slot only on matching confirmed receipt", () => {
    let n = 0; const gate = createWorkflowGate(() => `key-${++n}`);
    const targets = Array.from({ length: 30 }, (_, i) => review({ body: { goal: `Goal ${i}` } }));
    const keys = targets.map((target) => { const action = gate.begin(target)!; gate.finish(action); return action.idempotencyKey; });
    for (let i = 30; i < 35; i += 1) expect(() => gate.begin(review({ body: { goal: `Goal ${i}` } }))).toThrow(/Thirty/);
    targets.forEach((target, i) => { const action = gate.begin(target)!; expect(action.idempotencyKey).toBe(keys[i]); gate.finish(action, i === 0); });
    expect(gate.begin(review({ body: { goal: "New distinct goal" } }))).toBeDefined();
  });
  it("does not pretend non-idempotent legacy controls acquired durable replay", () => {
    let calls = 0; const gate = createWorkflowGate(() => { calls += 1; return "key"; });
    const action = gate.begin(review({ kind: "signal", idempotent: false }))!;
    expect(action.idempotencyKey).toBeUndefined(); expect(calls).toBe(0);
    gate.available(false); expect(gate.current(action)).toBe(false); expect(gate.read("runs")).toBeUndefined();
    gate.available(true); expect(gate.begin(review({ idempotent: false }))).toBeDefined();
  });
});
