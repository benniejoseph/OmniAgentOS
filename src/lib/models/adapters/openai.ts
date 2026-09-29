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
import { getModelRuntimeApiKey } from "@/lib/models/runtime-context";
import {
  appendModelTurnToConversation,
  modelConversationForToolTurn,
  type ModelConversationItem,
} from "@/lib/models/conversation";
import { promptCacheKeyForScope } from "@/lib/models/prompt-cache";
import { classifyProviderError } from "@/lib/models/provider-errors";

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
      reasoningEffort: request.reasoningEffort,
      maxOutputTokens: request.maxOutputTokens,
      model: target.model,
      apiKey: getModelRuntimeApiKey(request, "openai"),
      promptCacheKey: promptCacheKeyForScope(request.usageScope),
    });
    return {
      text: turn.text,
      provider: "openai",
      model: turn.model,
      usage: turn.usage,
      latencyMs: turn.latencyMs,
      estimatedCostUsd: turn.estimatedCostUsd,
      costKnown: turn.estimatedCostUsd !== undefined,
      providerRequestId: turn.responseId,
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
      maxOutputTokens: request.maxOutputTokens,
      model: target.model,
      apiKey: getModelRuntimeApiKey(request, "openai"),
    });
    return {
      text: result.text,
      provider: "openai",
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
      estimatedCostUsd: result.estimatedCostUsd,
      costKnown: result.estimatedCostUsd !== undefined,
      providerRequestId: result.responseId,
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
    const conversation = modelConversationForToolTurn({
      provider: "openai",
      prompt: request.input,
      conversation: request.conversation,
      continuationConversation: request.continuation?.conversation,
      toolResults: request.toolResults,
    });
    const nativeState = request.continuation?.state.length
      ? request.continuation.state as ConversationItem[]
      : undefined;
    const prior = nativeState ?? openAIConversationItems(conversation);
    // A conversation rebuilt from the canonical transcript already holds the
    // results; only provider state needs them appended.
    const toolResults = nativeState ? request.toolResults || [] : [];
    const durableInput: ConversationItem[] = [
      ...prior,
      ...toolResults.map((result) => ({
        type: "function_call_output" as const,
        call_id: result.callId,
        output: result.output,
      })),
    ];
    const input: ConversationItem[] = [
      ...prior,
      ...toolResults.map((result) =>
        result.computerObservation
          ? {
              type: "ephemeral_computer_function_output" as const,
              call_id: result.callId,
              output: result.output,
              observation: result.computerObservation,
            }
          : {
              type: "function_call_output" as const,
              call_id: result.callId,
              output: result.output,
            }
      ),
    ];
    const turn = await streamResponseTurn({
      instructions: request.instructions,
      input,
      tools: request.tools.map((tool) => ({
        ...tool,
        strict: false as const,
      })),
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      onDelta: () => undefined,
      abortSignal: request.abortSignal,
      reasoningEffort: request.reasoningEffort,
      maxOutputTokens: request.maxOutputTokens,
      model: target.model,
      apiKey: getModelRuntimeApiKey(request, "openai"),
      promptCacheKey: promptCacheKeyForScope(request.usageScope),
    });
    return {
      text: turn.text,
      toolCalls: turn.functionCalls,
      continuation: {
        provider: "openai",
        state: [
          ...durableInput,
          ...turn.outputItems,
        ] as Record<string, unknown>[],
        conversation: appendModelTurnToConversation(conversation, {
          text: turn.text,
          toolCalls: turn.functionCalls,
        }),
      },
      provider: "openai",
      model: turn.model,
      usage: turn.usage,
      latencyMs: turn.latencyMs,
      estimatedCostUsd: turn.estimatedCostUsd,
      costKnown: turn.estimatedCostUsd !== undefined,
      providerRequestId: turn.responseId,
    };
  },
  classifyError(error) {
    return classifyProviderError("openai", error);
  },
};

function openAIConversationItems(
  conversation: readonly ModelConversationItem[],
): ConversationItem[] {
  return conversation.map((item) => {
    if (item.type === "message" || item.type === "observation") return item;
    if (item.type === "tool_call") {
      return {
        type: "function_call",
        id: item.callId,
        call_id: item.callId,
        name: item.name,
        arguments: item.argumentsJson,
      };
    }
    return {
      type: "function_call_output",
      call_id: item.callId,
      output: item.content,
    };
  });
}
