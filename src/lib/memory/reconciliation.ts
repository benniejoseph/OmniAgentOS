import { z } from "zod";
import type { MemoryRecord } from "@/lib/memory/types";

export const memoryReconciliationKindSchema = z.enum([
  "confirmation",
  "contradiction",
]);

export const memoryReconciliationStatusSchema = z.enum([
  "pending",
  "resolved",
]);

export const memoryReconciliationDecisionSchema = z.enum([
  "confirm_candidate",
  "keep_existing",
  "keep_both",
]);

export const memoryReconciliationDetectionReasonSchema = z.enum([
  "unconfirmed_candidate",
  "unverified_inference",
  "unverified_workflow_output",
  "similar_claim_conflict",
  "explicit_contradiction",
  "legacy_candidate",
]);

export type MemoryReconciliationKind = z.infer<
  typeof memoryReconciliationKindSchema
>;
export type MemoryReconciliationStatus = z.infer<
  typeof memoryReconciliationStatusSchema
>;
export type MemoryReconciliationDecision = z.infer<
  typeof memoryReconciliationDecisionSchema
>;
export type MemoryReconciliationDetectionReason = z.infer<
  typeof memoryReconciliationDetectionReasonSchema
>;

export type MemoryReconciliationReview = {
  id: string;
  tenantId: string;
  ownerActorId?: string;
  kind: MemoryReconciliationKind;
  status: MemoryReconciliationStatus;
  decision?: MemoryReconciliationDecision;
  detectionReason: MemoryReconciliationDetectionReason;
  candidate: MemoryRecord;
  existing?: MemoryRecord;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
};

export type MemoryReconciliationResolution = Readonly<{
  candidateStatus: "active" | "superseded";
  existingStatus?: "active" | "contradicted";
  closeCandidateValidity: boolean;
  closeExistingValidity: boolean;
}>;

/**
 * One deterministic state transition shared by file and Postgres stores.
 * Candidates never become retrievable before an explicit review decision.
 */
export function memoryReconciliationResolution(
  kind: MemoryReconciliationKind,
  decision: MemoryReconciliationDecision,
): MemoryReconciliationResolution {
  const parsedKind = memoryReconciliationKindSchema.parse(kind);
  const parsedDecision = memoryReconciliationDecisionSchema.parse(decision);
  if (parsedKind === "confirmation" && parsedDecision === "keep_both") {
    throw new Error(
      "A confirmation review cannot keep both because it has no existing claim.",
    );
  }

  if (parsedDecision === "confirm_candidate") {
    return Object.freeze({
      candidateStatus: "active" as const,
      ...(parsedKind === "contradiction"
        ? { existingStatus: "contradicted" as const }
        : {}),
      closeCandidateValidity: false,
      closeExistingValidity: parsedKind === "contradiction",
    });
  }
  if (parsedDecision === "keep_existing") {
    return Object.freeze({
      candidateStatus: "superseded" as const,
      ...(parsedKind === "contradiction"
        ? { existingStatus: "active" as const }
        : {}),
      closeCandidateValidity: true,
      closeExistingValidity: false,
    });
  }
  return Object.freeze({
    candidateStatus: "active" as const,
    existingStatus: "active" as const,
    closeCandidateValidity: false,
    closeExistingValidity: false,
  });
}

export function memoryReconciliationDetectionReason(
  record: Pick<MemoryRecord, "assertedBy" | "contradictionOfId" | "source" | "tags">,
): MemoryReconciliationDetectionReason {
  if (record.contradictionOfId) {
    return record.source.startsWith("correction:")
      ? "explicit_contradiction"
      : "similar_claim_conflict";
  }
  if (record.assertedBy === "agent") return "unverified_inference";
  if (record.source.toLowerCase().includes("workflow")) {
    return "unverified_workflow_output";
  }
  return "unconfirmed_candidate";
}
