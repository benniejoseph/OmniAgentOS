import { beforeEach, describe, expect, it, vi } from "vitest";

const snapshotMocks = vi.hoisted(() => ({
  getMcpExportConfiguration: vi.fn(),
  getMcpExportConfigurationForRequest: vi.fn(),
  listModelAssignmentsForRequest: vi.fn(),
  listModelCatalogForRequest: vi.fn(),
  listProviderConnections: vi.fn(),
  listProviderConnectionsForRequest: vi.fn(),
  listServiceApiKeysForRequest: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({
  isAuthEnforced: vi.fn(() => true),
  isBootstrapConfigured: vi.fn(() => false),
}));

vi.mock("@/lib/db/client", () => ({
  getStorageBackend: vi.fn(() => "postgres"),
  hasDatabaseUrl: vi.fn(() => true),
}));

vi.mock("@/lib/settings/credential-vault", () => ({
  credentialVaultStatus: vi.fn(() => ({
    configured: true,
    activeKeyId: "keyring-a",
    message: "Ready",
  })),
}));

vi.mock("@/lib/settings/service-api-keys", () => ({
  listServiceApiKeysForRequest:
    snapshotMocks.listServiceApiKeysForRequest,
}));

vi.mock("@/lib/settings/store", () => ({
  getMcpExportConfiguration: snapshotMocks.getMcpExportConfiguration,
  getMcpExportConfigurationForRequest:
    snapshotMocks.getMcpExportConfigurationForRequest,
  listModelAssignmentsForRequest:
    snapshotMocks.listModelAssignmentsForRequest,
  listModelCatalogForRequest: snapshotMocks.listModelCatalogForRequest,
  listProviderConnections: snapshotMocks.listProviderConnections,
  listProviderConnectionsForRequest:
    snapshotMocks.listProviderConnectionsForRequest,
}));

import { getSettingsSnapshot } from "@/lib/settings/snapshot";

const input = {
  tenantId: "tenant-a",
  actorId: "settings-owner@example.test",
  requestActorBinding: {
    version: 1 as const,
    kind: "auth_user" as const,
    authUserId: "11111111-1111-4111-8111-111111111111",
    canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
    legacyOwnerActorIds: Object.freeze(["settings-owner@example.test"]),
    readableOwnerActorIds: Object.freeze([
      "actor:11111111-1111-4111-8111-111111111111",
      "settings-owner@example.test",
    ]),
  },
};

beforeEach(() => {
  snapshotMocks.listProviderConnections.mockReset().mockResolvedValue([]);
  snapshotMocks.listProviderConnectionsForRequest.mockReset().mockResolvedValue([]);
  snapshotMocks.listModelCatalogForRequest.mockReset().mockResolvedValue([]);
  snapshotMocks.listModelAssignmentsForRequest.mockReset().mockResolvedValue([]);
  snapshotMocks.listServiceApiKeysForRequest.mockReset().mockResolvedValue([]);
  snapshotMocks.getMcpExportConfiguration.mockReset().mockResolvedValue({
    tenantId: input.tenantId,
    actorId: input.actorId,
    enabled: false,
    serverName: "Asael",
    allowedScopes: [],
    defaultApprovalMode: "governed",
    exposeResources: false,
    endpointPath: "/api/mcp",
    readiness: "disabled",
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:00:00.000Z",
  });
  snapshotMocks.getMcpExportConfigurationForRequest
    .mockReset()
    .mockResolvedValue({
      tenantId: input.tenantId,
      actorId: input.actorId,
      enabled: false,
      serverName: "Asael",
      allowedScopes: [],
      defaultApprovalMode: "governed",
      exposeResources: false,
      endpointPath: "/api/mcp",
      readiness: "disabled",
      manageable: true,
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:00.000Z",
    });
});

describe("settings snapshot owner scopes", () => {
  it("passes the request binding to the opt-in provider metadata list", async () => {
    const snapshot = await getSettingsSnapshot({
      ...input,
      providerOwnerScope: "readable",
      modelAssignmentOwnerScope: "readable",
    });

    const exactOwner = {
      tenantId: input.tenantId,
      actorId: input.actorId,
    };
    expect(snapshotMocks.listProviderConnectionsForRequest).toHaveBeenCalledWith({
      ...exactOwner,
      requestActorBinding: input.requestActorBinding,
      includeDeploymentFallback: true,
    });
    expect(snapshotMocks.listProviderConnections).not.toHaveBeenCalled();
    expect(snapshotMocks.listModelCatalogForRequest).toHaveBeenCalledWith(
      input,
    );
    expect(snapshotMocks.listModelAssignmentsForRequest).toHaveBeenCalledWith(
      input,
    );
    expect(snapshotMocks.getMcpExportConfiguration).toHaveBeenCalledWith(
      exactOwner,
    );
    expect(
      snapshotMocks.getMcpExportConfigurationForRequest,
    ).not.toHaveBeenCalled();
    expect(snapshotMocks.listServiceApiKeysForRequest).toHaveBeenCalledWith(
      input,
    );
    expect(snapshot.requestReadContracts).toEqual({
      providerConnections: "readable_v1",
      modelAssignments: "readable_v1",
      mcpExportConfiguration: "exact_v1",
    });
  });

  it("keeps provider metadata exact when the opt-in is absent", async () => {
    snapshotMocks.listProviderConnections.mockResolvedValue([
      {
        actorId: input.actorId,
        source: "tenant_vault",
        provider: "openai",
      },
      {
        actorId: "unexpected-owner@example.test",
        source: "tenant_vault",
        provider: "google",
      },
      {
        actorId: input.actorId,
        source: "deployment_environment",
        provider: "anthropic",
      },
    ]);
    snapshotMocks.listModelAssignmentsForRequest.mockResolvedValue([
      { actorId: input.actorId, scope: "main_agent", manageable: true },
      { actorId: input.actorId, scope: "workflow", manageable: true },
    ]);
    const snapshot = await getSettingsSnapshot(input);

    expect(snapshotMocks.listProviderConnections).toHaveBeenCalledWith({
      tenantId: input.tenantId,
      actorId: input.actorId,
      includeDeploymentFallback: true,
    });
    expect(snapshotMocks.listProviderConnectionsForRequest).not.toHaveBeenCalled();
    expect(snapshotMocks.listModelAssignmentsForRequest).toHaveBeenCalledWith({
      tenantId: input.tenantId,
      actorId: input.actorId,
    });
    expect(snapshot.providers.map((provider) => provider.manageable)).toEqual([
      true,
      false,
      false,
    ]);
    expect(snapshot.requestReadContracts).toEqual({
      providerConnections: "exact_v1",
      modelAssignments: "exact_v1",
      mcpExportConfiguration: "exact_v1",
    });
    expect(snapshot.assignments.map((assignment) => assignment.manageable)).toEqual([
      true,
      true,
    ]);
    expect(snapshot.mcp.manageable).toBe(true);
  });

  it("can widen assignment metadata without widening provider metadata", async () => {
    await getSettingsSnapshot({
      ...input,
      modelAssignmentOwnerScope: "readable",
    });

    expect(snapshotMocks.listProviderConnections).toHaveBeenCalledWith({
      tenantId: input.tenantId,
      actorId: input.actorId,
      includeDeploymentFallback: true,
    });
    expect(snapshotMocks.listProviderConnectionsForRequest).not.toHaveBeenCalled();
    expect(snapshotMocks.listModelAssignmentsForRequest).toHaveBeenCalledWith(
      input,
    );
  });

  it("widens MCP metadata only when its independent owner scope is requested", async () => {
    snapshotMocks.getMcpExportConfigurationForRequest.mockResolvedValue({
      tenantId: input.tenantId,
      actorId: input.actorId,
      enabled: true,
      serverName: "Retained MCP",
      allowedScopes: ["mcp:discover"],
      defaultApprovalMode: "governed",
      exposeResources: false,
      endpointPath: "/api/mcp",
      readiness: "ready",
      manageable: false,
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:00.000Z",
    });

    const snapshot = await getSettingsSnapshot({
      ...input,
      mcpOwnerScope: "readable",
    });

    expect(snapshotMocks.getMcpExportConfigurationForRequest).toHaveBeenCalledWith(
      input,
    );
    expect(snapshotMocks.getMcpExportConfiguration).not.toHaveBeenCalled();
    expect(snapshot.mcp).toEqual(expect.objectContaining({
      actorId: input.actorId,
      serverName: "Retained MCP",
      manageable: false,
    }));
    expect(snapshot.requestReadContracts).toEqual({
      providerConnections: "exact_v1",
      modelAssignments: "exact_v1",
      mcpExportConfiguration: "readable_v1",
    });
  });
});
