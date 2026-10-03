import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn(), change: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/responsibilities/lifecycle-service", () => ({ getResponsibilityLifecycle: mocks.read, changeResponsibilityLifecycleService: mocks.change }));
import { GET, POST } from "./route";
const context = { tenantId: "tenant", actorId: "owner", role: "operator", source: "session" };
const id = `responsibility:${"a".repeat(64)}`; const route = { params: Promise.resolve({ id }) };
const base = `https://example.test/api/responsibilities/${id}/lifecycle`;
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue(context); mocks.read.mockResolvedValue({ current: null, preview: { authorityEffect: "none" } }); mocks.change.mockResolvedValue({ receipt: { action: "pause" } }); });
describe("Responsibility lifecycle HTTP boundary", () => {
  it("reads private history/activation preview without invoking a control", async () => {
    const input = new Request(`${base}?view=activation`); const response = await GET(input, route);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.read).toHaveBeenCalledWith(context, id, true); expect(mocks.change).not.toHaveBeenCalled();
    for (const query of ["?activate=true", "?view=activation&view=activation", "?view=run", "?actorId=other"]) expect((await GET(new Request(base + query), route)).status).toBe(400);
  });
  it("requires the existing idempotency header and manage.workflow for the exact resource", async () => {
    const body = { action: "pause", expectedRevision: 1, expectedGeneration: 1 };
    const missing = await POST(new Request(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), route);
    expect(missing.status).toBe(400); expect(mocks.change).not.toHaveBeenCalled();
    const input = new Request(base, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "exact-pause-key" }, body: JSON.stringify(body) });
    const response = await POST(input, route); expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenLastCalledWith({ request: input, action: "manage.workflow", resourceType: "responsibility_lifecycle", resourceId: id, nativeMutationCapability: "responsibilities.lifecycle.manage" });
    expect(mocks.change).toHaveBeenCalledWith(context, id, body, "exact-pause-key");
  });
  it("does not control after denial or malformed JSON and never returns private storage errors", async () => {
    const request = () => new Request(base, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "exact-key" }, body: "{" });
    mocks.authorize.mockRejectedValueOnce(new Error("denied")); expect((await POST(request(), route)).status).toBe(403);
    expect((await POST(request(), route)).status).toBe(400); expect(mocks.change).not.toHaveBeenCalled();
    mocks.read.mockRejectedValue(new Error("private source body")); const response = await GET(new Request(base), route);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private source body");
  });
});
