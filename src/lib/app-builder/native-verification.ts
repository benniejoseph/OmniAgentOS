import "server-only";
import type { AppBuilderVerification } from "./contracts";
import { assertNativeValidationReceipt, nativeCandidateValidationPassed, type NativeValidationRequest, type NativeValidationReceipt } from "@/lib/self-improvement/native-contracts";

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
