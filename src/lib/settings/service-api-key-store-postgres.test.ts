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
    runWithDatabaseTenantScope: vi.fn(
      async (_tenantId: string, operation: () => Promise<unknown>) => operation(),
    ),
  };
});

vi.mock("@/lib/storage/json", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/json")>();
  return { ...actual, readJsonFile: dbMocks.readJsonFile };
});

vi.mock("@/lib/events/store", () => ({
  appendDomainEventSafely: vi.fn(async () => undefined),
}));

import {
  SettingsStoreError,
  listServiceApiKeyRecordsForRequest,
} from "@/lib/settings/store";
import { serviceApiKeyPreviewTenantSegmentV2 } from "@/lib/settings/service-api-key-preview";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "settings-owner@example.test";
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
  dbMocks.readJsonFile.mockReset().mockResolvedValue({ apiKeys: [] });
  dbMocks.sql.mockClear();
});

describe("request-bound service API key records", () => {
  it("merges redacted rows, projects the request actor, and gates management", async () => {
    dbMocks.rows.push(
      serviceKeyRow("11111111-1111-4111-8111-111111111111", canonicalActorId),
      serviceKeyRow("22222222-2222-4222-8222-222222222222", actorId),
    );

    const records = await listServiceApiKeyRecordsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    });
    expect(records).toEqual([
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        actorId,
        manageable: false,
      }),
      expect.objectContaining({
        id: "22222222-2222-4222-8222-222222222222",
        actorId,
        manageable: true,
      }),
    ]);

    expect(dbMocks.statements).toHaveLength(1);
    expect(dbMocks.statements[0].text).not.toContain("SELECT *");
    expect(dbMocks.statements[0].text).not.toContain("token_hash");
    expect(dbMocks.statements[0].text).toMatch(
      /tenant_id = \$\d+[\s\S]*?actor_id IN \(\$\d+, \$\d+\)[\s\S]*?tenant_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?actor_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?OR actor_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?ORDER BY created_at DESC, id COLLATE "C" ASC/,
    );
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      canonicalActorId,
      actorId,
      "tenant-a",
      canonicalActorId,
      actorId,
    ]);
    expect(JSON.stringify(records)).not.toContain("tokenHash");
  });

  it("uses the exact actor twice for a malformed request binding", async () => {
    await listServiceApiKeyRecordsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: {
        ...binding,
        readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
      },
    });

    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      actorId,
      actorId,
      "tenant-a",
      actorId,
      actorId,
    ]);
  });

  it("fails the complete read on an unexpected owner or duplicate id", async () => {
    dbMocks.rows.push(serviceKeyRow(
      "33333333-3333-4333-8333-333333333333",
      "unexpected-owner@example.test",
    ));
    await expect(listServiceApiKeyRecordsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(SettingsStoreError);

    dbMocks.rows.splice(
      0,
      1,
      serviceKeyRow("44444444-4444-4444-8444-444444444444", canonicalActorId),
      serviceKeyRow("44444444-4444-4444-8444-444444444444", actorId),
    );
    await expect(listServiceApiKeyRecordsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(SettingsStoreError);
  });

  it("rejects token previews that do not bind to the tenant and key id", async () => {
    const id = "77777777-7777-4777-8777-777777777777";
    const base = serviceKeyRow(id, actorId);
    const invalidPreviews = [
      `asael_sk_${serviceApiKeyPreviewTenantSegmentV2("tenant-b")}…${id.slice(0, 8)}`,
      `${base.token_prefix.slice(0, -8)}99999999`,
      `${base.token_prefix}extra`,
    ];

    for (const tokenPrefix of invalidPreviews) {
      dbMocks.rows.splice(0, dbMocks.rows.length, {
        ...base,
        token_prefix: tokenPrefix,
      });
      await expect(listServiceApiKeyRecordsForRequest({
        tenantId: "tenant-a",
        actorId,
        requestActorBinding: binding,
      })).rejects.toBeInstanceOf(SettingsStoreError);
    }
  });

  it("safely projects historical names accepted before write hardening", async () => {
    dbMocks.rows.push({
      ...serviceKeyRow("88888888-8888-4888-8888-888888888888", actorId),
      name: "Automation\nkey\u0000",
    });

    const records = await listServiceApiKeyRecordsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    });

    expect(records[0].name).toBe("Automation�key�");
    expect(records[0].name).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("keeps file fallback exact-owner and strips the token hash", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      apiKeys: [
        fileServiceKey("55555555-5555-4555-8555-555555555555", canonicalActorId),
        {
          ...fileServiceKey("66666666-6666-4666-8666-666666666666", actorId),
          futureSecret: "must-not-leak",
        },
      ],
    });

    const records = await listServiceApiKeyRecordsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    });

    expect(records).toEqual([
      expect.objectContaining({
        id: "66666666-6666-4666-8666-666666666666",
        actorId,
        manageable: true,
      }),
    ]);
    expect(records[0]).not.toHaveProperty("tokenHash");
    expect(records[0]).not.toHaveProperty("futureSecret");
    expect(JSON.stringify(records)).not.toContain("must-not-leak");
    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(dbMocks.sql).not.toHaveBeenCalled();
  });
});

function serviceKeyRow(id: string, ownerActorId: string) {
  const tenantSegment = serviceApiKeyPreviewTenantSegmentV2("tenant-a");
  return {
    id,
    tenant_id: "tenant-a",
    actor_id: ownerActorId,
    name: `Key ${id.slice(0, 4)}`,
    token_prefix: `asael_sk_${tenantSegment}…${id.slice(0, 8)}`,
    token_last_four: "abcd",
    scopes: ["mcp:discover", "mcp:tools:list"],
    status: "active",
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    created_at: "2026-09-04T10:00:00.000Z",
    updated_at: "2026-09-04T10:00:00.000Z",
  };
}

function fileServiceKey(id: string, ownerActorId: string) {
  const tenantSegment = serviceApiKeyPreviewTenantSegmentV2("tenant-a");
  return {
    id,
    tenantId: "tenant-a",
    actorId: ownerActorId,
    name: `Key ${id.slice(0, 4)}`,
    tokenHash: "a".repeat(64),
    tokenPrefix: `asael_sk_${tenantSegment}…${id.slice(0, 8)}`,
    tokenLastFour: "abcd",
    scopes: ["mcp:discover"],
    status: "active",
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:00:00.000Z",
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
