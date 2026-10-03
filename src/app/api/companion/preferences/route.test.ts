import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPANION_PREFERENCES } from "@/lib/companion/contracts";
import { CompanionPreferencesError } from "@/lib/companion/state";
import { companionOwnerSha256 } from "@/lib/companion/owner-binding";

const mocks = vi.hoisted(() => ({ authorizeRequest: vi.fn(), getCompanionPreferences: vi.fn(), saveCompanionPreferences: vi.fn(), scope: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: (request: Request) => Promise<Response>) => async (request: Request) => { mocks.scope(request); return handler(request); } }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/companion/service", () => ({ getCompanionPreferences: mocks.getCompanionPreferences, saveCompanionPreferences: mocks.saveCompanionPreferences }));
import { GET, PATCH } from "@/app/api/companion/preferences/route";

const context = { tenantId: "tenant-a", actorId: "owner@example.test", role: "viewer", source: "session" };
const body = { action: "save", expectedRevision: 0, preferences: DEFAULT_COMPANION_PREFERENCES };
function patch(value: unknown = body, key = "save-a") {
  return new Request("https://example.test/api/companion/preferences", {
    method: "PATCH", headers: { "content-type": "application/json", origin: "https://example.test", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(value),
  });
}

describe("Companion preference routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue(context);
    mocks.getCompanionPreferences.mockResolvedValue({ snapshot: { revision: 0, persisted: false } });
    mocks.saveCompanionPreferences.mockResolvedValue({ snapshot: { revision: 1 }, mutation: { outcome: "saved", revision: 1 } });
  });

  it("authorizes an owner-bound read and returns private defaults without a save", async () => {
    const request = new Request("https://example.test/api/companion/preferences?actorId=someone-else");
    const response = await GET(request);
    expect(mocks.scope).toHaveBeenCalledWith(request);
    expect(mocks.authorizeRequest).toHaveBeenCalledWith({ request, action: "read", resourceType: "companion_preferences" });
    expect(mocks.getCompanionPreferences).toHaveBeenCalledExactlyOnceWith(context);
    expect(mocks.saveCompanionPreferences).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("uses the dedicated own-preference permission, existing CSRF guard and exact submitted idempotency key", async () => {
    const request = patch();
    const response = await PATCH(request);
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "manage.own_preferences", resourceType: "companion_preferences", nativeMutationCapability: "companion.preferences.update" });
    expect(mocks.saveCompanionPreferences).toHaveBeenCalledExactlyOnceWith(context, body, "save-a");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("requires an exact expected owner before a native preference read or write", async () => {
    mocks.authorizeRequest.mockResolvedValue({ ...context, source: "mobile" });
    for (const header of [undefined, "malformed", companionOwnerSha256("another-tenant", context.actorId), companionOwnerSha256(context.tenantId, "another-owner@example.test")]) {
      for (const method of ["GET", "PATCH"]) {
        const request = method === "PATCH" ? patch() : new Request("https://example.test/api/companion/preferences");
        if (header) request.headers.set("x-asael-companion-owner-sha256", header);
        const response = await (method === "PATCH" ? PATCH : GET)(request);
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ code: "companion_owner_conflict", reload: true });
      }
    }
    expect(mocks.getCompanionPreferences).not.toHaveBeenCalled();
    expect(mocks.saveCompanionPreferences).not.toHaveBeenCalled();
  });

  it("keeps same-key native retries pinned to the authenticated owner even after credential replacement", async () => {
    const request = patch();
    request.headers.set("x-asael-companion-owner-sha256", companionOwnerSha256(context.tenantId, context.actorId));
    mocks.authorizeRequest.mockResolvedValue({ ...context, source: "mobile" });
    expect((await PATCH(request.clone())).status).toBe(200);
    mocks.authorizeRequest.mockResolvedValue({ ...context, actorId: "replacement-owner@example.test", source: "mobile" });
    expect((await PATCH(request.clone())).status).toBe(409);
    expect(mocks.saveCompanionPreferences).toHaveBeenCalledTimes(1);
  });

  it("validates an optional web owner binding and accepts a correctly bound native GET", async () => {
    const request = new Request("https://example.test/api/companion/preferences");
    request.headers.set("x-asael-companion-owner-sha256", companionOwnerSha256(context.tenantId, context.actorId));
    mocks.authorizeRequest.mockResolvedValue({ ...context, source: "mobile" });
    expect((await GET(request)).status).toBe(200);
    mocks.authorizeRequest.mockResolvedValue(context);
    request.headers.set("x-asael-companion-owner-sha256", "0".repeat(64));
    expect((await GET(request)).status).toBe(409);
    expect(mocks.getCompanionPreferences).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing idempotency key before any preference write", async () => {
    const response = await PATCH(patch(body, ""));
    expect(response.status).toBe(400);
    expect(mocks.saveCompanionPreferences).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not save when the shared authorization/CSRF/native gate denies a request", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("Forbidden"));
    const response = await PATCH(patch());
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.saveCompanionPreferences).not.toHaveBeenCalled();
  });

  it("bounds preference request bodies before persistence", async () => {
    const response = await PATCH(patch({ ...body, padding: "x".repeat(4_097) }));
    expect(response.status).toBe(413);
    expect(mocks.saveCompanionPreferences).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("preserves the explicit version-conflict contract", async () => {
    mocks.saveCompanionPreferences.mockRejectedValue(new CompanionPreferencesError("Companion preferences changed. Reload before saving again.", 409, "companion_revision_conflict"));
    const response = await PATCH(patch());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Companion preferences changed. Reload before saving again.", code: "companion_revision_conflict", reload: true });
  });

  it("does not return storage exception text or a false successful default after read failure", async () => {
    mocks.getCompanionPreferences.mockRejectedValue(new Error("PRIVATE_STORAGE_DETAIL"));
    const response = await GET(new Request("https://example.test/api/companion/preferences"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Companion preferences could not be loaded or saved.", code: "companion_unavailable" });
  });
});
