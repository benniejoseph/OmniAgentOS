import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNativeValidationReceipt, nativeCandidateValidationPassed, nativeValidationReceiptSchema, nativeValidationRequestSchema, selfImprovementNativeSha, SELF_IMPROVEMENT_NATIVE_PROFILE_SHA256, type NativeValidationReceipt } from "./native-contracts";
import { nativeValidationFixture } from "./native-test-fixtures";
import { improvementPreparationPassed, type ImprovementPlan, type ImprovementPreparation } from "./runtime";

function reseal(receipt: NativeValidationReceipt): NativeValidationReceipt {
  const { receiptSha256: _old, ...body } = receipt;
  return nativeValidationReceiptSchema.parse({ ...body, receiptSha256: selfImprovementNativeSha("native_validation_receipt", body) });
}
function baseline() {
  const fixture = nativeValidationFixture();
  const { requestSha256: _old, ...body } = { ...fixture.request, purpose: "baseline" as const };
  const request = nativeValidationRequestSchema.parse({ ...body, requestSha256: selfImprovementNativeSha("native_validation_request", body) });
  const checks = structuredClone(fixture.receipt.checks.slice(0, 2));
  checks[1].exitCode = 1; checks[1].testSummary!.passedTests = 1; checks[1].testSummary!.failedTests = 1;
  return { request, receipt: reseal({ ...fixture.receipt, requestSha256: request.requestSha256, checks, artifact: null }) };
}
function preparation(receipt: NativeValidationReceipt) {
  const { request } = nativeValidationFixture();
  const plan: ImprovementPlan = { releaseTarget: "macos_app", summary: "Synthetic native preparation", sourcePaths: request.analyzePaths.filter(path => path.includes("/lib/")), newSourcePaths: [], focusedTestPaths: request.focusedTestPaths, adjacentTestPaths: request.adjacentTestPaths, acceptanceCriteria: ["A meaningful control passes and the regression fails."] };
  const value: ImprovementPreparation = { attempt: 0, workspaceSha256: receipt.workspaceSha256, testHashes: Object.fromEntries(request.focusedTestPaths.map(path => [path, "a".repeat(64)])), accepted: false,
    checks: receipt.checks.map((check, index) => ({ output: check.outputTail || "", reportComplete: check.command !== "macos_test_focused" || Boolean(check.testSummary) && !check.testReportFailure,
      evidence: { executionId: `${receipt.requestId}:${index}`, command: check.command, paths: check.paths, outputSha256: check.outputSha256, workspaceSha256: check.workspaceAfterSha256, exitCode: check.exitCode,
        totalTests: check.testSummary?.totalTests ?? 0, passedTests: check.testSummary?.passedTests ?? 0, failedTests: check.testSummary?.failedTests ?? 0, pendingTests: check.testSummary?.pendingTests ?? 0, executedPaths: check.testSummary?.executedPaths ?? [], completedAt: check.completedAt } })) };
  return { value, plan };
}
describe("native test preparation profile", () => {
  it("shares the v2 cross-language profile and requires analysis before a mixed baseline", () => {
    const { request, receipt } = baseline();
    expect(request.profileSha256).toBe(SELF_IMPROVEMENT_NATIVE_PROFILE_SHA256);
    expect(() => assertNativeValidationReceipt(request, receipt)).not.toThrow();
    const { value, plan } = preparation(receipt);
    expect(improvementPreparationPassed(value, plan)).toBe(true);
    expect(nativeCandidateValidationPassed(receipt)).toBe(false);
  });
  it.each(["analysis", "all_failed", "all_passed", "unproven"] as const)("retains %s evidence without admitting source implementation", kind => {
    const { request, receipt } = baseline();
    if (kind === "analysis") receipt.checks[0].exitCode = 1;
    if (kind === "all_failed") { receipt.checks[1].testSummary!.passedTests = 0; receipt.checks[1].testSummary!.failedTests = 2; }
    if (kind === "all_passed") { receipt.checks[1].testSummary!.passedTests = 2; receipt.checks[1].testSummary!.failedTests = 0; receipt.checks[1].exitCode = 0; }
    if (kind === "unproven") { delete receipt.checks[1].testSummary; receipt.checks[1].testReportFailure = "unproven_test_report"; receipt.checks[1].exitCode = 0; }
    const sealed = reseal(receipt);
    expect(() => assertNativeValidationReceipt(request, sealed)).not.toThrow();
    const { value, plan } = preparation(sealed);
    expect(improvementPreparationPassed(value, plan)).toBe(false);
  });
  it("rejects missing, reordered and contradictory check evidence", () => {
    for (const mutate of [
      (receipt: NativeValidationReceipt) => { receipt.checks.shift(); },
      (receipt: NativeValidationReceipt) => { receipt.checks.reverse(); },
      (receipt: NativeValidationReceipt) => { receipt.checks[1].testSummary!.pendingTests = 1; },
      (receipt: NativeValidationReceipt) => { receipt.checks[1].testReportFailure = "unproven_test_report"; },
    ]) {
      const { request, receipt } = baseline(); mutate(receipt);
      expect(() => assertNativeValidationReceipt(request, reseal(receipt))).toThrow();
    }
  });
  it("does not accept an unproven candidate test even when its process exited zero", () => {
    const { request, receipt } = nativeValidationFixture();
    delete receipt.checks[1].testSummary; receipt.checks[1].testReportFailure = "unproven_test_report";
    expect(nativeCandidateValidationPassed(receipt)).toBe(false);
    expect(() => assertNativeValidationReceipt(request, reseal(receipt))).toThrow(/Unproven/);
    receipt.artifact = null;
    expect(() => assertNativeValidationReceipt(request, reseal(receipt))).not.toThrow();
  });
  it("keeps historical v1 seals readable while refusing a profile substitution", () => {
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/self-improvement/fixtures/native-validation-v1.json"), "utf8"));
    const request = nativeValidationRequestSchema.parse(fixture.request), receipt = nativeValidationReceiptSchema.parse(fixture.receipt);
    expect(() => assertNativeValidationReceipt(request, receipt)).not.toThrow();
    expect(receipt.receiptSha256).toBe("b142ae84d1ba61792b55f2f3b7045a51b0a83315409aa47b094dc4746222aaaa");
    const { requestSha256: _old, ...body } = { ...request, profileSha256: SELF_IMPROVEMENT_NATIVE_PROFILE_SHA256 };
    expect(nativeValidationRequestSchema.safeParse({ ...body, requestSha256: selfImprovementNativeSha("native_validation_request", body) }).success).toBe(false);
  });
});
