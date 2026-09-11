import { describe, expect, it } from "vitest";

import {
  MODEL_ASSIGNMENT_CONTRACT_VERSION,
  modelAssignmentConfigurationSha256,
  modelAssignmentRoleSupportsFallback,
  modelSupportsAssignmentRole,
} from "@/lib/settings/model-assignment-contract";

describe("functional model assignment contract", () => {
  it("admits only provider and capability combinations backed by a runtime", () => {
    expect(modelSupportsAssignmentRole("planner", "openai", {
      capabilities: ["text", "tools"],
    })).toBe(true);
    expect(modelSupportsAssignmentRole("planner", "google", {
      capabilities: ["text", "tools"],
    })).toBe(false);
    expect(modelSupportsAssignmentRole("market_research", "google", {
      capabilities: ["text"],
    })).toBe(true);
    expect(modelSupportsAssignmentRole("embeddings", "openai", {
      capabilities: ["embeddings"],
    })).toBe(true);
    expect(modelSupportsAssignmentRole("audio", "openai", {
      capabilities: ["speech"],
    })).toBe(false);
    expect(modelSupportsAssignmentRole("audio", "openai", {
      capabilities: ["transcription"],
    })).toBe(true);
    expect(modelSupportsAssignmentRole("audio", "google", {
      capabilities: ["audio", "transcription"],
    })).toBe(true);
    expect(modelSupportsAssignmentRole("image_generation", "google", {
      capabilities: ["image"],
    })).toBe(true);
    expect(modelSupportsAssignmentRole("image_generation", "openai", {
      capabilities: ["image"],
    })).toBe(true);
    expect(modelSupportsAssignmentRole("video_generation", "google", {
      capabilities: ["video"],
    })).toBe(true);
    expect(modelSupportsAssignmentRole("video_generation", "openai", {
      capabilities: ["video"],
    })).toBe(false);
    expect(modelSupportsAssignmentRole("computer_use", "openai", {
      capabilities: ["computer_use"],
    })).toBe(true);
    expect(modelSupportsAssignmentRole("web_search", "anthropic", {
      capabilities: ["text", "tools"],
    })).toBe(false);
  });

  it("exposes fallback only where the runtime executes and receipts attempts", () => {
    expect(modelAssignmentRoleSupportsFallback("main_agent")).toBe(true);
    expect(modelAssignmentRoleSupportsFallback("verifier")).toBe(true);
    expect(modelAssignmentRoleSupportsFallback("market_research")).toBe(true);
    expect(modelAssignmentRoleSupportsFallback("embeddings")).toBe(false);
    expect(modelAssignmentRoleSupportsFallback("vision")).toBe(false);
    expect(modelAssignmentRoleSupportsFallback("audio")).toBe(false);
    expect(modelAssignmentRoleSupportsFallback("audio_diarization")).toBe(false);
    expect(modelAssignmentRoleSupportsFallback("web_search")).toBe(false);
    expect(modelAssignmentRoleSupportsFallback("image_generation")).toBe(false);
    expect(modelAssignmentRoleSupportsFallback("video_generation")).toBe(false);
    expect(modelAssignmentRoleSupportsFallback("computer_use")).toBe(false);
    expect(modelAssignmentRoleSupportsFallback("speech_synthesis")).toBe(false);
    expect(modelAssignmentRoleSupportsFallback("realtime_transcription")).toBe(false);
  });

  it("binds activation identity, revision, and validation time into the digest", () => {
    const base = {
      scope: "planner" as const,
      provider: "openai" as const,
      modelId: "gpt-5.2",
      allowCrossProviderFallback: false,
      revision: 3,
      validatedAt: "2026-09-07T12:00:00.000Z",
    };
    const digest = modelAssignmentConfigurationSha256(base);
    expect(MODEL_ASSIGNMENT_CONTRACT_VERSION).toBe(
      "p11.8-model-assignment:1",
    );
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(modelAssignmentConfigurationSha256(base)).toBe(digest);
    expect(modelAssignmentConfigurationSha256({
      ...base,
      revision: 4,
    })).not.toBe(digest);
    expect(modelAssignmentConfigurationSha256({
      ...base,
      modelId: "gpt-5.4",
    })).not.toBe(digest);
  });
});
