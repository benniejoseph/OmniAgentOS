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
    issueAssetObjectDelivery: vi.fn(),
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
  issueAssetObjectDelivery: mocks.issueAssetObjectDelivery,
}));

import { GET } from "@/app/api/assets/delivery/route";

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "owner@example.test",
  });
  mocks.issueAssetObjectDelivery.mockReset().mockResolvedValue({
    token: "ao1.payload.signature",
    expiresAt: "2026-09-06T12:05:00.000Z",
    object: {
      id: "asset_object_a",
      sourceKind: "capture_asset",
      sourceId: "capture_asset_a",
      mediaType: "application/pdf",
    },
  });
});

describe("private asset delivery issuer", () => {
  it("issues a short-lived owner- and purpose-bound application URL", async () => {
    const response = await GET(new Request(
      "http://localhost/api/assets/delivery?sourceKind=capture_asset&sourceId=capture_asset_a",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "asset_object",
      resourceId: "capture_asset_a",
    }));
    expect(mocks.issueAssetObjectDelivery).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "owner@example.test",
      sourceKind: "capture_asset",
      sourceId: "capture_asset_a",
      purpose: "capture.asset.download",
    });
    await expect(response.json()).resolves.toMatchObject({
      delivery: {
        url: "/api/assets/delivery/ao1.payload.signature?purpose=capture.asset.download",
      },
    });
  });

  it("rejects an unknown source kind before authorization", async () => {
    const response = await GET(new Request(
      "http://localhost/api/assets/delivery?sourceKind=arbitrary&sourceId=asset-a",
    ));

    expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
  });

  it("does not disclose unavailable object state", async () => {
    mocks.issueAssetObjectDelivery.mockRejectedValueOnce(
      new mocks.AssetObjectError("not ready", "object_not_ready"),
    );
    const response = await GET(new Request(
      "http://localhost/api/assets/delivery?sourceKind=capture_segment&sourceId=segment-a",
    ));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "A deliverable private asset was not found.",
    });
  });
});
