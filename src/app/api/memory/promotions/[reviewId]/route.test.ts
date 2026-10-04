import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: <T>(handler: T) => handler }));
vi.mock("@/lib/app-services/memory-promotion", () => ({ inspectMemoryPromotionService: mocks.read }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize,
  forbiddenResponse: (error: unknown) => { if (error instanceof Error && error.message === "denied") return Response.json({ error: "Forbidden", message: "denied" }, { status: 403 }); throw error; },
}));
import { GET } from "@/app/api/memory/promotions/[reviewId]/route";
import { promotionContext } from "@/lib/mobile/memory-promotion.test-fixtures";
const route = (reviewId = "promotion-beyond-list") => ({ params: Promise.resolve({ reviewId }) });
beforeEach(() => { mocks.authorize.mockReset().mockResolvedValue({ ...promotionContext, role: "viewer" });
  mocks.read.mockReset().mockResolvedValue({ data: { acceptance: null }, receipt: {} }); });
describe("exact promotion recovery route", () => {
  it("uses current read authority and the frozen raw key filter without a decision capability", async () => {
    const key = "c".repeat(64), response = await GET(new Request(`http://localhost/api/memory/promotions/promotion-beyond-list?acceptanceKeySha256=${key}`), route());
    expect(response.status).toBe(200); expect((await response.json()).acceptance).toBeNull();
    expect(mocks.read.mock.calls[0].slice(1)).toEqual(["promotion-beyond-list", { acceptanceKeySha256: key }]);
    expect(mocks.authorize.mock.calls[0][0]).toMatchObject({ action: "read", resourceId: "promotion-beyond-list" });
    expect(mocks.authorize.mock.calls[0][0]).not.toHaveProperty("nativeMutationCapability");
  });
  it.each(["?acceptanceKeySha256=x", "?limit=50", `?acceptanceKeySha256=${"a".repeat(64)}&acceptanceKeySha256=${"a".repeat(64)}`])("rejects invalid recovery query %s", async (query) => {
    expect((await GET(new Request(`http://localhost/api/memory/promotions/review${query}`), route())).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("refuses overlong identity and current authorization failure with private responses", async () => {
    expect((await GET(new Request("http://localhost/api/memory/promotions/review"), route("x".repeat(201)))).status).toBe(400);
    mocks.authorize.mockRejectedValue(new Error("denied"));
    const result = await GET(new Request("http://localhost/api/memory/promotions/review"), route());
    expect(result.status).toBe(403); expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
