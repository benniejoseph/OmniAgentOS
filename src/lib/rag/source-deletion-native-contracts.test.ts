import { describe, expect, it } from "vitest";
import { privateActionAcceptanceId } from "@/lib/memory/private-action-contracts";
import { buildNativeKnowledgeSourceDeletionIntent, NATIVE_KNOWLEDGE_SOURCE_DELETION_POLICY_SHA256,
  nativeKnowledgeSourceDeletionAcceptanceSchema, nativeKnowledgeSourceDeletionRequestSchema, nativeKnowledgeSourceDeletionReviewSchema,
  sealNativeKnowledgeSourceDeletionAcceptance, sealNativeKnowledgeSourceDeletionPin } from "@/lib/rag/source-deletion-native-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const scope = { tenantId: "source-delete-test", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
const review = sealNativeKnowledgeSourceDeletionPin({ sourceKind: "mail", documentCount: 2, derivedMemoryCount: 1,
  retrievalTraceCount: 0, graphNodeCount: 1, graphEdgeCount: 0, manifestSha256: "a".repeat(64), policySha256: NATIVE_KNOWLEDGE_SOURCE_DELETION_POLICY_SHA256 });
describe("native complete local source deletion contract", () => {
  it("binds source, complete manifest, owner and stable key without retaining deleted contents", () => {
    const request = nativeKnowledgeSourceDeletionRequestSchema.parse({ contract: "asael-knowledge-source-delete:1", review });
    const intent = buildNativeKnowledgeSourceDeletionIntent({ scope, sourceKind: "mail", request, idempotencyKey: "delete-one" });
    const accepted = sealNativeKnowledgeSourceDeletionAcceptance({ contract: "asael-knowledge-source-deletion-acceptance:1",
      id: privateActionAcceptanceId(scope,intent.keySha256), operation: intent.operation, scope, resourceId: intent.resourceId, keySha256: intent.keySha256,
      requestSha256: canonicalJsonSha256(intent), reviewSha256: review.reviewSha256, acceptedAt: "2026-10-05T10:00:00.123Z",
      result: { sourceKind: "mail", localOnly: true, manifestSha256: review.manifestSha256, documents: 2, memories: 1, retrievalTraces: 0, graphNodes: 1, graphEdges: 0 } });
    expect(nativeKnowledgeSourceDeletionAcceptanceSchema.parse(accepted)).toEqual(accepted);
    expect(() => buildNativeKnowledgeSourceDeletionIntent({ scope, sourceKind: "drive", request, idempotencyKey: "delete-one" })).toThrow();
    expect(() => nativeKnowledgeSourceDeletionRequestSchema.parse({ ...request, review: { ...review, documentCount: 1 } })).toThrow();
    expect(() => nativeKnowledgeSourceDeletionAcceptanceSchema.parse({ ...accepted, result: { ...accepted.result, deletedTitles: ["Private title"] } })).toThrow();
    expect(() => nativeKnowledgeSourceDeletionAcceptanceSchema.parse({ ...accepted, scope: { ...scope, ownerActorId: "other@example.test" } })).toThrow();
  });
  it("never publishes an actionable truncated or unsupported review", () => {
    const documents = [{ id: "one", title: "One", expired: false }];
    expect(() => nativeKnowledgeSourceDeletionReviewSchema.parse({ sourceKind: "mail", localOnly: true, futureImportsMayReappear: true,
      eligible: true, reason: null, pin: review, documents })).toThrow();
    expect(() => nativeKnowledgeSourceDeletionReviewSchema.parse({ sourceKind: "mail", localOnly: true, futureImportsMayReappear: true,
      eligible: true, reason: "unsupported_memory_lineage", pin: null, documents })).toThrow();
    expect(() => nativeKnowledgeSourceDeletionRequestSchema.parse({ contract: "asael-knowledge-source-delete:1", review, providerDelete: true })).toThrow();
  });
});
