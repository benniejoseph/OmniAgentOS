import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  listModelAssignments: vi.fn(),
  listModelCatalog: vi.fn(),
  listProviderConnections: vi.fn(),
}));

vi.mock("@/lib/settings/store", () => storeMocks);

import { resolveRuntimeModelAssignment } from "@/lib/settings/runtime-models";
import { resolveSpecializedRuntime } from "@/lib/settings/specialized-runtime";

const digest = "a".repeat(64);
const baseAssignment = {
  id: "assignment-main",
  tenantId: "tenant-a",
  actorId: "actor-a",
  scope: "main_agent" as const,
  provider: "openai" as const,
  modelId: "gpt-5.2",
  allowCrossProviderFallback: false,
  runtimeReadiness: "active" as const,
  runtimeNote: "active",
  contractVersion: "p11.8-model-assignment:1" as const,
  revision: 4,
  configurationSha256: digest,
  validatedAt: "2026-09-07T12:00:00.000Z",
  createdAt: "2026-09-07T11:00:00.000Z",
  updatedAt: "2026-09-07T12:00:00.000Z",
};

const openAiConnection = {
  id: "connection-openai",
  tenantId: "tenant-a",
  actorId: "actor-a",
  provider: "openai" as const,
  label: "OpenAI",
  source: "tenant_vault" as const,
  status: "connected" as const,
  enabled: true,
  configuredFields: ["apiKey"],
  runtimeReadiness: "active_tenant_runtime" as const,
  runtimeNote: "active",
};

beforeEach(() => {
  storeMocks.listModelAssignments.mockReset().mockResolvedValue([
    baseAssignment,
  ]);
  storeMocks.listModelCatalog.mockReset().mockResolvedValue([{
    id: "catalog-openai",
    tenantId: "tenant-a",
    actorId: "actor-a",
    provider: "openai",
    modelId: "gpt-5.2",
    displayName: "gpt-5.2",
    capabilities: ["text", "tools", "vision"],
    lifecycle: "available",
    discoveredAt: "2026-09-07T12:00:00.000Z",
    updatedAt: "2026-09-07T12:00:00.000Z",
  }]);
  storeMocks.listProviderConnections.mockReset().mockResolvedValue([
    openAiConnection,
  ]);
  storeMocks.getProviderCredentials.mockReset().mockImplementation(
    async ({ connectionId }: { connectionId: string }) => ({
      connection: connectionId === "connection-anthropic"
        ? { provider: "anthropic" }
        : { provider: "openai" },
      credentials: {
        apiKey: connectionId === "connection-anthropic"
          ? "anthropic-secret"
          : "openai-secret",
      },
    }),
  );
});

describe("functional model runtime routing", () => {
  it("binds the exact active assignment revision to every metered request", async () => {
    const runtime = await resolveRuntimeModelAssignment({
      tenantId: "tenant-a",
      actorId: "actor-a",
      scope: "main_agent",
      tier: "reasoning",
      requiredFeature: "tools",
      deploymentFallback: {
        provider: "openai",
        model: "deployment-model",
        configured: true,
      },
    });

    expect(runtime).toMatchObject({
      configured: true,
      source: "tenant_assignment",
      assignmentId: "assignment-main",
      assignmentRevision: 4,
      assignmentConfigurationSha256: digest,
      provider: "openai",
      model: "gpt-5.2",
    });
    expect(runtime.bind({
      input: "hello",
      usageScope: {
        tenantId: "tenant-a",
        actorId: "actor-a",
        sourceStreamId: "run-a",
        operation: "tool_turn",
        purpose: "test",
      },
    })).toMatchObject({
      preferredProvider: "openai",
      allowedProviders: ["openai"],
      usageScope: {
        assignmentId: "assignment-main",
        assignmentScope: "main_agent",
        assignmentRevision: 4,
        assignmentConfigurationSha256: digest,
        credentialSource: "tenant_vault",
      },
    });
    await expect(runtime.withProviderApiKey("openai", async (apiKey) => apiKey))
      .resolves.toBe("openai-secret");
  });

  it("keeps a legacy route inactive and does not claim an assignment receipt", async () => {
    storeMocks.listModelAssignments.mockResolvedValue([{
      ...baseAssignment,
      runtimeReadiness: "configuration_only",
      contractVersion: "legacy",
      configurationSha256: undefined,
      validatedAt: undefined,
    }]);

    const runtime = await resolveRuntimeModelAssignment({
      tenantId: "tenant-a",
      actorId: "actor-a",
      scope: "main_agent",
      tier: "fast",
      requiredFeature: "text",
      deploymentFallback: {
        provider: "openai",
        model: "deployment-model",
        configured: true,
      },
    });

    expect(runtime.source).toBe("deployment_environment");
    expect(runtime.usageReceipt).toEqual({
      credentialSource: "deployment_environment",
    });
    expect(runtime.warnings[0]).toContain("legacy or unvalidated");
  });

  it("activates only a validated specialized assignment and keeps its key server-only", async () => {
    storeMocks.listModelAssignments.mockResolvedValue([{
      ...baseAssignment,
      id: "assignment-embedding",
      scope: "embeddings",
      modelId: "text-embedding-3-large",
    }]);
    storeMocks.listModelCatalog.mockResolvedValue([{
      id: "catalog-embedding",
      tenantId: "tenant-a",
      actorId: "actor-a",
      provider: "openai",
      modelId: "text-embedding-3-large",
      displayName: "text-embedding-3-large",
      capabilities: ["embeddings"],
      lifecycle: "available",
      discoveredAt: "2026-09-07T12:00:00.000Z",
      updatedAt: "2026-09-07T12:00:00.000Z",
    }]);

    const runtime = await resolveSpecializedRuntime({
      tenantId: "tenant-a",
      actorId: "actor-a",
      scope: "embeddings",
      requiredCapability: "embeddings",
      deploymentModel: "deployment-embedding",
      deploymentConfigured: false,
    });

    expect(runtime).toMatchObject({
      source: "tenant_assignment",
      configured: true,
      model: "text-embedding-3-large",
      usageReceipt: {
        assignmentId: "assignment-embedding",
        assignmentScope: "embeddings",
        assignmentRevision: 4,
        assignmentConfigurationSha256: digest,
        credentialSource: "tenant_vault",
      },
    });
    expect(JSON.stringify(runtime)).not.toContain("openai-secret");
    await expect(runtime.withApiKey(async (apiKey) => apiKey))
      .resolves.toBe("openai-secret");
  });

  it("resolves provider-specific specialist routes from Settings", async () => {
    storeMocks.listModelAssignments.mockResolvedValue([{
      ...baseAssignment,
      id: "assignment-audio",
      scope: "audio",
      provider: "google",
      modelId: "google-cloud-speech:latest_long",
    }]);
    storeMocks.listModelCatalog.mockResolvedValue([{
      id: "catalog-google-speech",
      tenantId: "tenant-a",
      actorId: "actor-a",
      provider: "google",
      modelId: "google-cloud-speech:latest_long",
      displayName: "Google Cloud Speech",
      capabilities: ["audio", "transcription"],
      lifecycle: "available",
      discoveredAt: "2026-09-07T12:00:00.000Z",
      updatedAt: "2026-09-07T12:00:00.000Z",
    }]);
    storeMocks.listProviderConnections.mockResolvedValue([{
      ...openAiConnection,
      id: "connection-google",
      provider: "google",
    }]);
    storeMocks.getProviderCredentials.mockResolvedValue({
      connection: { provider: "google" },
      credentials: { apiKey: "google-workspace-secret" },
    });

    const runtime = await resolveSpecializedRuntime({
      tenantId: "tenant-a",
      actorId: "actor-a",
      scope: "audio",
      requiredCapability: "transcription",
      deploymentProvider: "openai",
      deploymentModel: "deployment-transcription",
      deploymentConfigured: true,
    });

    expect(runtime).toMatchObject({
      source: "tenant_assignment",
      configured: true,
      provider: "google",
      model: "google-cloud-speech:latest_long",
      usageReceipt: {
        assignmentScope: "audio",
        assignmentId: "assignment-audio",
        credentialSource: "tenant_vault",
      },
    });
    await expect(runtime.withApiKey(async (apiKey) => apiKey))
      .resolves.toBe("google-workspace-secret");
  });
});
