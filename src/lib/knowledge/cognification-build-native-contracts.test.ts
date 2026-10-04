import { describe,expect,it } from "vitest";
import { buildNativeCognitionBuildIntent,cognitionBuildAcceptanceId,NATIVE_COGNITION_BUILD_POLICY_SHA256,nativeCognitionBuildAcceptanceSchema,
  nativeCognitionBuildProcessingSchema,nativeCognitionBuildRequestSchema,sealNativeCognitionBuildAcceptance,sealNativeCognitionBuildPin } from "@/lib/knowledge/cognification-build-native-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const scope = { tenantId: "cognition-build-test",ownerActorId: "owner@example.test",canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
const review = sealNativeCognitionBuildPin({ documentId: "document:one",sourceItemId: "source:one",sourceRevisionId: "revision:one",sourcePolicySha256: "a".repeat(64),
  retentionExpiresAt: null,generationId: `cognition_generation_${"a".repeat(48)}`,sourcePlanSha256: "b".repeat(64),batchCount: 2,existingReviewCount: 1,
  existingReviewManifestSha256: "c".repeat(64),policySha256: NATIVE_COGNITION_BUILD_POLICY_SHA256 });
describe("native paid cognition contracts", () => {
  it("binds the exact source, routing generation and stable key without accepting edited pins", () => {
    const request = nativeCognitionBuildRequestSchema.parse({ contract: "asael-knowledge-cognition-build:1",review });
    const intent = buildNativeCognitionBuildIntent({ scope,documentId: review.documentId,request,idempotencyKey: "paid-once" });
    const acceptance = sealNativeCognitionBuildAcceptance({ contract: "asael-knowledge-cognition-build-acceptance:1",id: cognitionBuildAcceptanceId(scope,intent.keySha256),scope,
      documentId: review.documentId,keySha256: intent.keySha256,requestSha256: canonicalJsonSha256(intent),reviewSha256: review.reviewSha256,sourcePlanSha256: review.sourcePlanSha256,
      operationJobId: "job:one",totalBatches: 2,reusedBatches: 1,acceptedAt: "2026-10-05T10:00:00.123Z" });
    expect(nativeCognitionBuildAcceptanceSchema.parse(acceptance)).toEqual(acceptance);
    expect(() => nativeCognitionBuildRequestSchema.parse({ ...request,review: { ...review,generationId: `cognition_generation_${"b".repeat(48)}` } })).toThrow();
    expect(() => buildNativeCognitionBuildIntent({ scope,documentId: "document:other",request,idempotencyKey: "paid-once" })).toThrow();
    expect(() => nativeCognitionBuildRequestSchema.parse({ ...request,automaticRetry: true })).toThrow();
    expect(() => nativeCognitionBuildAcceptanceSchema.parse({ ...acceptance,reusedBatches: 2 })).toThrow();
  });
  it("cannot report completion without distinct saved reviews and never enables automatic retry", () => {
    const observation = { phase: "completed",totalBatches: 2,completedBatches: 2,reusedBatches: 1,
      reviewIds: [`cognition_batch_${"a".repeat(48)}`,`cognition_batch_${"b".repeat(48)}`],reason: null,automaticRetryAllowed: false };
    expect(nativeCognitionBuildProcessingSchema.parse(observation)).toEqual(observation);
    expect(() => nativeCognitionBuildProcessingSchema.parse({ ...observation,reviewIds: [observation.reviewIds[0],observation.reviewIds[0]] })).toThrow();
    expect(() => nativeCognitionBuildProcessingSchema.parse({ ...observation,completedBatches: 1 })).toThrow();
    expect(() => nativeCognitionBuildProcessingSchema.parse({ ...observation,automaticRetryAllowed: true })).toThrow();
  });
});
