import { describe, expect, it } from "vitest";
import { sealEngineeringSignal, selectEngineeringSignal, collectEngineeringSignalsFromRuns } from "./evidence";
import { createSelfImprovementPolicy, classifySelfImprovementChange, assertSelfImprovementCycleTransition, assertSelfImprovementCycleIntegrity } from "./policy";
import { selfImprovementPolicySchema, sealSelfImprovementApproval, sealSelfImprovementCandidate, sealSelfImprovementValidation, sealSelfImprovementReleaseBinding, type SelfImprovementCycle } from "./contracts";
import type { AgentRunRecord } from "@/lib/runs/types";
import type { ToolExecutionRecord } from "@/lib/tools/types";
const sha = (letter: string) => letter.repeat(64);
const scope = { tenantId: "tenant", ownerActorId: "owner", repository: { owner: "asael", name: "app", defaultBranch: "main" }, baseRevision: "a".repeat(40) };
const now = "2026-10-26T12:00:00.000Z";
const policy = createSelfImprovementPolicy({});
const candidate = (path = "src/lib/studio/graph.ts") => sealSelfImprovementCandidate({ revision: "b".repeat(40), workspaceSha256: sha("c"), diffSha256: sha("d"), changedFiles: [{ path, beforeSha256: sha("a"), afterSha256: sha("b") }], changedLines: 12, architectureImpact: "minor" });
const signal = () => sealEngineeringSignal({ version: 1, scope, kind: "owner_correction", summary: "The saved title is missing.", symptomSha256: sha("e"), observations: [{ sourceKind: "owner_feedback", sourceId: "run1", sourceSha256: sha("f"), observedAt: now, outcome: "needs_work" }] });
const validation = () => sealSelfImprovementValidation({ scope, policySha256: policy.policySha256, signalSha256: signal().signalSha256, candidateSha256: candidate().candidateSha256, candidateRevision: candidate().revision, workspaceSha256: candidate().workspaceSha256,
  checks: (["focused_regression", "adjacent_regression", "typecheck", "independent_review"] as const).map((kind) => ({ id: kind, kind, outcome: "passed", producerKind: kind === "independent_review" ? "agent_review" : "command", producerId: `receipt:${kind}`, candidateRevision: candidate().revision, workspaceSha256: candidate().workspaceSha256, evidenceSha256: sha("e"), declaredCases: 1, executedCases: 1, failedCases: 0, completedAt: now })) });
const cycle = (): SelfImprovementCycle => ({ id: "cycle", scope, policy, stage: "validating", revision: 1, signal: signal(), candidate: candidate(), validation: validation(), approval: null, release: null, releaseReceipt: null, correctionsUsed: 0, dailyReservationUsd: 100, createdAt: now, updatedAt: now });
describe("self-improvement release boundaries", () => {
  it("rejects policy drift and spending above the ceiling", () => {
    expect(() => createSelfImprovementPolicy({ dailyBudgetUsd: 100.01 })).toThrow();
    expect(selfImprovementPolicySchema.safeParse({ ...policy, maxCorrections: 2 }).success).toBe(false);
    expect(selfImprovementPolicySchema.safeParse({ ...policy, dailyBudgetUsd: 99 }).success).toBe(false);
  });
  it("seals the per-cycle outcome notification preference without changing its default", () => {
    expect(policy.notifyOutcomes).toBe(true);
    const silent = createSelfImprovementPolicy({ notifyOutcomes: false });
    expect(silent.notifyOutcomes).toBe(false); expect(silent.policySha256).not.toBe(policy.policySha256);
    expect(selfImprovementPolicySchema.safeParse({ ...silent, notifyOutcomes: true }).success).toBe(false);
  });
  it("allows app repairs while protecting authority, native and release files", () => {
    expect(classifySelfImprovementChange({ policy, candidate: candidate() }).disposition).toBe("routine");
    for (const path of ["src/lib/auth/session.ts", "src/lib/tools/executor.ts", "src/lib/self-improvement/policy.ts", "src/proxy.ts", "src/lib/config.ts", "src/lib/models/gateway.ts", "src/lib/connectors/credential-store.ts", "src/app/api/agent/route.ts", "src/app/api/projects/[id]/builder/route.ts", "src/app/api/mobile/session/route.ts", "scripts/deploy-production.mjs", "apps/flutter/lib/main.dart", "AGENTS.md", "src/lib/studio/AGENTS.md", "supabase/migrations/change.sql"]) expect(classifySelfImprovementChange({ policy, candidate: candidate(path) }).disposition, path).toBe("review_required");
    expect(classifySelfImprovementChange({ policy, candidate: candidate("src/app/api/studio/projects/route.ts") }).disposition).toBe("routine");
    expect(() => candidate("src/lib/studio/../../auth/session.ts")).toThrow();
  });
  it("requires complete checks for the exact candidate", () => {
    const before = cycle();
    expect(() => assertSelfImprovementCycleTransition(before, { ...before, stage: "ready_for_release", revision: 2 })).not.toThrow();
    const { validationSha256: _digest, ...body } = validation();
    const missing = sealSelfImprovementValidation({ ...body, checks: body.checks.slice(0, 3) });
    expect(() => assertSelfImprovementCycleIntegrity({ ...before, stage: "ready_for_release", validation: missing })).toThrow();
    expect(() => assertSelfImprovementCycleIntegrity({ ...before, candidate: candidate("src/lib/studio/other.ts") })).toThrow();
  });
  it("requires reproduction of a code nomination at the original baseline", () => {
    const nomination = sealEngineeringSignal({ version: 1, scope, kind: "code_defect", summary: "Empty title reaches formatter.", symptomSha256: sha("e"), observations: [{ sourceKind: "source_file", sourceId: "file", path: "src/lib/studio/graph.ts", sourceRevision: scope.baseRevision, sourceSha256: sha("f"), observedAt: now, outcome: "needs_work" }] });
    const { validationSha256: _digest, ...body } = validation();
    expect(() => assertSelfImprovementCycleIntegrity({ ...cycle(), stage: "ready_for_release", signal: nomination, validation: sealSelfImprovementValidation({ ...body, signalSha256: nomination.signalSha256 }) })).toThrow(/baseline/);
  });
  it("permits only one correction and never restarts terminal work", () => {
    const before = cycle(); const correcting = { ...before, stage: "correcting" as const, revision: 2, correctionsUsed: 1 };
    expect(() => assertSelfImprovementCycleTransition(before, correcting)).not.toThrow();
    const corrected = { ...correcting, stage: "validating" as const, revision: 3 };
    expect(() => assertSelfImprovementCycleTransition(correcting, corrected)).not.toThrow();
    expect(() => assertSelfImprovementCycleTransition(corrected, { ...corrected, revision: 4, stage: "correcting" })).toThrow(/correction/);
    expect(() => assertSelfImprovementCycleTransition({ ...before, stage: "failed" }, { ...before, revision: 2, stage: "implementing" })).toThrow();
  });
  it("allows exact human approval after the coding deadline without reopening coding", () => {
    const artifact = candidate("src/lib/self-improvement/policy.ts");
    const { validationSha256: _digest, ...body } = validation();
    const validated = sealSelfImprovementValidation({ ...body, candidateSha256: artifact.candidateSha256 });
    const before = { ...cycle(), candidate: artifact, validation: validated, stage: "review_required" as const };
    const approvedAt = "2026-10-27T12:00:00.000Z";
    const approval = sealSelfImprovementApproval({ approvalId: "explicit", tenantId: scope.tenantId, ownerActorId: scope.ownerActorId, candidateSha256: artifact.candidateSha256,
      policySha256: policy.policySha256, validationSha256: validated.validationSha256, decision: "approved" as const, approvedAt,
      expiresAt: "2026-10-27T13:00:00.000Z" });
    const approved = { ...before, stage: "ready_for_release" as const, revision: 2, updatedAt: approvedAt, approval };
    expect(() => assertSelfImprovementCycleTransition(before, approved)).not.toThrow();
    expect(() => assertSelfImprovementCycleTransition(before, { ...approved, approval: { ...approval, candidateSha256: sha("d") } })).toThrow(/approval/);
    expect(() => assertSelfImprovementCycleTransition(before, { ...approved, updatedAt: approval.expiresAt })).toThrow(/approval/);
    expect(() => assertSelfImprovementCycleTransition(before, { ...approved, stage: "implementing" })).toThrow(/deadline/);
  });
  it("requires matching paired-release receipts and retains uncertain release locks", () => {
    const before = cycle(); const release = sealSelfImprovementReleaseBinding({ releaseId: "release", scope, previousRevision: scope.baseRevision, sourceCandidateRevision: before.candidate!.revision, candidateRevision: before.candidate!.revision, sourceTree: "c".repeat(40), mergedTree: "c".repeat(40), pullRequestUrl: "https://github.com/asael/app/pull/1", candidateSha256: before.candidate!.candidateSha256, policySha256: policy.policySha256, validationSha256: before.validation!.validationSha256, runner: "asael_paired_production" });
    const releasing = { ...before, stage: "releasing" as const, release };
    expect(() => assertSelfImprovementCycleTransition(releasing, { ...releasing, stage: "failed", revision: 2 })).toThrow(/uncertain/);
    const receipt = { releaseBindingSha256: release.releaseBindingSha256, outcome: "deployed" as const, webRevision: "b".repeat(40), workerRevision: "a".repeat(40), manifestSha256: sha("e"), healthEvidenceSha256: sha("e"), behaviorEvidenceSha256: sha("e"), evidenceSha256: sha("e"), recordedAt: now };
    expect(() => assertSelfImprovementCycleTransition(releasing, { ...releasing, stage: "succeeded", revision: 2, releaseReceipt: receipt })).toThrow(/matching deployed/);
    expect(() => assertSelfImprovementCycleTransition(releasing, { ...releasing, stage: "succeeded", revision: 2, releaseReceipt: { ...receipt, workerRevision: "b".repeat(40) } })).not.toThrow();
  });
  it("requires unexpired approval to start but permits in-flight reconciliation after expiry", () => {
    const { candidateSha256: _candidate, ...artifactBody } = candidate();
    const artifact = sealSelfImprovementCandidate({ ...artifactBody, architectureImpact: "major" });
    const { validationSha256: _validation, ...validationBody } = validation();
    const validated = sealSelfImprovementValidation({ ...validationBody, candidateSha256: artifact.candidateSha256 });
    const approval = sealSelfImprovementApproval({ approvalId: "exact-major-review", tenantId: scope.tenantId, ownerActorId: scope.ownerActorId,
      candidateSha256: artifact.candidateSha256, policySha256: policy.policySha256, validationSha256: validated.validationSha256,
      decision: "approved", approvedAt: now, expiresAt: "2026-10-26T12:05:00.000Z" });
    const ready = { ...cycle(), stage: "ready_for_release" as const, candidate: artifact, validation: validated, approval };
    const release = sealSelfImprovementReleaseBinding({ releaseId: "major-release", scope, previousRevision: scope.baseRevision,
      sourceCandidateRevision: artifact.revision, candidateRevision: artifact.revision, sourceTree: "c".repeat(40), mergedTree: "c".repeat(40),
      pullRequestUrl: "https://github.com/asael/app/pull/1", candidateSha256: artifact.candidateSha256, policySha256: policy.policySha256,
      validationSha256: validated.validationSha256, runner: "asael_paired_production" });
    const releasing = { ...ready, revision: 2, stage: "releasing" as const, release, updatedAt: "2026-10-26T12:04:00.000Z" };
    expect(() => assertSelfImprovementCycleTransition(ready, releasing)).not.toThrow();
    expect(() => assertSelfImprovementCycleTransition(ready, { ...releasing, updatedAt: approval.expiresAt })).toThrow(/approval expired/);
    expect(() => assertSelfImprovementCycleIntegrity({ ...releasing, updatedAt: "2026-10-26T12:10:00.000Z" })).not.toThrow();
  });
});
describe("deterministic engineering signals", () => {
  it("stays quiet for missing, foreign, stale or already handled evidence", () => {
    expect(selectEngineeringSignal({ scope, signals: [], now }).outcome).toBe("no_change");
    expect(selectEngineeringSignal({ scope: { ...scope, ownerActorId: "other" }, signals: [signal()], now }).outcome).toBe("no_change");
    expect(selectEngineeringSignal({ scope, signals: [signal()], now: "2026-11-26T12:00:00.000Z" }).outcome).toBe("no_change");
    expect(selectEngineeringSignal({ scope, signals: [signal()], now, previouslyHandledSymptomSha256: [signal().symptomSha256] }).outcome).toBe("no_change");
  });
  it("counts distinct real failures rather than repeated reads and dry runs", () => {
    const run = { id: "run1", tenantId: scope.tenantId, ownerActorId: scope.ownerActorId, prompt: "Save title.", status: "completed" } as AgentRunRecord;
    const receipt = { id: "tool1", tenantId: scope.tenantId, actorId: scope.ownerActorId, toolId: "app.projects.update", input: {}, status: "failed", reason: "Missing title", createdAt: now, riskLevel: 1, dryRun: false } as ToolExecutionRecord;
    const one = collectEngineeringSignalsFromRuns({ scope, runs: [{ run, receipts: [receipt, receipt] }] });
    expect(one[0].observations).toHaveLength(1);
    expect(selectEngineeringSignal({ scope, signals: one, now }).outcome).toBe("no_change");
    const two = collectEngineeringSignalsFromRuns({ scope, runs: [{ run, receipts: [receipt, { ...receipt, id: "tool2" }, { ...receipt, id: "tool3", dryRun: true }] }] });
    expect(two[0].observations).toHaveLength(2);
    expect(selectEngineeringSignal({ scope, signals: two, now }).outcome).toBe("selected");
  });
});
