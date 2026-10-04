import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), list: vi.fn(), decide: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: <T>(handler: T) => handler }));
vi.mock("@/lib/app-services/memory-promotion", () => ({ listMemoryPromotionService: mocks.list, decideMemoryPromotionService: mocks.decide }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize,
  forbiddenResponse: (error: unknown) => { if (error instanceof Error && error.message === "denied") return Response.json({ error: "Forbidden", message: "denied" }, { status: 403 }); throw error; },
}));
import { GET, PATCH } from "@/app/api/memory/promotions/route";
import { MemoryPromotionNativeError } from "@/lib/memory/promotion-native-contracts";
import { promotionContext, promotionFixture } from "@/lib/mobile/memory-promotion.test-fixtures";
function patch(body: unknown = promotionFixture().request, query = "", key: string | null = "promotion-key-one") {
  return new Request(`http://localhost/api/memory/promotions${query}`, { method: "PATCH", headers: {
    "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}),
  }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); mocks.authorize.mockResolvedValue(promotionContext);
  mocks.list.mockResolvedValue({ data: { reviews: [] }, receipt: {} }); mocks.decide.mockResolvedValue({ data: { replayed: false }, receipt: {} }); });
describe("native promotion routes", () => {
  it("uses strict list defaults without mutation enrollment", async () => {
    expect((await GET(new Request("http://localhost/api/memory/promotions"))).status).toBe(200);
    expect(mocks.list.mock.calls[0][1]).toEqual({ status: "pending", limit: 25 });
    expect(mocks.authorize.mock.calls[0][0]).not.toHaveProperty("nativeMutationCapability");
  });
  it.each(["?limit=51", "?limit=1.5", "?limit=1e1", "?limit=", "?status=unknown", "?status=all&status=pending", "?workspaceId=other"])("rejects %s", async (query) => {
    const result = await GET(new Request(`http://localhost/api/memory/promotions${query}`));
    expect(result.status).toBe(400); expect(mocks.list).not.toHaveBeenCalled();
  });
  it("enrolls only the exact decision and request-bound purpose", async () => {
    const result = await PATCH(patch()); expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize.mock.calls[0][0]).toMatchObject({ action: "write.memory", nativeMutationCapability: "memory.promotions.decide", resourceId: "promotion-one" });
    expect(mocks.decide.mock.calls[0][0]).toMatchObject({ idempotencyKey: "promotion-key-one", executionScope: { purpose: "api.memory.promotions.decide", causationId: "promotion-one" } });
  });
  it("rejects missing key, extra query, legacy body and actual bytes before authorization", async () => {
    const request = promotionFixture().request;
    for (const [input, status] of [[patch(request, "", null), 400], [patch(request, "?status=pending"), 400],
      [patch({ action: "decide_promotion", reviewId: request.reviewId, decision: "promote" }), 400],
      [patch(JSON.stringify(request) + " ".repeat(4_097)), 413]] as const) {
      const response = await PATCH(input); expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.decide).not.toHaveBeenCalled();
  });
  it.each([new MemoryPromotionNativeError("memory_promotion_changed", 409, "Refresh the review."), new Error("denied"), new Error("auth offline")])("keeps failures private and without admission claims", async (error) => {
    mocks.authorize.mockRejectedValue(error);
    const result = await PATCH(patch()); expect([403, 409, 503]).toContain(result.status);
    expect(result.headers.get("cache-control")).toBe("private, no-store"); expect(await result.json()).not.toHaveProperty("admission");
    expect(mocks.decide).not.toHaveBeenCalled();
  });
});
