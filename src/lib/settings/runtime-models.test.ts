import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  listModelAssignments: vi.fn(),
  listModelCatalog: vi.fn(),
  listProviderConnections: vi.fn(),
}));

vi.mock("@/lib/settings/store", () => storeMocks);

import { getModelRuntime } from "@/lib/models/runtime-context";
import {
  ModelRouteUnavailableError,
  resolveRuntimeModelAssignment,
} from "@/lib/settings/runtime-models";
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
  it("requires every declared capability on the same visual Computer Use target", async () => {
    const visualRuntime = await resolveRuntimeModelAssignment({
      tenantId: "",
      actorId: "",
      scope: "computer_use",
      tier: "reasoning",
      requiredFeature: "tools",
      requiredFeatures: ["vision"],
      deploymentFallback: {
        provider: "openai",
        model: "deployment-vision-model",
        configured: true,
      },
    });
    const toolsOnlyRuntime = await resolveRuntimeModelAssignment({
      tenantId: "",
      actorId: "",
      scope: "computer_use",
      tier: "reasoning",
      requiredFeature: "tools",
      requiredFeatures: ["vision"],
      deploymentFallback: {
        provider: "aws_bedrock",
        model: "deployment-tools-only-model",
        configured: true,
      },
    });

    expect(visualRuntime.configured).toBe(true);
    expect(toolsOnlyRuntime.configured).toBe(false);
  });

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

describe("workspace model routes that cannot be used as saved", () => {
  const route = {
    tenantId: "tenant-a",
    actorId: "actor-a",
    scope: "main_agent" as const,
    tier: "reasoning" as const,
    requiredFeature: "tools" as const,
    deploymentFallback: {
      provider: "openai" as const,
      model: "deployment-model",
      configured: true,
    },
  };
  const usageScope = {
    tenantId: "tenant-a",
    actorId: "actor-a",
    sourceStreamId: "run-a",
    operation: "tool_turn" as const,
    purpose: "test",
  };
  const NO_CONNECTION =
    "The assigned provider does not have an enabled, validated workspace connection";
  const NO_CREDENTIAL = "The assigned workspace credential could not be opened";
  const RECONNECT = "Reconnect the provider in Settings, then try again.";
  const pinnedRoutes = [
    {
      label: "an unreadable",
      code: "settings_unreadable",
      problem: "Workspace model routing could not be read",
      remedy: "Try again when Settings is available.",
      arrange: () => storeMocks.listModelAssignments.mockRejectedValue(
        new Error("Settings database unavailable."),
      ),
    },
    {
      label: "a disconnected",
      code: "connection_unavailable",
      problem: NO_CONNECTION,
      remedy: RECONNECT,
      arrange: () => storeMocks.listProviderConnections.mockResolvedValue([
        { ...openAiConnection, enabled: false },
      ]),
    },
    {
      label: "an unopenable",
      code: "credential_unavailable",
      problem: NO_CREDENTIAL,
      remedy: RECONNECT,
      arrange: () => storeMocks.getProviderCredentials.mockRejectedValue(
        new Error("Credential could not be unsealed."),
      ),
    },
    {
      label: "a blank",
      code: "credential_unavailable",
      problem: NO_CREDENTIAL,
      remedy: RECONNECT,
      arrange: () => storeMocks.getProviderCredentials.mockResolvedValue({
        connection: { provider: "openai" },
        credentials: { apiKey: "  " },
      }),
    },
  ] as const;

  beforeEach(() => {
    vi.stubEnv("OMNIAGENT_MODEL_ROUTE_ALLOW_DEPLOYMENT_FALLBACK", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(pinnedRoutes)(
    "stops $label workspace route instead of moving it to the deployment's keys",
    async ({ arrange, code, problem, remedy }) => {
      arrange();
      const message = `${problem}, so no model was called. ${remedy}`;

      const runtime = await resolveRuntimeModelAssignment(route);

      expect(runtime).toMatchObject({
        scope: "main_agent",
        source: "tenant_assignment",
        configured: false,
        allowCrossProviderFallback: false,
        reason: message,
      });
      expect(runtime.degradation).toEqual({ outcome: "blocked", code, message });
      expect(runtime.warnings).toEqual([message]);
      expect(runtime.provider).toBeUndefined();
      expect(runtime.model).toBeUndefined();
      expect(runtime.usageReceipt).toEqual({ assignmentScope: "main_agent" });
      const bound = runtime.bind({ input: "hello", usageScope });
      expect(bound.usageScope).toEqual({
        ...usageScope,
        assignmentScope: "main_agent",
      });
      expect(getModelRuntime(bound)).toEqual({ targets: [], credentials: {} });
      const operation = vi.fn(async (apiKey: string | undefined) => apiKey);
      const refused = runtime.withProviderApiKey("openai", operation);
      await expect(refused).rejects.toBeInstanceOf(ModelRouteUnavailableError);
      await expect(refused).rejects.toMatchObject({
        name: "ModelRouteUnavailableError",
        message,
        degradation: { outcome: "blocked", code, message },
      });
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it.each(pinnedRoutes)(
    "lets the deployment put $label route on its own keys, and says so",
    async ({ arrange, code, problem }) => {
      vi.stubEnv("OMNIAGENT_MODEL_ROUTE_ALLOW_DEPLOYMENT_FALLBACK", "true");
      arrange();
      const message = `${problem}, so deployment-environment routing remains in effect.`;

      const runtime = await resolveRuntimeModelAssignment(route);

      expect(runtime).toMatchObject({
        source: "deployment_environment",
        configured: true,
        provider: "openai",
        model: "deployment-model",
      });
      expect(runtime.degradation).toEqual({
        outcome: "deployment_environment",
        code,
        message,
      });
      expect(runtime.warnings).toEqual([message]);
      expect(runtime.usageReceipt).toEqual({
        credentialSource: "deployment_environment",
      });
      expect(getModelRuntime(runtime.bind({ input: "hello" }))).toBeUndefined();
      await expect(runtime.withProviderApiKey(
        "openai",
        async (apiKey) => apiKey ?? "deployment key",
      )).resolves.toBe("deployment key");
    },
  );

  it("reopens deployment routing only for the exact opt-in", async () => {
    storeMocks.listProviderConnections.mockResolvedValue([]);

    for (const value of ["TRUE", "1", "yes", ""]) {
      vi.stubEnv("OMNIAGENT_MODEL_ROUTE_ALLOW_DEPLOYMENT_FALLBACK", value);
      const runtime = await resolveRuntimeModelAssignment(route);
      expect(runtime.degradation?.outcome).toBe("blocked");
    }
  });

  it.each([
    {
      code: "route_inactive",
      assignment: {
        ...baseAssignment,
        runtimeReadiness: "configuration_only",
        contractVersion: "legacy",
        configurationSha256: undefined,
        validatedAt: undefined,
      },
      problem: "The saved route is a legacy or unvalidated configuration",
    },
    {
      code: "route_not_generative",
      assignment: {
        ...baseAssignment,
        provider: "typesafe",
        modelId: "typesafe-semantic",
      },
      problem:
        "The saved route uses TypeSafe, whose semantic decisions run only through the dedicated shadow resolver and cannot replace a generative model route",
    },
  ])(
    "keeps deployment routing for a $code route, which never carried workspace traffic, and marks it",
    async ({ assignment, code, problem }) => {
      storeMocks.listModelAssignments.mockResolvedValue([assignment]);
      const message = `${problem}, so deployment-environment routing remains in effect.`;

      const runtime = await resolveRuntimeModelAssignment(route);

      expect(runtime).toMatchObject({
        source: "deployment_environment",
        configured: true,
        provider: "openai",
        model: "deployment-model",
      });
      expect(runtime.degradation).toEqual({
        outcome: "deployment_environment",
        code,
        message,
      });
      expect(runtime.warnings).toEqual([message]);
    },
  );

  it("keeps a catalog warning ahead of the reason the route stopped or moved", async () => {
    storeMocks.listModelCatalog.mockResolvedValue([]);
    storeMocks.listProviderConnections.mockResolvedValue([]);
    const catalogWarning =
      "Primary model gpt-5.2 is not in the latest workspace catalog. The saved assignment remains selected pending review.";
    const blocked = `${NO_CONNECTION}, so no model was called. ${RECONNECT}`;
    const moved = `${NO_CONNECTION}, so deployment-environment routing remains in effect.`;

    const stopped = await resolveRuntimeModelAssignment(route);
    vi.stubEnv("OMNIAGENT_MODEL_ROUTE_ALLOW_DEPLOYMENT_FALLBACK", "true");
    const standIn = await resolveRuntimeModelAssignment(route);

    expect(stopped.warnings).toEqual([catalogWarning, blocked]);
    expect(stopped.reason).toBe(blocked);
    expect(standIn.warnings).toEqual([catalogWarning, moved]);
  });

  it("marks nothing when the route works, none was saved, or no workspace asked", async () => {
    const working = await resolveRuntimeModelAssignment(route);
    storeMocks.listModelAssignments.mockResolvedValue([]);
    const unsaved = await resolveRuntimeModelAssignment(route);
    const anonymous = await resolveRuntimeModelAssignment({
      ...route,
      tenantId: "",
      actorId: "",
    });

    expect(working).toMatchObject({ source: "tenant_assignment", configured: true });
    expect(unsaved.source).toBe("deployment_environment");
    expect(anonymous.source).toBe("deployment_environment");
    for (const runtime of [working, unsaved, anonymous]) {
      expect(runtime.degradation).toBeUndefined();
    }
  });
});
