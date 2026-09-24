import { AsyncLocalStorage } from "node:async_hooks";
import {
  hasAnthropicKey,
  hasGeminiKey,
  hasOpenAIKey,
} from "@/lib/config";
import { getDatabasePoolMax } from "@/lib/db/client";
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
  ModelReasoningEffort,
  ModelTarget,
  ModelTextRequest,
  ModelTier,
  ProviderId,
} from "@/lib/models/types";
import {
  CommandModelSelectionError,
  resolveCommandModelSelection,
  type CommandModelSelectionRequest,
} from "@/lib/models/command-selection";
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
import type { AiUsageScope } from "@/lib/usage/types";

type RuntimeProviderId = Exclude<ProviderId, "local">;

type RuntimeModelRequestCache = {
  settings: Map<string, Promise<RuntimeSettingsSnapshot>>;
  credentials: Map<string, Promise<ModelRuntimeCredential | undefined>>;
};

type RuntimeSettingsSnapshot = {
  assignments: ModelAssignment[];
  catalog: ModelCatalogEntry[];
  connections: Awaited<ReturnType<typeof listProviderConnections>>;
};

const runtimeModelRequestCache =
  new AsyncLocalStorage<RuntimeModelRequestCache>();

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
  assignmentRevision?: number;
  assignmentConfigurationSha256?: string;
  commandSelectionSha256?: string;
  commandReasoningLevel?: string;
  reasoningEffort?: ModelReasoningEffort;
  provider?: RuntimeProviderId;
  model?: string;
  fallbackProvider?: RuntimeProviderId;
  fallbackModel?: string;
  allowCrossProviderFallback: boolean;
  warnings: readonly string[];
  reason: string;
  usageReceipt: Pick<
    AiUsageScope,
    | "assignmentScope"
    | "assignmentId"
    | "assignmentRevision"
    | "assignmentConfigurationSha256"
    | "credentialSource"
  >;
  bind<TRequest extends ModelTextRequest>(request: TRequest): TRequest;
  withProviderApiKey<TResult>(
    provider: RuntimeProviderId,
    operation: (apiKey: string | undefined) => Promise<TResult>,
  ): Promise<TResult>;
}>;

/**
 * Shares Settings routing reads and vault openings only inside one request.
 * No model assignment or plaintext credential crosses a request boundary, so
 * revocation remains visible on the next command while a multi-stage agent
 * turn avoids repeating the same three database reads for every subsystem.
 */
export function withRuntimeModelRequestCache<
  TArgs extends unknown[],
  TResult,
>(
  handler: (...args: TArgs) => TResult | Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return (...args) => {
    const existing = runtimeModelRequestCache.getStore();
    if (existing) return Promise.resolve(handler(...args));
    return Promise.resolve(runtimeModelRequestCache.run(
      { settings: new Map(), credentials: new Map() },
      () => handler(...args),
    ));
  };
}

/**
 * Resolves a stored model-assignment scope into request-bound
 * server runtime state. Plaintext credentials remain captured by closures and
 * a WeakMap; callers receive no serializable secret fields.
 */
export async function resolveRuntimeModelAssignment(input: {
  tenantId: string;
  actorId: string;
  scope: ModelAssignmentScope;
  tier: ModelTier;
  requiredFeature: ModelFeature;
  /**
   * Additional capabilities that must be present on the same runtime target.
   * This is intentionally conjunctive: a tools-only fallback must not be used
   * for a visual Computer Use turn.
   */
  requiredFeatures?: readonly ModelFeature[];
  deploymentFallback?: DeploymentModelFallback;
  /** Explicit per-command choice, revalidated against this scope's Settings route. */
  commandSelection?: CommandModelSelectionRequest;
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
    ({ assignments, catalog, connections } =
      await readRuntimeSettingsSnapshot(tenantId, actorId));
  } catch {
    if (input.commandSelection) {
      throw new CommandModelSelectionError(
        "The selected model could not be revalidated against Settings. Choose again after Settings is available.",
      );
    }
    return withWarnings(environment, [
      "Workspace model routing could not be read, so deployment-environment routing remains in effect.",
    ]);
  }

  const assignment = assignments.find((item) => item.scope === input.scope);
  if (!assignment) {
    if (input.commandSelection) {
      throw new CommandModelSelectionError(
        "The selected model no longer has an active Settings route for this agent.",
      );
    }
    return environment;
  }
  if (
    assignment.runtimeReadiness !== "active" ||
    assignment.contractVersion !== "p11.8-model-assignment:1" ||
    !assignment.configurationSha256 ||
    !assignment.validatedAt
  ) {
    if (input.commandSelection) {
      throw new CommandModelSelectionError(
        "The selected model route is no longer active. Review it in Settings and choose again.",
      );
    }
    return withWarnings(environment, [
      "The saved route is a legacy or unvalidated configuration, so deployment-environment routing remains in effect.",
    ]);
  }
  if (assignment.provider === "typesafe") {
    if (input.commandSelection) {
      throw new CommandModelSelectionError(
        "TypeSafe is not a generative Command model route.",
      );
    }
    return withWarnings(environment, [
      "TypeSafe semantic decisions run only through the dedicated shadow resolver and cannot replace a generative model route.",
    ]);
  }
  const commandSelection = input.commandSelection
    ? resolveCommandModelSelection({
        selection: input.commandSelection,
        assignment,
        catalog,
      })
    : undefined;
  const selectedSettingsProvider = commandSelection?.provider || assignment.provider;
  const selectedModelId = commandSelection?.modelId || assignment.modelId;
  const provider = runtimeProvider(selectedSettingsProvider);

  const warnings: string[] = [];
  addLifecycleWarning(
    warnings,
    catalog,
    selectedSettingsProvider,
    selectedModelId,
    commandSelection?.route === "fallback" ? "Fallback" : "Primary",
  );
  const primaryConnection = connections.find((connection) =>
    connection.provider === selectedSettingsProvider &&
    connection.source === "tenant_vault" &&
    connection.enabled &&
    connection.status === "connected"
  );
  if (!primaryConnection) {
    if (commandSelection) {
      throw new CommandModelSelectionError(
        "The selected model provider is no longer connected. Choose a different model or repair it in Settings.",
      );
    }
    return withWarnings(environment, [
      ...warnings,
      "The assigned provider does not have an enabled, validated workspace connection, so deployment-environment routing remains in effect.",
    ]);
  }

  const primaryCredentials = await readProviderCredential(selectedSettingsProvider, {
    tenantId,
    actorId,
    connectionId: primaryConnection.id,
  });
  if (!primaryCredentials) {
    if (commandSelection) {
      throw new CommandModelSelectionError(
        "The selected model credential could not be opened. Repair the provider connection in Settings.",
      );
    }
    return withWarnings(environment, [
      ...warnings,
      "The assigned workspace credential could not be opened, so deployment-environment routing remains in effect.",
    ]);
  }

  const targets: ModelTarget[] = [modelTarget(provider, selectedModelId, input.tier)];
  const credentials: Partial<Record<RuntimeProviderId, ModelRuntimeCredential>> = {
    [provider]: primaryCredentials,
  };
  let fallbackProvider: RuntimeProviderId | undefined;
  let fallbackModel: string | undefined;
  let crossProviderFallback = false;

  if (!commandSelection && assignment.fallbackProvider && assignment.fallbackModelId) {
    if (assignment.fallbackProvider === "typesafe") {
      warnings.push(
        "A TypeSafe semantic-decision provider cannot be used as a generative fallback.",
      );
    } else {
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
  }

  const requiredFeatures = modelFeatureRequirements(input);
  const capableTargets = targets.filter((target) =>
    requiredFeatures.every((feature) => target.features.includes(feature))
  );
  const primaryMissingFeatures = requiredFeatures.filter((feature) =>
    !targets[0]?.features.includes(feature)
  );
  if (primaryMissingFeatures.length) {
    warnings.push(
      `The assigned primary provider runtime does not advertise ${primaryMissingFeatures.join(" and ")} support for this path.`,
    );
  }
  const context: ModelRuntimeContext = { targets, credentials };
  const allowedProviders = [...new Set(targets.map((target) => target.provider))];
  const reason = [
    commandSelection
      ? `You selected ${selectedSettingsProvider}/${selectedModelId} from the validated ${input.scope.replaceAll("_", " ")} Settings route.`
      : `Workspace ${input.scope.replaceAll("_", " ")} routing selected ${assignment.provider}/${assignment.modelId}.`,
    ...warnings,
  ].join(" ");
  const usageReceipt: RuntimeModelResolution["usageReceipt"] = {
    assignmentScope: input.scope,
    assignmentId: assignment.id,
    assignmentRevision: assignment.revision,
    assignmentConfigurationSha256: assignment.configurationSha256,
    credentialSource: "tenant_vault",
  };

  return {
    scope: input.scope,
    source: "tenant_assignment",
    configured: capableTargets.length > 0,
    assignmentId: assignment.id,
    assignmentRevision: assignment.revision,
    assignmentConfigurationSha256: assignment.configurationSha256,
    commandSelectionSha256: commandSelection?.selectionSha256,
    commandReasoningLevel: commandSelection?.reasoningLevel,
    reasoningEffort: commandSelection?.reasoningEffort,
    provider,
    model: selectedModelId,
    fallbackProvider,
    fallbackModel,
    allowCrossProviderFallback: crossProviderFallback,
    warnings,
    reason,
    usageReceipt,
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
        ...(commandSelection?.reasoningEffort
          ? { reasoningEffort: commandSelection.reasoningEffort }
          : {}),
        ...(request.usageScope
          ? { usageScope: { ...request.usageScope, ...usageReceipt } }
          : {}),
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
  requiredFeatures?: readonly ModelFeature[];
  deploymentFallback?: DeploymentModelFallback;
}): RuntimeModelResolution {
  const first = input.deploymentFallback || deploymentTarget(input.tier, input.requiredFeature);
  const requiredFeatures = modelFeatureRequirements(input);
  const firstFeatures = first
    ? modelTarget(first.provider, first.model, input.tier).features
    : [];
  const configured = (
    input.deploymentFallback?.configured ??
      hasModelProviderFeature(input.requiredFeature, input.tier)
  ) && requiredFeatures.every((feature) => firstFeatures.includes(feature));
  const usageReceipt: RuntimeModelResolution["usageReceipt"] = {
    credentialSource: "deployment_environment",
  };
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
    usageReceipt,
    bind<TRequest extends ModelTextRequest>(request: TRequest) {
      return {
        ...request,
        ...(request.usageScope
          ? { usageScope: { ...request.usageScope, ...usageReceipt } }
          : {}),
      } as TRequest;
    },
    withProviderApiKey<TResult>(
      _provider: RuntimeProviderId,
      operation: (apiKey: string | undefined) => Promise<TResult>,
    ) {
      return operation(undefined);
    },
  };
}

function modelFeatureRequirements(input: {
  requiredFeature: ModelFeature;
  requiredFeatures?: readonly ModelFeature[];
}): readonly ModelFeature[] {
  return [...new Set([
    input.requiredFeature,
    ...(input.requiredFeatures || []),
  ])];
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
  if (provider === "typesafe") {
    throw new Error(
      "TypeSafe semantic decisions require the dedicated shadow resolver.",
    );
  }
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
  const cache = runtimeModelRequestCache.getStore();
  if (!cache) return openProviderCredential(provider, input);
  const key = [provider, input.tenantId, input.actorId, input.connectionId]
    .join("\0");
  const existing = cache.credentials.get(key);
  if (existing) return existing;
  const pending = openProviderCredential(provider, input);
  cache.credentials.set(key, pending);
  return pending;
}

async function openProviderCredential(
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

async function readRuntimeSettingsSnapshot(
  tenantId: string,
  actorId: string,
): Promise<RuntimeSettingsSnapshot> {
  const load = async () => {
    if (getDatabasePoolMax() === 1) {
      const assignments = await listModelAssignments({ tenantId, actorId });
      const catalog = await listModelCatalog({ tenantId, actorId });
      const connections = await listProviderConnections({
        tenantId,
        actorId,
        includeDeploymentFallback: false,
      });
      return { assignments, catalog, connections };
    }
    const [assignments, catalog, connections] = await Promise.all([
      listModelAssignments({ tenantId, actorId }),
      listModelCatalog({ tenantId, actorId }),
      listProviderConnections({
        tenantId,
        actorId,
        includeDeploymentFallback: false,
      }),
    ]);
    return { assignments, catalog, connections };
  };
  const cache = runtimeModelRequestCache.getStore();
  if (!cache) return load();
  const key = `${tenantId}\0${actorId}`;
  const existing = cache.settings.get(key);
  if (existing) return existing;
  const pending = load();
  cache.settings.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (cache.settings.get(key) === pending) cache.settings.delete(key);
    throw error;
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
