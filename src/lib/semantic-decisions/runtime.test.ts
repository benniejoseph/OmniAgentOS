import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSemanticDecisionRuntime } from "@/lib/semantic-decisions/runtime";
import { createTypeSafeSemanticDecisionProvider } from "@/lib/semantic-decisions/typesafe-provider";
import type { ModelAssignment } from "@/lib/settings/types";

const digest = "b".repeat(64);
const assignment: ModelAssignment = {
  id: "assignment-semantic",
  tenantId: "tenant-a",
  actorId: "actor-a",
  scope: "semantic_decision",
  provider: "typesafe",
  modelId: "jev-settings-model",
  allowCrossProviderFallback: false,
  runtimeReadiness: "active",
  runtimeNote: "active",
  contractVersion: "p11.8-model-assignment:1",
  revision: 3,
  configurationSha256: digest,
  validatedAt: "2026-09-18T08:00:00.000Z",
  createdAt: "2026-09-18T07:00:00.000Z",
  updatedAt: "2026-09-18T08:00:00.000Z",
};
const connection = {
  id: "connection-typesafe",
  tenantId: "tenant-a",
  actorId: "actor-a",
  provider: "typesafe" as const,
  label: "TypeSafe Jev",
  source: "tenant_vault" as const,
  status: "connected" as const,
  enabled: true,
  configuredFields: ["apiKey"],
  runtimeReadiness: "active_tenant_runtime" as const,
  runtimeNote: "active",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    listAssignments: vi.fn(async () => [assignment]),
    listCatalog: vi.fn(async () => [{
      id: "catalog-jev",
      tenantId: "tenant-a",
      actorId: "actor-a",
      provider: "typesafe" as const,
      modelId: "jev-settings-model",
      displayName: "Jev settings model",
      capabilities: ["semantic_decision"],
      lifecycle: "available" as const,
      discoveredAt: "2026-09-18T08:00:00.000Z",
      updatedAt: "2026-09-18T08:00:00.000Z",
    }]),
    listConnections: vi.fn(async () => [connection]),
    openCredentials: vi.fn(async () => ({
      connection,
      credentials: { apiKey: "typesafe-settings-secret-value" },
    })),
    createProvider: createTypeSafeSemanticDecisionProvider,
    ...overrides,
  };
}

describe("semantic decision runtime", () => {
  it("is disabled until an exact actor-owned assignment exists", async () => {
    const deps = dependencies({
      listAssignments: vi.fn(async () => []),
    });

    await expect(resolveSemanticDecisionRuntime(
      { tenantId: "tenant-a", actorId: "actor-a" },
      deps,
    )).resolves.toBeUndefined();
    expect(deps.openCredentials).not.toHaveBeenCalled();
  });

  it("opens the sealed Settings credential without serializing it", async () => {
    const runtime = await resolveSemanticDecisionRuntime(
      { tenantId: "tenant-a", actorId: "actor-a" },
      dependencies(),
    );

    expect(runtime).toMatchObject({
      state: "ready",
      providerId: "typesafe",
      model: "jev-settings-model",
      assignmentReceipt: {
        assignmentScope: "semantic_decision",
        assignmentId: "assignment-semantic",
        assignmentRevision: 3,
        assignmentConfigurationSha256: digest,
        credentialSource: "tenant_vault",
      },
    });
    expect(JSON.stringify(runtime)).not.toContain("typesafe-settings-secret-value");
  });

  it("honors the emergency shadow kill switch", async () => {
    vi.stubEnv("OMNIAGENT_SEMANTIC_DECISION_SHADOW_DISABLED", "true");
    const deps = dependencies();

    await expect(resolveSemanticDecisionRuntime(
      { tenantId: "tenant-a", actorId: "actor-a" },
      deps,
    )).resolves.toBeUndefined();
    expect(deps.listAssignments).not.toHaveBeenCalled();
  });
});
