import { GEMINI_FAST_MODEL, hasGeminiKey } from "@/lib/config";
import { generateGeminiText, generateGeminiToolTurn } from "@/lib/google/ai";
import { classifyProviderError } from "@/lib/models/adapters/openai";
import type { ModelProviderAdapter } from "@/lib/models/types";

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
    });
    return {
      text: result.text,
      provider: "google",
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
      estimatedCostUsd: result.estimatedCostUsd,
      costKnown: result.estimatedCostUsd !== undefined,
    };
  },
  async generateToolTurn(request, target) {
    const result = await generateGeminiToolTurn({
      prompt: request.input,
      instructions: request.instructions,
      model: target.model,
      maxOutputTokens: request.maxOutputTokens,
      tools: request.tools,
      continuation: request.continuation,
      toolResults: request.toolResults,
      abortSignal: request.abortSignal,
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
    };
  },
  classifyError(error) {
    return classifyProviderError("google", error);
  },
};
