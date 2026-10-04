import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), exact: vi.fn(), resolve: vi.fn(), graph: vi.fn(), entities: vi.fn(), retire: vi.fn() }));
vi.mock("@/lib/memory/store", () => ({
  listPrivateMemoryReconciliationReviews: mocks.list,
  getPrivateMemoryReconciliationReview: mocks.exact,
  resolvePrivateMemoryReconciliationReview: mocks.resolve,
}));
vi.mock("@/lib/memory/graph", () => ({ indexUserPrivateMemoryGraphRecords: mocks.graph }));
vi.mock("@/lib/entities/extraction", async (original) => ({
  ...(await original<typeof import("@/lib/entities/extraction")>()),
  projectExplicitMemoryEntities: mocks.entities,
}));
vi.mock("@/lib/entities/store", () => ({ retireEntityMemoryLineage: mocks.retire }));

import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { inspectMemoryReconciliationService, listMemoryReconciliationService, resolveMemoryReconciliationService } from "@/lib/app-services/memory-reconciliation";
import { MAIN_AGENT_APP_SERVICE_BINDINGS } from "@/lib/app-services/registry";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import type { MemoryReconciliationReview } from "@/lib/memory/reconciliation";
import { memoryReconciliationNativeAcceptanceSchema, memoryReconciliationNativeIntent } from "@/lib/memory/reconciliation-native-contracts";
import {
  nativeMemoryReconciliationDecisionResponseSchema,
  nativeMemoryReconciliationListResponseSchema,
  nativeMemoryReconciliationReadResponseSchema,
} from "@/lib/mobile/memory-reconciliation-contracts";
import type { SecurityContext } from "@/lib/security/types";

const at = "2026-10-04T00:00:00.000Z";
const context: SecurityContext = {
  tenantId: "tenant-review", actorId: "owner@example.test", role: "admin", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "session-review", tenantName: "Private" },
};
const ownerActorId = `actor:${context.auth!.userId}`;
const request = { contract: "asael-memory-reconciliation-decision:1" as const, reviewId: "review-one", decision: "confirm_candidate" as const, expectedReviewToken: "a".repeat(64) };
const key = "review-key-one";
function review(resolved = true): MemoryReconciliationReview {
  const candidate = {
    id: "memory-new", tenantId: context.tenantId, type: "fact" as const, title: "Claim", content: "Project meeting is Thursday.",
    tags: [], scope: "user" as const, source: "correction:owner", importance: 0.7, assertedBy: "user" as const,
    claimStatus: resolved ? "active" as const : "candidate" as const, createdAt: at, updatedAt: at, embedding: [0.1],
    accessBinding: buildUserPrivateMemoryAccessBindingV1({ tenantId: context.tenantId, ownerActorId, originPurpose: "test", accessBoundAt: at }),
  };
  return { id: request.reviewId, tenantId: context.tenantId, ownerActorId, kind: "contradiction", status: resolved ? "resolved" : "pending",
    ...(resolved ? { decision: request.decision, resolvedAt: at, resolvedBy: ownerActorId } : {}),
    detectionReason: "explicit_contradiction", candidate,
    existing: { ...candidate, id: "memory-old", content: "Project meeting is Tuesday.", claimStatus: resolved ? "contradicted" : "active" }, createdAt: at, updatedAt: at };
}
function committed(newlyApplied = true) {
  const intent = memoryReconciliationNativeIntent({ tenantId: context.tenantId, ownerActorId, reviewId: request.reviewId, idempotencyKey: key, request });
  const target = { memoryId: "memory-new", claimStatus: "candidate" as const, targetRevision: 1, lifecycleRevision: 0 };
  const oldTarget = { ...target, memoryId: "memory-old", claimStatus: "active" as const };
  const acceptance = memoryReconciliationNativeAcceptanceSchema.parse({
    contract: "asael-memory-reconciliation-acceptance:1", id: intent.acceptanceId,
    tenantId: context.tenantId, ownerActorId, reviewId: request.reviewId, candidateMemoryId: "memory-new", existingMemoryId: "memory-old",
    decision: request.decision, idempotencyKeySha256: intent.keySha256, requestSha256: intent.requestSha256,
    expectedReviewToken: request.expectedReviewToken, resolvedAt: at,
    before: { candidate: target, existing: oldTarget },
    after: { candidate: { ...target, claimStatus: "active", targetRevision: 2 }, existing: { ...oldTarget, claimStatus: "contradicted", targetRevision: 2 } },
  });
  return { review: review(), reviewToken: null, acceptance, newlyApplied };
}
function mutationCaller() {
  return createRequestMutationAppServiceCaller(new Request("http://localhost/api/memory/reconciliation", { method: "PATCH", headers: { "Idempotency-Key": key } }), context,
    { purpose: "api.memory.reconciliation.native.resolve", causationId: request.reviewId });
}
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.graph.mockResolvedValue(undefined); mocks.entities.mockResolvedValue(undefined); mocks.retire.mockResolvedValue(undefined);
});

describe("canonical private reconciliation service", () => {
  it("lists only the canonical read scope, strips private internals, and withholds viewer decisions", async () => {
    mocks.list.mockResolvedValue([{ review: review(false), reviewToken: request.expectedReviewToken, acceptance: null }]);
    const result = await listMemoryReconciliationService(createAppServiceCaller({ context: { ...context, role: "viewer" } }), {
      contract: "asael-memory-reconciliation-read:1", status: "pending", limit: 3,
    });
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ tenantId: context.tenantId, ownerActorId,
      accessScope: expect.objectContaining({ purposeId: "memory.read.v1" }) }), { status: "pending", limit: 3 });
    expect(result.data.reviews[0].reviewToken).toBeNull();
    expect(result.data.reviews[0].candidate).not.toHaveProperty("embedding");
    expect(result.data.reviews[0].candidate).not.toHaveProperty("accessBinding");
    expect(result.data.reviews[0]).not.toHaveProperty("resolvedBy");
    expect(nativeMemoryReconciliationListResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt })).toBeTruthy();
  });
  it("reads the exact target and separates another native acceptance from observed resolution", async () => {
    mocks.exact.mockResolvedValue(committed());
    const result = await inspectMemoryReconciliationService(createAppServiceCaller({ context }), request.reviewId, { acceptanceKeySha256: "f".repeat(64) });
    expect(mocks.exact).toHaveBeenCalledWith(expect.objectContaining({ ownerActorId }), request.reviewId);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(result.data.review.status).toBe("resolved");
    expect(result.data.acceptance).toBeNull();
    expect(nativeMemoryReconciliationReadResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt })).toBeTruthy();
    expect(mocks.graph).not.toHaveBeenCalled();
  });
  it("returns matching accepted evidence on exact recovery without side effects", async () => {
    const stored = committed(); mocks.exact.mockResolvedValue(stored);
    const result = await inspectMemoryReconciliationService(createAppServiceCaller({ context }), request.reviewId, { acceptanceKeySha256: stored.acceptance.idempotencyKeySha256 });
    expect(result.data.acceptance).toEqual(stored.acceptance);
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.graph).not.toHaveBeenCalled();
    expect(mocks.entities).not.toHaveBeenCalled(); expect(mocks.retire).not.toHaveBeenCalled();
  });
  it("fails exact missing authority or review without list or legacy recovery", async () => {
    await expect(inspectMemoryReconciliationService(createAppServiceCaller({ context: { ...context, source: "service" } }), request.reviewId)).rejects.toMatchObject({ status: 403 });
    expect(mocks.exact).not.toHaveBeenCalled();
    mocks.exact.mockResolvedValue(null);
    await expect(inspectMemoryReconciliationService(createAppServiceCaller({ context }), request.reviewId)).rejects.toMatchObject({ status: 404 });
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("commits one exact decision and binds the correct purpose plus downstream outcomes", async () => {
    mocks.resolve.mockResolvedValue(committed());
    const result = await resolveMemoryReconciliationService(mutationCaller(), request);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ request, reviewId: request.reviewId, idempotencyKey: key,
      authority: expect.objectContaining({ ownerActorId, accessScope: expect.objectContaining({ purposeId: "memory.correct.v1" }) }) }));
    expect(result.data.projections).toEqual({ graph: "confirmed", entities: "confirmed", retiredLineage: "confirmed" });
    expect(result.receipt.idempotencyKeySha256).not.toEqual(result.data.acceptance.idempotencyKeySha256);
    expect(nativeMemoryReconciliationDecisionResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt })).toBeTruthy();
  });
  it("preserves a committed decision when graph and entity projections fail independently", async () => {
    mocks.resolve.mockResolvedValue(committed()); mocks.graph.mockRejectedValue(new Error("graph unavailable")); mocks.entities.mockRejectedValue(new Error("entities unavailable"));
    const result = await resolveMemoryReconciliationService(mutationCaller(), request);
    expect(result.data.acceptance.reviewId).toBe(request.reviewId);
    expect(result.data.projections).toEqual({ graph: "unconfirmed", entities: "unconfirmed", retiredLineage: "confirmed" });
    expect(mocks.retire).toHaveBeenCalledOnce();
  });
  it.each(["agent", "system", "import"] as const)("does not relabel a %s claim to force entity creation while retiring old lineage", async (assertedBy) => {
    const stored = committed(); stored.review.candidate.assertedBy = assertedBy; mocks.resolve.mockResolvedValue(stored);
    const result = await resolveMemoryReconciliationService(mutationCaller(), request);
    expect(result.data.review.candidate.assertedBy).toBe(assertedBy);
    expect(result.data.projections.entities).toBe("not_applicable");
    expect(mocks.entities).not.toHaveBeenCalled(); expect(mocks.retire).toHaveBeenCalledOnce();
  });
  it("never repeats projections for a matching replay", async () => {
    mocks.resolve.mockResolvedValue(committed(false));
    const result = await resolveMemoryReconciliationService(mutationCaller(), request);
    expect(result.data.replayed).toBe(true);
    expect(result.data.projections).toEqual({ graph: "not_repeated", entities: "not_repeated", retiredLineage: "not_repeated" });
    expect(mocks.graph).not.toHaveBeenCalled(); expect(mocks.entities).not.toHaveBeenCalled(); expect(mocks.retire).not.toHaveBeenCalled();
  });
  it("does not enroll an agent tool merely by registering native services", () => {
    expect(MAIN_AGENT_APP_SERVICE_BINDINGS.some((binding) => binding.operation.startsWith("memory.reconciliation."))).toBe(false);
  });
});
