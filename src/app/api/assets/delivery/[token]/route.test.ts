import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AssetObjectError extends Error {
    constructor(message: string, public readonly code: string) {
      super(message);
      this.name = "AssetObjectError";
    }
  }
  return {
    AssetObjectError,
    authorizeRequest: vi.fn(),
    redeemAssetObjectDelivery: vi.fn(),
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/storage/object-plane", () => ({
  AssetObjectError: mocks.AssetObjectError,
  redeemAssetObjectDelivery: mocks.redeemAssetObjectDelivery,
}));

import { GET } from "@/app/api/assets/delivery/[token]/route";

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "owner@example.test",
  });
  mocks.redeemAssetObjectDelivery.mockReset().mockResolvedValue({
    object: {
      mediaType: "audio/webm",
      byteCount: 4,
      contentSha256: "a".repeat(64),
    },
    bytes: new Uint8Array(Buffer.from("test")),
  });
});

describe("private asset delivery redemption", () => {
  it("reauthorizes and streams verified private bytes without auditing the token", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/assets/delivery/secret-token?purpose=capture.recording.playback",
      ),
      { params: Promise.resolve({ token: "secret-token" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(await response.text()).toBe("test");
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "asset_object",
      metadata: {
        operation: "redeem_private_delivery",
        purpose: "capture.recording.playback",
      },
    }));
    expect(mocks.authorizeRequest.mock.calls[0]?.[0]).not.toHaveProperty("resourceId");
    expect(mocks.redeemAssetObjectDelivery).toHaveBeenCalledWith({
      token: "secret-token",
      tenantId: "tenant-a",
      actorId: "owner@example.test",
      purpose: "capture.recording.playback",
    });
  });

  it("rejects arbitrary delivery purposes before authorization", async () => {
    const response = await GET(
      new Request("http://localhost/api/assets/delivery/token?purpose=arbitrary"),
      { params: Promise.resolve({ token: "token" }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
  });

  it("fails closed after deletion or token expiry", async () => {
    mocks.redeemAssetObjectDelivery.mockRejectedValueOnce(
      new mocks.AssetObjectError("expired", "delivery_token_expired"),
    );
    const response = await GET(
      new Request(
        "http://localhost/api/assets/delivery/token?purpose=capture.asset.download",
      ),
      { params: Promise.resolve({ token: "token" }) },
    );

    expect(response.status).toBe(404);
  });
});
