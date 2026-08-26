import { afterEach, describe, expect, it, vi } from "vitest";
import {
  estimateGeminiCostUsd,
  generateGeminiText,
  generateGeminiToolTurn,
} from "@/lib/google/ai";

describe("Google AI provider", () => {
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL_PRICING_JSON;
    vi.unstubAllGlobals();
  });

  it("normalizes Interactions API text and usage", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "interaction-1",
      model: "gemini-test",
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "Concise result" }] }],
      usage: { total_input_tokens: 10, total_output_tokens: 4, total_cached_tokens: 2, total_tokens: 14 },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(generateGeminiText({ prompt: "Summarize this" })).resolves.toMatchObject({
      text: "Concise result",
      model: "gemini-test",
      responseId: "interaction-1",
      usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 14 },
    });
  });

  it("calculates only explicitly configured Gemini pricing", () => {
    process.env.GEMINI_MODEL_PRICING_JSON = JSON.stringify({ gemini: { input: 0.3, cachedInput: 0.03, output: 2.5 } });
    expect(estimateGeminiCostUsd("gemini", { inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 500, totalTokens: 1_500 })).toBe(0.001496);
    expect(estimateGeminiCostUsd("unknown", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, totalTokens: 2 })).toBeUndefined();
  });

  it("uses official function tools and continues statelessly with exact prior steps", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const functionCall = {
      type: "function_call",
      id: "call-1",
      name: "memory_search",
      arguments: { query: "Ada" },
      signature: "signed-step",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "interaction-1",
        model: "gemini-test",
        status: "completed",
        steps: [functionCall],
        usage: { total_input_tokens: 8, total_output_tokens: 2, total_tokens: 10 },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "interaction-2",
        model: "gemini-test",
        status: "completed",
        steps: [{ type: "model_output", content: [{ type: "text", text: "Ada found" }] }],
        usage: { total_input_tokens: 12, total_output_tokens: 3, total_tokens: 15 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const tools = [{
      type: "function" as const,
      name: "memory_search",
      description: "Search memory",
      parameters: { type: "object" },
    }];

    const first = await generateGeminiToolTurn({
      prompt: "Find Ada",
      model: "gemini-test",
      tools,
    });
    expect(first.toolCalls).toEqual([{
      callId: "call-1",
      name: "memory_search",
      argumentsJson: JSON.stringify({ query: "Ada" }),
    }]);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstBody).toMatchObject({
      store: false,
      tools: [{
        type: "function",
        name: "memory_search",
        description: "Search memory",
        parameters: { type: "object" },
      }],
    });
    expect(firstBody).not.toHaveProperty("previous_interaction_id");

    const second = await generateGeminiToolTurn({
      prompt: "Find Ada",
      model: "gemini-test",
      tools,
      continuation: first.continuation,
      toolResults: [{
        callId: "call-1",
        name: "memory_search",
        output: "{\"name\":\"Ada\"}",
      }],
    });
    expect(second.text).toBe("Ada found");
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondBody.store).toBe(false);
    expect(secondBody).not.toHaveProperty("previous_interaction_id");
    expect(secondBody.input).toContainEqual(functionCall);
    expect(secondBody.input).toContainEqual({
      type: "function_result",
      name: "memory_search",
      call_id: "call-1",
      result: [{ type: "text", text: "{\"name\":\"Ada\"}" }],
    });
  });
});
