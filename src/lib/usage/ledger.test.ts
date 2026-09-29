import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(),
  getSql: vi.fn(),
  hasDatabaseUrl: () => false,
}));

import { modelPricingProvenance } from "@/lib/models/pricing";
import { recordAiUsage } from "@/lib/usage/ledger";
import type { RecordAiUsageInput } from "@/lib/usage/ledger";

const scope = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  sourceStreamId: "run-1",
  operation: "tool_turn",
  purpose: "Answer the owner",
} as const;

let dataDirectory = "";

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "asael-ledger-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", dataDirectory);
  vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({ "gpt-5": { input: 1, output: 4 } }));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDirectory, { recursive: true, force: true });
});

function usageInput(overrides: Partial<RecordAiUsageInput>): RecordAiUsageInput {
  return {
    ...scope,
    status: "completed",
    provider: "openai",
    model: "gpt-5-2025-08-07",
    usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, reasoningTokens: 60 },
    ...overrides,
  };
}

describe("AI usage ledger pricing", () => {
  it("names the configured price a snapshot's cost came from", async () => {
    const expected = modelPricingProvenance("openai", "gpt-5");

    const record = await recordAiUsage(usageInput({ estimatedCostUsd: 0.0014 }));
    const withReceipt = await recordAiUsage(usageInput({
      callReceipts: [{
        provider: "openai",
        model: "gpt-5-2025-08-07",
        status: "completed",
        usage: { inputTokens: 1_000, outputTokens: 100, cacheWriteInputTokens: 40 },
        latencyMs: 20,
        estimatedCostUsd: 0.0014,
      }],
    }));

    expect(record).toMatchObject({
      estimatedCostMicrousd: 1_400,
      ...expected,
      usage: { reasoningTokens: 60 },
    });
    expect(withReceipt.callReceipts[0]).toMatchObject({
      ...expected,
      usage: { cacheWriteInputTokens: 40 },
    });
    expect(withReceipt.usage).toMatchObject({ cacheWriteInputTokens: 40 });
  });

  it("names no price for a cost it does not know", async () => {
    const record = await recordAiUsage(usageInput({}));

    expect(record.estimatedCostMicrousd).toBeUndefined();
    expect(record).not.toHaveProperty("pricingSource");
    expect(record).not.toHaveProperty("pricingVersion");
  });
});
