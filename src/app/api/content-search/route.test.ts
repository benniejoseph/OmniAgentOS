import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), search: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/content-search/service", () => ({ searchContent: mocks.search }));
import { GET } from "./route";
import { searchContext } from "@/lib/content-search/test-fixtures";
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue(searchContext); mocks.search.mockResolvedValue({ groups: [] }); });
describe("content search HTTP boundary", () => {
  it("takes tenant and owner only from authorization and returns private no-store", async () => {
    const response = await GET(new Request("https://asael.example/api/content-search?q=report"));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ action: "read", resourceType: "content_search" }));
    expect(mocks.search).toHaveBeenCalledWith(searchContext, { query: "report", limit: 8 });
  });
  it("rejects owner injection and unauthenticated searches before a provider read", async () => {
    expect((await GET(new Request("https://asael.example/api/content-search?q=report&tenantId=foreign"))).status).toBe(400);
    mocks.authorize.mockRejectedValue(new Error("denied"));
    const response = await GET(new Request("https://asael.example/api/content-search?q=report"));
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(mocks.search).not.toHaveBeenCalled();
  });
});
