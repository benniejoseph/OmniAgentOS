import { describe, expect, it } from "vitest";
import {
  commandReasoningOptionsForModel,
  modelReasoningEfforts,
  openAIMaxOutputTokens,
  resolveModelReasoningEffort,
} from "@/lib/models/reasoning-effort";

describe("reasoning effort by provider and model", () => {
  it("offers Claude models the effort levels they accept", () => {
    expect(modelReasoningEfforts("anthropic", "claude-opus-5-5"))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(modelReasoningEfforts("anthropic", "claude-opus-4-6"))
      .toEqual(["low", "medium", "high", "max"]);
    expect(modelReasoningEfforts("anthropic", "claude-sonnet-4-5")).toEqual([]);
  });

  it("offers no effort for a Claude model reached through another provider", () => {
    expect(modelReasoningEfforts("aws_bedrock", "claude-opus-5-5")).toEqual([]);
    expect(modelReasoningEfforts("google", "claude-opus-5-5")).toEqual([]);
    expect(modelReasoningEfforts("openai", "claude-opus-5-5")).toEqual([]);
  });

  it("shows Command only the Claude levels the model accepts", () => {
    expect(commandReasoningOptionsForModel("anthropic", "claude-mythos-preview"))
      .toEqual([
        { id: "low", label: "Low", nativeEffort: "low" },
        { id: "medium", label: "Medium", nativeEffort: "medium" },
        { id: "high", label: "High", nativeEffort: "high" },
        { id: "ultra", label: "Ultra", nativeEffort: "max" },
      ]);
    expect(commandReasoningOptionsForModel("anthropic", "claude-opus-4-5")
      .map((option) => option.id)).toEqual(["low", "medium", "high"]);
    expect(commandReasoningOptionsForModel("anthropic", "claude-haiku-4-5"))
      .toEqual([]);
  });

  it("uses the nearest level a Claude model accepts at or below the one asked for", () => {
    expect(resolveModelReasoningEffort("anthropic", "claude-opus-5-5", "xhigh"))
      .toBe("xhigh");
    expect(resolveModelReasoningEffort("anthropic", "claude-mythos-preview", "xhigh"))
      .toBe("high");
    expect(resolveModelReasoningEffort("anthropic", "claude-opus-4-5", "max"))
      .toBe("high");
    expect(resolveModelReasoningEffort("anthropic", "claude-opus-5-5", "minimal"))
      .toBe("low");
    expect(resolveModelReasoningEffort("anthropic", "claude-opus-5-5")).toBe("low");
    expect(resolveModelReasoningEffort("anthropic", "claude-sonnet-4-5", "high"))
      .toBeUndefined();
  });

  it.each([
    ["gpt-5", ["minimal", "low", "medium", "high"]],
    ["gpt-5-mini", ["minimal", "low", "medium", "high"]],
    ["gpt-5-2025-08-07", ["minimal", "low", "medium", "high"]],
    ["gpt-5.1", ["low", "medium", "high"]],
    ["gpt-5.1-codex", ["low", "medium", "high"]],
    ["gpt-5.2", ["low", "medium", "high", "xhigh"]],
    ["GPT-5.5", ["low", "medium", "high", "xhigh"]],
    ["gpt-5.6", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.10", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-6", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
    ["o3", ["low", "medium", "high"]],
    ["o4-mini", ["low", "medium", "high"]],
    ["gpt-50", []],
    ["gpt-4o-mini", []],
    ["ogpt-5", []],
  ] as const)("offers %s the OpenAI levels it accepts", (model, efforts) => {
    expect(modelReasoningEfforts("openai", model)).toEqual(efforts);
  });

  it("uses the nearest level an OpenAI model accepts at or below the one asked for", () => {
    expect(resolveModelReasoningEffort("openai", "gpt-5", "minimal")).toBe("minimal");
    expect(resolveModelReasoningEffort("openai", "gpt-5", "max")).toBe("high");
    expect(resolveModelReasoningEffort("openai", "gpt-5.5", "minimal")).toBe("low");
    expect(resolveModelReasoningEffort("openai", "gpt-5.5", "xhigh")).toBe("xhigh");
    expect(resolveModelReasoningEffort("openai", "gpt-5.5", "max")).toBe("xhigh");
    expect(resolveModelReasoningEffort("openai", "gpt-5.1", "xhigh")).toBe("high");
    expect(resolveModelReasoningEffort("openai", "gpt-5.6", "max")).toBe("max");
    expect(resolveModelReasoningEffort("openai", "gpt-5.2", "medium")).toBe("medium");
    expect(resolveModelReasoningEffort("openai", "gpt-5-mini")).toBe("minimal");
    expect(resolveModelReasoningEffort("openai", "gpt-5.5")).toBe("low");
    expect(resolveModelReasoningEffort("openai", "gpt-4o-mini", "high"))
      .toBeUndefined();
  });

  it("shows Command the OpenAI levels each model accepts", () => {
    expect(commandReasoningOptionsForModel("openai", "gpt-5.5")
      .map((option) => option.id)).toEqual(["low", "medium", "high", "extra_high"]);
    expect(commandReasoningOptionsForModel("openai", "gpt-5")
      .map((option) => option.id)).toEqual(["low", "medium", "high"]);
    expect(commandReasoningOptionsForModel("openai", "gpt-5.6")
      .map((option) => option.id))
      .toEqual(["low", "medium", "high", "extra_high", "ultra"]);
  });

  it.each([
    [2_000, "minimal", 2_000],
    [2_000, "low", 6_000],
    [2_000, "medium", 10_000],
    [2_000, "high", 18_000],
    [2_000, "xhigh", 27_000],
    [3_000, "max", 28_000],
    [2_000, undefined, 2_000],
  ] as const)(
    "gives an OpenAI answer of %i tokens at %s effort room to reason",
    (answerTokens, effort, sent) => {
      expect(openAIMaxOutputTokens(answerTokens, effort)).toBe(sent);
    },
  );
});
