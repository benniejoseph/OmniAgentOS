import { describe, expect, it } from "vitest";
import {
  attachModelProviderResponseReceipt,
  getModelProviderResponseReceipt,
  sumModelUsage,
} from "@/lib/models/types";

describe("model usage", () => {
  it("adds up several calls, with cache writes and reasoning only when a call had them", () => {
    expect(sumModelUsage([
      { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, totalTokens: 120, cacheWriteInputTokens: 10 },
      undefined,
      { inputTokens: 50, outputTokens: 40, cachedInputTokens: 5, totalTokens: 90, reasoningTokens: 25 },
    ])).toEqual({
      inputTokens: 150,
      outputTokens: 60,
      cachedInputTokens: 35,
      totalTokens: 210,
      cacheWriteInputTokens: 10,
      reasoningTokens: 25,
    });
    expect(sumModelUsage([
      { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
    ])).toEqual({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 });
  });

  it("keeps a failed call's cache writes and reasoning on its receipt", () => {
    const error = attachModelProviderResponseReceipt(new Error("cut off"), {
      latencyMs: 12,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 0,
        totalTokens: 120,
        cacheWriteInputTokens: 40,
        reasoningTokens: 15,
      },
    });
    const invalid = attachModelProviderResponseReceipt(new Error("cut off"), {
      latencyMs: 12,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 0,
        totalTokens: 120,
        cacheWriteInputTokens: Number.NaN,
        reasoningTokens: -4,
      },
    });

    expect(getModelProviderResponseReceipt(error)?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0,
      totalTokens: 120,
      cacheWriteInputTokens: 40,
      reasoningTokens: 15,
    });
    expect(getModelProviderResponseReceipt(invalid)?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0,
      totalTokens: 120,
    });
  });
});
