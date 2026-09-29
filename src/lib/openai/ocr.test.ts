import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  recordAiUsageSafely: vi.fn(),
}));

vi.mock("@/lib/settings/specialized-runtime", () => ({
  resolveSpecializedRuntime: async () => ({
    configured: true,
    model: "gpt-5",
    usageReceipt: { credentialSource: "deployment_environment" },
    withApiKey: <T>(run: (apiKey?: string) => T) => run(undefined),
  }),
}));

vi.mock("@/lib/openai/client", () => ({
  classifyOpenAITerminalResponse: () => undefined,
  getOpenAIClient: () => ({ responses: { create: mocks.create } }),
}));

vi.mock("@/lib/usage/ledger", () => ({
  recordAiUsageSafely: mocks.recordAiUsageSafely,
}));

import { extractTextFromImages } from "@/lib/openai/ocr";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("image OCR usage", () => {
  it("records the tokens and priced cost of a transcription", async () => {
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      "gpt-5": { input: 1, cachedInput: 0.1, output: 4 },
    }));
    mocks.create.mockResolvedValue({
      id: "resp_ocr",
      output_text: " Page one ",
      usage: {
        input_tokens: 1_000,
        input_tokens_details: { cached_tokens: 200 },
        output_tokens: 100,
        output_tokens_details: { reasoning_tokens: 40 },
        total_tokens: 1_100,
      },
    });

    const text = await extractTextFromImages(["data:image/png;base64,AA=="], {
      tenantId: "tenant-a",
      actorId: "actor-a",
      sourceStreamId: "document-1",
      operation: "ocr",
      purpose: "Read a scanned page",
    });

    expect(text).toBe("Page one");
    expect(mocks.recordAiUsageSafely).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      model: "gpt-5",
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 100,
        totalTokens: 1_100,
        reasoningTokens: 40,
        imageCount: 1,
      },
      // 800 × 1 + 200 × 0.1 + 100 × 4 = 1,220 per million.
      estimatedCostUsd: 0.00122,
    }));
  });
});
