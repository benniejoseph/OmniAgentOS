import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeConnectorError, sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";

const mocks = vi.hoisted(() => ({ authorizeRequest: vi.fn(), submit: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/connector-credential-removal", () => ({
  submitNativeConnectorCredentialRemovalService: mocks.submit,
  readNativeConnectorCredentialRemovalService: mocks.read,
}));
import { POST } from "@/app/api/connectors/native/credential-removals/route";
import { GET } from "@/app/api/connectors/native/credential-removals/[keySha256]/route";

const context = { tenantId: "tenant-one", actorId: "owner@example.test", role: "admin", source: "session" };
const body = { contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: "connector-one", action: "remove_credential",
  review: sealConnectorNativePin({ kind: "mcp", connectorId: "connector-one", connectorSha256: "a".repeat(64), contractsSha256: "b".repeat(64),
    configurationSha256: "c".repeat(64), reviewFingerprint: null, credentialVersion: 2 }), preview: null };
const keySha256 = "d".repeat(64);
const params = { params: Promise.resolve({ keySha256 }) };
function post(value: unknown = body, key = "remove-credential-once", query = "") {
  return new Request(`https://example.test/api/connectors/native/credential-removals${query}`, {
    method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(value),
  });
}
function get(query = "") { return new Request(`https://example.test/api/connectors/native/credential-removals/${keySha256}${query}`); }

describe("exact native credential removal routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authorizeRequest.mockResolvedValue(context);
    mocks.submit.mockResolvedValue({ data: { replayed: false }, receipt: {} });
    mocks.read.mockResolvedValue({ data: { action: null }, receipt: {} });
  });

  it("uses the manager, risk and v41 capability gate with one exact human request scope", async () => {
    const request = post();
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "manage.connector", resourceType: "connector_native_action",
      resourceId: "connector-one", nativeMutationCapability: "connectors.credentials.remove", riskLevel: 2, metadata: { operation: "remove_credential", kind: "mcp" } });
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ context, idempotencyKey: "remove-credential-once",
      executionScope: expect.objectContaining({ purpose: "api.connectors.native.action", causationId: "connector-one",
        executingPrincipalType: "user", executingPrincipalId: context.actorId, tenantId: context.tenantId }) }), body);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("returns the existing acceptance status on explicit same-key replay", async () => {
    mocks.submit.mockResolvedValue({ data: { replayed: true }, receipt: {} });
    expect((await POST(post())).status).toBe(200);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });

  it("rejects missing keys, unsupported actions and unknown queries before admission", async () => {
    for (const request of [post(body, ""), post({ ...body, action: "discover" }), post(body, "key", "?actorId=someone-else")]) {
      const response = await POST(request);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("bounds request bytes and rejects non-JSON bodies before admission", async () => {
    expect((await POST(post({ ...body, padding: "x".repeat(8192) }))).status).toBe(413);
    const request = post();
    request.headers.set("content-type", "text/plain");
    expect((await POST(request)).status).toBe(415);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("honors shared authorization denial without crossing the application-service boundary", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("Denied"));
    for (const response of [await POST(post()), await GET(get(), params)]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("recovers only the exact receipt using current read authority without a mutation scope", async () => {
    const request = get();
    const response = await GET(request, params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "read", resourceType: "connector_native_action" });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ context }, { keySha256 });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects malformed receipt keys and extra recovery queries", async () => {
    expect((await GET(get(), { params: Promise.resolve({ keySha256: "not-a-digest" }) })).status).toBe(400);
    expect((await GET(get("?retry=true"), params)).status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("preserves exact conflicts and private unknown-outcome recovery without leaking internal errors", async () => {
    mocks.submit.mockRejectedValue(new NativeConnectorError("connector_conflict", 409, "The reviewed connector changed."));
    const conflict = await POST(post());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "The reviewed connector changed.", code: "connector_conflict" });
    mocks.submit.mockRejectedValue(new Error("PRIVATE_CREDENTIAL_STORAGE_FAILURE"));
    const unknown = await POST(post());
    expect(unknown.status).toBe(503);
    expect(unknown.headers.get("cache-control")).toBe("private, no-store");
    await expect(unknown.json()).resolves.toEqual({ error: "Connector action evidence is unavailable. Read the exact receipt before taking another action.", code: "connector_unconfirmed" });
    expect(mocks.submit).toHaveBeenCalledTimes(2);
  });
});
