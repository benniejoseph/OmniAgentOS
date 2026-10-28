import { selfImprovementSha256 } from "./contracts";
import { reviewManifestSchema, reviewCompletionReceiptSchema, type ReviewManifest, type ReviewRead, type ReviewSubmission } from "./review-contracts";

/** Synthetic metadata only; does not claim a provider, DB or executor run. */
export function reviewFixture() {
  const source = "src/feature.ts", test = "src/feature.test.ts", hash = "a".repeat(64);
  const plan = { summary: "Reject excess capacity", sourcePaths: [source], newSourcePaths: [], focusedTestPaths: [test], adjacentTestPaths: ["src/adjacent.test.ts"], acceptanceCriteria: ["Reject excess while preserving the input.", "Accept exact capacity."] };
  const preparation = { accepted: true, testHashes: { [test]: hash } };
  const baseline = { id: "baseline", executionId: "red", command: "test_focused", paths: [test], outputSha256: hash, workspaceSha256: "b".repeat(64), exitCode: 1, totalTests: 2, passedTests: 1, failedTests: 1 };
  const checks = ["lint_focused", "typecheck_direct", "test_focused", "test_focused"].map((command, index) => ({ ...baseline, id: `candidate:${index}`, executionId: `check${index}`, command,
    paths: index === 3 ? plan.adjacentTestPaths : [test], workspaceSha256: hash, exitCode: 0, failedTests: 0, passedTests: 2 }));
  const manifest = reviewManifestSchema.parse({ tenantId: "t", ownerActorId: "actor:11111111-1111-4111-8111-111111111111", projectId: "p", cycleId: "cycle", policySha256: hash,
    sessionId: `app_build_${"a".repeat(48)}`, checkpointId: "checkpoint", verificationId: "verification", workspaceSha256: hash,
    planSha256: selfImprovementSha256("review_plan", plan), preparationSha256: selfImprovementSha256("review_preparation", preparation), checksSha256: selfImprovementSha256("review_checks", { baseline, checks }),
    criteria: plan.acceptanceCriteria, sourcePaths: [source], focusedTestPaths: [test], fileHashes: { [source]: hash, [test]: hash }, checks: [baseline, ...checks] });
  const reads: ReviewRead[] = [source, test].map((path, index) => ({ executionId: `read${index}`, path, sha256: hash, startLine: 1, endLine: 20, inputSha256: hash, scopeSha256: hash }));
  const result: ReviewSubmission = { architectureImpact: "none", summary: "Both exact boundaries are evidenced.", baselineControl: { status: "satisfied", rationale: "Same valid setup and exact-capacity control pass before the repair.", evidence: [{ path: test, startLine: 2, endLine: 5, checkId: "baseline" }] },
    criteria: plan.acceptanceCriteria.map((_, index) => ({ criterionId: `c${index + 1}`, status: "satisfied", rationale: "The cited assertions establish this behavior.", evidence: [{ path: test, startLine: 6 + index, endLine: 8 + index, checkId: "candidate:2" }] })) };
  return { plan, preparation, baseline, checks, manifest, reads, result, runId: "11111111-1111-4111-8111-111111111111" };
}

export function syntheticReviewReceipt(manifest: ReviewManifest, runId: string, result: ReviewSubmission, reads: ReviewRead[] = []) {
  const { tenantId, ownerActorId, projectId, cycleId, policySha256, sessionId, checkpointId, verificationId, workspaceSha256, planSha256, preparationSha256, checksSha256 } = manifest;
  const body = { version: 1 as const, runId, tenantId, ownerActorId, projectId, cycleId, policySha256, sessionId, checkpointId, verificationId, workspaceSha256, planSha256, preparationSha256, checksSha256,
    manifestSha256: selfImprovementSha256("review_manifest", manifest), criterionCount: manifest.criteria.length, outcome: "passed" as const, reason: "complete" as const,
    result, reads, resultSha256: selfImprovementSha256("review_result", result) };
  return reviewCompletionReceiptSchema.parse({ ...body, receiptSha256: selfImprovementSha256("review_completion", body) });
}

export function syntheticPassingReview(manifest: ReviewManifest, runId: string) {
  const test = manifest.focusedTestPaths[0];
  const candidate = manifest.checks.find(check => check.id !== "baseline" && check.command.includes("test_focused") && check.paths.includes(test))!;
  const evidence = { path: test, startLine: 1, endLine: 1 };
  const result: ReviewSubmission = { architectureImpact: "minor", summary: "Synthetic exact-criterion assessment.",
    baselineControl: { status: "satisfied", rationale: "Synthetic relevant control.", evidence: [{ ...evidence, checkId: "baseline" }] },
    criteria: manifest.criteria.map((_, index) => ({ criterionId: `c${index + 1}`, status: "satisfied", rationale: "Synthetic matching assertions.", evidence: [{ ...evidence, checkId: candidate.id }] })) };
  const reads = Object.entries(manifest.fileHashes).map(([path, sha256], index) => ({ executionId: `synthetic-read-${index}`, path, sha256, startLine: 1, endLine: 1, inputSha256: "a".repeat(64), scopeSha256: "b".repeat(64) }));
  return syntheticReviewReceipt(manifest, runId, result, reads);
}
