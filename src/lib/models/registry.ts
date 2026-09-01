import { anthropicModelAdapter } from "@/lib/models/adapters/anthropic";
import { bedrockModelAdapter } from "@/lib/models/adapters/bedrock";
import { googleModelAdapter } from "@/lib/models/adapters/google";
import { openAIModelAdapter } from "@/lib/models/adapters/openai";
import type {
  ModelFeature,
  ModelProviderAdapter,
  ModelTarget,
  ModelTier,
  ProviderId,
} from "@/lib/models/types";

const adapters = new Map<ProviderId, ModelProviderAdapter>([
  [openAIModelAdapter.id, openAIModelAdapter],
  [googleModelAdapter.id, googleModelAdapter],
  [anthropicModelAdapter.id, anthropicModelAdapter],
  [bedrockModelAdapter.id, bedrockModelAdapter],
]);

export function getModelProvider(provider: ProviderId) {
  return adapters.get(provider);
}

export function listConfiguredModelProviders() {
  return [...adapters.values()].filter((adapter) => adapter.configured());
}

export function hasModelProviderFeature(feature: ModelFeature, tier: ModelTier = "fast") {
  return listConfiguredModelProviders().some((adapter) =>
    adapter.targets(tier).some((target) => target.features.includes(feature))
  );
}

export function modelTargets(input: {
  tier: ModelTier;
  feature: ModelFeature;
  preferredProvider?: ProviderId;
  allowedProviders?: readonly ProviderId[];
  allowCrossProviderFallback?: boolean;
  runtimeTargets?: readonly ModelTarget[];
}) {
  const allowedProviders = input.allowedProviders
    ? new Set(input.allowedProviders)
    : undefined;
  const crossProviderFallback = input.allowCrossProviderFallback === true;
  if (input.runtimeTargets) {
    const targets: Array<{ adapter: ModelProviderAdapter; target: ModelTarget }> = [];
    const seenTargets = new Set<string>();
    for (const target of input.runtimeTargets) {
      if (allowedProviders && !allowedProviders.has(target.provider)) continue;
      if (
        input.preferredProvider &&
        !crossProviderFallback &&
        target.provider !== input.preferredProvider
      ) continue;
      if (!target.features.includes(input.feature)) continue;
      const adapter = adapters.get(target.provider);
      if (!adapter || adapter.id !== target.provider) continue;
      const key = `${adapter.id}:${target.model}`;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      targets.push({ adapter, target });
    }
    return targets;
  }
  const order = input.preferredProvider && !crossProviderFallback
    ? [input.preferredProvider]
    : providerOrder(input.preferredProvider);
  const targets: Array<{ adapter: ModelProviderAdapter; target: ModelTarget }> = [];
  const seenTargets = new Set<string>();
  for (const provider of order) {
    if (allowedProviders && !allowedProviders.has(provider)) continue;
    const adapter = adapters.get(provider);
    if (!adapter?.configured()) continue;
    const providerTargets = adapter.targets(input.tier).filter((candidate) =>
      candidate.provider === adapter.id && candidate.features.includes(input.feature)
    );
    for (const target of providerTargets) {
      const key = `${adapter.id}:${target.model}`;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      targets.push({ adapter, target });
    }
    if (providerTargets.length && !crossProviderFallback) break;
  }
  return targets;
}

function providerOrder(preferred?: ProviderId) {
  const configured = (process.env.OMNIAGENT_MODEL_PROVIDER_ORDER || "openai,google,anthropic")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(isProviderId);
  return [...new Set([...(preferred ? [preferred] : []), ...configured, "openai", "google", "anthropic", "aws_bedrock"])] as ProviderId[];
}

function isProviderId(value: string): value is ProviderId {
  return value === "openai" || value === "google" || value === "anthropic" || value === "aws_bedrock" || value === "local";
}
