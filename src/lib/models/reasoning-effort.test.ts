import { describe, expect, it } from "vitest";
import {
  commandReasoningOptionsForModel,
  modelReasoningEfforts,
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

  it("falls back to the least intensive level a Claude model accepts", () => {
    expect(resolveModelReasoningEffort("anthropic", "claude-opus-5-5", "xhigh"))
      .toBe("xhigh");
    expect(resolveModelReasoningEffort("anthropic", "claude-mythos-preview", "xhigh"))
      .toBe("low");
    expect(resolveModelReasoningEffort("anthropic", "claude-opus-5-5", "minimal"))
      .toBe("low");
    expect(resolveModelReasoningEffort("anthropic", "claude-opus-5-5")).toBe("low");
    expect(resolveModelReasoningEffort("anthropic", "claude-sonnet-4-5", "high"))
      .toBeUndefined();
  });

  it("keeps the OpenAI levels", () => {
    expect(modelReasoningEfforts("openai", "gpt-5-mini"))
      .toEqual(["minimal", "low", "medium", "high"]);
    expect(modelReasoningEfforts("openai", "gpt-6"))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(modelReasoningEfforts("openai", "o3")).toEqual(["low", "medium", "high"]);
  });
});
