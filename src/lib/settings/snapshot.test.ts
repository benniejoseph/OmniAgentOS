import { beforeEach, describe, expect, it, vi } from "vitest";

const snapshotMocks = vi.hoisted(() => ({
  getMcpExportConfiguration: vi.fn(),
  listModelAssignments: vi.fn(),
  listModelCatalog: vi.fn(),
  listProviderConnections: vi.fn(),
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
  listModelAssignments: snapshotMocks.listModelAssignments,
  listModelCatalog: snapshotMocks.listModelCatalog,
  listProviderConnections: snapshotMocks.listProviderConnections,
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
  snapshotMocks.listModelCatalog.mockReset().mockResolvedValue([]);
  snapshotMocks.listModelAssignments.mockReset().mockResolvedValue([]);
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
});

describe("settings snapshot owner scopes", () => {
  it("passes the request binding only to service-key metadata", async () => {
    await getSettingsSnapshot(input);

    const exactOwner = {
      tenantId: input.tenantId,
      actorId: input.actorId,
    };
    expect(snapshotMocks.listProviderConnections).toHaveBeenCalledWith({
      ...exactOwner,
      includeDeploymentFallback: true,
    });
    expect(snapshotMocks.listModelCatalog).toHaveBeenCalledWith(exactOwner);
    expect(snapshotMocks.listModelAssignments).toHaveBeenCalledWith(exactOwner);
    expect(snapshotMocks.getMcpExportConfiguration).toHaveBeenCalledWith(
      exactOwner,
    );
    expect(snapshotMocks.listServiceApiKeysForRequest).toHaveBeenCalledWith(
      input,
    );
  });
});
