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
  listProviderConnectionsForRequest,
} from "@/lib/settings/store";

const tenantId = "tenant-a";
const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "provider-owner@example.test";
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
  dbMocks.readJsonFile.mockReset().mockResolvedValue({ providers: [] });
  dbMocks.sql.mockClear();
});

describe("request-bound provider connection metadata", () => {
  it("merges explicit metadata rows and derives management from physical ownership", async () => {
    dbMocks.rows.push(
      {
        ...providerRow(
          "11111111-1111-4111-8111-111111111111",
          canonicalActorId,
          "google",
        ),
        label: "Canonical\u202e\nconnection",
        validation_code: "provider\nnotice",
        future_secret: "must-not-leak",
      },
      providerRow(
        "22222222-2222-4222-8222-222222222222",
        actorId,
        "openai",
      ),
    );

    const records = await listProviderConnectionsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
      includeDeploymentFallback: false,
    });

    expect(records).toEqual([
      expect.objectContaining({
        actorId,
        provider: "google",
        label: "Canonical connection",
        validationCode: "provider notice",
        manageable: false,
        runtimeReadiness: "configuration_only",
      }),
      expect.objectContaining({
        actorId,
        provider: "openai",
        manageable: true,
        runtimeReadiness: "active_tenant_runtime",
      }),
    ]);
    expect(dbMocks.statements).toHaveLength(1);
    expect(dbMocks.statements[0].text).not.toContain("SELECT *");
    expect(dbMocks.statements[0].text).not.toContain("sealed_credentials");
    expect(dbMocks.statements[0].text).not.toContain("credential_key_id");
    expect(dbMocks.statements[0].text).toMatch(
      /tenant_id = \$\d+[\s\S]*?actor_id IN \(\$\d+, \$\d+\)[\s\S]*?tenant_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?actor_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?OR actor_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?ORDER BY updated_at DESC, id COLLATE "C"/,
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
    await listProviderConnectionsForRequest({
      tenantId,
      actorId,
      requestActorBinding: {
        ...binding,
        readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
      },
      includeDeploymentFallback: false,
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

  it("rejects unexpected owners, duplicate ids, and cross-owner provider collisions", async () => {
    dbMocks.rows.push(providerRow(
      "33333333-3333-4333-8333-333333333333",
      "unexpected-owner@example.test",
      "openai",
    ));
    await expect(listProviderConnectionsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
      includeDeploymentFallback: false,
    })).rejects.toBeInstanceOf(SettingsStoreError);

    const duplicateId = "44444444-4444-4444-8444-444444444444";
    dbMocks.rows.splice(
      0,
      dbMocks.rows.length,
      providerRow(duplicateId, canonicalActorId, "google"),
      providerRow(duplicateId, actorId, "openai"),
    );
    await expect(listProviderConnectionsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
      includeDeploymentFallback: false,
    })).rejects.toBeInstanceOf(SettingsStoreError);

    dbMocks.rows.splice(
      0,
      dbMocks.rows.length,
      providerRow(
        "55555555-5555-4555-8555-555555555555",
        canonicalActorId,
        "openai",
      ),
      providerRow(
        "66666666-6666-4666-8666-666666666666",
        actorId,
        "openai",
      ),
    );
    await expect(listProviderConnectionsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
      includeDeploymentFallback: false,
    })).rejects.toBeInstanceOf(SettingsStoreError);
  });

  it("fails closed on malformed credential metadata and revoked-state contradictions", async () => {
    const invalidRows = [
      { ...providerRow("77777777-7777-4777-8777-777777777777", actorId, "openai"), enabled: "true" },
      { ...providerRow("77777777-7777-4777-8777-777777777777", actorId, "openai"), label: 42 },
      { ...providerRow("77777777-7777-4777-8777-777777777777", actorId, "openai"), credential_fingerprint: "not-a-fingerprint" },
      { ...providerRow("77777777-7777-4777-8777-777777777777", actorId, "openai"), configured_fields: ["apiKey", "secretAccessKey"] },
      { ...providerRow("77777777-7777-4777-8777-777777777777", actorId, "openai"), status: "revoked", enabled: true, configured_fields: [], credential_fingerprint: null },
      { ...providerRow("77777777-7777-4777-8777-777777777777", actorId, "openai"), status: "revoked", enabled: false, configured_fields: ["apiKey"], credential_fingerprint: null },
    ];

    for (const row of invalidRows) {
      dbMocks.rows.splice(0, dbMocks.rows.length, row);
      await expect(listProviderConnectionsForRequest({
        tenantId,
        actorId,
        requestActorBinding: binding,
        includeDeploymentFallback: false,
      })).rejects.toBeInstanceOf(SettingsStoreError);
    }
  });

  it("keeps file fallback exact-owner and strips ciphertext and unknown fields", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      providers: [
        fileProvider(
          "88888888-8888-4888-8888-888888888888",
          canonicalActorId,
          "google",
        ),
        {
          ...fileProvider(
            "99999999-9999-4999-8999-999999999999",
            actorId,
            "openai",
          ),
          credentialKeyId: "secret-key-id",
          sealedCredentials: { ciphertext: "must-not-leak" },
          futureSecret: "also-must-not-leak",
        },
      ],
    });

    const records = await listProviderConnectionsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
      includeDeploymentFallback: false,
    });

    expect(records).toEqual([
      expect.objectContaining({
        actorId,
        provider: "openai",
        manageable: true,
      }),
    ]);
    expect(records[0]).not.toHaveProperty("credentialKeyId");
    expect(records[0]).not.toHaveProperty("sealedCredentials");
    expect(records[0]).not.toHaveProperty("futureSecret");
    expect(JSON.stringify(records)).not.toContain("must-not-leak");
    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(dbMocks.sql).not.toHaveBeenCalled();
  });
});

function providerRow(
  id: string,
  ownerActorId: string,
  provider: "openai" | "google" | "anthropic" | "aws_bedrock",
) {
  return {
    id,
    tenant_id: tenantId,
    actor_id: ownerActorId,
    provider,
    label: `${provider} connection`,
    status: "connected",
    enabled: true,
    credential_version: 2,
    credential_fingerprint: "0123456789ab",
    configured_fields: provider === "aws_bedrock"
      ? ["accessKeyId", "region", "secretAccessKey"]
      : ["apiKey"],
    last_validated_at: "2026-09-04T10:00:00.000Z",
    validation_code: null,
    catalog_refreshed_at: "2026-09-04T10:00:00.000Z",
    created_at: "2026-09-03T10:00:00.000Z",
    updated_at: provider === "google"
      ? "2026-09-05T10:00:00.000Z"
      : "2026-09-04T10:00:00.000Z",
    rotated_at: "2026-09-04T09:00:00.000Z",
  };
}

function fileProvider(
  id: string,
  ownerActorId: string,
  provider: "openai" | "google",
) {
  const row = providerRow(id, ownerActorId, provider);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    provider: row.provider,
    label: row.label,
    status: row.status,
    enabled: row.enabled,
    credentialVersion: row.credential_version,
    credentialFingerprint: row.credential_fingerprint,
    configuredFields: row.configured_fields,
    lastValidatedAt: row.last_validated_at,
    validationCode: row.validation_code,
    catalogRefreshedAt: row.catalog_refreshed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rotatedAt: row.rotated_at,
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
