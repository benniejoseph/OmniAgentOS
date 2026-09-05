import { timingSafeEqual } from "node:crypto";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type ApprovalBindingDecision = Readonly<
  | { accepted: true; reason: "exact_binding" }
  | { accepted: false; reason: "material_binding_changed" }
>;

/** Hashes the complete material target/input binding presented for approval. */
export function approvalMaterialBindingSha256(value: {
  targetSha256: string;
  inputSha256: string;
}) {
  return canonicalJsonSha256(parseMaterialBinding(value));
}

/**
 * An approval is reusable only for the exact binding that was reviewed.
 * Malformed digests fail closed before comparison.
 */
export function evaluateApprovalBinding(input: {
  approvedBindingSha256: string;
  requestedBindingSha256: string;
}): ApprovalBindingDecision {
  const approved = parseSha256(input.approvedBindingSha256);
  const requested = parseSha256(input.requestedBindingSha256);
  const accepted = timingSafeEqual(Buffer.from(approved, "hex"), Buffer.from(requested, "hex"));
  return Object.freeze(accepted
    ? { accepted: true as const, reason: "exact_binding" as const }
    : { accepted: false as const, reason: "material_binding_changed" as const });
}

function parseMaterialBinding(value: {
  targetSha256: string;
  inputSha256: string;
}) {
  return Object.freeze({
    targetSha256: parseSha256(value.targetSha256),
    inputSha256: parseSha256(value.inputSha256),
  });
}

function parseSha256(value: string) {
  const normalized = value.trim();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error("Approval bindings require canonical lowercase SHA-256 digests.");
  }
  return normalized;
}
