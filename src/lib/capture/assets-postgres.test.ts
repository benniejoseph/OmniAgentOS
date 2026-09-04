import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const dbMocks = vi.hoisted(() => {
  const state = { databaseEnabled: true };
  const rows: Record<string, unknown>[] = [];
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const sql = vi.fn(
    (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push({ text: renderStatement(strings, params), params });
      return Promise.resolve([...rows]);
    },
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: vi.fn(() => sql),
    hasDatabaseUrl: vi.fn(() => state.databaseEnabled),
    readJsonFile: vi.fn(),
    rows,
    sql,
    state,
    statements,
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return {
    ...actual,
    ensureDatabaseSchema: dbMocks.ensureDatabaseSchema,
    getSql: dbMocks.getSql,
    hasDatabaseUrl: dbMocks.hasDatabaseUrl,
  };
});

vi.mock("@/lib/storage/json", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/json")>();
  return {
    ...actual,
    readJsonFile: dbMocks.readJsonFile,
  };
});

import {
  CaptureAssetReadConflictError,
  getCaptureAsset,
  getCaptureAssetForRequest,
  listCaptureAssets,
  listInternalCaptureAssets,
} from "@/lib/capture/assets";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "capture-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

beforeEach(() => {
  dbMocks.state.databaseEnabled = true;
  dbMocks.rows.splice(0);
  dbMocks.statements.splice(0);
  dbMocks.ensureDatabaseSchema.mockClear();
  dbMocks.getSql.mockClear();
  dbMocks.hasDatabaseUrl.mockClear();
  dbMocks.readJsonFile.mockReset().mockResolvedValue({ assets: [] });
  dbMocks.sql.mockClear();
});

describe("Postgres Capture asset collection reads", () => {
  it("merges owner partitions before globally ordering and limiting", async () => {
    dbMocks.rows.push(
      assetRow("canonical-asset", canonicalActorId),
      assetRow("email-asset", actorId),
    );

    await expect(listCaptureAssets({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    }, 2)).resolves.toEqual([
      expect.objectContaining({
        id: "canonical-asset",
        actorId,
        contentAvailable: false,
        indexable: false,
        manageable: false,
      }),
      expect.objectContaining({
        id: "email-asset",
        actorId,
        contentAvailable: true,
        indexable: true,
        manageable: true,
      }),
    ]);

    expect(dbMocks.statements).toHaveLength(1);
    expect(dbMocks.statements[0].text).toMatch(
      /FROM omni_capture_assets[\s\S]*?WHERE tenant_id = \$\d+[\s\S]*?AND \(actor_id = \$\d+ OR actor_id = \$\d+\)[\s\S]*?COALESCE\(metadata->>'internalKind', ''\) = ''[\s\S]*?ORDER BY updated_at DESC, id ASC[\s\S]*?LIMIT \$\d+/,
    );
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      canonicalActorId,
      actorId,
      2,
    ]);
  });

  it("uses an exact actor query for missing or malformed bindings", async () => {
    await listCaptureAssets({ tenantId: "tenant-a", actorId }, 7);
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      actorId,
      actorId,
      7,
    ]);

    dbMocks.statements.splice(0);
    await listCaptureAssets({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: {
        ...binding,
        legacyOwnerActorIds: Object.freeze(["another-owner@example.test"]),
      },
    }, 5);
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      actorId,
      actorId,
      5,
    ]);
  });

  it("keeps the file fallback exact even when a valid binding is supplied", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      assets: [
        fileAsset("canonical-asset", canonicalActorId),
        fileAsset("email-asset", actorId),
        fileAsset("internal-email-asset", actorId, { internalKind: "browser_frame" }),
      ],
    });

    await expect(listCaptureAssets({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    }, 10)).resolves.toEqual([
      expect.objectContaining({
        id: "email-asset",
        actorId,
        contentAvailable: true,
        indexable: true,
        manageable: true,
      }),
    ]);

    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(dbMocks.sql).not.toHaveBeenCalled();
  });

  it("resolves request metadata from the owner pair without widening content", async () => {
    dbMocks.rows.push(assetRow("canonical-asset", canonicalActorId));

    await expect(getCaptureAssetForRequest("canonical-asset", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual(expect.objectContaining({
      id: "canonical-asset",
      actorId,
      contentAvailable: false,
      indexable: false,
      manageable: false,
    }));

    expect(dbMocks.statements[0].text).toMatch(
      /WHERE id = \$\d+[\s\S]*?tenant_id = \$\d+[\s\S]*?\(actor_id = \$\d+ OR actor_id = \$\d+\)[\s\S]*?COALESCE\(metadata->>'internalKind', ''\) = ''[\s\S]*?LIMIT 1/,
    );
    expect(dbMocks.statements[0].text).not.toContain(" content ");
    expect(dbMocks.statements[0].params).toEqual([
      "canonical-asset",
      "tenant-a",
      canonicalActorId,
      actorId,
    ]);
  });

  it("keeps request metadata exact for invalid bindings and file fallback", async () => {
    await getCaptureAssetForRequest("asset-a", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: {
        ...binding,
        readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
      },
    });
    expect(dbMocks.statements[0].params).toEqual([
      "asset-a",
      "tenant-a",
      actorId,
      actorId,
    ]);

    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      assets: [
        fileAsset("canonical-asset", canonicalActorId),
        fileAsset("email-asset", actorId),
      ],
    });
    await expect(getCaptureAssetForRequest("canonical-asset", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toBeUndefined();
    await expect(getCaptureAssetForRequest("email-asset", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual(expect.objectContaining({
      id: "email-asset",
      contentAvailable: true,
      indexable: true,
      manageable: true,
    }));
  });

  it("fails closed when selected metadata does not match the request owner pair", async () => {
    dbMocks.rows.push(assetRow("asset-a", "unexpected-owner@example.test"));

    await expect(getCaptureAssetForRequest("asset-a", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(CaptureAssetReadConflictError);
  });

  it("leaves direct and internal Capture asset reads exact", async () => {
    await getCaptureAsset("asset-a", {
      tenantId: "tenant-a",
      actorId,
    });
    expect(dbMocks.statements[0].text).not.toContain(" OR actor_id = ");
    expect(dbMocks.statements[0].params).toEqual([
      "asset-a",
      "tenant-a",
      actorId,
    ]);

    dbMocks.statements.splice(0);
    await listInternalCaptureAssets({
      tenantId: "tenant-a",
      actorId,
    }, {
      kind: "browser_frame",
      scopeField: "runId",
      scopeValue: "run-a",
      limit: 4,
    });
    expect(dbMocks.statements[0].text).not.toContain(" OR actor_id = ");
    expect(dbMocks.statements[0].params).toContain(actorId);
    expect(dbMocks.statements[0].params).not.toContain(canonicalActorId);
  });
});

function assetRow(id: string, ownerActorId: string) {
  return {
    id,
    tenant_id: "tenant-a",
    actor_id: ownerActorId,
    filename: `${id}.txt`,
    media_type: "text/plain",
    extension: "txt",
    byte_count: 12,
    content_sha256: "a".repeat(64),
    storage_kind: "database",
    status: "indexed",
    extraction_status: "completed",
    tags: ["capture"],
    metadata: {},
    created_at: "2026-09-04T10:00:00.000Z",
    updated_at: "2026-09-04T12:00:00.000Z",
  };
}

function fileAsset(
  id: string,
  ownerActorId: string,
  metadata: Record<string, unknown> = {},
) {
  return {
    id,
    tenantId: "tenant-a",
    actorId: ownerActorId,
    filename: `${id}.txt`,
    mediaType: "text/plain",
    extension: "txt",
    byteCount: 12,
    contentSha256: "a".repeat(64),
    storageKind: "filesystem" as const,
    status: "stored" as const,
    extractionStatus: "pending" as const,
    tags: ["capture"],
    metadata,
    contentPath: `/tmp/${id}.txt`,
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
