import {
  hasAnthropicKey,
  hasGeminiKey,
  hasOpenAIKey,
} from "@/lib/config";
import {
  bindModelRuntime,
  type ModelRuntimeCredential,
  type ModelRuntimeContext,
} from "@/lib/models/runtime-context";
import {
  getModelProvider,
  hasModelProviderFeature,
  modelTargets,
} from "@/lib/models/registry";
import type {
  ModelFeature,
  ModelTarget,
  ModelTextRequest,
  ModelTier,
  ProviderId,
} from "@/lib/models/types";
import {
  getProviderCredentials,
  listModelAssignments,
  listModelCatalog,
  listProviderConnections,
} from "@/lib/settings/store";
import type {
  ModelAssignment,
  ModelAssignmentScope,
  ModelCatalogEntry,
  SettingsModelProvider,
} from "@/lib/settings/types";

type RuntimeProviderId = Exclude<ProviderId, "local">;

export type DeploymentModelFallback = Readonly<{
  provider: RuntimeProviderId;
  model: string;
  fallbackModel?: string;
  reason?: string;
  configured?: boolean;
}>;

export type RuntimeModelResolution = Readonly<{
  scope: ModelAssignmentScope;
  source: "tenant_assignment" | "deployment_environment";
  configured: boolean;
  assignmentId?: string;
  provider?: RuntimeProviderId;
  model?: string;
  fallbackProvider?: RuntimeProviderId;
  fallbackModel?: string;
  allowCrossProviderFallback: boolean;
  warnings: readonly string[];
  reason: string;
  bind<TRequest extends ModelTextRequest>(request: TRequest): TRequest;
  withProviderApiKey<TResult>(
    provider: RuntimeProviderId,
    operation: (apiKey: string | undefined) => Promise<TResult>,
  ): Promise<TResult>;
}>;

/**
 * Resolves one of the eight stored model-assignment scopes into request-bound
 * server runtime state. Plaintext credentials remain captured by closures and
 * a WeakMap; callers receive no serializable secret fields.
 */
export async function resolveRuntimeModelAssignment(input: {
  tenantId: string;
  actorId: string;
  scope: ModelAssignmentScope;
  tier: ModelTier;
  requiredFeature: ModelFeature;
  deploymentFallback?: DeploymentModelFallback;
}): Promise<RuntimeModelResolution> {
  const tenantId = input.tenantId.trim();
  const actorId = input.actorId.trim();
  const environment = deploymentResolution(input);
  if (!tenantId || !actorId) {
    return withWarnings(environment, [
      "A tenant model assignment was not read because the authenticated tenant and actor were not both available.",
    ]);
  }

  let assignments: ModelAssignment[];
  let catalog: ModelCatalogEntry[];
  let connections: Awaited<ReturnType<typeof listProviderConnections>>;
  try {
    [assignments, catalog, connections] = await Promise.all([
      listModelAssignments({ tenantId, actorId }),
      listModelCatalog({ tenantId, actorId }),
      listProviderConnections({
        tenantId,
        actorId,
        includeDeploymentFallback: false,
      }),
    ]);
  } catch {
    return withWarnings(environment, [
      "Workspace model routing could not be read, so deployment-environment routing remains in effect.",
    ]);
  }

  const assignment = assignments.find((item) => item.scope === input.scope);
  if (!assignment) return environment;
  const provider = runtimeProvider(assignment.provider);

  const warnings: string[] = [];
  addLifecycleWarning(warnings, catalog, assignment.provider, assignment.modelId, "Primary");
  const primaryConnection = connections.find((connection) =>
    connection.provider === assignment.provider &&
    connection.source === "tenant_vault" &&
    connection.enabled &&
    connection.status === "connected"
  );
  if (!primaryConnection) {
    return withWarnings(environment, [
      ...warnings,
      "The assigned provider does not have an enabled, validated workspace connection, so deployment-environment routing remains in effect.",
    ]);
  }

  const primaryCredentials = await readProviderCredential(assignment.provider, {
    tenantId,
    actorId,
    connectionId: primaryConnection.id,
  });
  if (!primaryCredentials) {
    return withWarnings(environment, [
      ...warnings,
      "The assigned workspace credential could not be opened, so deployment-environment routing remains in effect.",
    ]);
  }

  const targets: ModelTarget[] = [modelTarget(provider, assignment.modelId, input.tier)];
  const credentials: Partial<Record<RuntimeProviderId, ModelRuntimeCredential>> = {
    [provider]: primaryCredentials,
  };
  let fallbackProvider: RuntimeProviderId | undefined;
  let fallbackModel: string | undefined;
  let crossProviderFallback = false;

  if (assignment.fallbackProvider && assignment.fallbackModelId) {
    const candidateProvider = runtimeProvider(assignment.fallbackProvider);
    addLifecycleWarning(
      warnings,
      catalog,
      assignment.fallbackProvider,
      assignment.fallbackModelId,
      "Fallback",
    );
    if (candidateProvider === provider) {
      fallbackProvider = candidateProvider;
      fallbackModel = assignment.fallbackModelId;
      targets.push(modelTarget(candidateProvider, assignment.fallbackModelId, input.tier));
    } else if (!assignment.allowCrossProviderFallback) {
      warnings.push(
        "The cross-provider fallback was not enabled because explicit disclosure consent is not stored.",
      );
    } else {
      const fallbackConnection = connections.find((connection) =>
        connection.provider === assignment.fallbackProvider &&
        connection.source === "tenant_vault" &&
        connection.enabled &&
        connection.status === "connected"
      );
      const fallbackCredentials = fallbackConnection
        ? await readProviderCredential(assignment.fallbackProvider, {
            tenantId,
            actorId,
            connectionId: fallbackConnection.id,
          })
        : undefined;
      if (!fallbackCredentials) {
        warnings.push(
          "The consented cross-provider fallback is unavailable because its workspace connection is not enabled and validated.",
        );
      } else {
        fallbackProvider = candidateProvider;
        fallbackModel = assignment.fallbackModelId;
        crossProviderFallback = true;
        targets.push(modelTarget(candidateProvider, assignment.fallbackModelId, input.tier));
        Object.assign(credentials, { [candidateProvider]: fallbackCredentials });
      }
    }
  }

  const capableTargets = targets.filter((target) =>
    target.features.includes(input.requiredFeature)
  );
  if (!targets[0]?.features.includes(input.requiredFeature)) {
    warnings.push(
      `The assigned primary provider runtime does not advertise ${input.requiredFeature} support for this path.`,
    );
  }
  const context: ModelRuntimeContext = { targets, credentials };
  const allowedProviders = [...new Set(targets.map((target) => target.provider))];
  const reason = [
    `Workspace ${input.scope.replaceAll("_", " ")} routing selected ${assignment.provider}/${assignment.modelId}.`,
    ...warnings,
  ].join(" ");

  return {
    scope: input.scope,
    source: "tenant_assignment",
    configured: capableTargets.length > 0,
    assignmentId: assignment.id,
    provider,
    model: assignment.modelId,
    fallbackProvider,
    fallbackModel,
    allowCrossProviderFallback: crossProviderFallback,
    warnings,
    reason,
    bind<TRequest extends ModelTextRequest>(request: TRequest): TRequest {
      const continuationProvider = (
        request as ModelTextRequest & {
          continuation?: { provider?: ProviderId };
        }
      ).continuation?.provider;
      const activeProvider = continuationProvider || provider;
      const routed = {
        ...request,
        preferredProvider: activeProvider,
        allowedProviders: continuationProvider ? [activeProvider] : allowedProviders,
        allowCrossProviderFallback: continuationProvider ? false : crossProviderFallback,
      } as TRequest;
      return bindModelRuntime(routed, context);
    },
    withProviderApiKey<TResult>(
      requestedProvider: RuntimeProviderId,
      operation: (apiKey: string | undefined) => Promise<TResult>,
    ) {
      const credential = credentials[requestedProvider];
      return operation(credential?.kind === "api_key" ? credential.apiKey : undefined);
    },
  };
}

function deploymentResolution(input: {
  scope: ModelAssignmentScope;
  tier: ModelTier;
  requiredFeature: ModelFeature;
  deploymentFallback?: DeploymentModelFallback;
}): RuntimeModelResolution {
  const first = input.deploymentFallback || deploymentTarget(input.tier, input.requiredFeature);
  const configured = input.deploymentFallback?.configured ??
    hasModelProviderFeature(input.requiredFeature, input.tier);
  return {
    scope: input.scope,
    source: "deployment_environment",
    configured,
    provider: first?.provider,
    model: first?.model,
    fallbackProvider: first?.fallbackModel ? first.provider : undefined,
    fallbackModel: first?.fallbackModel,
    allowCrossProviderFallback: false,
    warnings: [],
    reason: first?.reason || "Deployment-environment model routing remains in effect.",
    bind<TRequest extends ModelTextRequest>(request: TRequest) {
      return request;
    },
    withProviderApiKey<TResult>(
      _provider: RuntimeProviderId,
      operation: (apiKey: string | undefined) => Promise<TResult>,
    ) {
      return operation(undefined);
    },
  };
}

function deploymentTarget(
  tier: ModelTier,
  feature: ModelFeature,
): DeploymentModelFallback | undefined {
  const candidate = modelTargets({
    tier,
    feature,
    allowCrossProviderFallback: true,
  })[0]?.target;
  if (!candidate || candidate.provider === "local") return undefined;
  return {
    provider: candidate.provider,
    model: candidate.model,
    configured: deploymentProviderConfigured(candidate.provider),
  };
}

function modelTarget(
  provider: RuntimeProviderId,
  model: string,
  tier: ModelTier,
): ModelTarget {
  const adapterTarget = getModelProvider(provider)?.targets(tier)[0];
  return {
    provider,
    model,
    tier,
    features: adapterTarget?.features || [],
  };
}

function runtimeProvider(
  provider: SettingsModelProvider,
): RuntimeProviderId {
  return provider;
}

async function readProviderCredential(
  provider: SettingsModelProvider,
  input: {
  tenantId: string;
  actorId: string;
  connectionId: string;
  },
): Promise<ModelRuntimeCredential | undefined> {
  try {
    const result = await getProviderCredentials(input);
    if (provider === "aws_bedrock") {
      const accessKeyId = result.credentials.accessKeyId?.trim();
      const secretAccessKey = result.credentials.secretAccessKey?.trim();
      const region = result.credentials.region?.trim();
      const sessionToken = result.credentials.sessionToken?.trim();
      if (!accessKeyId || !secretAccessKey || !region) return undefined;
      return {
        kind: "aws_bedrock",
        accessKeyId,
        secretAccessKey,
        region,
        ...(sessionToken ? { sessionToken } : {}),
      };
    }
    const apiKey = result.credentials.apiKey?.trim();
    return apiKey ? { kind: "api_key", apiKey } : undefined;
  } catch {
    return undefined;
  }
}

function addLifecycleWarning(
  warnings: string[],
  catalog: ModelCatalogEntry[],
  provider: SettingsModelProvider,
  modelId: string,
  label: "Primary" | "Fallback",
) {
  const model = catalog.find((item) =>
    item.provider === provider && item.modelId === modelId
  );
  if (model?.lifecycle === "deprecated" || model?.lifecycle === "retiring") {
    warnings.push(
      `${label} model ${modelId} is marked ${model.lifecycle}. The saved assignment remains selected and was not silently changed.`,
    );
  } else if (!model) {
    warnings.push(
      `${label} model ${modelId} is not in the latest workspace catalog. The saved assignment remains selected pending review.`,
    );
  }
}

function withWarnings(
  resolution: RuntimeModelResolution,
  warnings: readonly string[],
): RuntimeModelResolution {
  if (!warnings.length) return resolution;
  return {
    ...resolution,
    warnings: [...resolution.warnings, ...warnings],
    reason: [resolution.reason, ...warnings].join(" "),
  };
}

function deploymentProviderConfigured(provider: RuntimeProviderId) {
  if (provider === "openai") return hasOpenAIKey();
  if (provider === "google") return hasGeminiKey();
  if (provider === "anthropic") return hasAnthropicKey();
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID?.trim() &&
    process.env.AWS_SECRET_ACCESS_KEY?.trim() &&
    (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION)?.trim(),
  );
}
