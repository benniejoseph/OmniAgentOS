import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeConnectorError } from "@/lib/connectors/native-control-contracts";
import { nativeMcpRegistrationFixture } from "../../../../../../tests/fixtures/native-mcp-registration";

const mocks = vi.hoisted(() => ({ authorizeRequest: vi.fn(), prepare: vi.fn(), preparationRead: vi.fn(), abandon: vi.fn(), register: vi.fn(), registrationRead: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/connector-mcp-registration", () => ({ prepareNativeMcpRegistrationService: mocks.prepare,
  readNativeMcpRegistrationPreparationService: mocks.preparationRead, abandonNativeMcpRegistrationPreparationService: mocks.abandon,
  submitNativeMcpRegistrationService: mocks.register, readNativeMcpRegistrationService: mocks.registrationRead }));
import { POST as PREPARE } from "@/app/api/connectors/native/mcp-registration-preparations/route";
import { GET as PREPARATION } from "@/app/api/connectors/native/mcp-registration-preparations/[keySha256]/route";
import { POST as ABANDON } from "@/app/api/connectors/native/mcp-registration-preparations/[keySha256]/abandon/route";
import { POST as REGISTER } from "@/app/api/connectors/native/mcp-registrations/route";
import { GET as REGISTRATION } from "@/app/api/connectors/native/mcp-registrations/[keySha256]/route";

const fixture = nativeMcpRegistrationFixture("bearer_vault", true);
const context = { tenantId: fixture.scope.tenantId, actorId: fixture.scope.ownerActorId, role: "admin", source: "session" };
const token = fixture.prepareRequest.payload.bearerToken!;
const prepare = fixture.prepareRequest, prepareKey = fixture.preparationKey, intent = fixture.preparationIntent;
const abandon = fixture.abandonRequest, register = fixture.registrationRequest;
const params = { params: Promise.resolve({ keySha256: intent.keySha256 }) };
function post(path: string, body: unknown, key = prepareKey, query = "") {
  return new Request(`https://example.test/api/connectors/native/${path}${query}`, { method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });
}
function get(path: string, query = "") { return new Request(`https://example.test/api/connectors/native/${path}/${intent.keySha256}${query}`); }
const abandonPath = `mcp-registration-preparations/${intent.keySha256}/abandon`;
const calls = () => [mocks.prepare, mocks.preparationRead, mocks.abandon, mocks.register, mocks.registrationRead];

describe("exact prepared native MCP registration routes", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.authorizeRequest.mockResolvedValue(context);
    for (const mock of [mocks.prepare, mocks.abandon, mocks.register]) mock.mockResolvedValue({ data: { replayed: false }, receipt: {} });
    mocks.preparationRead.mockResolvedValue({ data: { prepared: null }, receipt: {} });
    mocks.registrationRead.mockResolvedValue({ data: { action: null }, receipt: {} });
  });
  it("admits secret preparation through manager authority and keeps private input out of authorization metadata", async () => {
    const request = post("mcp-registration-preparations", prepare), response = await PREPARE(request);
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "manage.connector", resourceType: "connector_native_preparation",
      resourceId: fixture.connectorId, nativeMutationCapability: "connectors.mcp.register", riskLevel: 2,
      metadata: { operation: "register_mcp", kind: "mcp", phase: "prepare" } });
    expect(JSON.stringify(mocks.authorizeRequest.mock.calls[0][0].metadata)).not.toContain(token);
    expect(JSON.stringify(mocks.authorizeRequest.mock.calls[0][0].metadata)).not.toContain("synthetic-private-query");
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ context, idempotencyKey: prepareKey,
      executionScope: expect.objectContaining({ purpose: "api.connectors.native.action", causationId: fixture.connectorId }) }), prepare);
    expect(mocks.register).not.toHaveBeenCalled(); expect(mocks.abandon).not.toHaveBeenCalled();
  });
  it("keeps final registration secret-free and bound to an exact human mutation scope", async () => {
    const request = post("mcp-registrations", register, "register-once"), response = await REGISTER(request);
    expect(response.status).toBe(201);
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "manage.connector", resourceType: "connector_native_action",
      resourceId: fixture.connectorId, nativeMutationCapability: "connectors.mcp.register", riskLevel: 2, metadata: { operation: "register_mcp", kind: "mcp" } });
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
      resourceId: fixture.connectorId, nativeMutationCapability: "connectors.mcp.register", riskLevel: 2,
      metadata: { operation: "abandon_mcp_registration_preparation", kind: "mcp" } });
    expect(mocks.abandon).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ context: viewer, idempotencyKey: prepareKey,
      executionScope: expect.objectContaining({ purpose: "api.connectors.native.mcp_registration_preparation.abandon", causationId: fixture.connectorId }) }), abandon, { keySha256: intent.keySha256 });
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled();
  });
  it("returns 200 only for an explicit same-key replay of each mutation", async () => {
    for (const mock of [mocks.prepare, mocks.abandon, mocks.register]) mock.mockResolvedValue({ data: { replayed: true }, receipt: {} });
    expect((await PREPARE(post("mcp-registration-preparations", prepare))).status).toBe(200);
    expect((await ABANDON(post(abandonPath, abandon), params)).status).toBe(200);
    expect((await REGISTER(post("mcp-registrations", register))).status).toBe(200);
    for (const mock of [mocks.prepare, mocks.abandon, mocks.register]) expect(mock).toHaveBeenCalledTimes(1);
  });
  it("recovers both exact keys with read-only authority and without live-target mutation scope", async () => {
    const viewer = { ...context, role: "viewer" }; mocks.authorizeRequest.mockResolvedValue(viewer);
    const first = get("mcp-registration-preparations"), second = get("mcp-registrations");
    for (const response of [await PREPARATION(first, params), await REGISTRATION(second, params)]) {
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.authorizeRequest).toHaveBeenNthCalledWith(1, { request: first, action: "read", resourceType: "connector_native_preparation" });
    expect(mocks.authorizeRequest).toHaveBeenNthCalledWith(2, { request: second, action: "read", resourceType: "connector_native_action" });
    for (const mock of [mocks.preparationRead, mocks.registrationRead]) expect(mock).toHaveBeenCalledExactlyOnceWith({ context: viewer }, { keySha256: intent.keySha256 });
    for (const mock of [mocks.prepare, mocks.abandon, mocks.register]) expect(mock).not.toHaveBeenCalled();
  });
  it("accepts the maximum decoded token plus metadata while refusing excess UTF-8 bytes", async () => {
    expect((await PREPARE(post("mcp-registration-preparations", { ...prepare, payload: { ...prepare.payload, bearerToken: "a".repeat(8192) } }))).status).toBe(201);
    const invalid = await PREPARE(post("mcp-registration-preparations", { ...prepare, payload: { ...prepare.payload, bearerToken: "é".repeat(4097) } }));
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain("é"); expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
  it("requires all three original mutation keys before authorization", async () => {
    for (const response of [await PREPARE(post("mcp-registration-preparations", prepare, "")), await REGISTER(post("mcp-registrations", register, "")),
      await ABANDON(post(abandonPath, abandon, ""), params)]) {
      expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("rejects unrelated operations, transient abandonment fields and unknown queries before admission", async () => {
    const responses = [await PREPARE(post("mcp-registration-preparations", { ...prepare, operation: "rotate_mcp" })),
      await PREPARE(post("mcp-registration-preparations", prepare, prepareKey, "?retry=true")),
      await REGISTER(post("mcp-registrations", { ...register, action: "remove_credential" })),
      await REGISTER(post("mcp-registrations", { ...register, bearerToken: token })),
      await REGISTER(post("mcp-registrations", register, prepareKey, "?force=true")),
      await ABANDON(post(abandonPath, { ...abandon, payload: { bearerToken: token } }), params),
      await ABANDON(post(abandonPath, abandon, prepareKey, "?force=true"), params)];
    for (const response of responses) { expect(response.status).toBe(400); expect(await response.text()).not.toContain(token); }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("bounds each complete JSON body and rejects non-JSON input", async () => {
    const checks = [
      { path: "mcp-registration-preparations", value: prepare, limit: 65_536, run: (request: Request) => PREPARE(request) },
      { path: "mcp-registrations", value: register, limit: 8192, run: (request: Request) => REGISTER(request) },
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
    for (const response of [await PREPARATION(get("mcp-registration-preparations"), bad), await REGISTRATION(get("mcp-registrations"), bad),
      await PREPARATION(get("mcp-registration-preparations", "?owner=other"), params), await REGISTRATION(get("mcp-registrations", "?retry=true"), params),
      await ABANDON(post(abandonPath, abandon), bad)]) expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("honors authorization refusal on every operation", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("Denied"));
    for (const response of [await PREPARE(post("mcp-registration-preparations", prepare)), await REGISTER(post("mcp-registrations", register)),
      await ABANDON(post(abandonPath, abandon), params), await PREPARATION(get("mcp-registration-preparations"), params), await REGISTRATION(get("mcp-registrations"), params)]) {
      expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("returns static unknown-outcome errors without credential or ciphertext detail", async () => {
    for (const mock of calls()) mock.mockRejectedValue(new Error(`PRIVATE ${token} sealed_credential`));
    for (const response of [await PREPARE(post("mcp-registration-preparations", prepare)), await REGISTER(post("mcp-registrations", register)),
      await ABANDON(post(abandonPath, abandon), params), await PREPARATION(get("mcp-registration-preparations"), params), await REGISTRATION(get("mcp-registrations"), params)]) {
      expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({ error: "Connector action evidence is unavailable. Read the exact receipt before taking another action.", code: "connector_unconfirmed" });
    }
    mocks.abandon.mockRejectedValue(new NativeConnectorError("connector_conflict", 409, "The registration preparation is already consumed."));
    expect((await ABANDON(post(abandonPath, abandon), params)).status).toBe(409);
  });
});
