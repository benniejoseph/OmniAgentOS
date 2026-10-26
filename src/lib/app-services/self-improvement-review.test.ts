import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServiceCaller } from "./contracts";
import type { StoredSelfImprovementCycle } from "@/lib/self-improvement/store";
import { sealEngineeringSignal } from "@/lib/self-improvement/evidence";
import { sealSelfImprovementApproval, sealSelfImprovementCandidate, sealSelfImprovementValidation, selfImprovementApprovalSchema } from "@/lib/self-improvement/contracts";
import { assertSelfImprovementCycleIntegrity, createSelfImprovementPolicy } from "@/lib/self-improvement/policy";
import { publicSelfImprovementCycle, reviewSelfImprovementService } from "./self-improvement";
const owner = { tenantId: "candidate", ownerActorId: "actor:11111111-1111-4111-8111-111111111111" };
const mock = vi.hoisted(() => ({ get: vi.fn(), renew: vi.fn(), reviewExpired: vi.fn(), discard: vi.fn(), transition: vi.fn(), hold: vi.fn(), yieldLease: vi.fn() }));
vi.mock("./contracts", () => ({ appServiceActorBinding: () => ({ canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" }), authorizeAppServiceCall: () => ({}), completeAppServiceCall: (_call: unknown, data: unknown) => data }));
vi.mock("@/lib/self-improvement/store", async original => ({ ...await original<typeof import("@/lib/self-improvement/store")>(), getSelfImprovementCycle: mock.get, renewSelfImprovementCycleLease: mock.renew, reviewExpiredSelfImprovementApproval: mock.reviewExpired, discardHeldSelfImprovementCandidate: mock.discard, transitionSelfImprovementCycle: mock.transition, holdSelfImprovementRelease: mock.hold, releaseSelfImprovementExecutionLease: mock.yieldLease }));
vi.mock("@/lib/self-improvement/scheduler", () => ({ enqueueSelfImprovementCycle: vi.fn() }));
const caller = { context: { tenantId: owner.tenantId, actorId: owner.ownerActorId, role: "admin", source: "session" }, idempotencyKey: "owner-review" } as AppServiceCaller;
const digest = (value: string) => value.repeat(64);
function fixture(path: string, architectureImpact: "minor" | "major"): StoredSelfImprovementCycle {
  const now = new Date().toISOString(), scope = { ...owner, repository: { owner: "asael", name: "app", defaultBranch: "main" }, baseRevision: "a".repeat(40) }, policy = createSelfImprovementPolicy({ maxCycleBudgetUsd: 100 });
  const signal = sealEngineeringSignal({ version: 1, scope, kind: "owner_correction", symptomSha256: digest("a"), summary: "Repair saved behavior", observations: [{ sourceKind: "owner_feedback", sourceId: "feedback", sourceSha256: digest("b"), observedAt: now, outcome: "needs_work" }] });
  const candidate = sealSelfImprovementCandidate({ revision: "b".repeat(40), workspaceSha256: digest("c"), diffSha256: digest("d"), changedFiles: [{ path, beforeSha256: digest("e"), afterSha256: digest("f") }], changedLines: 20, architectureImpact });
  const validation = sealSelfImprovementValidation({ scope, policySha256: policy.policySha256, signalSha256: signal.signalSha256, candidateSha256: candidate.candidateSha256, candidateRevision: candidate.revision, workspaceSha256: candidate.workspaceSha256,
    checks: (["focused_regression", "adjacent_regression", "typecheck", "independent_review"] as const).map(kind => ({ id: kind, kind, outcome: "passed", producerKind: kind === "independent_review" ? "agent_review" : "command", producerId: kind, candidateRevision: candidate.revision, workspaceSha256: candidate.workspaceSha256, evidenceSha256: digest("a"), declaredCases: 1, executedCases: 1, failedCases: 0, completedAt: now })) });
  return { cycle: { id: "cycle", scope, policy, stage: "review_required", revision: 4, signal, candidate, validation, approval: null, release: null, releaseReceipt: null, correctionsUsed: 0, dailyReservationUsd: 100, createdAt: now, updatedAt: now }, configurationId: "configuration", configurationGeneration: 1, projectId: "project", repositoryId: "42", day: now.slice(0,10), leaseExpiresAt: now, runtime: {}, spendUsd: 1, usageState: "known", controllerId: null, controllerHold: null };
}
beforeEach(() => { for (const fn of Object.values(mock)) fn.mockReset(); });
async function exercise(stored: StoredSelfImprovementCycle, decision: "approve" | "reject", requestCaller = caller) {
  const expectedRevision = stored.cycle.revision;
  mock.get.mockImplementation(async () => stored);
  mock.renew.mockImplementation(async () => { stored = { ...stored, cycle: { ...stored.cycle, revision: stored.cycle.revision+1 }, leaseToken: "private" }; return stored; });
  mock.transition.mockImplementation(async input => { stored = { ...stored, cycle: { ...stored.cycle, ...input.patch, revision: stored.cycle.revision+1, stage: input.nextStage, updatedAt: new Date().toISOString() } }; assertSelfImprovementCycleIntegrity(stored.cycle); return stored; });
  mock.hold.mockImplementation(async input => { stored = { ...stored, cycle: { ...stored.cycle, revision: stored.cycle.revision+1 }, controllerHold: { category: input.category, occurredAt: new Date().toISOString() } }; return stored; });
  mock.yieldLease.mockImplementation(async input => { expect(input.expectedRevision).toBe(stored.cycle.revision); return { ...stored, leaseToken: undefined }; });
  mock.reviewExpired.mockImplementation(async input => { stored = { ...stored, cycle: { ...stored.cycle, revision: stored.cycle.revision+1, approval: input.approval || null,
    stage: input.decision === "approve" ? "ready_for_release" : "cancelled", updatedAt: new Date().toISOString() } }; assertSelfImprovementCycleIntegrity(stored.cycle); return stored; });
  mock.discard.mockImplementation(async () => { stored = { ...stored, cycle: { ...stored.cycle, stage: "cancelled", revision: stored.cycle.revision+1, updatedAt: new Date().toISOString() } }; assertSelfImprovementCycleIntegrity(stored.cycle); return stored; });
  return reviewSelfImprovementService(requestCaller, { cycleId: stored.cycle.id, expectedRevision, candidateSha256: stored.cycle.candidate!.candidateSha256, validationSha256: stored.cycle.validation!.validationSha256, decision });
}
describe("owner review release routing", () => {
  it("persists protected approval as a manual handoff before yielding its latest lease", async () => {
    const result = await exercise(fixture("src/proxy.ts", "minor"), "approve");
    expect(result).toMatchObject({ manualReleaseRequired: true, cycle: { controllerHold: { category: "manual_operator_release_required" } } });
    expect(mock.hold).toHaveBeenCalledOnce(); expect(mock.yieldLease).toHaveBeenCalledOnce();
  });
  it("carries exact owner approval for a major ordinary application change", async () => {
    const result = await exercise(fixture("src/lib/studio/graph.ts", "major"), "approve") as unknown as { cycle: { approval: unknown } };
    expect(selfImprovementApprovalSchema.parse(result.cycle.approval)).toMatchObject({ ...owner, decision: "approved" });
    expect(mock.hold).not.toHaveBeenCalled(); expect(mock.yieldLease).toHaveBeenCalledOnce();
  });
  it("cancels a rejected candidate without issuing approval or release work", async () => {
    const result = await exercise(fixture("src/proxy.ts", "minor"), "reject");
    expect(result).toMatchObject({ manualReleaseRequired: false, cycle: { stage: "cancelled", approval: null } });
    expect(mock.hold).not.toHaveBeenCalled(); expect(mock.yieldLease).not.toHaveBeenCalled();
  });
  it("renews the same expired unclaimed candidate without replaying coding or claiming execution", async () => {
    let stored = fixture("src/lib/studio/graph.ts", "major");
    const approvedAt = new Date(Date.now()-120_000).toISOString(), expiresAt = new Date(Date.now()-60_000).toISOString();
    stored = { ...stored, cycle: { ...stored.cycle, stage: "ready_for_release", createdAt: approvedAt, updatedAt: approvedAt,
      approval: sealSelfImprovementApproval({ approvalId: "earlier", ...owner, candidateSha256: stored.cycle.candidate!.candidateSha256,
        policySha256: stored.cycle.policy.policySha256, validationSha256: stored.cycle.validation!.validationSha256, decision: "approved", approvedAt, expiresAt }) } };
    expect(publicSelfImprovementCycle(stored)).toMatchObject({ approvalExpired: true, approvalRenewalAvailable: true, releaseEligibility: "owner_review" });
    const result = await exercise(stored, "approve");
    expect(result).toMatchObject({ cycle: { stage: "ready_for_release", approvalExpired: false, approvalRenewalAvailable: false, candidate: stored.cycle.candidate, validation: stored.cycle.validation } });
    expect(mock.reviewExpired).toHaveBeenCalledOnce(); expect(mock.renew).not.toHaveBeenCalled(); expect(mock.transition).not.toHaveBeenCalled();
    await expect(exercise({ ...stored, controllerId: "claimed" }, "approve")).rejects.toThrow(/no longer current/);
    expect(publicSelfImprovementCycle({ ...stored, controllerId: "claimed" }).approvalRenewalAvailable).toBe(false);
  });
  it.each(["base_revision_changed", "manual_operator_release_required"])("lets the owner discard an unclaimed %s hold without starting any work", async category => {
    const original = fixture("src/lib/studio/graph.ts", "minor"), stored: StoredSelfImprovementCycle = { ...original,
      cycle: { ...original.cycle, stage: "ready_for_release" }, controllerHold: { category, occurredAt: original.cycle.updatedAt } };
    expect(publicSelfImprovementCycle(stored).discardAvailable).toBe(true);
    const result = await exercise(stored, "reject");
    expect(result).toMatchObject({ manualReleaseRequired: false, cycle: { stage: "cancelled", discardAvailable: false,
      candidate: stored.cycle.candidate, validation: stored.cycle.validation, controllerHold: stored.controllerHold } });
    expect(mock.discard).toHaveBeenCalledWith(expect.objectContaining({ owner, cycleId: stored.cycle.id, expectedRevision: stored.cycle.revision,
      candidateSha256: stored.cycle.candidate!.candidateSha256, validationSha256: stored.cycle.validation!.validationSha256 }));
    expect(mock.renew).not.toHaveBeenCalled(); expect(mock.transition).not.toHaveBeenCalled(); expect(mock.yieldLease).not.toHaveBeenCalled();
  });
  it("never offers or performs discard for a claimed, releasing, active or uncertain held candidate", async () => {
    const original = fixture("src/lib/studio/graph.ts", "minor"), held: StoredSelfImprovementCycle = { ...original,
      cycle: { ...original.cycle, stage: "ready_for_release" }, controllerHold: { category: "base_revision_changed", occurredAt: original.cycle.updatedAt } };
    for (const stored of [{ ...held, controllerId: "controller" }, { ...held, usageState: "unknown" as const },
      { ...held, leaseExpiresAt: new Date(Date.now()+60_000).toISOString() }, { ...held, cycle: { ...held.cycle, stage: "releasing" as const } }]) {
      expect(publicSelfImprovementCycle(stored).discardAvailable).toBe(false);
      await expect(exercise(stored, "reject")).rejects.toThrow(/no longer current/);
    }
    await expect(exercise(held, "approve")).rejects.toThrow(/no longer current/);
    await expect(exercise(held, "reject", { ...caller, context: { ...caller.context, role: "operator" } })).rejects.toThrow(/authenticated application owner/);
    await expect(exercise(held, "reject", { ...caller, context: { ...caller.context, source: "service" } })).rejects.toThrow(/authenticated application owner/);
    expect(mock.discard).not.toHaveBeenCalled(); expect(mock.renew).not.toHaveBeenCalled();
  });
});
