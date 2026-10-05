import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeGithubUpgradeFixture } from "../../../../../../tests/fixtures/native-github-upgrade";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(), review: vi.fn(), submit: vi.fn(), read: vi.fn(), close: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/app-services/connector-github-upgrade", () => ({
  reviewNativeGithubUpgradeService: mocks.review,
  submitNativeGithubUpgradeService: mocks.submit,
  readNativeGithubUpgradeService: mocks.read,
  closeNativeGithubUpgradeService: mocks.close,
}));

import { POST as SUBMIT, maxDuration } from "./route";
import { GET as READ } from "./[keySha256]/route";
import { POST as CLOSE } from "./[keySha256]/close/route";
import { GET as REVIEW } from "../mcp/[id]/github-upgrade-review/route";

const f = nativeGithubUpgradeFixture();
const context = {
  tenantId: f.scope.tenantId, actorId: f.scope.ownerActorId,
  role: "admin", source: "session",
};
const keyParams = { params: Promise.resolve({ keySha256: f.intent.keySha256 }) };
const idParams = { params: Promise.resolve({ id: f.connectorId }) };
function post(body: unknown = f.request, key = f.key, query = "") {
  return new Request(`https://example.test/api/connectors/native/github-upgrades${query}`, {
    method: "POST", headers: { "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body),
  });
}
function get(query = "") {
  return new Request(`https://example.test/api/connectors/native/github-upgrades/${f.intent.keySha256}${query}`);
}
function proof(query = "") {
  return new Request(`https://example.test/api/connectors/native/mcp/${f.connectorId}/github-upgrade-review${query}`);
}
const calls = () => [mocks.review, mocks.submit, mocks.read, mocks.close];

describe("exact native official GitHub upgrade routes", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.authorizeRequest.mockResolvedValue(context);
    mocks.review.mockResolvedValue({ data: { upgradeReview: { connectorId: f.connectorId,
      eligible: true, reason: "eligible", review: f.request.review } }, receipt: {} });
    mocks.submit.mockResolvedValue({ data: { upgrade: f.settled, replayed: false }, receipt: {} });
    mocks.read.mockResolvedValue({ data: { upgrade: null }, receipt: {} });
    mocks.close.mockResolvedValue({ data: { upgrade: f.closedAbsent, replayed: false }, receipt: {} });
  });

  it("reads server-bound raw eligibility under current management without dispatch", async () => {
    const request = proof(), response = await REVIEW(request, idParams);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({
      request, action: "manage.connector", resourceType: "connector_native_upgrade",
      resourceId: f.connectorId,
    });
    expect(mocks.review).toHaveBeenCalledExactlyOnceWith({ context }, f.connectorId);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("uses one enrolled risk-2 operation and the original exact key", async () => {
    const request = post(), response = await SUBMIT(request);
    expect(maxDuration).toBe(60);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({
      request, action: "manage.connector", resourceType: "connector_native_upgrade",
      resourceId: f.connectorId, nativeMutationCapability: "connectors.github.upgrade",
      riskLevel: 2, metadata: { operation: "upgrade_github", kind: "mcp" },
    });
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      context, idempotencyKey: f.key,
      executionScope: expect.objectContaining({
        purpose: "api.connectors.native.github_upgrade", causationId: f.connectorId,
      }),
    }), f.request);
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("reads exact owner evidence and fences an uncertain attempt through distinct close", async () => {
    const readRequest = get(), readResponse = await READ(readRequest, keyParams);
    expect(readResponse.status).toBe(200);
    expect(readResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({
      request: readRequest, action: "read", resourceType: "connector_native_upgrade",
      resourceId: f.intent.keySha256,
    });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ context }, { keySha256: f.intent.keySha256 });
    vi.clearAllMocks(); mocks.authorizeRequest.mockResolvedValue({ ...context, role: "viewer" });
    const closeRequest = post(f.closeRequest), closeResponse = await CLOSE(closeRequest, keyParams);
    expect(closeResponse.status).toBe(201);
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({
      request: closeRequest, action: "read", resourceType: "connector_native_upgrade",
      resourceId: f.connectorId, nativeMutationCapability: "connectors.github.upgrade",
      riskLevel: 0, metadata: { operation: "close_github_upgrade", kind: "mcp" },
    });
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      idempotencyKey: f.key,
      executionScope: expect.objectContaining({
        purpose: "api.connectors.native.github_upgrade_close", causationId: f.connectorId,
      }),
    }), f.closeRequest, { keySha256: f.intent.keySha256 });
  });

  it("returns 200 for same-key terminal replay", async () => {
    mocks.submit.mockResolvedValue({ data: { upgrade: f.settled, replayed: true }, receipt: {} });
    mocks.close.mockResolvedValue({ data: { upgrade: f.closeSettled, replayed: true }, receipt: {} });
    expect((await SUBMIT(post())).status).toBe(200);
    expect((await CLOSE(post(f.closeRequest), keyParams)).status).toBe(200);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("rejects changed intent, extra fields, query and missing key before authorization", async () => {
    for (const response of [
      await SUBMIT(post(f.request, "")),
      await CLOSE(post(f.closeRequest, ""), keyParams),
      await SUBMIT(post({ ...f.request, action: "discover" })),
      await SUBMIT(post({ ...f.request, bearerToken: "synthetic-private" })),
      await CLOSE(post({ ...f.closeRequest, retry: true }), keyParams),
      await SUBMIT(post(f.request, f.key, "?retry=true")),
      await READ(get("?retry=true"), keyParams),
      await REVIEW(proof("?retry=true"), idParams),
      await CLOSE(post(f.closeRequest, f.key, "?force=true"), keyParams),
    ]) {
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("synthetic-private");
    }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });

  it("bounds bodies and malformed path identities", async () => {
    expect((await SUBMIT(post({ ...f.request, padding: "x".repeat(8192) }))).status).toBe(413);
    expect((await CLOSE(post({ ...f.closeRequest, padding: "x".repeat(16_384) }), keyParams)).status).toBe(413);
    const badType = post(); badType.headers.set("content-type", "text/plain");
    expect((await SUBMIT(badType)).status).toBe(415);
    const badKey = { params: Promise.resolve({ keySha256: "not-a-digest" }) };
    const badId = { params: Promise.resolve({ id: "not valid" }) };
    expect((await READ(get(), badKey)).status).toBe(400);
    expect((await CLOSE(post(f.closeRequest), badKey)).status).toBe(400);
    expect((await REVIEW(proof(), badId)).status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
  });

  it("honors failed authorization and hides unknown provider or database failures", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("Denied"));
    for (const response of [await REVIEW(proof(), idParams), await SUBMIT(post()),
      await READ(get(), keyParams), await CLOSE(post(f.closeRequest), keyParams)]) {
      expect(response.status).toBe(403);
    }
    calls().forEach((mock) => expect(mock).not.toHaveBeenCalled());
    vi.clearAllMocks(); mocks.authorizeRequest.mockResolvedValue(context);
    for (const mock of calls()) mock.mockRejectedValue(new Error("PRIVATE provider body token"));
    for (const response of [await REVIEW(proof(), idParams), await SUBMIT(post()),
      await READ(get(), keyParams), await CLOSE(post(f.closeRequest), keyParams)]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Connector action evidence is unavailable. Read the exact receipt before taking another action.", code: "connector_unconfirmed" });
    }
  });
});
