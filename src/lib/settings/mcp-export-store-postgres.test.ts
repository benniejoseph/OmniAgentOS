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
      async (_tenantId: string, operation: () => Promise<unknown>) =>
        operation(),
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
  McpExportConfigurationReadConflictError,
  getMcpExportConfigurationForRequest,
} from "@/lib/settings/store";

const tenantId = "tenant-a";
const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "mcp-owner@example.test";
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
  dbMocks.readJsonFile.mockReset().mockResolvedValue({ mcp: [] });
  dbMocks.sql.mockClear();
});

describe("request-bound MCP export configuration", () => {
  it("selects explicit public columns and projects canonical ownership read-only", async () => {
    dbMocks.rows.push({
      ...configurationRow(canonicalActorId),
      server_name: "Canonical\nMCP\u202e export",
      future_secret: "must-not-leak",
    });

    const configuration = await getMcpExportConfigurationForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });

    expect(configuration).toEqual({
      tenantId,
      actorId,
      enabled: true,
      serverName: "Canonical MCP export",
      allowedScopes: ["mcp:discover", "mcp:tools:list"],
      defaultApprovalMode: "governed",
      exposeResources: true,
      endpointPath: "/api/mcp",
      readiness: "ready",
      createdAt: "2026-09-05T10:00:00.000Z",
      updatedAt: "2026-09-05T11:00:00.000Z",
      manageable: false,
    });
    expect(configuration).not.toHaveProperty("futureSecret");
    expect(JSON.stringify(configuration)).not.toContain("must-not-leak");
    expect(dbMocks.statements).toHaveLength(1);
    expect(dbMocks.statements[0].text).not.toContain("SELECT *");
    expect(dbMocks.statements[0].text).toMatch(
      /SELECT tenant_id, actor_id, enabled, server_name, allowed_scopes,[\s\S]*?default_approval_mode, expose_resources, created_at, updated_at[\s\S]*?tenant_id = \$\d+[\s\S]*?actor_id IN \(\$\d+, \$\d+\)[\s\S]*?tenant_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?actor_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?OR actor_id COLLATE "C" = \$\d+::text COLLATE "C"/,
    );
    expect(dbMocks.statements[0].params).toEqual([
      tenantId,
      canonicalActorId,
      actorId,
      tenantId,
      canonicalActorId,
      actorId,
    ]);
  });

  it("marks an exact-owner row manageable", async () => {
    dbMocks.rows.push(configurationRow(actorId));

    await expect(getMcpExportConfigurationForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual(expect.objectContaining({
      tenantId,
      actorId,
      manageable: true,
    }));
  });

  it("returns an exact manageable default only when no row exists", async () => {
    const configuration = await getMcpExportConfigurationForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });

    expect(configuration).toEqual(expect.objectContaining({
      tenantId,
      actorId,
      enabled: false,
      serverName: "Asael",
      allowedScopes: ["mcp:discover", "mcp:tools:list"],
      defaultApprovalMode: "governed",
      exposeResources: false,
      endpointPath: "/api/mcp",
      readiness: "disabled",
      manageable: true,
    }));
    expect(configuration.createdAt).toBe(configuration.updatedAt);
  });

  it("uses the exact actor twice when the request binding is malformed", async () => {
    await getMcpExportConfigurationForRequest({
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

  it("fails closed with a typed 409 when both physical owners have rows", async () => {
    dbMocks.rows.push(
      configurationRow(canonicalActorId),
      configurationRow(actorId),
    );

    const read = getMcpExportConfigurationForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });
    await expect(read).rejects.toBeInstanceOf(
      McpExportConfigurationReadConflictError,
    );
    await expect(read).rejects.toMatchObject({
      name: "McpExportConfigurationReadConflictError",
      message: "MCP export configuration ownership is ambiguous.",
      status: 409,
    });
  });

  it("rejects malformed owner, boolean, server, scope, policy, and timestamp fields", async () => {
    const base = configurationRow(actorId);
    const invalidRows = [
      { ...base, tenant_id: "tenant-b" },
      { ...base, actor_id: "unexpected-owner@example.test" },
      { ...base, enabled: "true" },
      { ...base, server_name: 42 },
      { ...base, server_name: " Padded MCP" },
      { ...base, server_name: "x".repeat(121) },
      { ...base, server_name: "😀".repeat(61) },
      { ...base, allowed_scopes: "mcp:discover" },
      { ...base, allowed_scopes: ["mcp:discover", "mcp:discover"] },
      { ...base, allowed_scopes: ["mcp:discover", "unsafe:scope"] },
      { ...base, default_approval_mode: "automatic" },
      { ...base, expose_resources: "false" },
      { ...base, created_at: "2026-09-05 10:00:00Z" },
      { ...base, updated_at: "2026-09-05T09:00:00.000Z" },
    ];

    for (const row of invalidRows) {
      dbMocks.rows.splice(0, dbMocks.rows.length, row);
      await expect(getMcpExportConfigurationForRequest({
        tenantId,
        actorId,
        requestActorBinding: binding,
      })).rejects.toBeInstanceOf(McpExportConfigurationReadConflictError);
    }
  });

  it("keeps file fallback exact-owner, strictly projected, and manageable", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      mcp: [
        fileConfiguration(canonicalActorId),
        {
          ...fileConfiguration(actorId),
          serverName: "File\nMCP",
          futureSecret: "must-not-leak",
        },
      ],
    });

    const configuration = await getMcpExportConfigurationForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });

    expect(configuration).toEqual(expect.objectContaining({
      tenantId,
      actorId,
      serverName: "File MCP",
      manageable: true,
    }));
    expect(configuration).not.toHaveProperty("futureSecret");
    expect(JSON.stringify(configuration)).not.toContain("must-not-leak");
    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(dbMocks.sql).not.toHaveBeenCalled();
  });

  it("returns the exact default instead of reading a canonical file row", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      mcp: [fileConfiguration(canonicalActorId)],
    });

    const configuration = await getMcpExportConfigurationForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });

    expect(configuration).toEqual(expect.objectContaining({
      tenantId,
      actorId,
      enabled: false,
      serverName: "Asael",
      manageable: true,
    }));
    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(dbMocks.sql).not.toHaveBeenCalled();
  });

  it("does not replace malformed file metadata with a default", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      mcp: [{
        ...fileConfiguration(actorId),
        enabled: null,
      }],
    });

    await expect(getMcpExportConfigurationForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(McpExportConfigurationReadConflictError);
  });
});

function configurationRow(ownerActorId: string) {
  return {
    tenant_id: tenantId,
    actor_id: ownerActorId,
    enabled: true,
    server_name: "Team MCP",
    allowed_scopes: ["mcp:discover", "mcp:tools:list"],
    default_approval_mode: "governed",
    expose_resources: true,
    created_at: "2026-09-05T10:00:00.000Z",
    updated_at: "2026-09-05T11:00:00.000Z",
  };
}

function fileConfiguration(ownerActorId: string) {
  return {
    tenantId,
    actorId: ownerActorId,
    enabled: true,
    serverName: "Team MCP",
    allowedScopes: ["mcp:discover", "mcp:tools:list"],
    defaultApprovalMode: "governed",
    exposeResources: true,
    endpointPath: "/api/mcp",
    readiness: "ready",
    createdAt: "2026-09-05T10:00:00.000Z",
    updatedAt: "2026-09-05T11:00:00.000Z",
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
