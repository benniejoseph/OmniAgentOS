import { describe, expect, it } from "vitest";
import { buildNativeMemoryDeterministicIntent, nativeMemoryDeterministicAcceptanceSchema, nativeMemoryGraphRebuildRequestSchema,
  nativeMemoryMaintenanceRequestSchema, NATIVE_MEMORY_GRAPH_POLICY_SHA256, NATIVE_MEMORY_MAINTENANCE_POLICY_SHA256,
  sealNativeMemoryGraphRebuildPin, sealNativeMemoryMaintenancePin } from "@/lib/memory/deterministic-native-contracts";
import { privateActionAcceptanceId } from "@/lib/memory/private-action-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const scope = { tenantId: "test", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
describe("private deterministic Memory contracts", () => {
  it("binds operation, owner, complete inventory, policy and stable key without an execution timestamp", () => {
    const review = sealNativeMemoryMaintenancePin({ policyVersion: 1, eligibleMemoryCount: 2, inventorySha256: "a".repeat(64), planSha256: "b".repeat(64), policySha256: NATIVE_MEMORY_MAINTENANCE_POLICY_SHA256 });
    const request = nativeMemoryMaintenanceRequestSchema.parse({ contract: "asael-memory-maintenance-run:1", review });
    const input = { scope, kind: "maintenance" as const, request, idempotencyKey: "once" }, intent = buildNativeMemoryDeterministicIntent(input);
    expect(buildNativeMemoryDeterministicIntent(input)).toEqual(intent);
    expect(buildNativeMemoryDeterministicIntent({ ...input, idempotencyKey: "another" }).keySha256).not.toBe(intent.keySha256);
    expect(() => nativeMemoryMaintenanceRequestSchema.parse({ ...request, review: { ...review, eligibleMemoryCount: 3 } })).toThrow();
    expect(() => buildNativeMemoryDeterministicIntent({ ...input, kind: "graph" })).toThrow();
    expect(() => nativeMemoryMaintenanceRequestSchema.parse({ ...request, purposeId: "memory.maintenance.v1" })).toThrow();
  });
  it("rejects altered acceptance identity or result and incomplete graph bounds", () => {
    const review = sealNativeMemoryGraphRebuildPin({ memoryCount: 3, traceCount: 1, sourceManifestSha256: "c".repeat(64), graphPolicySha256: NATIVE_MEMORY_GRAPH_POLICY_SHA256 });
    const request = nativeMemoryGraphRebuildRequestSchema.parse({ contract: "asael-memory-graph-rebuild:1", review });
    const intent = buildNativeMemoryDeterministicIntent({ scope, kind: "graph", request, idempotencyKey: "graph-once" });
    const body = { contract: "asael-memory-graph-rebuild-acceptance:1", id: privateActionAcceptanceId(scope, intent.keySha256), scope,
      operation: intent.operation, resourceId: intent.resourceId, keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent),
      reviewSha256: review.reviewSha256, acceptedAt: "2026-10-04T12:00:00.000Z", result: { memoryCount: 3, traceCount: 1, nodeCount: 12, edgeCount: 20 } };
    const accepted = { ...body, acceptanceSha256: canonicalJsonSha256(body) };
    expect(nativeMemoryDeterministicAcceptanceSchema.parse(accepted)).toEqual(accepted);
    expect(() => nativeMemoryDeterministicAcceptanceSchema.parse({ ...accepted, result: { ...accepted.result, edgeCount: 19 } })).toThrow();
    expect(() => nativeMemoryDeterministicAcceptanceSchema.parse({ ...accepted, id: `private-action-acceptance:${"d".repeat(64)}` })).toThrow();
    expect(() => sealNativeMemoryGraphRebuildPin({ ...review, memoryCount: 2001 })).toThrow();
  });
});
