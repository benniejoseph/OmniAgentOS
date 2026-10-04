import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), inspect: vi.fn(), decide: vi.fn(), legacyRead: vi.fn(), activate: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/personal-context-consent", () => ({ inspectPersonalContextConsentService: mocks.inspect, decidePersonalContextConsentService: mocks.decide }));
vi.mock("@/lib/memory/personal-context-consent-store", async (original) => ({
  ...(await original<typeof import("@/lib/memory/personal-context-consent-store")>()),
  getPersonalContextConsentStatus: mocks.legacyRead, activatePersonalContextConsent: mocks.activate, revokePersonalContextConsent: mocks.revoke,
}));
vi.mock("@/lib/db/client", async (original) => ({ ...(await original<typeof import("@/lib/db/client")>()), withDatabaseRequestScope: (handler: unknown) => handler }));
import { GET, PATCH, POST, DELETE } from "./route";
import { GET as recover } from "./decisions/[id]/route";
import { PERSONAL_CONTEXT_NOTICE_SHA256 } from "@/lib/memory/personal-context-consent";
import { PersonalContextConsentNativeError } from "@/lib/memory/personal-context-consent-native-contracts";
const url = "https://app.example.test/api/memory/personal-context-consent";
const owner = "actor:11111111-1111-4111-8111-111111111111";
const context = { tenantId: "tenant:test", actorId: "owner@example.test", role: "admin", source: "mobile",
  auth: { userId: owner.slice(6), email: "owner@example.test", sessionId: "session:test", tenantName: "Private" } };
const request = { contract: "asael-personal-context-consent-decision:1", action: "activate", noticeSha256: PERSONAL_CONTEXT_NOTICE_SHA256,
  expectedState: "inactive", expectedConsentGeneration: 0, expectedLifecycleRevision: 0, expectedDecisionToken: "a".repeat(64) };
function patch(body: unknown = request, suffix = "", key: string | null = "consent-intent-one") {
  return new Request(url + suffix, { method: "PATCH", headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
}
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockResolvedValue(context);
  mocks.inspect.mockResolvedValue({ data: { current: {}, acceptance: null }, receipt: {} });
  mocks.decide.mockResolvedValue({ data: { replayed: false }, receipt: {} });
});
describe("native personal recall routes", () => {
  it("requires the exact native query and prevents legacy read fallback", async () => {
    for (const suffix of ["", "?contract=wrong", "?contract=asael-personal-context-consent-read:1&contract=asael-personal-context-consent-read:1", "?contract=asael-personal-context-consent-read:1&owner=other"]) {
      expect((await GET(new Request(url + suffix))).status).toBe(400);
    }
    expect(mocks.legacyRead).not.toHaveBeenCalled(); expect(mocks.inspect).not.toHaveBeenCalled();
    const response = await GET(new Request(url + "?contract=asael-personal-context-consent-read:1"));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.inspect).toHaveBeenCalledOnce();
  });
  it("admits only a bounded keyed exact decision through its dedicated capability", async () => {
    expect((await PATCH(patch())).status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ action: "write.memory", nativeMutationCapability: "memory.personal-context-consent.manage" }));
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "consent-intent-one", executionScope: expect.objectContaining({
      purpose: "api.memory.personal-context-consent.native.decide", causationId: owner, initiatingActorId: context.actorId,
    }) }), request);
    mocks.decide.mockClear();
    for (const bad of [patch(request, "?owner=other"), patch(request, "", null), patch({ ...request, actorId: "other" }), patch({ ...request, expectedDecisionToken: undefined }), patch({ ...request, extra: "x".repeat(5000) })]) {
      const response = await PATCH(bad);
      expect([400, 413]).toContain(response.status); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it("recovers an exact raw-key digest by read only, including missing acceptance", async () => {
    const key = "a".repeat(64);
    const response = await recover(new Request(`${url}/decisions/${key}`), { params: Promise.resolve({ id: key }) });
    expect(response.status).toBe(200); expect((await response.json()).acceptance).toBeNull();
    expect(mocks.inspect).toHaveBeenCalledWith(expect.objectContaining({ context }), key);
    expect(mocks.decide).not.toHaveBeenCalled();
    expect((await recover(new Request(`${url}/decisions/${key}?retry=true`), { params: Promise.resolve({ id: key }) })).status).toBe(400);
    expect((await recover(new Request(`${url}/decisions/bad`), { params: Promise.resolve({ id: "bad" }) })).status).toBe(400);
  });
  it("keeps native clients out of legacy activation and revocation", async () => {
    const activation = await POST(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ noticeSha256: PERSONAL_CONTEXT_NOTICE_SHA256 }) }));
    const revocation = await DELETE(new Request(url, { method: "DELETE" }));
    expect(activation.status).toBe(400); expect(revocation.status).toBe(400);
    expect(mocks.activate).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("keeps failures private and distinguishes conflict from unavailable storage", async () => {
    mocks.decide.mockRejectedValue(new PersonalContextConsentNativeError("personal_context_consent_stale", 409, "Reload the current consent."));
    expect((await PATCH(patch())).status).toBe(409);
    mocks.decide.mockRejectedValue(new Error("private database detail"));
    const unavailable = await PATCH(patch());
    expect(unavailable.status).toBe(503); expect(await unavailable.text()).not.toContain("private database detail");
    mocks.authorize.mockRejectedValue(new Error("forbidden"));
    const denied = await PATCH(patch());
    expect(denied.status).toBe(403); expect(denied.headers.get("cache-control")).toBe("private, no-store");
  });
});
