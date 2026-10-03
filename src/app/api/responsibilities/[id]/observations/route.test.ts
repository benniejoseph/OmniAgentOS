import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), history: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/responsibilities/observation-service", () => ({ getResponsibilityObservations: mocks.history }));
import { GET } from "./route";
const context = { tenantId: "t", actorId: "a", role: "viewer", source: "headers" };
const id = `responsibility:${"a".repeat(64)}`; const route = { params: Promise.resolve({ id }) };
const request = (query = "") => new Request(`https://example.test/api/responsibilities/${id}/observations${query}`);
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue(context); mocks.history.mockResolvedValue({ receipts: [], baseline: null }); });
describe("Responsibility observation GET-only HTTP boundary", () => {
  it("authorizes the exact resource and returns private bounded history", async () => {
    const input = request(); const response = await GET(input, route);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith({ request: input, action: "read", resourceType: "responsibility_observation", resourceId: id });
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith(context, id, 25);
  });
  it("rejects extra owner/admission parameters, duplicates and invalid limits", async () => {
    for (const query of ["?actorId=other", "?observe=true", "?limit=0", "?limit=101", "?limit=1.5", "?limit=2&limit=3"]) expect((await GET(request(query), route)).status).toBe(400);
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it("does not read after denial and redacts unavailable storage errors", async () => {
    mocks.authorize.mockRejectedValueOnce(new Error("denied")); expect((await GET(request(), route)).status).toBe(403); expect(mocks.history).not.toHaveBeenCalled();
    mocks.history.mockRejectedValue(new Error("private evidence body")); const failed = await GET(request(), route);
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private evidence body");
  });
});
