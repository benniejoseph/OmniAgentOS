import type { ModelUsage } from "@/lib/openai/model-router";
import type { AiUsageScope } from "@/lib/usage/types";

export type ProviderId = "openai" | "google" | "anthropic" | "aws_bedrock" | "local";
export type ModelTier = "fast" | "reasoning";
export type ModelFeature = "text" | "streaming" | "tools" | "json_schema" | "vision" | "audio";
export type ModelFailureKind = "abort" | "authentication" | "invalid_request" | "rate_limit" | "safety" | "timeout" | "unavailable" | "unknown";

export type ModelTarget = {
  provider: ProviderId;
  model: string;
  tier: ModelTier;
  features: ModelFeature[];
};

export type ModelAttemptReceipt = {
  provider: ProviderId;
  model: string;
  status: "completed" | "failed";
  latencyMs: number;
  failureKind?: ModelFailureKind;
  retryable?: boolean;
  usage?: ModelUsage;
  estimatedCostUsd?: number;
  providerRequestId?: string;
};

export type ModelGenerationResult = {
  text: string;
  provider: ProviderId;
  model: string;
  usage: ModelUsage;
  latencyMs: number;
  estimatedCostUsd?: number;
  costKnown: boolean;
  attempts: ModelAttemptReceipt[];
  providerRequestId?: string;
  usageReceiptRecorded?: boolean;
  usageReceiptId?: string;
};

export type ModelProviderResponseReceipt = Readonly<{
  usage?: ModelUsage;
  latencyMs: number;
  model?: string;
  estimatedCostUsd?: number;
  providerRequestId?: string;
}>;

export type ModelToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ModelToolCall = {
  callId: string;
  name: string;
  argumentsJson: string;
};

export type ModelToolResult = {
  callId: string;
  name: string;
  output: string;
  isError?: boolean;
};

/**
 * Provider-owned, stateless continuation data. The gateway rejects this state
 * if it is ever presented to another provider, which prevents opaque model
 * state from crossing the request's disclosure boundary.
 */
export type ModelToolContinuation = {
  provider: ProviderId;
  state: readonly Record<string, unknown>[];
};

export type ModelToolTurnRequest = ModelTextRequest & {
  preferredProvider: ProviderId;
  tools: readonly ModelToolDefinition[];
  continuation?: ModelToolContinuation;
  toolResults?: readonly ModelToolResult[];
};

export type ModelToolTurnResult = ModelGenerationResult & {
  toolCalls: ModelToolCall[];
  continuation: ModelToolContinuation;
};

export type ModelToolTurnAdapterResult = Omit<ModelToolTurnResult, "attempts">;

export type ModelTextRequest = {
  instructions?: string;
  input: string;
  tier?: ModelTier;
  preferredProvider?: ProviderId;
  /** Providers this request is permitted to disclose its contents to. */
  allowedProviders?: readonly ProviderId[];
  /**
   * Permit retrying a failed request with another allowed provider. Defaults
   * to false so a transient provider failure cannot silently cross a privacy
   * boundary. Same-provider model fallbacks remain available.
   */
  allowCrossProviderFallback?: boolean;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /** Content-free tenant/actor attribution for the unified AI usage ledger. */
  usageScope?: AiUsageScope;
};

export type ModelStructuredRequest = ModelTextRequest & {
  instructions: string;
  name: string;
  schema: Record<string, unknown>;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
};

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId,
    readonly kind: ModelFailureKind,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

const modelProviderResponseReceiptKey = Symbol.for(
  "omniagent.model-provider-response-receipt",
);

/** Attach content-free billing evidence without exposing it in serialized errors. */
export function attachModelProviderResponseReceipt(
  error: unknown,
  receipt: ModelProviderResponseReceipt,
) {
  const target = error instanceof Error
    ? error
    : new Error("Model provider response failed.", { cause: error });
  const normalized = normalizeProviderResponseReceipt(receipt);
  try {
    Object.defineProperty(target, modelProviderResponseReceiptKey, {
      value: normalized,
      enumerable: false,
      configurable: true,
    });
    return target;
  } catch {
    const wrapped = new Error(target.message, { cause: target });
    Object.defineProperty(wrapped, modelProviderResponseReceiptKey, {
      value: normalized,
      enumerable: false,
      configurable: false,
    });
    return wrapped;
  }
}

export function getModelProviderResponseReceipt(
  error: unknown,
): ModelProviderResponseReceipt | undefined {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  return (error as Record<PropertyKey, unknown>)[modelProviderResponseReceiptKey] as
    | ModelProviderResponseReceipt
    | undefined;
}

export function preserveModelProviderResponseReceipt<T extends Error>(
  source: unknown,
  target: T,
): T {
  const receipt = getModelProviderResponseReceipt(source);
  return (receipt
    ? attachModelProviderResponseReceipt(target, receipt)
    : target) as T;
}

function normalizeProviderResponseReceipt(
  receipt: ModelProviderResponseReceipt,
): ModelProviderResponseReceipt {
  const usage = receipt.usage
    ? {
        inputTokens: finiteUsageNumber(receipt.usage.inputTokens),
        outputTokens: finiteUsageNumber(receipt.usage.outputTokens),
        cachedInputTokens: finiteUsageNumber(receipt.usage.cachedInputTokens),
        totalTokens: finiteUsageNumber(receipt.usage.totalTokens),
      }
    : undefined;
  const estimatedCostUsd = Number(receipt.estimatedCostUsd);
  const model = receipt.model?.trim().slice(0, 200);
  const providerRequestId = receipt.providerRequestId?.trim().slice(0, 240);
  return {
    latencyMs: finiteUsageNumber(receipt.latencyMs),
    ...(usage ? { usage } : {}),
    ...(model ? { model } : {}),
    ...(Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0
      ? { estimatedCostUsd }
      : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
  };
}

function finiteUsageNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

export interface ModelProviderAdapter {
  readonly id: ProviderId;
  configured(): boolean;
  targets(tier: ModelTier): ModelTarget[];
  generateText(request: ModelTextRequest, target: ModelTarget): Promise<Omit<ModelGenerationResult, "attempts">>;
  generateStructured?(request: ModelStructuredRequest, target: ModelTarget): Promise<Omit<ModelGenerationResult, "attempts">>;
  generateToolTurn?(request: ModelToolTurnRequest, target: ModelTarget): Promise<ModelToolTurnAdapterResult>;
  classifyError(error: unknown): ModelProviderError;
}
