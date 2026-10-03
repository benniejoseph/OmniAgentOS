import { describe, expect, it } from "vitest";
import {
  buildTerminalReceiptV1, terminalReceiptV1Schema, terminalDispositionSchema,
  terminalVerificationStateSchema, terminalReasonCodeSchema, runExecutionModeSchema,
  type BuildTerminalReceiptV1Input,
} from "@/lib/runs/contracts";
import { parseCompanionTerminalReceipt } from "./terminal-receipt";

function receipt(overrides: Partial<BuildTerminalReceiptV1Input> = {}) {
  return buildTerminalReceiptV1({
    terminalReceiptId: "receipt-a", runId: "run-a", outcomeContractId: "contract-a", source: "outcome_evaluator",
    legacyStatus: null, disposition: "succeeded", executionMode: "live", verificationState: "verified", reasonCode: "all_requirements_verified",
    requirementResults: [{ requirementId: "criterion-a", requirementKind: "criterion", requirementLevel: "required", state: "verified", verificationMethod: "deterministic", verifierId: "verifier-a", verificationReceiptId: "verification-a" }],
    usefulWorkUnitCount: 1, artifactReceiptIds: [], effectReceiptIds: [], verifierReceiptIds: ["verification-a"], pendingApprovalIds: [], blockingDependencyIds: [], outputSha256: null,
    ...overrides,
  });
}
function parity(input: unknown) {
  const authoritative = terminalReceiptV1Schema.safeParse(input);
  expect(parseCompanionTerminalReceipt(input)).toEqual(authoritative.success ? authoritative.data : undefined);
}
describe("compact terminal display boundary against the authoritative schema", () => {
  it("preserves complete receipts and normalized identities without returning the input object", () => {
    const input = receipt();
    parity(input);
    parity({ ...input, terminalReceiptId: " receipt-a ", runId: " run-a ", verifierReceiptIds: [" verification-a "] });
    expect(parseCompanionTerminalReceipt(input)).not.toBe(input);
    expect(parseCompanionTerminalReceipt(input)?.requirementResults).not.toBe(input.requirementResults);
  });
  it("checks every disposition, execution mode, verification and reason combination", () => {
    const input = receipt();
    for (const disposition of terminalDispositionSchema.options) {
      for (const executionMode of runExecutionModeSchema.options) {
        for (const verificationState of terminalVerificationStateSchema.options) {
          for (const reasonCode of terminalReasonCodeSchema.options) parity({ ...input, disposition, executionMode, verificationState, reasonCode });
        }
      }
    }
  });
  it("accepts valid partial, waiting, blocked, unverified, failed and canceled evidence", () => {
    parity(receipt({ disposition: "partial", verificationState: "partially_verified", reasonCode: "requirements_unmet", requirementResults: [{ requirementId: "criterion-a", requirementKind: "criterion", requirementLevel: "required", state: "unverified", verificationMethod: "deterministic", verifierId: null, verificationReceiptId: null }] }));
    parity(receipt({ disposition: "waiting_approval", reasonCode: "approval_required", pendingApprovalIds: ["approval-a"] }));
    parity(receipt({ disposition: "blocked", reasonCode: "external_dependency", blockingDependencyIds: ["dependency-a"] }));
    parity(receipt({ disposition: "unverified", verificationState: "unverified", reasonCode: "verification_inconclusive" }));
    parity(receipt({ disposition: "failed", reasonCode: "execution_failed" }));
    parity(receipt({ disposition: "canceled", reasonCode: "authorized_cancellation" }));
  });
  it("never upgrades legacy receipts and requires their exact compatibility fields", () => {
    const cases = [
      ["completed", "unverified", "legacy_completed_without_verification"],
      ["failed", "failed", "legacy_failed"], ["canceled", "canceled", "legacy_canceled"],
      ["waiting_approval", "waiting_approval", "legacy_waiting_approval"],
    ] as const;
    for (const [legacyStatus, disposition, reasonCode] of cases) {
      const input = receipt({ source: "legacy_adapter", legacyStatus, disposition, reasonCode, outcomeContractId: null, executionMode: "unassessed", verificationState: "unassessed", requirementResults: [], verifierReceiptIds: [], pendingApprovalIds: legacyStatus === "waiting_approval" ? ["approval-a"] : [] });
      parity(input);
      for (const source of ["outcome_evaluator", "legacy_adapter"]) {
        for (const status of [null, "completed", "failed", "canceled", "waiting_approval"]) parity({ ...input, source, legacyStatus: status });
      }
      for (const executionMode of runExecutionModeSchema.options) parity({ ...input, executionMode });
      parity({ ...input, outcomeContractId: "invented" });
      parity({ ...input, verificationState: "verified" });
      parity({ ...input, requirementResults: receipt().requirementResults });
    }
  });
  it("rejects missing/extra fields and malformed JSON shapes, counts and IDs", () => {
    const input = receipt();
    for (const key of Object.keys(input)) {
      const missing = { ...input } as Record<string, unknown>;
      delete missing[key];
      parity(missing);
      for (const value of [null, undefined, {}, [], true, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_001, ""]) parity({ ...input, [key]: value });
    }
    parity({ ...input, unknown: "not accepted" });
    for (const value of [null, [], "receipt", 1]) parity(value);
    for (const value of [" bad id ", "a".repeat(241), "🙂", "../bad", "a\u0000b"]) parity({ ...input, runId: value });
    for (const value of ["a".repeat(64), "A".repeat(64), "a".repeat(63), 12]) parity({ ...input, outputSha256: value });
    expect(parseCompanionTerminalReceipt(Object.create(input))).toBeUndefined();
  });
  it("validates all requirement bindings, strong methods, counts and uniqueness", () => {
    const input = receipt();
    const first = input.requirementResults[0];
    for (const key of Object.keys(first)) {
      const missing = { ...first } as Record<string, unknown>;
      delete missing[key];
      parity({ ...input, requirementResults: [missing] });
      for (const value of [null, undefined, "invalid", 1, [], {}]) parity({ ...input, requirementResults: [{ ...first, [key]: value }] });
    }
    parity({ ...input, requirementResults: [{ ...first, extra: true }] });
    parity({ ...input, requirementResults: [first, first] });
    parity({ ...input, requirementResults: Array(1) });
    parity({ ...input, requirementResults: Array(385).fill(first) });
    for (const state of ["verified", "unverified", "failed", "not_assessed"]) {
      for (const requirementLevel of ["required", "optional"]) parity({ ...input, requirementResults: [{ ...first, state, requirementLevel }] });
    }
    for (const verificationMethod of ["deterministic", "provider_receipt", "read_after_write", "signed_evidence", "human_attestation", "model_assertion", "generated_summary", "citation_id_match", "none", "unassessed"]) parity({ ...input, requirementResults: [{ ...first, verificationMethod }] });
    parity({ ...input, requiredRequirementCount: 0, verifiedRequirementCount: 0, requirementResults: [] });
    parity({ ...input, requirementResults: [{ ...first, verificationReceiptId: "other" }] });
    parity({ ...input, requirementResults: [{ ...first, verifierId: null }] });
    parity({ ...input, requirementResults: [{ ...first, verificationReceiptId: null }] });
  });
  it("bounds each receipt list and detects duplicates after ID normalization", () => {
    const input = receipt();
    const fields = ["artifactReceiptIds", "effectReceiptIds", "verifierReceiptIds", "pendingApprovalIds", "blockingDependencyIds"] as const;
    for (const field of fields) {
      const maximum = field === "verifierReceiptIds" ? 384 : 128;
      for (const value of [Array(1), ["same", " same "], [null], [""], Array.from({ length: maximum + 1 }, (_, index) => `receipt-${index}`)]) parity({ ...input, [field]: value });
    }
  });
});
