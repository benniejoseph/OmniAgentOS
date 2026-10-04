import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createEmbedding: vi.fn(),
  recordAiUsageSafely: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    embeddings = { create: mocks.createEmbedding };
    responses = { create: vi.fn() };
  },
}));

vi.mock("@/lib/settings/specialized-runtime", () => ({
  resolveSpecializedRuntime: async () => ({
    configured: true,
    model: "text-embedding-3-large",
    usageReceipt: { credentialSource: "deployment_environment" },
    withApiKey: <T>(run: (apiKey?: string) => T) => run("sk-test-embedding-key"),
  }),
}));

vi.mock("@/lib/usage/ledger", () => ({
  recordAiUsageSafely: mocks.recordAiUsageSafely,
}));

import { embedTextsWithRuntime } from "@/lib/openai/client";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("embedding usage", () => {
  it("runs the optional native authority fence after credential resolution without billing a refused call", async () => {
    const beforeProvider = vi.fn(async () => { throw new Error("Recording source changed"); });
    await expect(embedTextsWithRuntime(["reviewed transcript"], undefined, undefined, beforeProvider)).rejects.toThrow("Recording source changed");
    expect(beforeProvider).toHaveBeenCalledOnce(); expect(mocks.createEmbedding).not.toHaveBeenCalled(); expect(mocks.recordAiUsageSafely).not.toHaveBeenCalled();
  });
  it("records the tokens and priced cost of an embedding call", async () => {
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      "text-embedding-3-large": { input: 0.13, output: 0 },
    }));
    mocks.createEmbedding.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 2_000, total_tokens: 2_000 },
    });

    const result = await embedTextsWithRuntime(["hello"], undefined, {
      tenantId: "tenant-a",
      actorId: "actor-a",
      sourceStreamId: "memory-1",
      operation: "embedding",
      purpose: "Index a memory",
    });

    expect(result?.vectors).toEqual([[0.1, 0.2]]);
    expect(mocks.recordAiUsageSafely).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      model: "text-embedding-3-large",
      usage: { inputTokens: 2_000, totalTokens: 2_000 },
      // 2,000 × 0.13 = 260 per million.
      estimatedCostUsd: 0.00026,
    }));
  });
});
