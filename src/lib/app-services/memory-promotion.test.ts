import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), decide: vi.fn(), graph: vi.fn(), entities: vi.fn() }));
vi.mock("@/lib/memory/promotion-native-store", () => ({
  listPrivateMemoryPromotionReviews: mocks.list, getPrivateMemoryPromotionReview: mocks.read, resolvePrivateMemoryPromotionReview: mocks.decide,
}));
vi.mock("@/lib/memory/graph", () => ({ indexUserPrivateMemoryGraphRecords: mocks.graph }));
vi.mock("@/lib/entities/extraction", async (original) => ({
  ...(await original<typeof import("@/lib/entities/extraction")>()), projectExplicitMemoryEntities: mocks.entities,
}));
import { decideMemoryPromotionService, inspectMemoryPromotionService, listMemoryPromotionService } from "@/lib/app-services/memory-promotion";
import { MAIN_AGENT_APP_SERVICE_BINDINGS } from "@/lib/app-services/registry";
import { promotionContext, promotionFixture, promotionMutationCaller, promotionOwnerId, promotionReadCaller } from "@/lib/mobile/memory-promotion.test-fixtures";

beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); mocks.graph.mockResolvedValue(undefined); });
describe("private native promotion services", () => {
  it("publishes compact summaries through exact canonical read authority", async () => {
    mocks.list.mockResolvedValue([promotionFixture({ resolved: false }).current]);
    const result = await listMemoryPromotionService(promotionReadCaller(), {});
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ ownerActorId: promotionOwnerId,
      accessScope: expect.objectContaining({ purposeId: "memory.read.v1", initiatingActorId: promotionOwnerId, workspaceId: null }),
    }), { status: "pending", limit: 25 });
    expect(result.data.reviews[0]).not.toHaveProperty("canonical");
    expect(result.data.reviews[0]).not.toHaveProperty("sourceClaimSha256");
    expect(JSON.stringify(result.data)).not.toContain("embedding");
    expect(JSON.stringify(MAIN_AGENT_APP_SERVICE_BINDINGS)).not.toContain("memory.promotions.decide");
  });
  it("withholds decision authority from a viewer and filters receipt by raw key hash", async () => {
    mocks.read.mockResolvedValue(promotionFixture({ resolved: false }).current);
    const viewer = promotionReadCaller({ ...promotionContext, role: "viewer" });
    const result = await inspectMemoryPromotionService(viewer, "promotion-one");
    expect(mocks.read.mock.calls[0][0].executionScope).toMatchObject({
      purpose: "api.memory.promotions.read", causationId: "promotion-one", initiatingActorId: promotionOwnerId,
    });
    expect(result.data.review.reviewToken).toBeNull();
    expect(result.data.review.allowedDecisions).toEqual([]);
    expect(result.data.review.canonical).not.toHaveProperty("accessBinding");
    const fixture = promotionFixture(); mocks.read.mockResolvedValue(fixture.current);
    expect((await inspectMemoryPromotionService(viewer, "promotion-one", { acceptanceKeySha256: "f".repeat(64) })).data.acceptance).toBeNull();
    expect((await inspectMemoryPromotionService(viewer, "promotion-one", { acceptanceKeySha256: fixture.intent.keySha256 })).data.acceptance?.id).toBe(fixture.intent.acceptanceId);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.graph).not.toHaveBeenCalled();
  });
  it("reports a saved promotion with an unconfirmed graph without relabeling authorship", async () => {
    const fixture = promotionFixture(); mocks.decide.mockResolvedValue(fixture.committed); mocks.graph.mockRejectedValue(new Error("projection offline"));
    const result = await decideMemoryPromotionService(promotionMutationCaller(), fixture.request);
    expect(result.data.acceptance.id).toBe(fixture.intent.acceptanceId);
    expect(result.data.projections).toEqual({ graph: "unconfirmed", entities: "not_applicable" });
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ authority: expect.objectContaining({
      ownerActorId: promotionOwnerId, accessScope: expect.objectContaining({ purposeId: "memory.write.v1" }),
      executionScope: expect.objectContaining({ purpose: "api.memory.promotions.decide", causationId: fixture.request.reviewId }),
    }) }));
    expect(mocks.graph.mock.calls[0][0][0].assertedBy).toBe("system"); expect(mocks.entities).not.toHaveBeenCalled();
  });
  it.each([true, false])("does not repeat projections for replay=%s or dismissal", async (replayed) => {
    const fixture = promotionFixture({ newlyApplied: !replayed, decision: replayed ? "promote" : "dismiss" });
    mocks.decide.mockResolvedValue(fixture.committed);
    const result = await decideMemoryPromotionService(promotionMutationCaller(), fixture.request);
    expect(result.data.replayed).toBe(replayed);
    expect(Object.values(result.data.projections)).toEqual([replayed ? "not_repeated" : "not_applicable", replayed ? "not_repeated" : "not_applicable"]);
    expect(mocks.graph).not.toHaveBeenCalled(); expect(mocks.entities).not.toHaveBeenCalled();
  });
  it.each([
    { executingPrincipalType: "agent" }, { executingPrincipalId: "different-user" }, { workspaceId: "workspace-other" },
    { projectId: "project-other" }, { missionId: "mission-other" }, { delegationId: "delegation-other" },
    { contextGrantIds: ["grant-other"] }, { capabilityGrantIds: ["grant-other"] },
    { purpose: "memory.maintenance.v1" }, { causationId: "another-review" },
  ])("rejects alternate mutation authority %j", async (override) => {
    const caller = promotionMutationCaller();
    await expect(decideMemoryPromotionService({ ...caller, executionScope: { ...caller.executionScope!, ...override } } as typeof caller,
      promotionFixture().request)).rejects.toMatchObject({ status: 403 });
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it("refuses unbound contexts and mismatched post-commit intent without projecting", async () => {
    await expect(inspectMemoryPromotionService(promotionReadCaller({ ...promotionContext, source: "headers" }), "promotion-one"))
      .rejects.toMatchObject({ status: 403 });
    const fixture = promotionFixture();
    mocks.decide.mockResolvedValue({ ...fixture.committed, acceptance: { ...fixture.committed.acceptance, requestSha256: "d".repeat(64) } });
    await expect(decideMemoryPromotionService(promotionMutationCaller(), fixture.request)).rejects.not.toHaveProperty("admission");
    expect(mocks.graph).not.toHaveBeenCalled();
  });
});
