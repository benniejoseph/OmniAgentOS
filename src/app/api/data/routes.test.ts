import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  createArchive: vi.fn(),
  memoryAccess: vi.fn(),
  restoreArchive: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/data/portable", () => ({
  createPortableArchive: mocks.createArchive,
  restorePortableArchive: mocks.restoreArchive,
}));
vi.mock("@/lib/memory/request-access", () => ({
  requestMemoryAccessFromSecurityContext: mocks.memoryAccess,
}));
vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorize,
}));

import {
  GET as exportArchive,
  POST as exportArchiveWithAssets,
} from "@/app/api/data/export/route";
import { POST as restoreArchive } from "@/app/api/data/restore/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "owner" as const,
  source: "session" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(context);
  mocks.memoryAccess.mockReturnValue({
    actorBinding: { canonicalActorId: "actor:owner-a" },
    databaseAccessScope: { purposeId: "memory.export.v1" },
    executionScope: { purpose: "api.portable.restore" },
  });
  mocks.createArchive.mockResolvedValue({
    format: "asael-portable-archive",
    version: 2,
    archiveSha256: "a".repeat(64),
  });
  mocks.restoreArchive.mockResolvedValue({
    knowledge: 1,
    verification: { receiptSha256: "b".repeat(64) },
  });
});

describe("portable archive API", () => {
  it("exports v2 without assets by default", async () => {
    const response = await exportArchive(new Request("http://localhost/api/data/export"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("-v2.json");
    expect(response.headers.get("x-asael-archive-sha256")).toBe("a".repeat(64));
    expect(mocks.createArchive).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      actorId: "owner@example.test",
      includeAssets: false,
    }));
  });

  it("requires and forwards a passphrase for encrypted asset export", async () => {
    const rejected = await exportArchiveWithAssets(jsonRequest({
      includeAssets: true,
      assetPassphrase: "too-short",
    }, "/api/data/export"));
    expect(rejected.status).toBe(400);
    expect(mocks.createArchive).not.toHaveBeenCalled();

    const response = await exportArchiveWithAssets(jsonRequest({
      includeAssets: true,
      assetPassphrase: "correct horse battery staple",
    }, "/api/data/export"));
    expect(response.status).toBe(200);
    expect(mocks.createArchive).toHaveBeenCalledWith(expect.objectContaining({
      includeAssets: true,
      assetPassphrase: "correct horse battery staple",
    }));
  });

  it("unwraps a verified archive and keeps the asset passphrase out of restore data", async () => {
    const archive = { format: "asael-portable-archive", version: 2 };
    const response = await restoreArchive(jsonRequest({
      archive,
      assetPassphrase: "correct horse battery staple",
    }, "/api/data/restore"));

    expect(response.status).toBe(200);
    expect(mocks.restoreArchive).toHaveBeenCalledWith(archive, expect.objectContaining({
      tenantId: "tenant-a",
      actorId: "owner@example.test",
      privateMemoryOwnerActorId: "actor:owner-a",
      assetPassphrase: "correct horse battery staple",
    }));
    expect(await response.json()).toEqual(expect.objectContaining({
      restored: expect.objectContaining({ knowledge: 1 }),
    }));
  });
});

function jsonRequest(body: unknown, path: string) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
