import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeConnectorError, connectorNativeTrashTarget, sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { buildTrashActionPreviewV1 } from "@/lib/trash/contracts";

const mocks = vi.hoisted(() => ({ authorizeRequest: vi.fn(), preview: vi.fn(), submit: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/connector-trash", () => ({ previewNativeConnectorTrashService: mocks.preview,
  submitNativeConnectorTrashService: mocks.submit, readNativeConnectorTrashService: mocks.read }));
import { GET as PREVIEW } from "@/app/api/connectors/native/mcp/[id]/trash-preview/route";
import { POST } from "@/app/api/connectors/native/trash-actions/route";
import { GET } from "@/app/api/connectors/native/trash-actions/[keySha256]/route";

const context = { tenantId: "tenant-one", actorId: "owner@example.test", role: "admin", source: "session" };
const pin = sealConnectorNativePin({ kind: "mcp", connectorId: "connector-one", connectorSha256: "a".repeat(64), contractsSha256: "b".repeat(64),
  configurationSha256: "c".repeat(64), reviewFingerprint: null, credentialVersion: 2 });
const preview = buildTrashActionPreviewV1({ version: "p9.3-trash-preview:1", action: "trash", trashId: null, resourceType: "mcp_connector",
  resourceId: pin.connectorId, lifecycleRevision: 0, targetSha256: canonicalJsonSha256(connectorNativeTrashTarget(pin)),
  effectSummary: "Move MCP connector Notes and 0 contract(s) to Trash.", reversible: true,
  issuedAt: "2026-10-05T01:00:00.000Z", expiresAt: "2026-10-05T01:10:00.000Z" });
const body = { contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: pin.connectorId, action: "trash", review: pin, preview };
const keySha256 = "d".repeat(64), params = { params: Promise.resolve({ keySha256 }) };
const previewParams = { params: Promise.resolve({ id: pin.connectorId }) };
function post(value: unknown = body, key = "trash-once", query = "") {
  return new Request(`https://example.test/api/connectors/native/trash-actions${query}`, {
    method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(value),
  });
}
function get(query = "") { return new Request(`https://example.test/api/connectors/native/trash-actions/${keySha256}${query}`); }
function getPreview(query = "") { return new Request(`https://example.test/api/connectors/native/mcp/${pin.connectorId}/trash-preview${query}`); }

describe("exact native MCP Trash routes", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.authorizeRequest.mockResolvedValue(context);
    mocks.preview.mockResolvedValue({ data: { review: null, preview: null, compensation: null }, receipt: {} });
    mocks.submit.mockResolvedValue({ data: { replayed: false }, receipt: {} });
    mocks.read.mockResolvedValue({ data: { action: null }, receipt: {} });
  });

  it("requires manager permission for a read-only exact preview without mutation admission", async () => {
    const request = getPreview(), response = await PREVIEW(request, previewParams);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "manage.connector", resourceType: "connector_native_action", resourceId: pin.connectorId });
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith({ context }, { id: pin.connectorId });
    expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });

  it("uses manager, risk and the v42 capability gate with one exact human request scope", async () => {
    const request = post(), response = await POST(request);
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "manage.connector", resourceType: "connector_native_action",
      resourceId: pin.connectorId, nativeMutationCapability: "connectors.trash", riskLevel: 2, metadata: { operation: "trash", kind: "mcp" } });
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ context, idempotencyKey: "trash-once",
      executionScope: expect.objectContaining({ purpose: "api.connectors.native.action", causationId: pin.connectorId,
        executingPrincipalType: "user", executingPrincipalId: context.actorId, tenantId: context.tenantId }) }), body);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("returns the original acceptance status only on explicit same-key replay", async () => {
    mocks.submit.mockResolvedValue({ data: { replayed: true }, receipt: {} });
    expect((await POST(post())).status).toBe(200); expect(mocks.submit).toHaveBeenCalledTimes(1);
  });

  it("rejects missing keys, unrelated lifecycle actions and unknown queries before admission", async () => {
    for (const request of [post(body, ""), post({ ...body, action: "remove_credential", preview: null }), post({ ...body, preview: null }),
      post(body, "key", "?actorId=someone-else")]) {
      const response = await POST(request); expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("bounds bytes and rejects non-JSON bodies before admission", async () => {
    expect((await POST(post({ ...body, padding: "x".repeat(8192) }))).status).toBe(413);
    const request = post(); request.headers.set("content-type", "text/plain");
    expect((await POST(request)).status).toBe(415);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("honors current authorization denial on every route", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("Denied"));
    for (const response of [await PREVIEW(getPreview(), previewParams), await POST(post()), await GET(get(), params)]) {
      expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });

  it("recovers an exact receipt with current read authority without target lookup or mutation scope", async () => {
    const request = get(), response = await GET(request, params);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "read", resourceType: "connector_native_action" });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ context }, { keySha256 });
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects malformed preview IDs, receipt keys and extra read queries", async () => {
    expect((await PREVIEW(getPreview(), { params: Promise.resolve({ id: "bad/id" }) })).status).toBe(400);
    expect((await PREVIEW(getPreview("?preview=true"), previewParams)).status).toBe(400);
    expect((await GET(get(), { params: Promise.resolve({ keySha256: "not-a-digest" }) })).status).toBe(400);
    expect((await GET(get("?retry=true"), params)).status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("preserves exact conflicts and private unknown-outcome recovery without leaking internals", async () => {
    mocks.submit.mockRejectedValue(new NativeConnectorError("connector_conflict", 409, "The reviewed connector changed."));
    const conflict = await POST(post()); expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "The reviewed connector changed.", code: "connector_conflict" });
    mocks.submit.mockRejectedValue(new Error("PRIVATE_SNAPSHOT_FAILURE"));
    const unknown = await POST(post()); expect(unknown.status).toBe(503); expect(unknown.headers.get("cache-control")).toBe("private, no-store");
    await expect(unknown.json()).resolves.toEqual({ error: "Connector action evidence is unavailable. Read the exact receipt before taking another action.", code: "connector_unconfirmed" });
    expect(mocks.submit).toHaveBeenCalledTimes(2);
  });
});
