import { beforeEach, describe, expect, it, vi } from "vitest";
import { draftFixture } from "@/lib/responsibilities/test-fixtures";
import { ResponsibilityError } from "@/lib/responsibilities/state";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), list: vi.fn(), create: vi.fn(), read: vi.fn(), change: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/responsibilities/service", () => ({ listResponsibilityDrafts: mocks.list, createResponsibilityDraft: mocks.create, getResponsibilityDraft: mocks.read, changeResponsibilityDraft: mocks.change }));
import { GET, POST } from "./route";
import { GET as DETAIL, PATCH } from "./[id]/route";
const context = { tenantId: "tenant-a", actorId: "owner-a", role: "operator", source: "headers" };
const id = `responsibility:${"a".repeat(64)}`;
const route = { params: Promise.resolve({ id }) };
const create = { action: "create", expectedRevision: 0, draft: draftFixture };
function request(method = "GET", body?: unknown, key = "change-a", url = "/api/responsibilities") {
  return new Request(`https://example.test${url}`, { method, headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue(context); mocks.list.mockResolvedValue({ records: [] }); mocks.create.mockResolvedValue({ replayed: false }); mocks.read.mockResolvedValue({ record: { id } }); mocks.change.mockResolvedValue({ replayed: false }); });
describe("Responsibility draft HTTP boundary", () => {
  it("authorizes exact owned list reads and rejects client owner selectors/duplicate or oversized limits", async () => {
    expect((await GET(request())).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith(context, 40);
    for (const suffix of ["?actorId=other", "?limit=101", "?limit=0", "?limit=2&limit=3", "?limit=1.5"]) expect((await GET(request("GET", undefined, "", `/api/responsibilities${suffix}`))).status).toBe(400);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
  it("requires existing workflow authority, passes exact key and returns create versus replay status", async () => {
    const change = request("POST", create);
    expect((await POST(change)).status).toBe(201);
    expect(mocks.authorize).toHaveBeenCalledWith({ request: change, action: "manage.workflow", resourceType: "responsibility_draft", nativeMutationCapability: "responsibilities.drafts.manage" });
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(context, create, "change-a");
    mocks.create.mockResolvedValue({ replayed: true });
    expect((await POST(request("POST", create))).status).toBe(200);
  });
  it("rejects missing keys before effects and denied/CSRF requests before service entry", async () => {
    expect((await POST(request("POST", create, ""))).status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
    mocks.authorize.mockRejectedValue(new Error("CSRF or role denied"));
    const result = await POST(request("POST", create));
    expect(result.status).toBe(403); expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("bounds JSON before persistence and excludes mutation query selectors", async () => {
    expect((await POST(request("POST", { padding: "x".repeat(32_769) }))).status).toBe(413);
    expect((await POST(request("POST", create, "key", "/api/responsibilities?activate=true"))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("supports explicit GET-only review preview with async route params", async () => {
    const result = await DETAIL(request("GET", undefined, "", `/api/responsibilities/${id}?view=review`), route);
    expect(result.status).toBe(200); expect(mocks.read).toHaveBeenCalledExactlyOnceWith(context, id, true);
    expect(mocks.change).not.toHaveBeenCalled();
    expect((await DETAIL(request("GET", undefined, "", `/api/responsibilities/${id}?view=activate`), route)).status).toBe(400);
  });
  it("preserves exact review hash, CAS and idempotency fields in the PATCH body", async () => {
    const body = { action: "review", expectedRevision: 2, draftSha256: "b".repeat(64), reviewSha256: "c".repeat(64) };
    const input = request("PATCH", body, "review-key", `/api/responsibilities/${id}`);
    const result = await PATCH(input, route);
    expect(mocks.authorize).toHaveBeenLastCalledWith({ request: input, action: "manage.workflow", resourceType: "responsibility_draft", resourceId: id, nativeMutationCapability: "responsibilities.drafts.manage" });
    expect(result.status).toBe(200); expect(mocks.change).toHaveBeenCalledExactlyOnceWith(context, id, body, "review-key");
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });
  it("returns safe conflict and storage uncertainty without leaking exception content", async () => {
    mocks.change.mockRejectedValueOnce(new ResponsibilityError("The draft changed.", 409, "responsibility_revision_conflict"));
    const conflict = await PATCH(request("PATCH", create), route);
    expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual({ error: "The draft changed.", code: "responsibility_revision_conflict", reload: true });
    mocks.read.mockRejectedValueOnce(new Error("private source body"));
    const failed = await DETAIL(request(), route);
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private source body");
  });
});
