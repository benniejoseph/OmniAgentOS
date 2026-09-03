import {
  ANTHROPIC_FAST_MODEL,
  ANTHROPIC_REASONING_MODEL,
  hasAnthropicKey,
} from "@/lib/config";
import { classifyProviderError } from "@/lib/models/adapters/openai";
import { estimateProviderCost } from "@/lib/models/pricing";
import type {
  ModelProviderAdapter,
  ModelStructuredRequest,
  ModelTarget,
  ModelTextRequest,
  ModelToolTurnRequest,
} from "@/lib/models/types";
import {
  attachModelProviderResponseReceipt,
  ModelProviderError,
} from "@/lib/models/types";
import type { ModelUsage } from "@/lib/openai/model-router";
import { getModelRuntimeApiKey } from "@/lib/models/runtime-context";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

type AnthropicResponse = {
  id?: string;
  model?: string;
  stop_reason?: string;
  content?: Array<{
    type?: string;
    id?: string;
    text?: string;
    name?: string;
    input?: unknown;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  error?: { message?: string };
};

export const anthropicModelAdapter: ModelProviderAdapter = {
  id: "anthropic",
  configured: hasAnthropicKey,
  targets(tier) {
    return [{
      provider: "anthropic",
      model: tier === "reasoning" ? ANTHROPIC_REASONING_MODEL : ANTHROPIC_FAST_MODEL,
      tier,
      features: ["text", "streaming", "tools", "json_schema", "vision"],
    }];
  },
  async generateText(request, target) {
    const result = await callAnthropic(request, target);
    const text = anthropicContent(result.body)
      .filter((item) => item.type === "text")
      .map((item) => item.text || "")
      .join("")
      .trim();
    if (!text) {
      throw anthropicResponseFailure(
        new ModelProviderError("Claude returned no text.", "anthropic", "unknown", false),
        result,
        target,
      );
    }
    return modelResult(result.body, target, result.latencyMs, text);
  },
  async generateStructured(request, target) {
    const result = await callAnthropic(request, target, {
      tools: [{
        name: request.name.slice(0, 64),
        description: "Return the requested result using this schema.",
        input_schema: request.schema,
      }],
      tool_choice: { type: "tool", name: request.name.slice(0, 64) },
    });
    const toolUse = anthropicContent(result.body).find((item) =>
      item.type === "tool_use" && item.name === request.name.slice(0, 64)
    );
    if (!toolUse || !toolUse.input || typeof toolUse.input !== "object") {
      throw anthropicResponseFailure(
        new ModelProviderError("Claude returned no structured tool result.", "anthropic", "invalid_request", false),
        result,
        target,
      );
    }
    return modelResult(result.body, target, result.latencyMs, JSON.stringify(toolUse.input));
  },
  async generateToolTurn(request, target) {
    const messages = anthropicToolMessages(request);
    const result = await callAnthropic(request, target, {
      messages,
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
    });
    const content = anthropicContent(result.body);
    const text = content
      .filter((item) => item.type === "text")
      .map((item) => item.text || "")
      .join("")
      .trim();
    const toolCalls = content.flatMap((item) => {
      if (item.type !== "tool_use" || !item.id || !item.name) return [];
      return [{
        callId: item.id,
        name: item.name,
        argumentsJson: JSON.stringify(
          item.input && typeof item.input === "object" ? item.input : {},
        ),
      }];
    });
    if (!text && !toolCalls.length) {
      throw anthropicResponseFailure(
        new ModelProviderError(
          "Claude returned neither text nor tool calls.",
          "anthropic",
          "unknown",
          false,
        ),
        result,
        target,
      );
    }
    return {
      ...modelResult(result.body, target, result.latencyMs, text),
      toolCalls,
      continuation: {
        provider: "anthropic",
        state: [
          ...messages,
          {
            role: "assistant",
            content,
          },
        ],
      },
    };
  },
  classifyError(error) {
    return classifyProviderError("anthropic", error);
  },
};

async function callAnthropic(
  request: ModelTextRequest | ModelStructuredRequest,
  target: ModelTarget,
  extra: Record<string, unknown> = {},
) {
  const apiKey = getModelRuntimeApiKey(request, "anthropic") || process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new ModelProviderError("Anthropic is not configured.", "anthropic", "authentication", false);
  const startedAt = Date.now();
  const response = await fetch(MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: target.model,
      max_tokens: Math.min(Math.max(request.maxOutputTokens || 2_000, 64), 16_000),
      ...(request.instructions ? { system: request.instructions } : {}),
      messages: [{ role: "user", content: request.input }],
      ...extra,
    }),
    signal: request.abortSignal,
  });
  const body = await response.json().catch(() => ({})) as AnthropicResponse;
  if (!response.ok) {
    const error = new Error(body.error?.message || `Anthropic returned ${response.status}.`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  const result = { body, latencyMs: Date.now() - startedAt };
  if (body.stop_reason === "refusal") {
    throw anthropicResponseFailure(
      new ModelProviderError("Claude refused the request.", "anthropic", "safety", false),
      result,
      target,
    );
  }
  return result;
}

function anthropicToolMessages(request: ModelToolTurnRequest) {
  if (request.continuation && request.continuation.provider !== "anthropic") {
    throw new ModelProviderError(
      "Anthropic cannot consume another provider's continuation state.",
      "anthropic",
      "invalid_request",
      false,
    );
  }
  const prior = request.continuation?.state;
  const messages: Record<string, unknown>[] = prior?.length
    ? prior.map((message) => ({ ...message }))
    : [{ role: "user", content: request.input }];
  if (request.toolResults?.length) {
    messages.push({
      role: "user",
      content: request.toolResults.map((result) => ({
        type: "tool_result",
        tool_use_id: result.callId,
        content: result.output,
        ...(result.isError ? { is_error: true } : {}),
      })),
    });
  }
  return messages;
}

function modelResult(body: AnthropicResponse, target: ModelTarget, latencyMs: number, text: string) {
  const usage = anthropicUsage(body.usage);
  const pricing = estimateProviderCost("anthropic", body.model || target.model, usage);
  return {
    text,
    provider: "anthropic" as const,
    model: body.model || target.model,
    usage,
    latencyMs,
    ...pricing,
    ...(body.id ? { providerRequestId: body.id } : {}),
  };
}

function anthropicContent(body: AnthropicResponse) {
  return Array.isArray(body.content) ? body.content : [];
}

function anthropicResponseFailure(
  error: Error,
  result: { body: AnthropicResponse; latencyMs: number },
  target: ModelTarget,
) {
  const usage = anthropicUsage(result.body.usage);
  const pricing = estimateProviderCost(
    "anthropic",
    result.body.model || target.model,
    usage,
  );
  return attachModelProviderResponseReceipt(error, {
    usage,
    latencyMs: result.latencyMs,
    model: result.body.model || target.model,
    estimatedCostUsd: pricing.costKnown
      ? pricing.estimatedCostUsd
      : undefined,
    providerRequestId: result.body.id,
  });
}

function anthropicUsage(raw: AnthropicResponse["usage"]): ModelUsage {
  const inputTokens = finite(raw?.input_tokens);
  const outputTokens = finite(raw?.output_tokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: finite(raw?.cache_read_input_tokens),
    totalTokens: inputTokens + outputTokens,
  };
}

function finite(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}
