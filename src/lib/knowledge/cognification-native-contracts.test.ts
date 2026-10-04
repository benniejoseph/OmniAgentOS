import { describe, expect, it } from "vitest";
import { buildKnowledgeCognitionNativeIntent, KNOWLEDGE_COGNITION_NATIVE_POLICY_SHA256, knowledgeCognitionNativeAcceptanceSchema,
  knowledgeCognitionNativeDecisionRequestSchema, sealKnowledgeCognitionNativeAcceptance, sealKnowledgeCognitionNativePin } from "@/lib/knowledge/cognification-native-contracts";
import { privateActionAcceptanceId } from "@/lib/memory/private-action-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const scope = { tenantId: "source-map-test", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
const id = `cognition_batch_${"a".repeat(48)}`;
const review = sealKnowledgeCognitionNativePin({ candidateId: id, candidateSha256: "b".repeat(64), documentId: "document:one", sourceItemId: "source:one",
  sourceRevisionId: "revision:one", sourcePolicySha256: "c".repeat(64), retentionExpiresAt: null, reviewStateSha256: "d".repeat(64), policySha256: KNOWLEDGE_COGNITION_NATIVE_POLICY_SHA256 });
describe("native source-map accepted decision contract", () => {
  it("binds the exact reviewed source and decision without adopting another key or current state", () => {
    const request = knowledgeCognitionNativeDecisionRequestSchema.parse({ contract: "asael-knowledge-cognition-decision:1", decision: "confirm", review });
    const intent = buildKnowledgeCognitionNativeIntent({ scope, reviewId: id, request, idempotencyKey: "confirmed-once" });
    const accepted = sealKnowledgeCognitionNativeAcceptance({ contract: "asael-knowledge-cognition-acceptance:1", id: privateActionAcceptanceId(scope, intent.keySha256),
      scope, operation: intent.operation, resourceId: id, keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), reviewSha256: review.reviewSha256,
      acceptedAt: "2026-10-05T10:00:00.123Z", result: { decision: "confirm", status: "confirmed", memoryId: `memory:${id}`, memoryTargetRevision: 1 } });
    expect(knowledgeCognitionNativeAcceptanceSchema.parse(accepted)).toEqual(accepted);
    expect(canonicalJsonSha256(buildKnowledgeCognitionNativeIntent({ scope, reviewId: id, request: { ...request, decision: "dismiss" }, idempotencyKey: "confirmed-once" })))
      .not.toBe(accepted.requestSha256);
    expect(() => knowledgeCognitionNativeDecisionRequestSchema.parse({ ...request, review: { ...review, sourceRevisionId: "revision:changed" } })).toThrow();
    expect(() => buildKnowledgeCognitionNativeIntent({ scope, reviewId: `cognition_batch_${"e".repeat(48)}`, request, idempotencyKey: "confirmed-once" })).toThrow();
    expect(() => knowledgeCognitionNativeAcceptanceSchema.parse({ ...accepted, result: { ...accepted.result, memoryId: "memory:other" } })).toThrow();
  });
  it("keeps dismissal separate from Memory creation and rejects extra authority", () => {
    expect(() => knowledgeCognitionNativeDecisionRequestSchema.parse({ contract: "asael-knowledge-cognition-decision:1", decision: "dismiss", review, grants: ["invented"] })).toThrow();
    const request = knowledgeCognitionNativeDecisionRequestSchema.parse({ contract: "asael-knowledge-cognition-decision:1", decision: "dismiss", review });
    const intent = buildKnowledgeCognitionNativeIntent({ scope, reviewId: id, request, idempotencyKey: "dismiss-once" });
    expect(() => sealKnowledgeCognitionNativeAcceptance({ contract: "asael-knowledge-cognition-acceptance:1", id: privateActionAcceptanceId(scope, intent.keySha256),
      scope, operation: intent.operation, resourceId: id, keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), reviewSha256: review.reviewSha256,
      acceptedAt: "2026-10-05T10:00:00.123Z", result: { decision: "dismiss", status: "dismissed", memoryId: `memory:${id}`, memoryTargetRevision: 1 } })).toThrow();
  });
});
