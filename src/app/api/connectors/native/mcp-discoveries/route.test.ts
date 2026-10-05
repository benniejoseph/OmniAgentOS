import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeMcpDiscoveryFixture } from "../../../../../../tests/fixtures/native-mcp-discovery";
const mocks = vi.hoisted(() => ({ authorizeRequest: vi.fn(), submit: vi.fn(), read: vi.fn(), close: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorizeRequest, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/connector-mcp-discovery", () => ({ submitNativeMcpDiscoveryService: mocks.submit, readNativeMcpDiscoveryService: mocks.read, closeNativeMcpDiscoveryService: mocks.close }));
import { POST as SUBMIT, maxDuration } from "./route";
import { GET as READ } from "./[keySha256]/route";
import { POST as CLOSE } from "./[keySha256]/close/route";
const f = nativeMcpDiscoveryFixture(), context = { tenantId: f.scope.tenantId, actorId: f.scope.ownerActorId, role: "admin", source: "session" };
const params = { params: Promise.resolve({ keySha256: f.intent.keySha256 }) };
function post(body: unknown = f.request, key = f.key, query = "") { return new Request(`https://example.test/api/connectors/native/mcp-discoveries${query}`, {
  method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) }); }
function get(query = "") { return new Request(`https://example.test/api/connectors/native/mcp-discoveries/${f.intent.keySha256}${query}`); }
const calls = () => [mocks.submit, mocks.read, mocks.close];
describe("exact native MCP discovery routes", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.authorizeRequest.mockResolvedValue(context);
    for (const mock of [mocks.submit, mocks.close]) mock.mockResolvedValue({ data: { discovery: f.settled, replayed: false }, receipt: {} });
    mocks.read.mockResolvedValue({ data: { discovery: null }, receipt: {} }); });
  it("uses the enrolled manager boundary and one exact discovery mutation", async () => {
    const request = post(), response = await SUBMIT(request);
    expect(maxDuration).toBe(60); expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "manage.connector", resourceType: "connector_native_discovery",
      resourceId: f.connectorId, nativeMutationCapability: "connectors.mcp.discover", riskLevel: 2, metadata: { operation: "discover_mcp", kind: "mcp" } });
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ context, idempotencyKey: f.key,
      executionScope: expect.objectContaining({ purpose: "api.connectors.native.mcp_discovery", causationId: f.connectorId }) }), f.request);
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it("uses current owner read authority and a distinct mutation for explicit close", async () => {
    const viewer = { ...context, role: "viewer" }; mocks.authorizeRequest.mockResolvedValue(viewer);
    const request = post(f.closeRequest), response = await CLOSE(request, params);
    expect(response.status).toBe(201);
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "read", resourceType: "connector_native_discovery", resourceId: f.connectorId,
      nativeMutationCapability: "connectors.mcp.discover", riskLevel: 0, metadata: { operation: "close_mcp_discovery", kind: "mcp" } });
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ context: viewer, idempotencyKey: f.key,
      executionScope: expect.objectContaining({ purpose: "api.connectors.native.mcp_discovery_close", causationId: f.connectorId }) }), f.closeRequest, { keySha256: f.intent.keySha256 });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("recovers exact absent or settled evidence without a mutation scope", async () => {
    const request = get(), response = await READ(request, params);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "read", resourceType: "connector_native_discovery", resourceId: f.intent.keySha256 });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ context }, { keySha256: f.intent.keySha256 });
    expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled();
  });
  it("returns 200 for exact replays without reconstructing another request", async () => {
    for (const mock of [mocks.submit, mocks.close]) mock.mockResolvedValue({ data: { discovery: f.closedAbsent, replayed: true }, receipt: {} });
    expect((await SUBMIT(post())).status).toBe(200); expect((await CLOSE(post(f.closeRequest), params)).status).toBe(200);
    expect(mocks.submit).toHaveBeenCalledTimes(1); expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it("rejects missing keys, changed operations, private fields and query extensions before authorization", async () => {
    for (const response of [await SUBMIT(post(f.request, "")), await CLOSE(post(f.closeRequest, ""), params),
      await SUBMIT(post({ ...f.request, action: "enable" })), await SUBMIT(post({ ...f.request, bearerToken: "synthetic-private" })),
      await CLOSE(post({ ...f.closeRequest, retry: true }), params), await SUBMIT(post(f.request, f.key, "?retry=true")),
      await READ(get("?retry=true"), params), await CLOSE(post(f.closeRequest, f.key, "?force=true"), params)]) {
      expect(response.status).toBe(400); expect(await response.text()).not.toContain("synthetic-private");
    }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("bounds both JSON bodies and refuses malformed recovery keys", async () => {
    expect((await SUBMIT(post({ ...f.request, padding: "x".repeat(8192) }))).status).toBe(413);
    expect((await CLOSE(post({ ...f.closeRequest, padding: "x".repeat(16384) }), params)).status).toBe(413);
    const request = post(); request.headers.set("content-type", "text/plain"); expect((await SUBMIT(request)).status).toBe(415);
    const bad = { params: Promise.resolve({ keySha256: "not-a-digest" }) };
    expect((await READ(get(), bad)).status).toBe(400); expect((await CLOSE(post(f.closeRequest), bad)).status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
  });
  it("honors all authorization failures without dispatch", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("Denied"));
    for (const response of [await SUBMIT(post()), await READ(get(), params), await CLOSE(post(f.closeRequest), params)]) expect(response.status).toBe(403);
    calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("returns static unknown-outcome errors without private provider detail", async () => {
    for (const mock of calls()) mock.mockRejectedValue(new Error("PRIVATE endpoint secret provider body"));
    for (const response of [await SUBMIT(post()), await READ(get(), params), await CLOSE(post(f.closeRequest), params)]) {
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "Connector action evidence is unavailable. Read the exact receipt before taking another action.", code: "connector_unconfirmed" });
    }
  });
});
