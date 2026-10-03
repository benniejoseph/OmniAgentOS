import type { TerminalReceiptV1 } from "@/lib/runs/contracts";

// Display-only JSON boundary. Keep the complete terminal receipt invariants here
// without putting every run-authoring schema and Zod in the Command bundle.
// Differential tests bind this adapter to terminalReceiptV1Schema. The server
// schema remains authoritative for storage and execution.
const invalid = Symbol("invalid receipt");
type Guard = (value: unknown) => unknown | typeof invalid;
const oneOf = (...values: readonly string[]): Guard => (value) => typeof value === "string" && values.includes(value) ? value : invalid;
const id: Guard = (value) => {
  if (typeof value !== "string") return invalid;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 240 && /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(trimmed) ? trimmed : invalid;
};
const nullable = (guard: Guard): Guard => (value) => value === null ? null : guard(value);
const count: Guard = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : invalid;
const list = (guard: Guard, maximum: number, unique = false): Guard => (value) => {
  if (!Array.isArray(value) || value.length > maximum) return invalid;
  const items: unknown[] = [];
  for (const entry of value) {
    const parsed = guard(entry);
    if (parsed === invalid || (unique && items.includes(parsed))) return invalid;
    items.push(parsed);
  }
  return items;
};
const object = (fields: Readonly<Record<string, Guard>>): Guard => (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (Object.keys(input).length !== keys.length) return invalid;
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) return invalid;
    const parsed = fields[key](input[key]);
    if (parsed === invalid) return invalid;
    output[key] = parsed;
  }
  return output;
};
const requirement = object({
  requirementId: id,
  requirementKind: oneOf("criterion", "artifact", "effect"),
  requirementLevel: oneOf("required", "optional"),
  state: oneOf("verified", "failed", "unverified", "not_assessed"),
  verificationMethod: oneOf("deterministic", "provider_receipt", "read_after_write", "signed_evidence", "human_attestation", "model_assertion", "generated_summary", "citation_id_match", "none", "unassessed"),
  verifierId: nullable(id),
  verificationReceiptId: nullable(id),
});
const receipt = object({
  schemaVersion: (value) => value === 1 ? 1 : invalid,
  terminalReceiptId: id,
  runId: id,
  outcomeContractId: nullable(id),
  source: oneOf("outcome_evaluator", "legacy_adapter"),
  legacyStatus: nullable(oneOf("waiting_approval", "completed", "failed", "canceled")),
  disposition: oneOf("succeeded", "partial", "waiting_approval", "blocked", "unverified", "failed", "canceled"),
  executionMode: oneOf("live", "dry_run", "preview", "unassessed"),
  verificationState: oneOf("verified", "partially_verified", "unverified", "not_applicable", "unassessed"),
  reasonCode: oneOf("all_requirements_verified", "requirements_unmet", "approval_required", "external_dependency", "verification_inconclusive", "execution_failed", "authorized_cancellation", "legacy_completed_without_verification", "legacy_failed", "legacy_canceled", "legacy_waiting_approval"),
  requirementResults: list(requirement, 384),
  requiredRequirementCount: count,
  verifiedRequirementCount: count,
  failedRequirementCount: count,
  unverifiedRequirementCount: count,
  usefulWorkUnitCount: count,
  artifactReceiptIds: list(id, 128, true),
  effectReceiptIds: list(id, 128, true),
  verifierReceiptIds: list(id, 384, true),
  pendingApprovalIds: list(id, 128, true),
  blockingDependencyIds: list(id, 128, true),
  outputSha256: nullable((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : invalid),
});
const strongMethods = new Set(["deterministic", "provider_receipt", "read_after_write", "signed_evidence", "human_attestation"]);
const legacy = {
  waiting_approval: ["waiting_approval", "legacy_waiting_approval"],
  completed: ["unverified", "legacy_completed_without_verification"],
  failed: ["failed", "legacy_failed"],
  canceled: ["canceled", "legacy_canceled"],
} as const;

export function parseCompanionTerminalReceipt(input: unknown): TerminalReceiptV1 | undefined {
  try {
    const parsed = receipt(input);
    if (parsed === invalid) return undefined;
    const value = parsed as TerminalReceiptV1;
    const requirements = value.requirementResults;
    const required = requirements.filter((entry) => entry.requirementLevel === "required");
    if (new Set(requirements.map((entry) => entry.requirementId)).size !== requirements.length
      || value.requiredRequirementCount !== required.length
      || value.verifiedRequirementCount !== required.filter((entry) => entry.state === "verified").length
      || value.failedRequirementCount !== required.filter((entry) => entry.state === "failed").length
      || value.unverifiedRequirementCount !== required.filter((entry) => entry.state === "unverified" || entry.state === "not_assessed").length
      || requirements.some((entry) => (entry.state === "verified" && (entry.verifierId === null || entry.verificationReceiptId === null))
        || (entry.verificationReceiptId !== null && !value.verifierReceiptIds.includes(entry.verificationReceiptId)))) return undefined;

    if (value.source === "outcome_evaluator") {
      if (value.legacyStatus !== null || (requirements.length > 0 && value.outcomeContractId === null)) return undefined;
    } else {
      if (value.legacyStatus === null || value.outcomeContractId !== null || value.executionMode !== "unassessed"
        || value.verificationState !== "unassessed" || requirements.length > 0
        || value.disposition !== legacy[value.legacyStatus][0] || value.reasonCode !== legacy[value.legacyStatus][1]) return undefined;
    }
    if (value.disposition === "succeeded" && (value.source !== "outcome_evaluator" || value.outcomeContractId === null
      || value.executionMode !== "live" || value.verificationState !== "verified" || value.reasonCode !== "all_requirements_verified"
      || value.requiredRequirementCount === 0 || value.verifiedRequirementCount !== value.requiredRequirementCount
      || value.failedRequirementCount !== 0 || value.unverifiedRequirementCount !== 0
      || value.pendingApprovalIds.length > 0 || value.blockingDependencyIds.length > 0
      || required.some((entry) => !strongMethods.has(entry.verificationMethod)))) return undefined;
    if (value.disposition === "partial" && (value.usefulWorkUnitCount === 0
      || value.failedRequirementCount + value.unverifiedRequirementCount === 0 || value.reasonCode !== "requirements_unmet")) return undefined;
    if (value.disposition === "waiting_approval" && (value.pendingApprovalIds.length === 0
      || !["approval_required", "legacy_waiting_approval"].includes(value.reasonCode))) return undefined;
    if (value.disposition === "blocked" && (value.blockingDependencyIds.length === 0 || value.reasonCode !== "external_dependency")) return undefined;
    if (value.disposition === "unverified" && value.source !== "legacy_adapter"
      && (value.verificationState === "verified" || value.reasonCode !== "verification_inconclusive")) return undefined;
    if (value.disposition === "failed" && !["execution_failed", "requirements_unmet", "legacy_failed"].includes(value.reasonCode)) return undefined;
    if (value.disposition === "canceled" && !["authorized_cancellation", "legacy_canceled"].includes(value.reasonCode)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}
