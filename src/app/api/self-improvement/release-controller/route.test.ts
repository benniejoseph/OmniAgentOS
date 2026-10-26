import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
const mock = vi.hoisted(() => ({ authorize: vi.fn(), list: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mock.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/self-improvement/release-service", () => ({ executeSelfImprovementControllerAction: mock.execute, listSelfImprovementReleaseRequests: mock.list }));
const endpoint = "https://asael.example.test/api/self-improvement/release-controller";
beforeEach(() => { for (const fn of Object.values(mock)) fn.mockReset(); mock.authorize.mockResolvedValue({ tenantId: "tenant", actorId: "owner", source: "session", role: "admin" }); });
describe("private release controller HTTP boundary", () => {
  it("does not admit internal scheduler headers after authenticated authorization fails", async () => {
    mock.authorize.mockRejectedValue(new Error("No authenticated owner"));
    const response = await POST(new Request(endpoint, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "claim", "x-omni-internal-token": "scheduler" }, body: JSON.stringify({ action: "claim" }) }));
    expect(response.status).toBe(403); expect(mock.execute).not.toHaveBeenCalled();
  });
  it("refuses mutations without a caller-supplied retry identity", async () => {
    const response = await POST(new Request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(400); expect(mock.execute).not.toHaveBeenCalled();
  });
  it("bounds streamed action bodies before any controller effect", async () => {
    const response = await POST(new Request(endpoint, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "oversized" }, body: JSON.stringify({ excess: "x".repeat(64_001) }) }));
    expect(response.status).toBe(413); expect(mock.execute).not.toHaveBeenCalled();
  });
  it("reads candidate metadata without recording controller presence or allowing caches", async () => {
    mock.list.mockResolvedValue({ requests: [] });
    const response = await GET(new Request(endpoint));
    expect(await response.json()).toEqual({ requests: [] });
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(mock.execute).not.toHaveBeenCalled();
  });
});
