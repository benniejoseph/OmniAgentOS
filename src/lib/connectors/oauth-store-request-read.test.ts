import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const mocks = vi.hoisted(() => {
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

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: mocks.getSql,
  hasDatabaseUrl: mocks.hasDatabaseUrl,
}));

vi.mock("@/lib/storage/json", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage/json")>()),
  readJsonFile: mocks.readJsonFile,
}));

import {
  OAuthGrantReadConflictError,
  listOAuthGrantsForRequest,
} from "@/lib/connectors/oauth-store";

const tenantId = "tenant-a";
const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "oauth-owner@example.test";
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
  mocks.state.databaseEnabled = true;
  mocks.rows.splice(0);
  mocks.statements.splice(0);
  mocks.ensureDatabaseSchema.mockClear();
  mocks.getSql.mockClear();
  mocks.hasDatabaseUrl.mockClear();
  mocks.readJsonFile.mockReset().mockResolvedValue({ grants: [] });
  mocks.sql.mockClear();
});

describe("request-bound OAuth connection metadata", () => {
  it("selects only public metadata and derives management from physical ownership", async () => {
    mocks.rows.push(
      {
        ...grantRow(
          "11111111-1111-4111-8111-111111111111",
          canonicalActorId,
        ),
        sync_status: "error",
        sync_error: "provider\nwarning\u202e",
        sealed_tokens: "must-not-leak",
        sync_cursor: "must-not-leak",
      },
    );

    const records = await listOAuthGrantsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });

    expect(records).toEqual([
      expect.objectContaining({
        actorId,
        provider: "google",
        syncError: "provider warning",
        manageable: false,
      }),
    ]);
    expect(mocks.statements).toHaveLength(1);
    expect(mocks.statements[0].text).not.toContain("SELECT *");
    expect(mocks.statements[0].text).not.toContain("sealed_tokens");
    expect(mocks.statements[0].text).not.toContain("sync_cursor");
    expect(mocks.statements[0].text).toMatch(
      /tenant_id = \$\d+[\s\S]*?actor_id IN \(\$\d+, \$\d+\)[\s\S]*?tenant_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?actor_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?OR actor_id COLLATE "C" = \$\d+::text COLLATE "C"/,
    );
    expect(mocks.statements[0].params).toEqual([
      tenantId,
      canonicalActorId,
      actorId,
      tenantId,
      canonicalActorId,
      actorId,
    ]);
    expect(JSON.stringify(records)).not.toContain("must-not-leak");
  });

  it("uses the exact actor twice when the request binding is malformed", async () => {
    await listOAuthGrantsForRequest({
      tenantId,
      actorId,
      requestActorBinding: {
        ...binding,
        readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
      },
    });

    expect(mocks.statements[0].params).toEqual([
      tenantId,
      actorId,
      actorId,
      tenantId,
      actorId,
      actorId,
    ]);
  });

  it("rejects unexpected owners, duplicate ids, and provider collisions", async () => {
    mocks.rows.push(grantRow(
      "22222222-2222-4222-8222-222222222222",
      "unexpected-owner@example.test",
    ));
    await expect(listOAuthGrantsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(OAuthGrantReadConflictError);

    const duplicateId = "33333333-3333-4333-8333-333333333333";
    mocks.rows.splice(
      0,
      mocks.rows.length,
      grantRow(duplicateId, canonicalActorId),
      grantRow(duplicateId, actorId),
    );
    const duplicateIdRead = listOAuthGrantsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });
    await expect(duplicateIdRead).rejects.toBeInstanceOf(
      OAuthGrantReadConflictError,
    );
    await expect(duplicateIdRead).rejects.toMatchObject({
      name: "OAuthGrantReadConflictError",
      message: "Duplicate OAuth connection identifiers were found.",
    });

    mocks.rows.splice(
      0,
      mocks.rows.length,
      grantRow("44444444-4444-4444-8444-444444444444", canonicalActorId),
      grantRow("55555555-5555-4555-8555-555555555555", actorId),
    );
    const providerCollisionRead = listOAuthGrantsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });
    await expect(providerCollisionRead).rejects.toBeInstanceOf(
      OAuthGrantReadConflictError,
    );
    await expect(providerCollisionRead).rejects.toMatchObject({
      name: "OAuthGrantReadConflictError",
      message: "OAuth connection provider ownership is ambiguous.",
    });
  });

  it("fails closed on malformed lifecycle and scope metadata", async () => {
    const invalidRows = [
      { ...grantRow("66666666-6666-4666-8666-666666666666", actorId), status: "revoked" },
      { ...grantRow("66666666-6666-4666-8666-666666666666", actorId), authorization_generation: 0 },
      { ...grantRow("66666666-6666-4666-8666-666666666666", actorId), authorization_generation: true },
      { ...grantRow("66666666-6666-4666-8666-666666666666", actorId), authorization_generation: "1e2" },
      { ...grantRow("66666666-6666-4666-8666-666666666666", actorId), scopes: ["unsafe\nvalue"] },
      { ...grantRow("66666666-6666-4666-8666-666666666666", actorId), sync_status: "healthy", sync_error: "contradiction" },
      { ...grantRow("66666666-6666-4666-8666-666666666666", actorId), synced_items: -1 },
      { ...grantRow("66666666-6666-4666-8666-666666666666", actorId), synced_items: " 12 " },
      { ...grantRow("66666666-6666-4666-8666-666666666666", actorId), updated_at: "2026-09-05 10:00:00Z" },
      { ...grantRow("66666666-6666-4666-8666-666666666666", actorId), last_synced_at: null },
      { ...grantRow("66666666-6666-4666-8666-666666666666", actorId), last_synced_at: "2026-09-06T10:00:00.000Z" },
    ];

    for (const row of invalidRows) {
      mocks.rows.splice(0, mocks.rows.length, row);
      await expect(listOAuthGrantsForRequest({
        tenantId,
        actorId,
        requestActorBinding: binding,
      })).rejects.toBeInstanceOf(OAuthGrantReadConflictError);
    }
  });

  it("keeps file fallback exact-owner and strips token material", async () => {
    mocks.state.databaseEnabled = false;
    mocks.readJsonFile.mockResolvedValue({
      grants: [
        fileGrant(
          "77777777-7777-4777-8777-777777777777",
          canonicalActorId,
        ),
        {
          ...fileGrant(
            "88888888-8888-4888-8888-888888888888",
            actorId,
          ),
          authorizationGeneration: undefined,
          sealedTokens: { ciphertext: "must-not-leak" },
          syncCursor: "must-not-leak",
          futureSecret: "also-must-not-leak",
        },
      ],
    });

    const records = await listOAuthGrantsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });

    expect(records).toEqual([
      expect.objectContaining({
        actorId,
        provider: "google",
        authorizationGeneration: 1,
        manageable: true,
      }),
    ]);
    expect(records[0]).not.toHaveProperty("sealedTokens");
    expect(records[0]).not.toHaveProperty("syncCursor");
    expect(records[0]).not.toHaveProperty("futureSecret");
    expect(JSON.stringify(records)).not.toContain("must-not-leak");
    expect(mocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("defaults only absent legacy file fields and rejects explicit nulls", async () => {
    mocks.state.databaseEnabled = false;
    mocks.readJsonFile.mockResolvedValue({
      grants: [{
        ...fileGrant(
          "99999999-9999-4999-8999-999999999999",
          actorId,
        ),
        authorizationGeneration: null,
      }],
    });

    await expect(listOAuthGrantsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(OAuthGrantReadConflictError);
  });
});

function grantRow(id: string, ownerActorId: string) {
  return {
    id,
    tenant_id: tenantId,
    actor_id: ownerActorId,
    provider: "google",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    status: "active",
    authorization_generation: "2",
    expires_at: "2026-09-06T10:00:00.000Z",
    sync_status: "healthy",
    sync_error: null,
    last_synced_at: "2026-09-05T09:00:00.000Z",
    synced_items: 12,
    created_at: "2026-09-03T10:00:00.000Z",
    updated_at: "2026-09-05T10:00:00.000Z",
  };
}

function fileGrant(id: string, ownerActorId: string) {
  const row = grantRow(id, ownerActorId);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    provider: row.provider,
    scopes: row.scopes,
    status: row.status,
    authorizationGeneration: Number(row.authorization_generation),
    expiresAt: row.expires_at,
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at,
    syncedItems: row.synced_items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sealedTokens: { ciphertext: "ciphertext" },
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
