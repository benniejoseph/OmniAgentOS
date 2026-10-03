import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn(), enable: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/responsibilities/notification-service", () => ({ getResponsibilityNotifications: mocks.read, changeResponsibilityNotifications: mocks.enable }));
import { GET, POST } from "./route";
const context = { tenantId: "tenant", actorId: "owner", role: "operator", source: "session" };
const id = `responsibility:${"a".repeat(64)}`; const route = { params: Promise.resolve({ id }) }; const base = `https://example.test/api/responsibilities/${id}/notifications`;
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue(context); mocks.read.mockResolvedValue({ current: null }); mocks.enable.mockResolvedValue({ receipt: { action: "enable" } }); });
describe("Responsibility in-app admission HTTP contract", () => {
  it("reads only exact private history or enable preview and never starts delivery", async () => {
    const response = await GET(new Request(`${base}?view=enable`), route);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.read).toHaveBeenCalledWith(context, id, true); expect(mocks.enable).not.toHaveBeenCalled();
    for (const query of ["?send=1", "?view=enable&view=enable", "?view=activation", "?actorId=other"]) expect((await GET(new Request(base + query), route)).status).toBe(400);
  });
  it("requires the existing idempotency header and manage.workflow before exact admission", async () => {
    const body = { action: "enable", expectedRuntimeRevision: 1, expectedRuntimeGeneration: 1, configurationSha256: "a".repeat(64), acknowledgeDestination: "owner_in_app" };
    const request = (key?: string) => new Request(base, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
    expect((await POST(request(), route)).status).toBe(400); expect(mocks.enable).not.toHaveBeenCalled();
    const input = request("exact-enable"); expect((await POST(input, route)).status).toBe(200);
    expect(mocks.authorize).toHaveBeenLastCalledWith({ request: input, action: "manage.workflow", resourceType: "responsibility_notifications", resourceId: id, nativeMutationCapability: "responsibilities.notifications.manage" });
    expect(mocks.enable).toHaveBeenCalledWith(context, id, body, "exact-enable");
  });
  it("refuses malformed or denied writes and redacts storage failures", async () => {
    const input = () => new Request(base, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "key" }, body: "{" });
    expect((await POST(input(), route)).status).toBe(400); mocks.authorize.mockRejectedValueOnce(new Error("Denied"));
    expect((await POST(input(), route)).status).toBe(403); expect(mocks.enable).not.toHaveBeenCalled();
    mocks.read.mockRejectedValue(new Error("Private database detail")); const response = await GET(new Request(base), route);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("Private database");
  });
  it("passes an explicit stop through the same exact private action boundary", async () => {
    const body = { action: "stop", expectedRevision: 8, expectedGeneration: 2 };
    const input = new Request(base, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "stop-exact" }, body: JSON.stringify(body) });
    expect((await POST(input, route)).status).toBe(200);
    expect(mocks.enable).toHaveBeenCalledWith(context, id, body, "stop-exact");
    expect(mocks.authorize).toHaveBeenLastCalledWith({ request: input, action: "manage.workflow", resourceType: "responsibility_notifications", resourceId: id, nativeMutationCapability: "responsibilities.notifications.manage" });
  });
});
