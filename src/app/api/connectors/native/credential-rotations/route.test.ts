import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeConnectorError, connectorNativePreparationId, sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeCredentialPreparationIntent } from "@/lib/connectors/native-credential-rotation-contracts";

const mocks = vi.hoisted(() => ({ authorizeRequest: vi.fn(), prepare: vi.fn(), preparationRead: vi.fn(), abandon: vi.fn(), rotate: vi.fn(), rotationRead: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/connector-credential-rotation", () => ({ prepareNativeConnectorCredentialService: mocks.prepare,
  readNativeConnectorCredentialPreparationService: mocks.preparationRead, abandonNativeConnectorCredentialPreparationService: mocks.abandon,
  submitNativeConnectorCredentialRotationService: mocks.rotate, readNativeConnectorCredentialRotationService: mocks.rotationRead }));
import { POST as PREPARE } from "@/app/api/connectors/native/credential-preparations/route";
import { GET as PREPARATION } from "@/app/api/connectors/native/credential-preparations/[keySha256]/route";
import { POST as ABANDON } from "@/app/api/connectors/native/credential-preparations/[keySha256]/abandon/route";
import { POST as ROTATE } from "@/app/api/connectors/native/credential-rotations/route";
import { GET as ROTATION } from "@/app/api/connectors/native/credential-rotations/[keySha256]/route";

const context = { tenantId: "rotation-routes", actorId: "owner@example.test", role: "admin", source: "session" };
const scope = { tenantId: context.tenantId, ownerActorId: context.actorId, canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
const pin = sealConnectorNativePin({ kind: "mcp", connectorId: "connector-one", connectorSha256: "a".repeat(64), contractsSha256: "b".repeat(64),
  configurationSha256: "c".repeat(64), reviewFingerprint: null, credentialVersion: 0 });
const token = "synthetic-bearer-input";
const prepare = { contract: "asael-connector-prepare:1" as const, operation: "rotate_mcp" as const, connectorId: pin.connectorId,
  nonce: "11111111-1111-4111-8111-111111111111", review: pin,
  declaration: { name: "Notes", endpoint: "https://example.test/mcp", endpointRedacted: false, authType: "bearer_vault" as const,
    authTokenEnv: null, authHeaderName: null, defaultRiskLevel: 2 as const, approvalRequired: true, specSource: "none" as const, specUrl: null, specUrlRedacted: false },
  payload: { endpoint: null, specUrl: null, specText: null, bearerToken: token } };
const prepareKey = "prepare-once", intent = buildConnectorNativeCredentialPreparationIntent(scope, prepareKey, prepare);
const abandon = { contract: "asael-connector-credential-preparation-abandon:1", intent };
const rotate = { contract: "asael-connector-prepared-action:1", kind: "mcp", connectorId: pin.connectorId, action: "rotate_mcp",
  preparationId: connectorNativePreparationId(scope, intent.keySha256), preparationSha256: "d".repeat(64), review: pin };
const params = { params: Promise.resolve({ keySha256: intent.keySha256 }) };
function post(path: string, body: unknown, key = prepareKey, query = "") {
  return new Request(`https://example.test/api/connectors/native/${path}${query}`, { method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });
}
function get(path: string, query = "") { return new Request(`https://example.test/api/connectors/native/${path}/${intent.keySha256}${query}`); }
const abandonPath = `credential-preparations/${intent.keySha256}/abandon`;
const calls = () => [mocks.prepare, mocks.preparationRead, mocks.abandon, mocks.rotate, mocks.rotationRead];

describe("exact prepared native MCP credential routes", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.authorizeRequest.mockResolvedValue(context);
    for (const mock of [mocks.prepare, mocks.abandon, mocks.rotate]) mock.mockResolvedValue({ data: { replayed: false }, receipt: {} });
    mocks.preparationRead.mockResolvedValue({ data: { prepared: null }, receipt: {} });
    mocks.rotationRead.mockResolvedValue({ data: { action: null }, receipt: {} });
  });
  it("admits secret preparation through manager authority and keeps token out of authorization metadata", async () => {
    const request = post("credential-preparations", prepare), response = await PREPARE(request);
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "manage.connector", resourceType: "connector_native_preparation",
      resourceId: pin.connectorId, nativeMutationCapability: "connectors.credentials.rotate", riskLevel: 2,
      metadata: { operation: "rotate_mcp", kind: "mcp", phase: "prepare" } });
    expect(JSON.stringify(mocks.authorizeRequest.mock.calls[0][0].metadata)).not.toContain(token);
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ context, idempotencyKey: prepareKey,
      executionScope: expect.objectContaining({ purpose: "api.connectors.native.action", causationId: pin.connectorId }) }), prepare);
    expect(mocks.rotate).not.toHaveBeenCalled(); expect(mocks.abandon).not.toHaveBeenCalled();
  });
  it("keeps final rotation secret-free and bound to an exact human mutation scope", async () => {
    const request = post("credential-rotations", rotate, "rotate-once"), response = await ROTATE(request);
    expect(response.status).toBe(201);
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "manage.connector", resourceType: "connector_native_action",
      resourceId: pin.connectorId, nativeMutationCapability: "connectors.credentials.rotate", riskLevel: 2, metadata: { operation: "rotate_mcp", kind: "mcp" } });
    expect(mocks.rotate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ idempotencyKey: "rotate-once",
      executionScope: expect.objectContaining({ purpose: "api.connectors.native.action", causationId: pin.connectorId,
        initiatingActorId: context.actorId, executingPrincipalType: "user", executingPrincipalId: context.actorId }) }), rotate);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("admits own-staging cleanup after role demotion as a distinct enrolled mutation", async () => {
    const viewer = { ...context, role: "viewer" }; mocks.authorizeRequest.mockResolvedValue(viewer);
    const request = post(abandonPath, abandon), response = await ABANDON(request, params);
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "read", resourceType: "connector_native_preparation",
      resourceId: pin.connectorId, nativeMutationCapability: "connectors.credentials.rotate", riskLevel: 2,
      metadata: { operation: "abandon_credential_preparation", kind: "mcp" } });
    expect(mocks.abandon).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ context: viewer, idempotencyKey: prepareKey,
      executionScope: expect.objectContaining({ purpose: "api.connectors.native.preparation.abandon", causationId: pin.connectorId }) }), abandon, { keySha256: intent.keySha256 });
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.rotate).not.toHaveBeenCalled();
  });
  it("returns 200 only for an explicit same-key replay of each mutation", async () => {
    for (const mock of [mocks.prepare, mocks.abandon, mocks.rotate]) mock.mockResolvedValue({ data: { replayed: true }, receipt: {} });
    expect((await PREPARE(post("credential-preparations", prepare))).status).toBe(200);
    expect((await ABANDON(post(abandonPath, abandon), params)).status).toBe(200);
    expect((await ROTATE(post("credential-rotations", rotate))).status).toBe(200);
    for (const mock of [mocks.prepare, mocks.abandon, mocks.rotate]) expect(mock).toHaveBeenCalledTimes(1);
  });
  it("recovers both exact keys with read-only authority and without live-target mutation scope", async () => {
    const viewer = { ...context, role: "viewer" }; mocks.authorizeRequest.mockResolvedValue(viewer);
    const first = get("credential-preparations"), second = get("credential-rotations");
    for (const response of [await PREPARATION(first, params), await ROTATION(second, params)]) {
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.authorizeRequest).toHaveBeenNthCalledWith(1, { request: first, action: "read", resourceType: "connector_native_preparation" });
    expect(mocks.authorizeRequest).toHaveBeenNthCalledWith(2, { request: second, action: "read", resourceType: "connector_native_action" });
    for (const mock of [mocks.preparationRead, mocks.rotationRead]) expect(mock).toHaveBeenCalledExactlyOnceWith({ context: viewer }, { keySha256: intent.keySha256 });
    for (const mock of [mocks.prepare, mocks.abandon, mocks.rotate]) expect(mock).not.toHaveBeenCalled();
  });
  it("accepts the maximum decoded token plus metadata while refusing excess UTF-8 bytes", async () => {
    expect((await PREPARE(post("credential-preparations", { ...prepare, payload: { ...prepare.payload, bearerToken: "a".repeat(8192) } }))).status).toBe(201);
    const invalid = await PREPARE(post("credential-preparations", { ...prepare, payload: { ...prepare.payload, bearerToken: "é".repeat(4097) } }));
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain("é"); expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
  it("requires all three original mutation keys before authorization", async () => {
    for (const response of [await PREPARE(post("credential-preparations", prepare, "")), await ROTATE(post("credential-rotations", rotate, "")),
      await ABANDON(post(abandonPath, abandon, ""), params)]) {
      expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("rejects unrelated operations, transient abandonment fields and unknown queries before admission", async () => {
    const responses = [await PREPARE(post("credential-preparations", { ...prepare, operation: "register_mcp" })),
      await PREPARE(post("credential-preparations", prepare, prepareKey, "?retry=true")),
      await ROTATE(post("credential-rotations", { ...rotate, action: "remove_credential" })),
      await ROTATE(post("credential-rotations", { ...rotate, bearerToken: token })),
      await ROTATE(post("credential-rotations", rotate, prepareKey, "?force=true")),
      await ABANDON(post(abandonPath, { ...abandon, payload: { bearerToken: token } }), params),
      await ABANDON(post(abandonPath, abandon, prepareKey, "?force=true"), params)];
    for (const response of responses) { expect(response.status).toBe(400); expect(await response.text()).not.toContain(token); }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("bounds each complete JSON body and rejects non-JSON input", async () => {
    const checks = [
      { path: "credential-preparations", value: prepare, limit: 65_536, run: (request: Request) => PREPARE(request) },
      { path: "credential-rotations", value: rotate, limit: 8192, run: (request: Request) => ROTATE(request) },
      { path: abandonPath, value: abandon, limit: 16_384, run: (request: Request) => ABANDON(request, params) },
    ];
    for (const check of checks) {
      expect((await check.run(post(check.path, { ...check.value, padding: "x".repeat(check.limit) }))).status).toBe(413);
      const request = post(check.path, check.value); request.headers.set("content-type", "text/plain");
      expect((await check.run(request)).status).toBe(415);
    }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
  });
  it("refuses malformed exact keys and query extensions on recovery and abandonment", async () => {
    const bad = { params: Promise.resolve({ keySha256: "not-a-digest" }) };
    for (const response of [await PREPARATION(get("credential-preparations"), bad), await ROTATION(get("credential-rotations"), bad),
      await PREPARATION(get("credential-preparations", "?owner=other"), params), await ROTATION(get("credential-rotations", "?retry=true"), params),
      await ABANDON(post(abandonPath, abandon), bad)]) expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("honors authorization refusal on every operation", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("Denied"));
    for (const response of [await PREPARE(post("credential-preparations", prepare)), await ROTATE(post("credential-rotations", rotate)),
      await ABANDON(post(abandonPath, abandon), params), await PREPARATION(get("credential-preparations"), params), await ROTATION(get("credential-rotations"), params)]) {
      expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("returns static unknown-outcome errors without credential or ciphertext detail", async () => {
    for (const mock of calls()) mock.mockRejectedValue(new Error(`PRIVATE ${token} sealed_credential`));
    for (const response of [await PREPARE(post("credential-preparations", prepare)), await ROTATE(post("credential-rotations", rotate)),
      await ABANDON(post(abandonPath, abandon), params), await PREPARATION(get("credential-preparations"), params), await ROTATION(get("credential-rotations"), params)]) {
      expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({ error: "Connector action evidence is unavailable. Read the exact receipt before taking another action.", code: "connector_unconfirmed" });
    }
    mocks.abandon.mockRejectedValue(new NativeConnectorError("connector_conflict", 409, "The credential preparation is already consumed."));
    expect((await ABANDON(post(abandonPath, abandon), params)).status).toBe(409);
  });
});
