import { describe, expect, it } from "vitest";
import { improvementActionReceipt, improvementDiffHref, improvementHoldMessage, improvementRequiresManualRelease, improvementReviewInput, parseImprovementSnapshot } from "./self-improvement-workspace-state";

const hash = "a".repeat(64), candidateHash = "b".repeat(64), validationHash = "c".repeat(64);
const base = "1".repeat(40), candidate = "2".repeat(40), now = "2026-10-26T03:00:00.000Z";
const owner = { tenantId: "tenant_a", ownerActorId: "actor:owner" };
const repository = { owner: "benniejoseph", name: "omniagentos", defaultBranch: "main" };
const policy = { dailyBudgetUsd: 5, autoReleaseRoutineChanges: true, policySha256: hash };
function fixture() {
  const configuration = { ...owner, id: "config_1", projectId: "project_1", repositoryId: "123", repository, policy, generation: 1, nextDueAt: now, paused: false, timeZone: "Asia/Kolkata", dailyHour: 3, updatedAt: now };
  const cycle = {
    id: "cycle_1", configurationId: configuration.id, projectId: configuration.projectId, revision: 4,
    scope: { ...owner, repository, baseRevision: base }, policy, stage: "review_required", phase: "release_wait", summary: "Repair the project title truncation.", spendUsd: 0.45, usageState: "known",
    candidate: { revision: candidate, candidateSha256: candidateHash, workspaceSha256: hash, changedFiles: [{ path: "src/components/project-title.tsx" }], changedLines: 12 },
    validation: { validationSha256: validationHash, candidateSha256: candidateHash, candidateRevision: candidate, workspaceSha256: hash,
      checks: ["focused_regression", "adjacent_regression", "typecheck", "independent_review"].map((kind) => ({ id: kind, kind, outcome: "passed", candidateRevision: candidate, workspaceSha256: hash, executedCases: 1, failedCases: 0, declaredCases: 1 })),
      baselineReproduction: { executedCases: 1, failedCases: 1 } },
    classification: { disposition: "review_required", reasons: ["automatic_release_disabled"] }, agentRuns: [], pullRequestUrl: "https://github.com/benniejoseph/omniagentos/pull/1", createdAt: now, updatedAt: now, releaseReceipt: null,
  };
  return { configurations: [configuration], cycles: [cycle], github: { configured: true, missing: [] }, controller: { status: "offline", lastSeenAt: now } };
}

describe("Self-improvement workspace evidence and exact actions", () => {
  it("retains truthful controller and validation state with an immutable exact diff link", () => {
    const result = parseImprovementSnapshot(fixture(), owner.tenantId);
    expect(result.controller?.status).toBe("offline");
    expect(result.cycles[0].validation?.checks[0].executedCases).toBe(1);
    expect(improvementDiffHref(result.cycles[0])).toBe(`https://github.com/benniejoseph/omniagentos/compare/${base}...${candidate}`);
    expect(parseImprovementSnapshot({ ...fixture(), controller: undefined }).controller).toBeUndefined();
    const held = fixture();
    const resultWithHold = parseImprovementSnapshot({ ...held, cycles: [{ ...held.cycles[0], controllerHold: { category: "release_usage_unconfirmed", occurredAt: now } }] });
    expect(improvementHoldMessage(resultWithHold.cycles[0].controllerHold!.category)).toContain("not been reconciled");
    expect(improvementHoldMessage("candidate_drift")).toContain("candidate drift");
  });
  it("retains a silent cycle policy and requires its settings receipt to match", () => {
    const legacy = fixture();
    expect(parseImprovementSnapshot(legacy).configurations[0].policy.notifyOutcomes).toBe(true);
    const snapshot = parseImprovementSnapshot({ ...legacy,
      configurations: [{ ...legacy.configurations[0], policy: { ...policy, notifyOutcomes: false } }],
      cycles: [{ ...legacy.cycles[0], policy: { ...policy, notifyOutcomes: false } }],
    });
    const configuration = snapshot.configurations[0];
    expect(configuration.policy.notifyOutcomes).toBe(false);
    expect(snapshot.cycles[0].policy.notifyOutcomes).toBe(false);
    const input = { projectId: configuration.projectId, repositoryId: configuration.repositoryId,
      dailyBudgetUsd: 6, dailyHour: configuration.dailyHour, timeZone: configuration.timeZone,
      autoReleaseRoutineChanges: configuration.policy.autoReleaseRoutineChanges, notifyOutcomes: configuration.policy.notifyOutcomes,
      expectedGeneration: configuration.generation };
    const saved = { ...configuration, generation: 2, policy: { ...configuration.policy, dailyBudgetUsd: 6 } };
    expect(improvementActionReceipt("configure", input, { configuration: saved })).toContain("saved");
    expect(() => improvementActionReceipt("configure", input, { configuration: { ...saved, policy: { ...saved.policy, notifyOutcomes: true } } })).toThrow(/exact change/);
  });
  it("rejects cross-workspace and cross-owner records, duplicate identities and mismatched evidence", () => {
    expect(() => parseImprovementSnapshot(fixture(), "another_tenant")).toThrow(/workspace/);
    const otherOwner = fixture(); otherOwner.cycles[0].scope.ownerActorId = "actor:other";
    expect(() => parseImprovementSnapshot(otherOwner)).toThrow(/workspace/);
    const duplicate = fixture(); duplicate.cycles.push(duplicate.cycles[0]);
    expect(() => parseImprovementSnapshot(duplicate)).toThrow(/duplicate/);
    const oldEvidence = fixture(); oldEvidence.cycles[0].validation.candidateRevision = base;
    expect(() => parseImprovementSnapshot(oldEvidence)).toThrow(/different candidate/);
    const inventedCounts = fixture(); inventedCounts.cycles[0].validation.checks[0].executedCases = 0;
    expect(() => parseImprovementSnapshot(inventedCounts)).toThrow(/counts/);
    const unprovenRelease = fixture(); unprovenRelease.cycles[0].stage = "succeeded";
    expect(() => parseImprovementSnapshot(unprovenRelease)).toThrow(/production receipts/);
  });
  it("binds approval to the current revision and refuses incomplete checks", () => {
    const cycle = parseImprovementSnapshot(fixture()).cycles[0];
    expect(improvementReviewInput(cycle, "approve")).toEqual({ cycleId: cycle.id, expectedRevision: 4, candidateSha256: candidateHash, validationSha256: validationHash, decision: "approve" });
    cycle.validation!.checks.pop();
    expect(() => improvementReviewInput(cycle, "approve")).toThrow(/complete passing/);
    expect(improvementReviewInput(cycle, "reject").decision).toBe("reject");
    cycle.stage = "ready_for_release";
    expect(() => improvementReviewInput(cycle, "approve")).toThrow(/no longer/);
  });
  it("distinguishes an approved protected candidate from automatic release eligibility", () => {
    const baseCycle = fixture().cycles[0];
    const snapshot = parseImprovementSnapshot({ ...fixture(), cycles: [{ ...baseCycle, releaseEligibility: "manual_release" }] });
    const cycle = snapshot.cycles[0], input = improvementReviewInput(cycle, "approve");
    expect(improvementRequiresManualRelease(cycle)).toBe(true);
    const approved = { ...cycle, revision: 5, stage: "ready_for_release", controllerHold: { category: "manual_operator_release_required", occurredAt: now } };
    expect(improvementActionReceipt("review", input, { cycle: approved, manualReleaseRequired: true })).toContain("needs a trusted manual release");
    expect(improvementHoldMessage(approved.controllerHold.category)).toContain("protected code");
    expect(improvementRequiresManualRelease({ ...cycle, releaseEligibility: "owner_review" })).toBe(false);
  });
  it("renews only server-admitted expired approvals for the same validated candidate", () => {
    const cycle = parseImprovementSnapshot(fixture()).cycles[0];
    cycle.stage = "ready_for_release";
    cycle.approvalExpired = true;
    expect(() => improvementReviewInput(cycle, "approve")).toThrow(/no longer/);
    cycle.approvalRenewalAvailable = true;
    expect(improvementReviewInput(cycle, "approve")).toEqual({ cycleId: cycle.id, expectedRevision: cycle.revision, candidateSha256: candidateHash, validationSha256: validationHash, decision: "approve" });
    expect(improvementReviewInput(cycle, "reject").decision).toBe("reject");
    cycle.approvalExpired = false;
    expect(() => improvementReviewInput(cycle, "approve")).toThrow(/no longer/);
    cycle.approvalExpired = true; cycle.stage = "releasing";
    expect(() => improvementReviewInput(cycle, "approve")).toThrow(/no longer/);
  });
  it("does not present another action's response or an ambiguous run as success", () => {
    const snapshot = fixture(), configuration = snapshot.configurations[0];
    const input = { configurationId: configuration.id, expectedGeneration: 1, paused: true };
    expect(improvementActionReceipt("pause", input, { configuration: { ...configuration, generation: 2, paused: true } })).toContain("paused");
    expect(() => improvementActionReceipt("pause", input, { configuration: { ...configuration, id: "config_other", generation: 2, paused: true } })).toThrow(/exact change/);
    expect(() => improvementActionReceipt("pause", input, { configuration: { ...configuration, paused: true } })).toThrow(/exact change/);
    expect(() => improvementActionReceipt("run", { configurationId: configuration.id }, { outcome: "claimed" })).toThrow();
    expect(improvementActionReceipt("run", input, { outcome: "budget_exhausted" })).toContain("No new cycle");
    expect(() => improvementActionReceipt("review", { cycleId: "cycle_1", expectedRevision: 4, candidateSha256: candidateHash, validationSha256: validationHash, decision: "approve" }, { cycle: { ...snapshot.cycles[0], revision: 5, stage: "cancelled" } })).toThrow(/exact candidate/);
  });
});
