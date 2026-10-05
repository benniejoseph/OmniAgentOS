import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeConnectorError } from "@/lib/connectors/native-control-contracts";
import { nativeOpenapiImportFixture } from "../../../../../../tests/fixtures/native-openapi-import";

const mocks = vi.hoisted(() => ({ authorizeRequest: vi.fn(), prepare: vi.fn(), preparationRead: vi.fn(), abandon: vi.fn(), register: vi.fn(), registrationRead: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/connector-openapi-import", () => ({ prepareNativeOpenapiImportService: mocks.prepare,
  readNativeOpenapiImportPreparationService: mocks.preparationRead, abandonNativeOpenapiImportPreparationService: mocks.abandon,
  submitNativeOpenapiImportService: mocks.register, readNativeOpenapiImportService: mocks.registrationRead }));
import { POST as PREPARE, maxDuration as prepareMaxDuration } from "@/app/api/connectors/native/openapi-import-preparations/route";
import { GET as PREPARATION } from "@/app/api/connectors/native/openapi-import-preparations/[keySha256]/route";
import { POST as ABANDON } from "@/app/api/connectors/native/openapi-import-preparations/[keySha256]/abandon/route";
import { POST as REGISTER } from "@/app/api/connectors/native/openapi-imports/route";
import { GET as REGISTRATION } from "@/app/api/connectors/native/openapi-imports/[keySha256]/route";

const fixture = nativeOpenapiImportFixture("api_key_header_env", "url", true);
const context = { tenantId: fixture.scope.tenantId, actorId: fixture.scope.ownerActorId, role: "admin", source: "session" };
const token = "synthetic-private-query";
const prepare = fixture.prepareRequest, prepareKey = fixture.preparationKey, intent = fixture.intent;
const abandon = fixture.abandonRequest, register = fixture.request;
const params = { params: Promise.resolve({ keySha256: intent.keySha256 }) };
function post(path: string, body: unknown, key = prepareKey, query = "") {
  return new Request(`https://example.test/api/connectors/native/${path}${query}`, { method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });
}
function get(path: string, query = "") { return new Request(`https://example.test/api/connectors/native/${path}/${intent.keySha256}${query}`); }
const abandonPath = `openapi-import-preparations/${intent.keySha256}/abandon`;
const calls = () => [mocks.prepare, mocks.preparationRead, mocks.abandon, mocks.register, mocks.registrationRead];

describe("exact prepared native OpenAPI import routes", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.authorizeRequest.mockResolvedValue(context);
    mocks.prepare.mockResolvedValue({ data: { prepared: fixture.ready, replayed: false }, receipt: {} });
    for (const mock of [mocks.abandon, mocks.register]) mock.mockResolvedValue({ data: { replayed: false }, receipt: {} });
    mocks.preparationRead.mockResolvedValue({ data: { prepared: null }, receipt: {} });
    mocks.registrationRead.mockResolvedValue({ data: { action: null }, receipt: {} });
  });
  it("admits private source preparation through manager authority and keeps private input out of authorization metadata", async () => {
    const request = post("openapi-import-preparations", prepare), response = await PREPARE(request);
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "manage.connector", resourceType: "connector_native_preparation",
      resourceId: fixture.connectorId, nativeMutationCapability: "connectors.openapi.import", riskLevel: 2,
      metadata: { operation: "import_openapi", kind: "openapi", phase: "prepare" } });
    expect(JSON.stringify(mocks.authorizeRequest.mock.calls[0][0].metadata)).not.toContain(token);
    expect(JSON.stringify(mocks.authorizeRequest.mock.calls[0][0].metadata)).not.toContain("synthetic-private-query");
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ context, idempotencyKey: prepareKey,
      executionScope: expect.objectContaining({ purpose: "api.connectors.native.action", causationId: fixture.connectorId }) }), prepare);
    expect(mocks.register).not.toHaveBeenCalled(); expect(mocks.abandon).not.toHaveBeenCalled();
  });
  it("keeps final import source-free and bound to an exact human mutation scope", async () => {
    const request = post("openapi-imports", register, "register-once"), response = await REGISTER(request);
    expect(response.status).toBe(201);
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "manage.connector", resourceType: "connector_native_action",
      resourceId: fixture.connectorId, nativeMutationCapability: "connectors.openapi.import", riskLevel: 2, metadata: { operation: "import_openapi", kind: "openapi" } });
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ idempotencyKey: "register-once",
      executionScope: expect.objectContaining({ purpose: "api.connectors.native.action", causationId: fixture.connectorId,
        initiatingActorId: context.actorId, executingPrincipalType: "user", executingPrincipalId: context.actorId }) }), register);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("admits own-staging cleanup after role demotion as a distinct enrolled mutation", async () => {
    const viewer = { ...context, role: "viewer" }; mocks.authorizeRequest.mockResolvedValue(viewer);
    const request = post(abandonPath, abandon), response = await ABANDON(request, params);
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "read", resourceType: "connector_native_preparation",
      resourceId: fixture.connectorId, nativeMutationCapability: "connectors.openapi.import", riskLevel: 0,
      metadata: { operation: "abandon_openapi_import_preparation", kind: "openapi" } });
    expect(mocks.abandon).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ context: viewer, idempotencyKey: prepareKey,
      executionScope: expect.objectContaining({ purpose: "api.connectors.native.openapi_import_preparation.abandon", causationId: fixture.connectorId }) }), abandon, { keySha256: intent.keySha256 });
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled();
  });
  it("returns 200 for same-key ready/final/cleanup replays", async () => {
    mocks.prepare.mockResolvedValue({ data: { prepared: fixture.ready, replayed: true }, receipt: {} });
    for (const mock of [mocks.abandon, mocks.register]) mock.mockResolvedValue({ data: { replayed: true }, receipt: {} });
    expect((await PREPARE(post("openapi-import-preparations", prepare))).status).toBe(200);
    expect((await ABANDON(post(abandonPath, abandon), params)).status).toBe(200);
    expect((await REGISTER(post("openapi-imports", register))).status).toBe(200);
    for (const mock of [mocks.prepare, mocks.abandon, mocks.register]) expect(mock).toHaveBeenCalledTimes(1);
  });
  it("recovers both exact keys with read-only authority and without live-target mutation scope", async () => {
    const viewer = { ...context, role: "viewer" }; mocks.authorizeRequest.mockResolvedValue(viewer);
    const first = get("openapi-import-preparations"), second = get("openapi-imports");
    for (const response of [await PREPARATION(first, params), await REGISTRATION(second, params)]) {
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.authorizeRequest).toHaveBeenNthCalledWith(1, { request: first, action: "read", resourceType: "connector_native_preparation" });
    expect(mocks.authorizeRequest).toHaveBeenNthCalledWith(2, { request: second, action: "read", resourceType: "connector_native_action" });
    for (const mock of [mocks.preparationRead, mocks.registrationRead]) expect(mock).toHaveBeenCalledExactlyOnceWith({ context: viewer }, { keySha256: intent.keySha256 });
    for (const mock of [mocks.prepare, mocks.abandon, mocks.register]) expect(mock).not.toHaveBeenCalled();
  });
  it("admits every auth/source combination and reserves the explicit 60-second preparation route", async () => {
    expect(prepareMaxDuration).toBe(60);
    for (const auth of ["none", "bearer_env", "api_key_header_env"] as const) for (const source of ["url", "text"] as const) {
      const value = nativeOpenapiImportFixture(auth, source, source === "url");
      expect((await PREPARE(post("openapi-import-preparations", value.prepareRequest))).status).toBe(201);
    }
    expect(mocks.prepare).toHaveBeenCalledTimes(6);
  });
  it("distinguishes pending, new ready, replay and terminal failed preparation without claiming import success", async () => {
    for (const [prepared, replayed, status] of [[fixture.preparing, false, 202], [fixture.preparing, true, 202],
      [fixture.ready, false, 201], [fixture.ready, true, 200], [fixture.failed, false, 200], [fixture.expiredAttempt, true, 200],
      [fixture.consumed, true, 200], [fixture.abandonedAbsent, true, 200]] as const) {
      mocks.prepare.mockResolvedValue({ data: { prepared, replayed }, receipt: {} });
      const response = await PREPARE(post("openapi-import-preparations", prepare));
      expect(response.status).toBe(status); expect((await response.json()).prepared.availability).toBe(prepared.availability);
    }
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it("bounds decoded inline UTF-8 source independently of the complete JSON allowance", async () => {
    const text = nativeOpenapiImportFixture("none", "text").prepareRequest;
    expect((await PREPARE(post("openapi-import-preparations", { ...text, payload: { ...text.payload, specText: "é".repeat(1_000_000) } }))).status).toBe(201);
    const invalid = await PREPARE(post("openapi-import-preparations", { ...text, payload: { ...text.payload, specText: "é".repeat(1_000_001) } }));
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain("é"); expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
  it("requires all three original mutation keys before authorization", async () => {
    for (const response of [await PREPARE(post("openapi-import-preparations", prepare, "")), await REGISTER(post("openapi-imports", register, "")),
      await ABANDON(post(abandonPath, abandon, ""), params)]) {
      expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("rejects unrelated operations, transient abandonment fields and unknown queries before admission", async () => {
    const responses = [await PREPARE(post("openapi-import-preparations", { ...prepare, operation: "rotate_mcp" })),
      await PREPARE(post("openapi-import-preparations", prepare, prepareKey, "?retry=true")),
      await REGISTER(post("openapi-imports", { ...register, action: "remove_credential" })),
      await REGISTER(post("openapi-imports", { ...register, bearerToken: token })),
      await REGISTER(post("openapi-imports", register, prepareKey, "?force=true")),
      await ABANDON(post(abandonPath, { ...abandon, payload: { bearerToken: token } }), params),
      await ABANDON(post(abandonPath, abandon, prepareKey, "?force=true"), params)];
    for (const response of responses) { expect(response.status).toBe(400); expect(await response.text()).not.toContain(token); }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("bounds each complete JSON body and rejects non-JSON input", async () => {
    const checks = [
      { path: "openapi-import-preparations", value: prepare, limit: 4_100_000, run: (request: Request) => PREPARE(request) },
      { path: "openapi-imports", value: register, limit: 8192, run: (request: Request) => REGISTER(request) },
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
    for (const response of [await PREPARATION(get("openapi-import-preparations"), bad), await REGISTRATION(get("openapi-imports"), bad),
      await PREPARATION(get("openapi-import-preparations", "?owner=other"), params), await REGISTRATION(get("openapi-imports", "?retry=true"), params),
      await ABANDON(post(abandonPath, abandon), bad)]) expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("honors authorization refusal on every operation", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("Denied"));
    for (const response of [await PREPARE(post("openapi-import-preparations", prepare)), await REGISTER(post("openapi-imports", register)),
      await ABANDON(post(abandonPath, abandon), params), await PREPARATION(get("openapi-import-preparations"), params), await REGISTRATION(get("openapi-imports"), params)]) {
      expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("returns static unknown-outcome errors without source or ciphertext detail", async () => {
    for (const mock of calls()) mock.mockRejectedValue(new Error(`PRIVATE ${token} sealed_credential`));
    for (const response of [await PREPARE(post("openapi-import-preparations", prepare)), await REGISTER(post("openapi-imports", register)),
      await ABANDON(post(abandonPath, abandon), params), await PREPARATION(get("openapi-import-preparations"), params), await REGISTRATION(get("openapi-imports"), params)]) {
      expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({ error: "Connector action evidence is unavailable. Read the exact receipt before taking another action.", code: "connector_unconfirmed" });
    }
    mocks.abandon.mockRejectedValue(new NativeConnectorError("connector_conflict", 409, "The registration preparation is already consumed."));
    expect((await ABANDON(post(abandonPath, abandon), params)).status).toBe(409);
  });
});
