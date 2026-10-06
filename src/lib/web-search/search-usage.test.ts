import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  create: vi.fn(),
  recordAiUsageSafely: vi.fn(),
}));

vi.mock("@/lib/settings/specialized-runtime", () => ({
  resolveSpecializedRuntime: async () => ({
    configured: true,
    provider: "openai",
    model: "gpt-5",
    usageReceipt: { credentialSource: "deployment_environment" },
    withApiKey: <T>(run: (apiKey?: string) => T) => run(undefined),
  }),
}));

vi.mock("@/lib/openai/client", () => ({
  classifyOpenAITerminalResponse: () => undefined,
  getOpenAIClient: (options: unknown) => {
    mocks.client(options);
    return { responses: { create: mocks.create } };
  },
}));

vi.mock("@/lib/usage/ledger", () => ({
  recordAiUsageSafely: mocks.recordAiUsageSafely,
}));

import { runLiveWebSearch } from "@/lib/web-search/search";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("live web search usage", () => {
  it("records the tokens of a search and prices them with its query fee", async () => {
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      "gpt-5": { input: 1, cachedInput: 0.1, output: 4, webSearch: 0.01 },
    }));
    mocks.create.mockResolvedValue({
      id: "resp_search",
      output_text: "Short answer",
      output: [{
        id: "ws_search",
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          sources: [{ type: "url", url: "https://example.com/prices" }],
        },
      }],
      usage: {
        input_tokens: 1_000,
        input_tokens_details: { cached_tokens: 200 },
        output_tokens: 100,
        output_tokens_details: { reasoning_tokens: 40 },
        total_tokens: 1_100,
      },
    });

    await runLiveWebSearch({
      query: "current model prices",
      usageScope: {
        tenantId: "tenant-a",
        actorId: "actor-a",
        sourceStreamId: "run-1",
        operation: "web_search",
        purpose: "Answer the owner",
        correlationId: "correlation-a",
      },
    });

    // The deployment's client tells its gateway which work the call is for.
    expect(mocks.client).toHaveBeenCalledWith({
      apiKey: undefined,
      correlationId: "correlation-a",
    });
    expect(mocks.recordAiUsageSafely).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      model: "gpt-5",
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 100,
        totalTokens: 1_100,
        reasoningTokens: 40,
        searchQueryCount: 1,
      },
      // 800 × 1 + 200 × 0.1 + 100 × 4 = 1,220 per million, plus one query.
      estimatedCostUsd: 0.01122,
    }));
  });
});
