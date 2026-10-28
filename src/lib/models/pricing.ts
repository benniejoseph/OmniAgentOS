import { createHash } from "node:crypto";
import { claudeModelInBedrockId } from "@/lib/models/anthropic-capabilities";
import type { ModelUsage, ProviderId } from "@/lib/models/types";

/** US dollars per million tokens, and per query for web search. */
type TokenPrice = {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
};
export type ModelPrice = TokenPrice & {
  webSearch?: number;
  /** The full request uses these rates only above this input-token boundary. */
  longContext?: TokenPrice & { threshold: number };
};

const PRICING_ENV: Record<string, string> = {
  openai: "OPENAI_MODEL_PRICING_JSON",
  google: "GEMINI_MODEL_PRICING_JSON",
  anthropic: "ANTHROPIC_MODEL_PRICING_JSON",
  aws_bedrock: "BEDROCK_MODEL_PRICING_JSON",
};

// A provider can answer with a dated snapshot of the model it was asked for,
// such as gpt-5-2025-08-07 for gpt-5 or claude-sonnet-4-5-20250929 for
// claude-sonnet-4-5.
const DATED_SNAPSHOT = /-(?:20\d{2}-\d{2}-\d{2}|20\d{6})$/;

/**
 * The configured price of a model, or of the model a dated snapshot names
 * when the snapshot itself is not listed. Prices are read on every call, so a
 * changed environment applies at once.
 */
export function resolveModelPrice(provider: string, model: string) {
  const prices = configuredPrices(provider);
  const exact = prices.get(model);
  if (prices.has(model)) return exact ? { model, price: exact } : undefined;
  const base = model.replace(DATED_SNAPSHOT, "");
  const price = prices.get(base);
  return price ? { model: base, price } : undefined;
}

/** The cost of a model call in US dollars, or undefined when the model has no configured price. */
export function estimateModelCostUsd(provider: string, model: string, usage: ModelUsage) {
  const resolved = resolveModelPrice(provider, model);
  return resolved ? roundUsd(tokenCostUsd(provider, model, resolved.price, usage)) : undefined;
}

export function estimateProviderCost(
  provider: ProviderId,
  model: string,
  usage: ModelUsage,
) {
  const estimatedCostUsd = estimateModelCostUsd(provider, model, usage);
  return estimatedCostUsd === undefined
    ? { costKnown: false as const, estimatedCostUsd: undefined }
    : { costKnown: true as const, estimatedCostUsd };
}

/** The cost of an OpenAI web search call: its tokens plus a fee for each query. */
export function estimateWebSearchCostUsd(
  model: string,
  usage: ModelUsage,
  searchQueryCount: number,
) {
  const resolved = resolveModelPrice("openai", model);
  if (resolved?.price.webSearch === undefined) return undefined;
  return roundUsd(
    tokenCostUsd("openai", model, resolved.price, usage) +
    Math.max(0, Math.round(searchQueryCount)) * resolved.price.webSearch,
  );
}

/** Identifies the configured price a cost came from, so a changed price shows in usage records. */
export function modelPricingProvenance(provider: string, model: string) {
  const resolved = resolveModelPrice(provider, model);
  const price = resolved ? JSON.stringify(resolved.price) : "configured-rate";
  return {
    pricingSource: "environment",
    pricingVersion: createHash("sha256")
      .update(`${provider}\n${resolved?.model || model}\n${price}`)
      .digest("hex")
      .slice(0, 16),
  };
}

function tokenCostUsd(provider: string, model: string, price: ModelPrice, usage: ModelUsage) {
  const rates = price.longContext && usage.inputTokens > price.longContext.threshold
    ? price.longContext
    : price;
  const cacheWrite = usage.cacheWriteInputTokens || 0;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens - cacheWrite);
  return (
    uncached * rates.input +
    usage.cachedInputTokens * (rates.cachedInput ?? rates.input) +
    cacheWrite * (rates.cacheWrite ?? defaultCacheWritePrice(provider, model, rates)) +
    usage.outputTokens * rates.output
  ) / 1_000_000;
}

// Claude bills a five-minute prompt-cache write, the only kind Asael makes,
// at 1.25 times the input price. Other providers bill it as input.
function defaultCacheWritePrice(provider: string, model: string, price: TokenPrice) {
  const claude = provider === "anthropic" ||
    (provider === "aws_bedrock" && claudeModelInBedrockId(model) !== undefined);
  return claude ? price.input * 1.25 : price.input;
}

function configuredPrices(provider: string) {
  const prices = new Map<string, ModelPrice | undefined>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(process.env[PRICING_ENV[provider] || "LOCAL_MODEL_PRICING_JSON"] || "{}");
  } catch {
    return prices;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return prices;
  for (const [model, value] of Object.entries(parsed)) {
    // Keep an invalid exact entry so a dated model cannot inherit a cheaper
    // base rate after its own configuration was rejected.
    prices.set(model, modelPrice(value));
  }
  return prices;
}

function modelPrice(value: unknown): ModelPrice | undefined {
  const tokens = tokenPrice(value);
  if (!tokens) return undefined;
  const rates = value as Record<string, unknown>;
  const webSearch = rate(rates.webSearch);
  let longContext: ModelPrice["longContext"];
  if (Object.prototype.hasOwnProperty.call(rates, "longContext")) {
    const tier = tokenPrice(rates.longContext, true);
    const threshold = rates.longContext && typeof rates.longContext === "object"
      ? (rates.longContext as Record<string, unknown>).threshold
      : undefined;
    // A malformed tier must not silently fall back to cheaper short-context rates.
    if (!tier || typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold <= 0) return undefined;
    longContext = { threshold, ...tier };
  }
  return {
    ...tokens,
    ...(webSearch === undefined ? {} : { webSearch }),
    ...(longContext === undefined ? {} : { longContext }),
  };
}

function tokenPrice(value: unknown, strictOptionalRates = false): TokenPrice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rates = value as Record<string, unknown>;
  const input = rate(rates.input);
  const output = rate(rates.output);
  if (input === undefined || output === undefined) return undefined;
  const cachedInput = rate(rates.cachedInput);
  const cacheWrite = rate(rates.cacheWrite);
  if (strictOptionalRates && (
    (Object.prototype.hasOwnProperty.call(rates, "cachedInput") && cachedInput === undefined) ||
    (Object.prototype.hasOwnProperty.call(rates, "cacheWrite") && cacheWrite === undefined)
  )) return undefined;
  return {
    input,
    output,
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

// A rate is a non-negative number, or a string that holds one.
function rate(value: unknown) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
