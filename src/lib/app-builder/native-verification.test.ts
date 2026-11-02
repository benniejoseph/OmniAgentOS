import { describe, expect, it } from "vitest";
import { builderVerificationInputSchema, resolveBuilderCommandSpecification, type AppBuilderVerification } from "./contracts";
import { createBuilderCheckpointReadinessEvidence, normalizeBuilderVerificationChecks } from "./verification";
import { nativeBuilderVerificationChecks, nativeReviewValidationEvidence } from "./native-verification";
import { nativeValidationFixture } from "@/lib/self-improvement/native-test-fixtures";
import { selfImprovementNativeSha } from "@/lib/self-improvement/native-contracts";

type Check = AppBuilderVerification["checks"][number];
function nativeChecks(): Check[] {
  const common = { status: "passed" as const, exitCode: 0, durationMs: 100, outputSha256: "a".repeat(64), policySha256: "b".repeat(64) };
  const test = (purpose: "regression" | "adjacent"): Check => {
    const paths = [`apps/flutter/test/features/example/${purpose}_test.dart`];
    return { ...common, command: "macos_test_focused", paths, purpose,
      testSummary: { totalTests: 2, passedTests: 2, failedTests: 0, pendingTests: 0, executedPaths: paths, success: true } };
  };
  return [{ ...common, command: "macos_analyze" }, test("regression"), test("adjacent"), { ...common, command: "macos_build" }];
}
const input = { projectId: "project-example", sessionId: `app_build_${"a".repeat(48)}`,
  checkpointId: `app_build_checkpoint_${"b".repeat(48)}`, expectedSessionRevision: 3,
  nativeValidationRequestId: `self_native_${"c".repeat(64)}`, requireCompletedChecks: true };

describe("trusted native Builder verification", () => {
  it("projects sealed unsigned arm64 identity and keeps legacy missing case details absent", () => {
    const { request, receipt } = nativeValidationFixture();
    const evidence = nativeReviewValidationEvidence(request, receipt);
    expect(evidence).toMatchObject({ requestId: request.requestId, requestSha256: request.requestSha256, receiptSha256: receipt.receiptSha256,
      workspaceSha256: receipt.workspaceSha256, checkpointId: request.checkpointId, artifact: receipt.artifact,
      toolchainSha256: receipt.toolchainSha256, builderProfileSha256: receipt.builderProfileSha256, installedBaseline: receipt.installedBaseline });
    expect(evidence.artifact?.architecture).toBe("arm64");
    expect(evidence.checks[1]).not.toHaveProperty("testEvidence");
    expect(evidence).not.toHaveProperty("approval");
    expect(evidence).not.toHaveProperty("installedArtifact");
  });
  it("projects actual named case evidence without treating a tail as a complete report", () => {
    const { request, receipt } = nativeValidationFixture();
    const check = receipt.checks[1];
    check.testEvidence = { version: 1, outputSha256: check.outputSha256, complete: true, omittedCases: 0,
      suites: [{ id: 0, path: check.paths[0] }], cases: [
        { id: 1, suiteId: 0, name: "shared fixture control", line: 10, status: "passed" },
        { id: 2, suiteId: 0, name: "regression", line: 20, status: "passed" }] };
    const { receiptSha256: _old, ...body } = receipt;
    const sealed = { ...body, receiptSha256: selfImprovementNativeSha("native_validation_receipt", body) };
    expect(nativeReviewValidationEvidence(request, sealed).checks[1].testEvidence).toEqual(check.testEvidence);
    expect(nativeReviewValidationEvidence(request, sealed).checks[1]).not.toHaveProperty("outputTail");
    check.testEvidence.outputSha256 = "0".repeat(64);
    const { receiptSha256: _previous, ...changed } = sealed;
    expect(() => nativeReviewValidationEvidence(request, { ...changed, receiptSha256: selfImprovementNativeSha("native_validation_receipt", changed) })).toThrow(/case evidence/);
  });
  it("parses the shared TypeScript/Python receipt and imports only passing native evidence", () => {
    const { request, receipt } = nativeValidationFixture();
    const checks = nativeBuilderVerificationChecks(request, receipt);
    expect(createBuilderCheckpointReadinessEvidence(checks).replacement.status).toBe("passed");
    expect(checks[1].testSummary).toMatchObject({ totalTests: 2, success: true });
    expect(checks[3].command).toBe("macos_build");
  });
  it("does not relabel a structurally valid failed native check as passed", () => {
    const { request, receipt } = nativeValidationFixture();
    receipt.checks[0].exitCode = 1;
    const { receiptSha256: _old, ...body } = receipt;
    const failed = { ...body, receiptSha256: selfImprovementNativeSha("native_validation_receipt", body) };
    expect(() => nativeBuilderVerificationChecks(request, failed)).toThrow(/passing native/);
  });
  it("retains real Mac commands and counts through the persisted reader", () => {
    const checks = nativeChecks();
    expect(normalizeBuilderVerificationChecks(checks)).toEqual(checks);
    const result = createBuilderCheckpointReadinessEvidence(checks).replacement;
    expect(result.status).toBe("passed");
    expect(result.signals.map((signal) => signal.name)).toEqual(["lint", "typecheck", "regression_tests", "adjacent_tests", "build_logs"]);
  });
  it.each([0, 1, 2, 3])("rejects a missing native check at index %i", (index) => {
    const checks = nativeChecks(); checks.splice(index, 1);
    expect(createBuilderCheckpointReadinessEvidence(checks).replacement.status).toBe("failed");
  });
  it("does not accept a web build or analysis receipt as a Mac check", () => {
    const checks = nativeChecks(); checks[0] = { ...checks[0], command: "typecheck_direct" };
    expect(createBuilderCheckpointReadinessEvidence(checks).replacement.status).toBe("failed");
  });
  it.each(["skipped", "zero", "duplicate", "wrong_path", "failed"])("rejects %s native test evidence", (kind) => {
    const checks = nativeChecks(); const test = checks[1]; const summary = test.testSummary!;
    checks[1] = kind === "skipped" ? { ...test, testSummary: { ...summary, passedTests: 1, pendingTests: 1 } }
      : kind === "zero" ? { ...test, testSummary: { ...summary, totalTests: 0, passedTests: 0 } }
      : kind === "duplicate" ? { ...test, paths: [...test.paths!, ...test.paths!], testSummary: { ...summary, executedPaths: [...summary.executedPaths, ...summary.executedPaths] } }
      : kind === "wrong_path" ? { ...test, testSummary: { ...summary, executedPaths: ["apps/flutter/test/other_test.dart"] } }
      : { ...test, status: "failed", exitCode: 1 };
    expect(createBuilderCheckpointReadinessEvidence(checks).replacement.status).toBe("failed");
  });
  it("accepts only a completed native request reference, without caller results or commands", () => {
    expect(builderVerificationInputSchema.parse(input)).toEqual(input);
    for (const extra of [{ requireCompletedChecks: false }, { checks: nativeChecks() }, { focusedTestPaths: ["apps/flutter/test/example_test.dart"] }, { lintPaths: ["src/example.ts"] }]) {
      expect(builderVerificationInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
  });
  it("does not make native checks available to the Linux command executor", () => {
    expect(() => resolveBuilderCommandSpecification({ command: "macos_build" as never })).toThrow(/Unsupported/);
  });
});
