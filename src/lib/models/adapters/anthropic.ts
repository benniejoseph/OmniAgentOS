import {
  ANTHROPIC_FAST_MODEL,
  ANTHROPIC_REASONING_MODEL,
  hasAnthropicKey,
} from "@/lib/config";
import { classifyProviderError } from "@/lib/models/adapters/openai";
import {
  anthropicModelCapabilities,
  claudeMaxTokens,
} from "@/lib/models/anthropic-capabilities";
import { estimateProviderCost } from "@/lib/models/pricing";
import { resolveModelReasoningEffort } from "@/lib/models/reasoning-effort";
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
import {
  appendModelTurnToConversation,
  modelConversationForToolTurn,
  renderUntrustedObservation,
  type ModelConversationItem,
} from "@/lib/models/conversation";
import { renderModelComputerObservation } from "@/lib/models/computer-observation";

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
    cache_creation_input_tokens?: number;
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
    const name = request.name.slice(0, 64);
    const tools = [{
      name,
      description: "Return the requested result using this schema.",
      input_schema: request.schema,
    }];
    if (anthropicModelCapabilities(target.model).forcedToolChoice) {
      const result = await callAnthropic(request, target, {
        tools,
        tool_choice: { type: "tool", name },
      });
      return structuredToolResult(result, target, name);
    }
    // This model rejects a forced tool call, so the instructions ask for the
    // call and an answer given in text instead gets one repair turn.
    const asked = {
      ...request,
      instructions: `${request.instructions}\n\nReturn the result by calling the ${name} tool once.`,
    };
    const choice = {
      tools,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    };
    const first = await callAnthropic(asked, target, choice);
    const answeredInText = first.body.stop_reason === "end_turn" &&
      anthropicContent(first.body).some((item) => item.type === "text");
    if (!answeredInText) return structuredToolResult(first, target, name);
    const repaired = await callAnthropic(asked, target, {
      ...choice,
      messages: [
        { role: "user", content: request.input },
        { role: "assistant", content: anthropicContent(first.body) },
        {
          role: "user",
          content: `Call the ${name} tool now with the complete result.`,
        },
      ],
    }, first);
    return structuredToolResult(repaired, target, name);
  },
  async generateToolTurn(request, target) {
    const conversation = modelConversationForToolTurn({
      provider: "anthropic",
      prompt: request.input,
      conversation: request.conversation,
      continuationConversation: request.continuation?.conversation,
      toolResults: request.toolResults,
    });
    const durableMessages = anthropicToolMessages(request, conversation, false);
    const messages = anthropicToolMessages(request, conversation, true);
    const toolChoice = anthropicToolChoice(request);
    const result = await callAnthropic(request, target, {
      messages,
      cache_control: { type: "ephemeral" },
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    });
    const content = anthropicContent(result.body);
    const text = content
      .filter((item) => item.type === "text")
      .map((item) => item.text || "")
      .join("")
      .trim();
    const toolUses = content.filter((item) => item.type === "tool_use");
    // A call is never run with arguments Claude did not send, and a call
    // dropped here would stay open in the saved turn.
    if (toolUses.some((item) => !item.id || !item.name || !isInputObject(item.input))) {
      throw anthropicResponseFailure(
        new ModelProviderError(
          "Claude returned a tool call without an id, a name, or an input object.",
          "anthropic",
          "invalid_request",
          false,
        ),
        result,
        target,
      );
    }
    const toolCalls = toolUses.map((item) => ({
      callId: item.id!,
      name: item.name!,
      argumentsJson: JSON.stringify(item.input),
    }));
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
          ...durableMessages,
          {
            role: "assistant",
            content,
          },
        ],
        conversation: appendModelTurnToConversation(conversation, {
          text,
          toolCalls,
        }),
      },
    };
  },
  classifyError(error) {
    return classifyProviderError("anthropic", error);
  },
};

type AnthropicCall = {
  body: AnthropicResponse;
  latencyMs: number;
};

/**
 * Send one Messages request. A call that follows `earlier` in the same
 * generation returns, and fails with, the usage and latency of both calls.
 */
async function callAnthropic(
  request: ModelTextRequest | ModelStructuredRequest,
  target: ModelTarget,
  extra: Record<string, unknown> = {},
  earlier?: AnthropicCall,
): Promise<AnthropicCall> {
  const apiKey = getModelRuntimeApiKey(request, "anthropic") || process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new ModelProviderError("Anthropic is not configured.", "anthropic", "authentication", false);
  const effort = resolveModelReasoningEffort(
    "anthropic",
    target.model,
    request.reasoningEffort,
  );
  const answerTokens = Math.min(Math.max(request.maxOutputTokens || 2_000, 64), 16_000);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: target.model,
        max_tokens: claudeMaxTokens(target.model, answerTokens, effort),
        ...(request.instructions ? { system: request.instructions } : {}),
        messages: [{ role: "user", content: request.input }],
        ...(effort ? { output_config: { effort } } : {}),
        ...extra,
      }),
      signal: request.abortSignal,
    });
  } catch (error) {
    throw earlier ? anthropicResponseFailure(error, earlier, target) : error;
  }
  const body = await response.json().catch(() => ({})) as AnthropicResponse;
  if (!response.ok) {
    const error = new Error(body.error?.message || `Anthropic returned ${response.status}.`) as Error & { status: number };
    error.status = response.status;
    throw earlier ? anthropicResponseFailure(error, earlier, target) : error;
  }
  const latest = { body, latencyMs: Date.now() - startedAt };
  const result = earlier ? combinedCalls(earlier, latest) : latest;
  const stopped = unfinishedResponseError(body.stop_reason);
  if (stopped) throw anthropicResponseFailure(stopped, result, target);
  return result;
}

/**
 * The error for a response that must not be used. A reply cut off at the
 * token limit may end inside a tool call, whose input is then incomplete.
 * Any stop reason other than end_turn or tool_use is not used either:
 * pause_turn comes only from server tools, and stop_sequence only from stop
 * sequences, and these requests send neither.
 */
function unfinishedResponseError(stopReason: string | undefined) {
  if (stopReason === "refusal") {
    return new ModelProviderError("Claude refused the request.", "anthropic", "safety", false);
  }
  if (stopReason === "max_tokens") {
    return new ModelProviderError(
      "Claude reached the response token limit. Narrow the request or split it into smaller steps.",
      "anthropic",
      "unknown",
      false,
    );
  }
  if (stopReason === "model_context_window_exceeded") {
    return new ModelProviderError(
      "Claude reached the end of its context window. Narrow the request or split it into smaller steps.",
      "anthropic",
      "invalid_request",
      false,
    );
  }
  if (stopReason && stopReason !== "end_turn" && stopReason !== "tool_use") {
    return new ModelProviderError(
      `Claude ended the response with stop reason ${stopReason.slice(0, 40)}.`,
      "anthropic",
      "unknown",
      false,
    );
  }
  return undefined;
}

/**
 * The tool_choice for a tool turn, or undefined for Claude's default. A
 * request without tools sends none, because tool_choice needs tools.
 */
function anthropicToolChoice(request: ModelToolTurnRequest) {
  if (!request.tools.length) return undefined;
  if (request.toolChoice === "none") return { type: "none" };
  if (request.parallelToolCalls === false) {
    return { type: "auto", disable_parallel_tool_use: true };
  }
  return undefined;
}

function anthropicToolMessages(
  request: ModelToolTurnRequest,
  conversation: readonly ModelConversationItem[],
  includeComputerObservation: boolean,
) {
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
    : anthropicMessagesFromConversation(conversation);
  if (prior?.length && request.toolResults?.length) {
    messages.push({
      role: "user",
      content: request.toolResults.map((result) => ({
        type: "tool_result",
        tool_use_id: result.callId,
        content:
          includeComputerObservation && result.computerObservation
            ? [
                { type: "text", text: result.output },
                {
                  type: "text",
                  text: renderModelComputerObservation(
                    result.computerObservation,
                  ),
                },
                ...(result.computerObservation.screenshot
                  ? [{
                      type: "image",
                      source: {
                        type: "base64",
                        media_type:
                          result.computerObservation.screenshot.mimeType,
                        data:
                          result.computerObservation.screenshot.dataBase64,
                      },
                    }]
                  : []),
              ]
            : result.output,
        ...(result.isError ? { is_error: true } : {}),
      })),
    });
  }
  return messages;
}

function anthropicMessagesFromConversation(
  conversation: readonly ModelConversationItem[],
) {
  const messages: Array<{
    role: "user" | "assistant";
    content: Record<string, unknown>[];
  }> = [];
  const append = (
    role: "user" | "assistant",
    block: Record<string, unknown>,
  ) => {
    const prior = messages.at(-1);
    if (prior?.role === role) {
      prior.content.push(block);
    } else {
      messages.push({ role, content: [block] });
    }
  };
  for (const item of conversation) {
    if (item.type === "message") {
      append(item.role, { type: "text", text: item.content });
    } else if (item.type === "observation") {
      append("user", {
        type: "text",
        text: renderUntrustedObservation(item),
      });
    } else if (item.type === "tool_call") {
      append("assistant", {
        type: "tool_use",
        id: item.callId,
        name: item.name,
        input: parseArgumentsObject(item.argumentsJson),
      });
    } else {
      append("user", {
        type: "tool_result",
        tool_use_id: item.callId,
        content: item.content,
        ...(item.isError ? { is_error: true } : {}),
      });
    }
  }
  return messages;
}

function parseArgumentsObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
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

function isInputObject(value: unknown) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function anthropicContent(body: AnthropicResponse) {
  return Array.isArray(body.content) ? body.content : [];
}

function structuredToolInput(body: AnthropicResponse, name: string) {
  const toolUse = anthropicContent(body).find((item) =>
    item.type === "tool_use" && item.name === name
  );
  return toolUse?.input && typeof toolUse.input === "object"
    ? toolUse.input
    : undefined;
}

function structuredToolResult(
  result: AnthropicCall,
  target: ModelTarget,
  name: string,
) {
  const input = structuredToolInput(result.body, name);
  if (!input) {
    throw anthropicResponseFailure(
      new ModelProviderError("Claude returned no structured tool result.", "anthropic", "invalid_request", false),
      result,
      target,
    );
  }
  return modelResult(result.body, target, result.latencyMs, JSON.stringify(input));
}

/** The later call's response, with the usage and latency of both calls. */
function combinedCalls(
  earlier: AnthropicCall,
  later: AnthropicCall,
): AnthropicCall {
  const total = (key: keyof NonNullable<AnthropicResponse["usage"]>) =>
    finite(earlier.body.usage?.[key]) + finite(later.body.usage?.[key]);
  return {
    body: {
      ...later.body,
      usage: {
        input_tokens: total("input_tokens"),
        output_tokens: total("output_tokens"),
        cache_creation_input_tokens: total("cache_creation_input_tokens"),
        cache_read_input_tokens: total("cache_read_input_tokens"),
      },
    },
    latencyMs: earlier.latencyMs + later.latencyMs,
  };
}

function anthropicResponseFailure(
  error: unknown,
  result: AnthropicCall,
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
  const inputTokens = finite(raw?.input_tokens) +
    finite(raw?.cache_creation_input_tokens) +
    finite(raw?.cache_read_input_tokens);
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
