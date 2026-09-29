import { GEMINI_FAST_MODEL, hasGeminiKey } from "@/lib/config";
import { generateGeminiText, generateGeminiToolTurn } from "@/lib/google/ai";
import { classifyProviderError } from "@/lib/models/provider-errors";
import type { ModelProviderAdapter } from "@/lib/models/types";
import {
  ModelProviderError,
  preserveModelProviderResponseReceipt,
} from "@/lib/models/types";
import { getModelRuntimeApiKey } from "@/lib/models/runtime-context";

export const googleModelAdapter: ModelProviderAdapter = {
  id: "google",
  configured: hasGeminiKey,
  targets(tier) {
    return [{
      provider: "google",
      model: tier === "reasoning"
        ? process.env.GEMINI_REASONING_MODEL?.trim() || GEMINI_FAST_MODEL
        : GEMINI_FAST_MODEL,
      tier,
      features: ["text", "tools", "vision", "audio"],
    }];
  },
  async generateText(request, target) {
    const result = await generateGeminiText({
      prompt: request.input,
      instructions: request.instructions,
      model: target.model,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.abortSignal,
      apiKey: getModelRuntimeApiKey(request, "google"),
    });
    return {
      text: result.text,
      provider: "google",
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
      estimatedCostUsd: result.estimatedCostUsd,
      costKnown: result.estimatedCostUsd !== undefined,
      providerRequestId: result.responseId,
    };
  },
  async generateToolTurn(request, target) {
    const result = await generateGeminiToolTurn({
      prompt: request.input,
      conversation: request.conversation,
      instructions: request.instructions,
      model: target.model,
      maxOutputTokens: request.maxOutputTokens,
      tools: request.tools,
      toolChoice: request.toolChoice,
      continuation: request.continuation,
      toolResults: request.toolResults,
      abortSignal: request.abortSignal,
      apiKey: getModelRuntimeApiKey(request, "google"),
    });
    return {
      text: result.text,
      toolCalls: result.toolCalls,
      continuation: result.continuation,
      provider: "google",
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
      estimatedCostUsd: result.estimatedCostUsd,
      costKnown: result.estimatedCostUsd !== undefined,
      providerRequestId: result.responseId,
    };
  },
  classifyError(error) {
    // Google rejects an invalid API key with 400 INVALID_ARGUMENT, not 401,
    // and names the cause in the error's reason.
    const failure = error as {
      reason?: unknown;
      message?: unknown;
      status?: unknown;
    } | undefined;
    if (failure?.reason === "API_KEY_INVALID") {
      return preserveModelProviderResponseReceipt(
        error,
        new ModelProviderError(
          String(failure.message || "The Gemini API key is not valid.").slice(0, 1_000),
          "google",
          "authentication",
          false,
          Number(failure.status) || undefined,
        ),
      );
    }
    return classifyProviderError("google", error);
  },
};
