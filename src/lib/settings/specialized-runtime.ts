import "server-only";

import {
  getProviderCredentials,
  listModelAssignments,
  listModelCatalog,
  listProviderConnections,
} from "@/lib/settings/store";
import { modelSupportsAssignmentRole } from "@/lib/settings/model-assignment-contract";
import type {
  ModelAssignmentScope,
  SettingsModelProvider,
} from "@/lib/settings/types";
import type { AiUsageScope } from "@/lib/usage/types";

type SpecializedScope = Extract<
  ModelAssignmentScope,
  | "embeddings"
  | "vision"
  | "audio"
  | "audio_diarization"
  | "web_search"
  | "image_generation"
  | "video_generation"
  | "computer_use"
  | "speech_synthesis"
  | "realtime_transcription"
>;

type SpecializedCapability =
  | "embeddings"
  | "vision"
  | "transcription"
  | "tools"
  | "image"
  | "video"
  | "computer_use"
  | "speech";

export type SpecializedRuntimeResolution = Readonly<{
  scope: SpecializedScope;
  source: "tenant_assignment" | "deployment_environment";
  configured: boolean;
  provider: SettingsModelProvider;
  model: string;
  warning?: string;
  unavailableReason?:
    | "settings_unavailable"
    | "assignment_inactive"
    | "assignment_unsupported"
    | "credential_inactive"
    | "credential_unavailable"
    | "deployment_model_missing";
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
  requiredCapability: SpecializedCapability;
  deploymentProvider?: SettingsModelProvider;
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
    return unavailableResolution({
      resolution: environment,
      reason: "settings_unavailable",
      warning: "Settings could not verify the active workspace model route. Try again when Settings is available.",
    });
  }
  if (!assignment) return environment;
  const assignedResolution: SpecializedRuntimeResolution = {
    ...environment,
    source: "tenant_assignment",
    configured: false,
    provider: assignment.provider,
    model: assignment.modelId,
    usageReceipt: {
      assignmentScope: input.scope,
      assignmentId: assignment.id,
      assignmentRevision: assignment.revision,
      assignmentConfigurationSha256: assignment.configurationSha256,
      credentialSource: "tenant_vault",
    },
  };
  if (
    assignment.runtimeReadiness !== "active" ||
    assignment.contractVersion !== "p11.8-model-assignment:1" ||
    !assignment.configurationSha256 ||
    !assignment.validatedAt
  ) {
    return unavailableResolution({
      resolution: assignedResolution,
      reason: "assignment_inactive",
      warning: `The saved ${input.scope} route is not active. Re-save it in Settings after validating its provider.`,
    });
  }
  const model = catalog.find((candidate) =>
    candidate.provider === assignment.provider &&
    candidate.modelId === assignment.modelId
  );
  if (
    !model ||
    !modelSupportsAssignmentRole(input.scope, assignment.provider, model) ||
    !specializedCapabilityMatches(model.capabilities, input.requiredCapability)
  ) {
    return unavailableResolution({
      resolution: assignedResolution,
      reason: "assignment_unsupported",
      warning: `The saved ${input.scope} model does not support ${input.requiredCapability}. Refresh the provider catalog and choose a compatible model in Settings.`,
    });
  }
  const connection = connections.find((candidate) =>
    candidate.source === "tenant_vault" &&
    candidate.provider === assignment.provider &&
    candidate.status === "connected" &&
    candidate.enabled
  );
  if (!connection) {
    return unavailableResolution({
      resolution: assignedResolution,
      reason: "credential_inactive",
      warning: "The provider selected in Settings is not connected. Reconnect it, then re-save this model route.",
    });
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
    return unavailableResolution({
      resolution: assignedResolution,
      reason: "credential_unavailable",
      warning: "The provider credential selected in Settings could not be opened. Reconnect the provider and try again.",
    });
  }
  if (!apiKey) {
    return unavailableResolution({
      resolution: assignedResolution,
      reason: "credential_unavailable",
      warning: "The provider selected in Settings has no usable credential. Reconnect it and try again.",
    });
  }
  return {
    scope: input.scope,
    source: "tenant_assignment",
    configured: true,
    provider: assignment.provider,
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
  deploymentProvider?: SettingsModelProvider;
  deploymentModel: string;
  deploymentConfigured: boolean;
}): SpecializedRuntimeResolution {
  const model = input.deploymentModel.trim();
  const configured = input.deploymentConfigured && Boolean(model);
  return {
    scope: input.scope,
    source: "deployment_environment",
    configured,
    provider: input.deploymentProvider || "openai",
    model,
    ...(!configured && input.deploymentConfigured
      ? {
          warning: `The deployment credential is present, but ${input.scope} has no explicit model. Configure the model in Settings or the deployment environment.`,
          unavailableReason: "deployment_model_missing" as const,
        }
      : {}),
    usageReceipt: {
      credentialSource: "deployment_environment",
    },
    withApiKey(operation) {
      return operation(undefined);
    },
  };
}

function unavailableResolution(input: {
  resolution: SpecializedRuntimeResolution;
  reason: NonNullable<SpecializedRuntimeResolution["unavailableReason"]>;
  warning: string;
}): SpecializedRuntimeResolution {
  return {
    ...input.resolution,
    configured: false,
    warning: input.warning,
    unavailableReason: input.reason,
    async withApiKey<TResult>(_operation: (apiKey: string | undefined) => Promise<TResult>) {
      throw new Error("The selected specialized model route is unavailable.");
    },
  };
}

function specializedCapabilityMatches(
  capabilities: readonly string[],
  required: SpecializedCapability,
) {
  if (capabilities.includes(required)) return true;
  return required === "transcription" &&
    capabilities.includes("audio");
}
