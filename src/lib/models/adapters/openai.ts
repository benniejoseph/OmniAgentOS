import { AGENT_MODEL, WEB_SEARCH_MODEL, hasOpenAIKey } from "@/lib/config";
import {
  createStructuredResponseWithMetrics,
  streamResponseTurn,
  type ConversationItem,
} from "@/lib/openai/client";
import type {
  ModelProviderAdapter,
  ModelStructuredRequest,
  ModelTarget,
  ModelTextRequest,
} from "@/lib/models/types";
import { ModelProviderError } from "@/lib/models/types";

export const openAIModelAdapter: ModelProviderAdapter = {
  id: "openai",
  configured: hasOpenAIKey,
  targets(tier) {
    return [{
      provider: "openai",
      model: tier === "reasoning"
        ? process.env.OPENAI_REASONING_MODEL?.trim() || AGENT_MODEL
        : process.env.OPENAI_FAST_MODEL?.trim() || WEB_SEARCH_MODEL,
      tier,
      features: ["text", "streaming", "tools", "json_schema", "vision"],
    }];
  },
  async generateText(request: ModelTextRequest, target: ModelTarget) {
    const turn = await streamResponseTurn({
      instructions: request.instructions,
      input: request.input,
      onDelta: () => undefined,
      abortSignal: request.abortSignal,
      maxOutputTokens: request.maxOutputTokens,
      model: target.model,
    });
    return {
      text: turn.text,
      provider: "openai",
      model: turn.model,
      usage: turn.usage,
      latencyMs: turn.latencyMs,
      estimatedCostUsd: turn.estimatedCostUsd,
      costKnown: turn.estimatedCostUsd !== undefined,
    };
  },
  async generateStructured(request: ModelStructuredRequest, target: ModelTarget) {
    const result = await createStructuredResponseWithMetrics({
      instructions: request.instructions,
      input: request.input,
      schema: request.schema,
      name: request.name,
      abortSignal: request.abortSignal,
      reasoningEffort: request.reasoningEffort,
      model: target.model,
    });
    return {
      text: result.text,
      provider: "openai",
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
      estimatedCostUsd: result.estimatedCostUsd,
      costKnown: result.estimatedCostUsd !== undefined,
    };
  },
  async generateToolTurn(request, target) {
    if (request.continuation && request.continuation.provider !== "openai") {
      throw new ModelProviderError(
        "OpenAI cannot consume another provider's continuation state.",
        "openai",
        "invalid_request",
        false,
      );
    }
    const prior = request.continuation?.state.length
      ? request.continuation.state as ConversationItem[]
      : [{ role: "user", content: request.input } satisfies ConversationItem];
    const input: ConversationItem[] = [
      ...prior,
      ...(request.toolResults || []).map((result) => ({
        type: "function_call_output" as const,
        call_id: result.callId,
        output: result.output,
      })),
    ];
    const turn = await streamResponseTurn({
      instructions: request.instructions,
      input,
      tools: request.tools.map((tool) => ({
        ...tool,
        strict: false as const,
      })),
      onDelta: () => undefined,
      abortSignal: request.abortSignal,
      maxOutputTokens: request.maxOutputTokens,
      model: target.model,
    });
    return {
      text: turn.text,
      toolCalls: turn.functionCalls,
      continuation: {
        provider: "openai",
        state: [...input, ...turn.functionCallItems] as Record<string, unknown>[],
      },
      provider: "openai",
      model: turn.model,
      usage: turn.usage,
      latencyMs: turn.latencyMs,
      estimatedCostUsd: turn.estimatedCostUsd,
      costKnown: turn.estimatedCostUsd !== undefined,
    };
  },
  classifyError(error) {
    return classifyProviderError("openai", error);
  },
};

export function classifyProviderError(provider: "openai" | "google" | "anthropic" | "local", error: unknown) {
  if (error instanceof ModelProviderError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ModelProviderError("Model request was aborted.", provider, "abort", false);
  }
  const candidate = error as {
    status?: unknown;
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
  } | undefined;
  const status = Number(candidate?.status);
  const message = String(candidate?.message || "Model provider request failed.").slice(0, 1_000);
  const normalized = message.toLowerCase();
  if (candidate?.name === "AbortError") return new ModelProviderError(message, provider, "abort", false, status);
  if (status === 401 || status === 403) return new ModelProviderError(message, provider, "authentication", false, status);
  if (status === 400 || status === 404 || status === 422) return new ModelProviderError(message, provider, "invalid_request", false, status);
  if (status === 429) return new ModelProviderError(message, provider, "rate_limit", true, status);
  if (normalized.includes("safety") || normalized.includes("refusal") || normalized.includes("blocked")) {
    return new ModelProviderError(message, provider, "safety", false, status);
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return new ModelProviderError(message, provider, "timeout", true, status);
  }
  if (status >= 500 || normalized.includes("unavailable") || normalized.includes("connection")) {
    return new ModelProviderError(message, provider, "unavailable", true, status);
  }
  if (isRetryableNetworkFailure(candidate)) {
    return new ModelProviderError(message, provider, "unavailable", true, status);
  }
  return new ModelProviderError(message, provider, "unknown", false, Number.isFinite(status) ? status : undefined);
}

const retryableNetworkCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isRetryableNetworkFailure(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const code = String(candidate.code || "").toUpperCase();
    if (retryableNetworkCodes.has(code)) return true;
    const message = String(candidate.message || "").toLowerCase();
    if (
      message.includes("fetch failed") ||
      message.includes("failed to fetch") ||
      message.includes("network request failed") ||
      message.includes("socket hang up")
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
