import { describe, expect, it } from "vitest";
import { count, makeSubmission, parseReceipt, parseSource, retentionKeys, retrySupported, sloLabel } from "./operational-contracts";
const scope = { tenantId: "tenant-a", actorId: "actor-a" };
const stamp = "2026-10-04T12:00:00.000Z";
const digest = "a".repeat(64);
const policy = Object.fromEntries(retentionKeys.map((key) => [key, 30]));
const job = (status = "queued") => ({ id: "evaluation-job/opaque-long-id", type: "evaluation.run", status, createdAt: stamp, updatedAt: stamp, result: { evalRunId: "run-1" } });
const slo = (insufficient = false) => ({ checkedAt: stamp, healthy: true, policies: [{ id: "policy-1" }], evaluations: [{ policy: { id: "policy-1" }, breached: false, ...(insufficient ? { insufficientSamples: { samples: 2, minimumSamples: 10 } } : {}) }], breaches: [] });
const run = () => makeSubmission("run", { suite: "operator-console", maxSafetyMode: "synthetic" }, scope, "request-1");

describe("operational source truth", () => {
  it("keeps missing counts and health unavailable instead of zero or healthy", () => {
    expect(count(undefined)).toBe("Unavailable"); expect(count(0)).toBe("0"); expect(count(-1)).toBe("Unavailable");
    expect(sloLabel({})).toBe("Unavailable"); expect(sloLabel(slo(true))).toBe("Insufficient samples");
    expect(sloLabel({ healthy: true, evaluations: [] })).toBe("No enabled policy measurements");
  });
  it("accepts a real-shaped bounded empty evaluation snapshot but rejects incomplete success", () => {
    expect(parseSource("evaluations", { runs: [], cases: [], jobs: [], stats: { total: 0 } }, scope).runs).toEqual([]);
    expect(() => parseSource("evaluations", {}, scope)).toThrow();
    expect(() => parseSource("evaluations", { runs: [], cases: [], stats: {} }, scope)).toThrow();
  });
  it("rejects foreign tenant, duplicate identity, oversized lists, and changed security identity", () => {
    const body = { events: [{ id: "event-1", tenantId: scope.tenantId }], stats: {} };
    expect(parseSource("events", body, scope)).toEqual(body);
    expect(() => parseSource("events", { ...body, events: [{ id: "event-1", tenantId: "foreign" }] }, scope)).toThrow();
    expect(() => parseSource("events", { ...body, events: [body.events[0], body.events[0]] }, scope)).toThrow();
    expect(() => parseSource("events", { ...body, events: Array.from({ length: 25 }, (_, id) => ({ id: String(id) })) }, scope)).toThrow();
    expect(() => parseSource("context", { context: { ...scope, actorId: "other" }, policy: { rbacRules: {} } }, scope)).toThrow();
  });
  it("rejects contradictory SLO health and measurements without their policies", () => {
    expect(parseSource("slo", slo(true), scope).healthy).toBe(true);
    expect(() => parseSource("slo", { ...slo(), healthy: false }, scope)).toThrow();
    expect(() => parseSource("slo", { ...slo(), policies: [] }, scope)).toThrow();
    expect(() => parseSource("slo", { ...slo(), evaluations: [{ policy: { id: "other" }, breached: false }] }, scope)).toThrow();
  });
  it("requires every returned retention window and explicit backend state", () => {
    expect(parseSource("retention", { policy, backend: "bounded_local", automaticSweep: false }, scope).automaticSweep).toBe(false);
    expect(() => parseSource("retention", { policy: {}, backend: "postgres", automaticSweep: true }, scope)).toThrow();
    expect(() => parseSource("retention", { policy, backend: ["postgres"], automaticSweep: true }, scope)).toThrow();
  });
});

describe("frozen operational requests and bounded receipts", () => {
  it("preserves the exact body and key without adding mutation authority", () => {
    const draft = { suite: "  first-suite  ", maxSafetyMode: "mutation_allowed" };
    const request = makeSubmission("run", draft, scope, "stable-key"); draft.suite = "changed draft";
    expect(request.body).toEqual({ suite: "first-suite", maxSafetyMode: "mutation_allowed" });
    expect(request.body).not.toHaveProperty("allowMutation"); expect(request.key).toBe("stable-key"); expect(Object.isFrozen(request.body)).toBe(true);
  });
  it("copies the reviewed target so later source changes do not alter the preview", () => {
    const target = { policy: { ...policy }, backend: "postgres" };
    const submitted = makeSubmission("retention", {}, scope, "key", target); target.policy.runContentDays = 90;
    expect((submitted.target?.policy as Record<string, number>).runContentDays).toBe(30); expect(submitted.body).toEqual({ scope: "tenant" });
  });
  it("enforces current field bounds and does not introduce alert dispatch defaults", () => {
    expect(() => makeSubmission("review", { proposalId: "p", decision: "approved", reason: "short" }, scope, "key")).toThrow();
    expect(() => makeSubmission("marker", { message: "x".repeat(241), level: "info", category: "system" }, scope, "key")).toThrow();
    expect(makeSubmission("monitor", { queueAlerts: true, dispatchAlerts: false }, scope, "key").body).toEqual({ action: "run_monitor", queueAlerts: true, dispatchAlerts: false });
  });
  it("keeps every job outcome separate from an evaluation pass", () => {
    for (const status of ["queued", "running", "completed", "failed", "canceled"]) {
      const receipt = parseReceipt(run(), { job: job(status) });
      expect(receipt.status).toBe(status); expect(receipt.title).toBe("Evaluation request accepted"); expect(receipt.caveat).toContain("does not prove");
    }
  });
  it("rejects malformed or wrong-type evaluation acceptance", () => {
    for (const body of [{}, { job: {} }, { job: { ...job(), type: "agent.execute" } }, { job: { ...job(), status: ["completed"] } }]) expect(() => parseReceipt(run(), body)).toThrow();
  });
  it("binds a reviewed proposal to exact actor, tenant, version, decision and reason", () => {
    const submitted = makeSubmission("review", { proposalId: "proposal-1", decision: "approved", reason: "Reviewed exact change." }, scope, "key", { version: 2, proposalSha256: digest });
    const proposal = { id: "proposal-1", tenantId: scope.tenantId, status: "approved", reviewedBy: scope.actorId, reviewReason: "Reviewed exact change.", version: 2, proposalSha256: digest, reviewedAt: stamp };
    expect(parseReceipt(submitted, { proposal, applied: false }).status).toBe("approved");
    for (const changed of [{ reviewedBy: "other" }, { tenantId: "other" }, { id: "other" }, { version: 3 }, { reviewReason: "Different reason." }, { proposalSha256: "b".repeat(64) }]) expect(() => parseReceipt(submitted, { proposal: { ...proposal, ...changed }, applied: false })).toThrow();
    expect(() => parseReceipt(submitted, { proposal, applied: true })).toThrow();
  });
  it("binds replay case identity and preserves no inherited mutation authority", () => {
    const replayCase = { schemaVersion: 1, lane: "governed_evaluation", caseId: "case-1", caseDefinitionSha256: digest, replay: { mutationAuthority: "not_inherited" } };
    const submitted = makeSubmission("replay", { clusterId: "cluster-1" }, scope, "key", { replayCase });
    expect(parseReceipt(submitted, { job: job(), replayCase, mutationAuthorityInherited: false }).details).toContainEqual(["Replay case", "case-1"]);
    expect(() => parseReceipt(submitted, { job: job(), replayCase: { ...replayCase, caseId: "other" }, mutationAuthorityInherited: false })).toThrow();
    expect(() => parseReceipt(submitted, { job: job(), replayCase, mutationAuthorityInherited: true })).toThrow();
  });
  it("allows server-redacted marker text while requiring exact actor, category and level", () => {
    const submitted = makeSubmission("marker", { message: "A secret-shaped marker", level: "warn", category: "system" }, scope, "key");
    const event = { id: "marker-1", ...scope, action: "observability.marker", level: "warn", category: "system", message: "[REDACTED]", createdAt: stamp };
    expect(parseReceipt(submitted, { event }).details).toContainEqual(["message", "[REDACTED]"]);
    expect(() => parseReceipt(submitted, { event: { ...event, actorId: "other" } })).toThrow();
    expect(() => parseReceipt(submitted, { event: { ...event, level: "info" } })).toThrow();
  });
  it("requires separate dispatch results only when dispatch was submitted", () => {
    const result = { ...slo(true), trigger: "operator.api", actorId: scope.actorId, queuedAlerts: 0, incidentActions: [] };
    const submitted = makeSubmission("monitor", { queueAlerts: false, dispatchAlerts: true }, scope, "key");
    expect(() => parseReceipt(submitted, { result })).toThrow();
    expect(parseReceipt(submitted, { result, dispatch: { processed: [], delivered: 0, skipped: 0, failed: 0 } }).status).toBe("Insufficient samples");
    expect(() => parseReceipt(submitted, { result: { ...result, actorId: "other" }, dispatch: { processed: [], delivered: 0, skipped: 0, failed: 0 } })).toThrow();
  });
  it("confirms returned retention counts without claiming the read policy was locked", () => {
    const submitted = makeSubmission("retention", {}, scope, "key", { policy });
    const result = { scope: "tenant", tenantId: scope.tenantId, backend: "postgres", policy: { ...policy, runContentDays: 60 }, deleted: { runs: 4 }, batchLimit: 200, moreAvailable: true, completedAt: stamp };
    const receipt = parseReceipt(submitted, { result }); expect(receipt.status).toContain("more available"); expect(receipt.details).toContainEqual(["Applied policy · runContentDays", "60 days"]);
    expect(() => parseReceipt(submitted, { result: { ...result, scope: "all_tenants" } })).toThrow();
    expect(() => parseReceipt(submitted, { result: { ...result, tenantId: "other" } })).toThrow();
    expect(() => parseReceipt(submitted, { result: { ...result, deleted: { runs: -1 } } })).toThrow();
  });
  it("advertises retries only for existing idempotent or exact-review reconciliation contracts", () => {
    expect(["run", "review", "replay"].map((kind) => retrySupported(kind as "run"))).toEqual([true, true, true]);
    expect(retrySupported("marker")).toBe(false); expect(retrySupported("monitor")).toBe(false); expect(retrySupported("retention")).toBe(false);
  });
});
