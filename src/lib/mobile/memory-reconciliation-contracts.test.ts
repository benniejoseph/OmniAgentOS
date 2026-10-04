import { describe, expect, it } from "vitest";
import { publicMemoryServiceRecord } from "@/lib/app-services/memory";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptBodySchema } from "@/lib/app-services/receipt-contracts";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import {
  nativeMemoryReconciliationDecisionRequestSchema,
  nativeMemoryReconciliationListResponseSchema,
  nativeMemoryReconciliationQuerySchema,
  nativeMemoryReconciliationReviewSchema,
} from "@/lib/mobile/memory-reconciliation-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const at = "2026-10-04T00:00:00.000Z", tenantId = "tenant-review", ownerActorId = "actor:11111111-1111-4111-8111-111111111111";
function review() {
  const candidate = publicMemoryServiceRecord({
    id: "memory-one", tenantId, type: "fact", title: "Meeting date", content: "Thursday", tags: [], scope: "user", source: "manual", importance: 0.7,
    assertedBy: "user", claimStatus: "candidate", createdAt: at, updatedAt: at,
    accessBinding: buildUserPrivateMemoryAccessBindingV1({ tenantId, ownerActorId, originPurpose: "test", accessBoundAt: at }),
  });
  return { id: "review-one", tenantId, kind: "confirmation" as const, status: "pending" as const, detectionReason: "unconfirmed_candidate" as const,
    candidate, createdAt: at, updatedAt: at, reviewToken: "a".repeat(64) };
}
function response(item = review()) {
  const body = { contract: "asael-memory-reconciliation-read:1", scope: { tenantId, ownerActorId, visibility: "user_private" }, reviews: [item] };
  const receipt = appServiceReceiptBodySchema.parse({ schemaVersion: 1, receiptKind: "app_service_receipt", boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    operation: "memory.reconciliation.list", action: "read", resourceType: "memory_reconciliation", accessMode: "read", eventContract: "read_only:no_domain_mutation",
    authoritySha256: "b".repeat(64), idempotencyKeySha256: null, outcomeSha256: canonicalJsonSha256(body), resourceCount: 1, occurredAt: at });
  return { ...body, serviceReceipt: { ...receipt, receiptSha256: canonicalJsonSha256(receipt) } };
}
describe("v35 native Memory reconciliation publication", () => {
  it("accepts public Memory records and a receipt bound to the exact bounded list", () => {
    const value = response(); expect(nativeMemoryReconciliationListResponseSchema.parse(value)).toEqual(value);
  });
  it.each([
    { contract: "asael-memory-reconciliation-read:1", limit: 101 },
    { contract: "asael-memory-reconciliation-read:1", limit: 0 },
    { contract: "asael-memory-reconciliation-read:1", status: "other" },
    { contract: "asael-memory-reconciliation-read:1", ownerActorId },
    { limit: 50 },
  ])("rejects unbounded or scope-overriding list requests %#", (input) => {
    expect(nativeMemoryReconciliationQuerySchema.safeParse(input).success).toBe(false);
  });
  it("accepts only the reviewed native decision envelope", () => {
    const request = { contract: "asael-memory-reconciliation-decision:1", reviewId: "review-one", decision: "confirm_candidate", expectedReviewToken: "a".repeat(64) };
    expect(nativeMemoryReconciliationDecisionRequestSchema.parse(request)).toEqual(request);
    for (const invalid of [{ ...request, tenantId }, { ...request, reviewId: "x".repeat(201) }, { ...request, expectedReviewToken: "" }, { reviewId: "review-one", decision: "confirm_candidate" }]) {
      expect(nativeMemoryReconciliationDecisionRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("refuses raw bindings, cross-tenant targets and non-private scope labels", () => {
    const value = review();
    for (const candidate of [
      { ...value.candidate, accessBinding: { ownerActorId } },
      { ...value.candidate, tenantId: "other" },
      { ...value.candidate, access: { ...value.candidate.access, visibility: "agent_private" } },
      { ...value.candidate, access: { ...value.candidate.access, owner: undefined } },
      { ...value.candidate, claimStatus: "forgotten" },
    ]) expect(nativeMemoryReconciliationReviewSchema.safeParse({ ...value, candidate }).success).toBe(false);
  });
  it("rejects historical tokens and invalid confirmation decisions", () => {
    const value = review();
    for (const invalid of [{ ...value, status: "resolved", decision: "confirm_candidate", resolvedAt: at },
      { ...value, status: "resolved", decision: "keep_both", resolvedAt: at, reviewToken: null },
      { ...value, kind: "contradiction" }, { ...value, decision: "confirm_candidate" }]) {
      expect(nativeMemoryReconciliationReviewSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("rejects response body drift despite an otherwise valid service receipt", () => {
    const value = response();
    expect(nativeMemoryReconciliationListResponseSchema.safeParse({ ...value, reviews: [] }).success).toBe(false);
    expect(nativeMemoryReconciliationListResponseSchema.safeParse({ ...value, reviews: [...value.reviews, ...value.reviews] }).success).toBe(false);
  });
});
