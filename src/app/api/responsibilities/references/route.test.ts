import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/responsibilities/reference-options", () => ({ readResponsibilityReferenceOptions: mocks.read }));
import { GET } from "./route";
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue({ tenantId: "tenant-a", actorId: "owner" }); mocks.read.mockResolvedValue({ groups: {}, authorityEffect: "none" }); });
describe("Responsibility reference selector GET", () => {
  it("authorizes a private metadata-only read and disallows caller-selected ownership or limits", async () => {
    const request = new Request("https://example.test/api/responsibilities/references"); const response = await GET(request);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith({ request, action: "read", resourceType: "responsibility_references" });
    for (const query of ["actorId=other", "limit=1000", "workspaceId=other"]) expect((await GET(new Request(`${request.url}?${query}`))).status).toBe(400);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it("does not read after denial and redacts unexpected infrastructure failures", async () => {
    mocks.authorize.mockRejectedValueOnce(new Error("Denied"));
    expect((await GET(new Request("https://example.test/api/responsibilities/references"))).status).toBe(403); expect(mocks.read).not.toHaveBeenCalled();
    mocks.read.mockRejectedValueOnce(new Error("private source content"));
    const response = await GET(new Request("https://example.test/api/responsibilities/references")); expect(response.status).toBe(503); expect(await response.text()).not.toContain("private source content");
  });
});
