import "server-only";
import type { AppBuilderVerification } from "./contracts";
import { assertNativeValidationReceipt, decodeNativeTestEvidence, nativeCandidateValidationPassed, type NativeValidationRequest, type NativeValidationReceipt } from "@/lib/self-improvement/native-contracts";

/** Private supervisor context from an exact completed request; not a new read API.
 * Historical receipts retain absent case evidence. Unsigned artifact identity is
 * build evidence only, never owner approval or proof of installation.
 */
export function nativeReviewValidationEvidence(request: NativeValidationRequest, receipt: NativeValidationReceipt) {
  assertNativeValidationReceipt(request, receipt);
  return {
    tenantId: request.tenantId, ownerActorId: request.ownerActorId, cycleId: request.cycleId,
    projectId: request.projectId, sessionId: request.sessionId, checkpointId: request.checkpointId,
    requestId: request.requestId, requestSha256: request.requestSha256, snapshotSha256: receipt.snapshotSha256,
    receiptSha256: receipt.receiptSha256, controllerId: receipt.controllerId, purpose: request.purpose,
    workspaceSha256: receipt.workspaceSha256, toolchainSha256: receipt.toolchainSha256, builderProfileSha256: receipt.builderProfileSha256,
    completedAt: receipt.completedAt,
    checks: receipt.checks.map(check => ({ command: check.command, ...(check.purpose ? { purpose: check.purpose } : {}),
      paths: check.paths, policySha256: check.policySha256, exitCode: check.exitCode, outputSha256: check.outputSha256,
      startedAt: check.startedAt, completedAt: check.completedAt,
      ...(check.testSummary ? { testSummary: check.testSummary } : {}),
      ...(check.testEvidence ? { testEvidence: decodeNativeTestEvidence(check.testEvidence) } : {}),
      ...(check.testReportFailure ? { testReportFailure: check.testReportFailure } : {}),
    })),
    artifact: receipt.artifact, installedBaseline: receipt.installedBaseline, pairedBaseline: receipt.pairedBaseline,
  };
}
export type NativeReviewValidationEvidence = ReturnType<typeof nativeReviewValidationEvidence>;

/** Only the service resolves these records from the active trusted request. */
export function nativeBuilderVerificationChecks(request: NativeValidationRequest, receipt: NativeValidationReceipt): AppBuilderVerification["checks"] {
  assertNativeValidationReceipt(request, receipt);
  if (request.purpose !== "candidate" || !nativeCandidateValidationPassed(receipt)) throw new Error("Builder delivery requires a completed passing native candidate build.");
  return receipt.checks.map((check) => ({
    command: check.command,
    ...(check.paths.length ? { paths: check.paths } : {}),
    ...(check.purpose ? { purpose: check.purpose } : {}),
    policySha256: check.policySha256,
    status: "passed" as const,
    exitCode: check.exitCode,
    durationMs: check.durationMs,
    outputSha256: check.outputSha256,
    ...(check.testSummary ? { testSummary: { ...check.testSummary, success: check.exitCode === 0 && check.testSummary.failedTests === 0 && check.testSummary.pendingTests === 0 } } : {}),
  }));
}
