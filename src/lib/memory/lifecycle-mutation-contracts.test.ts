import { describe, expect, it } from "vitest";
import {
  lifecycleTokensEqual, memoryLifecycleAcceptanceSchema, memoryLifecycleIntent,
  memoryLifecycleMutationRequestSchema, memoryLifecycleReadSchema, memoryLifecycleTargetToken,
  type MemoryLifecycleTargetIdentity,
} from "@/lib/memory/lifecycle-mutation-contracts";

const target: MemoryLifecycleTargetIdentity = {
  tenantId: "tenant-a", ownerActorId: "actor:11111111-1111-4111-8111-111111111111",
  memoryId: "memory-a", visibility: "user_private", claimStatus: "active", targetRevision: 4, lifecycleRevision: 2,
};
const lifecycle = { policyVersion: 1, pinnedAt: null, archivedAt: null, archiveReason: null, duplicateOfMemoryId: null, updatedAt: null };
const request = { contract: "asael-memory-lifecycle-mutation:1" as const, action: "pin" as const, expectedTargetToken: memoryLifecycleTargetToken(target) };
const input = { ...target, idempotencyKey: "test-key", request };

describe("exact private Memory lifecycle contracts", () => {
  it("binds both counters, exact target, owner, tenant and claim state without accepting content or use counters", () => {
    const token = memoryLifecycleTargetToken(target);
    for (const change of [
      { targetRevision: 5 }, { lifecycleRevision: 3 }, { memoryId: "memory-b" },
      { ownerActorId: "actor:22222222-2222-4222-8222-222222222222" }, { tenantId: "tenant-b" }, { claimStatus: "superseded" as const },
    ]) expect(memoryLifecycleTargetToken({ ...target, ...change })).not.toBe(token);
    expect(() => memoryLifecycleTargetToken({ ...target, content: "private" } as never)).toThrow();
    expect(() => memoryLifecycleTargetToken({ ...target, useCount: 9 } as never)).toThrow();
    expect(lifecycleTokensEqual(token, token)).toBe(true);
    expect(lifecycleTokensEqual(token, "not-a-token")).toBe(false);
  });
  it("freezes exact action and token while scoping reusable key identities to the owner and tenant", () => {
    const accepted = memoryLifecycleIntent(input);
    expect(memoryLifecycleIntent(input)).toEqual(accepted);
    expect(memoryLifecycleIntent({ ...input, request: { ...request, action: "unpin" } }).requestSha256).not.toBe(accepted.requestSha256);
    expect(memoryLifecycleIntent({ ...input, request: { ...request, expectedTargetToken: "f".repeat(64) } }).requestSha256).not.toBe(accepted.requestSha256);
    expect(memoryLifecycleIntent({ ...input, memoryId: "memory-b" }).acceptanceId).toBe(accepted.acceptanceId);
    expect(memoryLifecycleIntent({ ...input, ownerActorId: "actor:22222222-2222-4222-8222-222222222222" }).acceptanceId).not.toBe(accepted.acceptanceId);
    expect(() => memoryLifecycleIntent({ ...input, idempotencyKey: "bad key" })).toThrow();
  });
  it("does not admit authority fields, invented operations or unbounded target tokens", () => {
    expect(memoryLifecycleMutationRequestSchema.safeParse({ ...request, ownerActorId: target.ownerActorId }).success).toBe(false);
    expect(memoryLifecycleMutationRequestSchema.safeParse({ ...request, action: "forget" }).success).toBe(false);
    expect(memoryLifecycleMutationRequestSchema.safeParse({ ...request, expectedTargetToken: "a".repeat(65) }).success).toBe(false);
  });
  it("rejects inconsistent lifecycle states instead of turning absent archival evidence into a false success", () => {
    const read = { contract: "asael-memory-lifecycle-read:1", target: { ...target, token: request.expectedTargetToken }, lifecycle };
    expect(memoryLifecycleReadSchema.safeParse(read).success).toBe(true);
    expect(memoryLifecycleReadSchema.safeParse({ ...read, lifecycle: { ...lifecycle, archivedAt: "2026-10-04T00:00:00.000Z" } }).success).toBe(false);
    expect(memoryLifecycleReadSchema.safeParse({ ...read, target: { ...read.target, claimStatus: "forgotten" } }).success).toBe(false);
  });
  it("requires one exact accepted transition and excludes private payload additions", () => {
    const intent = memoryLifecycleIntent(input);
    const acceptance = {
      contract: "asael-memory-lifecycle-acceptance:1", id: intent.acceptanceId,
      tenantId: target.tenantId, ownerActorId: target.ownerActorId, memoryId: target.memoryId,
      action: request.action, idempotencyKeySha256: intent.keySha256, requestSha256: intent.requestSha256,
      expectedTargetToken: request.expectedTargetToken,
      acceptedAt: "2026-10-04T00:00:00.000Z", targetRevision: 4, beforeLifecycleRevision: 2, afterLifecycleRevision: 3,
      lifecycle: { ...lifecycle, pinnedAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" },
      historicalTruthChanged: false, permanentDeletion: false,
    };
    expect(memoryLifecycleAcceptanceSchema.safeParse(acceptance).success).toBe(true);
    expect(memoryLifecycleAcceptanceSchema.safeParse({ ...acceptance, afterLifecycleRevision: 4 }).success).toBe(false);
    expect(memoryLifecycleAcceptanceSchema.safeParse({ ...acceptance, action: "unpin" }).success).toBe(false);
    expect(memoryLifecycleAcceptanceSchema.safeParse({ ...acceptance, content: "private" }).success).toBe(false);
  });
});
