import { createHash } from "node:crypto";
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
  listModelCatalogForRequest,
} from "@/lib/settings/store";

const tenantId = "tenant-a";
const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "catalog-owner@example.test";
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
  dbMocks.readJsonFile.mockReset().mockResolvedValue({ models: [] });
  dbMocks.sql.mockClear();
});

describe("request-bound model catalog records", () => {
  it("merges explicit metadata rows and derives selectability from the owner", async () => {
    dbMocks.rows.push(
      {
        ...modelRow(canonicalActorId, "gpt-canonical", "Canonical model"),
        future_secret: "must-not-leak",
      },
      modelRow(actorId, "gpt-exact", "Exact model"),
    );

    const records = await listModelCatalogForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });

    expect(records).toEqual([
      expect.objectContaining({
        actorId,
        modelId: "gpt-canonical",
        selectable: false,
      }),
      expect.objectContaining({
        actorId,
        modelId: "gpt-exact",
        selectable: true,
      }),
    ]);
    expect(dbMocks.statements).toHaveLength(1);
    expect(dbMocks.statements[0].text).not.toContain("SELECT *");
    expect(dbMocks.statements[0].text).not.toContain("sealed_credentials");
    expect(dbMocks.statements[0].text).toMatch(
      /tenant_id = \$\d+[\s\S]*?actor_id IN \(\$\d+, \$\d+\)[\s\S]*?tenant_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?actor_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?OR actor_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?ORDER BY provider COLLATE "C", display_name COLLATE "C",[\s\S]*?model_id COLLATE "C", id COLLATE "C"/,
    );
    expect(dbMocks.statements[0].params).toEqual([
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
    await listModelCatalogForRequest({
      tenantId,
      actorId,
      requestActorBinding: {
        ...binding,
        readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
      },
    });

    expect(dbMocks.statements[0].params).toEqual([
      tenantId,
      actorId,
      actorId,
      tenantId,
      actorId,
      actorId,
    ]);
  });

  it("rejects invalid hashes, unexpected owners, and semantic collisions", async () => {
    dbMocks.rows.push({
      ...modelRow(actorId, "gpt-exact", "Exact model"),
      id: "0".repeat(64),
    });
    await expect(listModelCatalogForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(SettingsStoreError);

    dbMocks.rows.splice(
      0,
      dbMocks.rows.length,
      modelRow("unexpected-owner@example.test", "gpt-exact", "Exact model"),
    );
    await expect(listModelCatalogForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(SettingsStoreError);

    dbMocks.rows.splice(0, dbMocks.rows.length, {
      ...modelRow(actorId, "wrong-tenant", "Wrong tenant"),
      tenant_id: "tenant-b",
    });
    await expect(listModelCatalogForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(SettingsStoreError);

    dbMocks.rows.splice(
      0,
      dbMocks.rows.length,
      modelRow(canonicalActorId, "shared-model", "Canonical copy"),
      modelRow(actorId, "shared-model", "Exact copy"),
    );
    await expect(listModelCatalogForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(SettingsStoreError);
  });

  it("sanitizes provider display data and withholds unsafe identifiers", async () => {
    const unsafeModelId = " model\nidentifier ";
    dbMocks.rows.push({
      ...modelRow(actorId, unsafeModelId, "Model\nname\u0000"),
      capabilities: ["text", "text", "tool\nuse"],
      lifecycle_reason: "Provider\nnotice\u0000",
    });

    const [record] = await listModelCatalogForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });

    expect(record.selectable).toBe(false);
    expect(record.modelId).toBe(unsafeModelId);
    expect(record.displayModelId).toBe("model�identifier");
    expect(record.displayName).toBe("Model�name�");
    expect(record.capabilities).toEqual(["text", "tool�use"]);
    expect(record.lifecycleReason).toBe("Provider�notice�");
    expect(record.displayModelId).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("matches the assignment length boundary without hiding longer IDs", async () => {
    const acceptedModelId = "a".repeat(240);
    const retainedModelId = "m".repeat(241);
    dbMocks.rows.push(
      modelRow(actorId, acceptedModelId, "Accepted identifier"),
      modelRow(actorId, retainedModelId, "Retained identifier"),
    );

    const records = await listModelCatalogForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });

    expect(records[0]).toEqual(expect.objectContaining({
      modelId: acceptedModelId,
      selectable: true,
    }));
    expect(records[1]).toEqual(expect.objectContaining({
      modelId: retainedModelId,
      displayModelId: retainedModelId,
      selectable: false,
    }));
  });

  it("keeps file fallback exact-owner and strips unknown fields", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      models: [
        fileModel(canonicalActorId, "canonical-file-model"),
        {
          ...fileModel(actorId, "exact-file-model"),
          futureSecret: "must-not-leak",
        },
      ],
    });

    const records = await listModelCatalogForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });

    expect(records).toEqual([
      expect.objectContaining({
        actorId,
        modelId: "exact-file-model",
        selectable: true,
      }),
    ]);
    expect(records[0]).not.toHaveProperty("futureSecret");
    expect(JSON.stringify(records)).not.toContain("must-not-leak");
    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(dbMocks.sql).not.toHaveBeenCalled();

    dbMocks.readJsonFile.mockResolvedValue({
      models: [{
        ...fileModel(actorId, "forged-file-model"),
        provider: "unknown-provider",
      }],
    });
    await expect(listModelCatalogForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(SettingsStoreError);

    dbMocks.readJsonFile.mockResolvedValue({
      models: [{
        ...fileModel(actorId, "forged-file-model"),
        id: "0".repeat(64),
      }],
    });
    await expect(listModelCatalogForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(SettingsStoreError);
  });
});

function modelRow(
  ownerActorId: string,
  modelId: string,
  displayName: string,
) {
  return {
    id: catalogId(ownerActorId, "openai", modelId),
    tenant_id: tenantId,
    actor_id: ownerActorId,
    provider: "openai",
    model_id: modelId,
    display_name: displayName,
    capabilities: ["text", "tools"],
    lifecycle: "available",
    lifecycle_reason: null,
    lifecycle_checked_at: "2026-09-04T10:00:00.000Z",
    discovered_at: "2026-09-04T10:00:00.000Z",
    updated_at: "2026-09-04T10:00:00.000Z",
  };
}

function fileModel(ownerActorId: string, modelId: string) {
  return {
    id: catalogId(ownerActorId, "openai", modelId),
    tenantId,
    actorId: ownerActorId,
    provider: "openai",
    modelId,
    displayName: modelId,
    capabilities: ["text", "tools"],
    lifecycle: "available",
    discoveredAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:00:00.000Z",
  };
}

function catalogId(
  ownerActorId: string,
  provider: string,
  modelId: string,
) {
  return createHash("sha256")
    .update(`${tenantId}\0${ownerActorId}\0${provider}\0${modelId}`)
    .digest("hex");
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
