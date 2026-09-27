import { describe, expect, it } from "vitest";
import {
  anthropicModelCapabilities,
  claudeMaxTokens,
  claudeModelInBedrockId,
} from "@/lib/models/anthropic-capabilities";

describe("Claude effort and thinking capabilities", () => {
  it.each([
    ["claude-fable-5-1", ["low", "medium", "high", "xhigh", "max"], true],
    ["claude-mythos-5-1", ["low", "medium", "high", "xhigh", "max"], true],
    ["claude-fable-5", ["low", "medium", "high", "xhigh", "max"], true],
    ["claude-mythos-5", ["low", "medium", "high", "xhigh", "max"], true],
    ["claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"], true],
    ["claude-opus-5", ["low", "medium", "high", "xhigh", "max"], true],
    ["claude-sonnet-5", ["low", "medium", "high", "xhigh", "max"], true],
    ["claude-mythos-preview", ["low", "medium", "high", "max"], true],
    ["claude-opus-4-8", ["low", "medium", "high", "xhigh", "max"], false],
    ["claude-opus-4-7", ["low", "medium", "high", "xhigh", "max"], false],
    ["claude-opus-4-6", ["low", "medium", "high", "max"], false],
    ["claude-sonnet-4-6", ["low", "medium", "high", "max"], false],
    ["claude-opus-4-5-20251101", ["low", "medium", "high"], false],
    ["claude-opus-4-5", ["low", "medium", "high"], false],
    [" Claude-Opus-5-5 ", ["low", "medium", "high", "xhigh", "max"], true],
  ])("lists the efforts %s accepts and whether it thinks by default", (model, efforts, thinks) => {
    expect(anthropicModelCapabilities(model)).toMatchObject({
      efforts,
      thinksByDefault: thinks,
    });
  });

  it.each([
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-1",
    "claude-3-7-sonnet-20250219",
    "claude-opus-5-5-20260101",
    "claude-opus-6",
    "constructor",
    "__proto__",
    "",
  ])("gives %s no effort and no thinking allowance", (model) => {
    expect(anthropicModelCapabilities(model)).toMatchObject({
      efforts: [],
      thinksByDefault: false,
    });
  });
});

describe("Claude reply size", () => {
  it.each([
    ["low", 6_000],
    ["medium", 10_000],
    ["high", 18_000],
    [undefined, 18_000],
    ["xhigh", 21_333],
    ["max", 21_333],
  ] as const)("adds room to think at %s effort to a 2,000-token answer", (effort, maxTokens) => {
    expect(claudeMaxTokens("claude-opus-5-5", 2_000, effort)).toBe(maxTokens);
  });

  it("keeps a request that streams no further than the SDK limit", () => {
    expect(claudeMaxTokens("claude-sonnet-5", 16_000, "low")).toBe(20_000);
    expect(claudeMaxTokens("claude-sonnet-5", 16_000, "medium")).toBe(21_333);
  });

  it.each(["claude-opus-4-8", "claude-sonnet-4-5", "claude-test"])(
    "keeps the answer budget for %s, which does not think by default",
    (model) => {
      expect(claudeMaxTokens(model, 3_000, "max")).toBe(3_000);
    },
  );
});

describe("Claude model ids on Amazon Bedrock", () => {
  it.each([
    ["anthropic.claude-opus-5-5", "claude-opus-5-5"],
    ["us.anthropic.claude-opus-5-5", "claude-opus-5-5"],
    ["global.anthropic.claude-sonnet-5", "claude-sonnet-5"],
    ["anthropic.claude-opus-5-5-v1", "claude-opus-5-5"],
    ["anthropic.claude-opus-4-5-20251101-v1:0", "claude-opus-4-5-20251101"],
    ["eu.anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-3-5-sonnet-20241022"],
    [
      "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5-5",
      "claude-opus-5-5",
    ],
    [
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-fable-5-1",
      "claude-fable-5-1",
    ],
    [" US.Anthropic.Claude-Opus-5-5 ", "claude-opus-5-5"],
  ])("finds the Claude model in %s", (modelId, claude) => {
    expect(claudeModelInBedrockId(modelId)).toBe(claude);
  });

  it.each([
    "amazon.nova-lite-v1:0",
    "meta.llama3-70b-instruct-v1:0",
    "notanthropic.claude-opus-5-5",
    "anthropic.titan-text",
    "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4",
  ])("finds no Claude model in %s", (modelId) => {
    expect(claudeModelInBedrockId(modelId)).toBeUndefined();
  });
});
