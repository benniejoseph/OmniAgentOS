import { selfImprovementSha256, sealSelfImprovementValidation } from "./contracts";
import { reviewManifestSchema } from "./review-contracts";
import { reviewFixture, syntheticPassingReview } from "./review-test-fixtures";
import { initialSelfImprovementRuntime, selfImprovementRuntimeSchema, type ImprovementPlan } from "./runtime";
import type { StoredSelfImprovementCycle } from "./store";

/** Explicit synthetic new proof for boundary tests, never a runtime legacy upgrade. */
export function withSyntheticCriterionReview(stored: StoredSelfImprovementCycle): StoredSelfImprovementCycle {
  if (!stored.cycle.candidate || !stored.cycle.validation) throw new Error("Fixture needs its candidate and validation.");
  const native = stored.cycle.candidate.releaseTarget === "macos_app", base = reviewFixture(), hash = "a".repeat(64), now = stored.cycle.updatedAt;
  const plan: ImprovementPlan = native ? { ...base.plan, releaseTarget: "macos_app", sourcePaths: ["apps/flutter/lib/features/example/example.dart"], focusedTestPaths: ["apps/flutter/test/features/example_test.dart"], adjacentTestPaths: ["apps/flutter/test/features/adjacent_test.dart"] } : base.plan;
  const check = (command: string, paths: string[], index: number, baseline = false) => ({ executionId: `synthetic-check-${index}`, command, paths, outputSha256: hash,
    workspaceSha256: baseline ? "b".repeat(64) : stored.cycle.candidate!.workspaceSha256, exitCode: baseline ? 1 : 0,
    totalTests: command.includes("test_focused") ? 2 : 0, passedTests: command.includes("test_focused") ? baseline ? 1 : 2 : 0, failedTests: baseline ? 1 : 0,
    pendingTests: 0, executedPaths: command.includes("test_focused") ? paths : [], completedAt: now });
  const baseline = check(native ? "macos_test_focused" : "test_focused", plan.focusedTestPaths, 0, true);
  const checks = native ? [check("macos_analyze", [...plan.sourcePaths, ...plan.focusedTestPaths], 1), check("macos_test_focused", plan.focusedTestPaths, 2), check("macos_test_focused", plan.adjacentTestPaths, 3), check("macos_build", [], 4)]
    : [check("lint_focused", [...plan.sourcePaths, ...plan.focusedTestPaths], 1), check("typecheck_direct", [], 2), check("test_focused", plan.focusedTestPaths, 3), check("test_focused", plan.adjacentTestPaths, 4)];
  const statics = native ? [check("macos_analyze", [...plan.sourcePaths, ...plan.focusedTestPaths], 5)] : [check("lint_focused", plan.focusedTestPaths, 5), check("typecheck_direct", [], 6)];
  const preparation = { attempt: 0, workspaceSha256: baseline.workspaceSha256, testHashes: Object.fromEntries(plan.focusedTestPaths.map(path => [path, hash])), accepted: true,
    checks: [...statics.map(evidence => ({ ...evidence, workspaceSha256: baseline.workspaceSha256 })), baseline].map(evidence => ({ evidence, output: "Synthetic fixture command evidence.", reportComplete: true })) };
  const cycle = { ...stored.cycle, builderSessionId: stored.cycle.builderSessionId || base.manifest.sessionId, checkpointId: stored.cycle.checkpointId || "synthetic-checkpoint", verificationId: stored.cycle.verificationId || "synthetic-verification" };
  const manifest = reviewManifestSchema.parse({ ...base.manifest, tenantId: cycle.scope.tenantId, ownerActorId: cycle.scope.ownerActorId, projectId: stored.projectId, cycleId: cycle.id, policySha256: cycle.policy.policySha256,
    sessionId: cycle.builderSessionId, checkpointId: cycle.checkpointId, verificationId: cycle.verificationId, workspaceSha256: cycle.candidate!.workspaceSha256,
    planSha256: selfImprovementSha256("review_plan", plan), preparationSha256: selfImprovementSha256("review_preparation", preparation), checksSha256: selfImprovementSha256("review_checks", { baseline, checks }),
    supervisionSha256: selfImprovementSha256("review_supervision", { syntheticFixture: true, cycleId: cycle.id, checkpointId: cycle.checkpointId }),
    criteria: plan.acceptanceCriteria, sourcePaths: plan.sourcePaths, focusedTestPaths: plan.focusedTestPaths,
    fileHashes: Object.fromEntries([...plan.sourcePaths, ...plan.focusedTestPaths, ...plan.adjacentTestPaths].map(path => [path, hash])),
    checks: [baseline, ...checks].map(({ executionId, command, paths, outputSha256, workspaceSha256, exitCode, totalTests, passedTests, failedTests }, index) => ({ id: index === 0 ? "baseline" : `candidate:${index - 1}`, executionId, command, paths, outputSha256, workspaceSha256, exitCode, totalTests, passedTests, failedTests })),
  });
  const reviewReceipt = syntheticPassingReview(manifest, base.runId);
  const runtime = selfImprovementRuntimeSchema.parse({ ...initialSelfImprovementRuntime(), ...stored.runtime, phase: "release_wait", plan, baseline, checks, preparations: [preparation],
    reviewRunId: base.runId, reviewReceipt, sourceHashes: preparation.testHashes });
  const { validationSha256: _previous, ...validation } = cycle.validation!;
  cycle.validation = sealSelfImprovementValidation({ ...validation, checks: validation.checks.map(item => item.kind !== "independent_review" ? item : { ...item,
    producerId: base.runId, evidenceSha256: reviewReceipt.receiptSha256, declaredCases: reviewReceipt.criterionCount, executedCases: reviewReceipt.criterionCount }) });
  return { ...stored, cycle, runtime };
}
