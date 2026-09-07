import "server-only";

import {
  getProviderCredentials,
  listModelAssignments,
  listModelCatalog,
  listProviderConnections,
} from "@/lib/settings/store";
import type { ModelAssignmentScope } from "@/lib/settings/types";
import type { AiUsageScope } from "@/lib/usage/types";

type SpecializedScope = Extract<
  ModelAssignmentScope,
  "embeddings" | "vision" | "audio"
>;

export type SpecializedRuntimeResolution = Readonly<{
  scope: SpecializedScope;
  source: "tenant_assignment" | "deployment_environment";
  configured: boolean;
  provider: "openai";
  model: string;
  warning?: string;
  usageReceipt: Pick<
    AiUsageScope,
    | "assignmentScope"
    | "assignmentId"
    | "assignmentRevision"
    | "assignmentConfigurationSha256"
    | "credentialSource"
  >;
  withApiKey<TResult>(
    operation: (apiKey: string | undefined) => Promise<TResult>,
  ): Promise<TResult>;
}>;

export async function resolveSpecializedRuntime(input: {
  tenantId?: string;
  actorId?: string;
  scope: SpecializedScope;
  requiredCapability: "embeddings" | "vision" | "transcription";
  deploymentModel: string;
  deploymentConfigured: boolean;
}): Promise<SpecializedRuntimeResolution> {
  const environment = deploymentResolution(input);
  const tenantId = input.tenantId?.trim();
  const actorId = input.actorId?.trim();
  if (!tenantId || !actorId) return environment;

  let assignment;
  let catalog;
  let connections;
  try {
    [assignment, catalog, connections] = await Promise.all([
      listModelAssignments({ tenantId, actorId }).then((items) =>
        items.find((item) => item.scope === input.scope)
      ),
      listModelCatalog({ tenantId, actorId }),
      listProviderConnections({
        tenantId,
        actorId,
        includeDeploymentFallback: false,
      }),
    ]);
  } catch {
    return { ...environment, warning: "The validated workspace route could not be read." };
  }
  if (
    !assignment ||
    assignment.runtimeReadiness !== "active" ||
    assignment.contractVersion !== "p11.8-model-assignment:1" ||
    !assignment.configurationSha256 ||
    !assignment.validatedAt
  ) return environment;
  if (assignment.provider !== "openai") {
    return { ...environment, warning: "This specialized runtime currently supports only validated OpenAI workspace routes." };
  }
  const model = catalog.find((candidate) =>
    candidate.provider === assignment.provider &&
    candidate.modelId === assignment.modelId
  );
  if (!model || !specializedCapabilityMatches(model.capabilities, input.requiredCapability)) {
    return { ...environment, warning: `The active ${input.scope} route does not cover ${input.requiredCapability}.` };
  }
  const connection = connections.find((candidate) =>
    candidate.source === "tenant_vault" &&
    candidate.provider === "openai" &&
    candidate.status === "connected" &&
    candidate.enabled
  );
  if (!connection) {
    return { ...environment, warning: "The assigned workspace credential is not active." };
  }
  let apiKey: string | undefined;
  try {
    const opened = await getProviderCredentials({
      tenantId,
      actorId,
      connectionId: connection.id,
    });
    apiKey = opened.credentials.apiKey?.trim();
  } catch {
    return { ...environment, warning: "The assigned workspace credential could not be opened." };
  }
  if (!apiKey) return environment;
  return {
    scope: input.scope,
    source: "tenant_assignment",
    configured: true,
    provider: "openai",
    model: assignment.modelId,
    usageReceipt: {
      assignmentScope: input.scope,
      assignmentId: assignment.id,
      assignmentRevision: assignment.revision,
      assignmentConfigurationSha256: assignment.configurationSha256,
      credentialSource: "tenant_vault",
    },
    withApiKey(operation) {
      return operation(apiKey);
    },
  };
}

function deploymentResolution(input: {
  scope: SpecializedScope;
  deploymentModel: string;
  deploymentConfigured: boolean;
}): SpecializedRuntimeResolution {
  return {
    scope: input.scope,
    source: "deployment_environment",
    configured: input.deploymentConfigured,
    provider: "openai",
    model: input.deploymentModel,
    usageReceipt: {
      credentialSource: "deployment_environment",
    },
    withApiKey(operation) {
      return operation(undefined);
    },
  };
}

function specializedCapabilityMatches(
  capabilities: readonly string[],
  required: "embeddings" | "vision" | "transcription",
) {
  if (capabilities.includes(required)) return true;
  return required === "transcription" &&
    capabilities.includes("audio");
}
