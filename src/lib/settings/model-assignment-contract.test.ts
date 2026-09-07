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
    expect(modelSupportsAssignmentRole("embeddings", "openai", {
      capabilities: ["embeddings"],
    })).toBe(true);
    expect(modelSupportsAssignmentRole("audio", "openai", {
      capabilities: ["speech"],
    })).toBe(false);
    expect(modelSupportsAssignmentRole("audio", "openai", {
      capabilities: ["transcription"],
    })).toBe(true);
  });

  it("exposes fallback only where the runtime executes and receipts attempts", () => {
    expect(modelAssignmentRoleSupportsFallback("main_agent")).toBe(true);
    expect(modelAssignmentRoleSupportsFallback("verifier")).toBe(true);
    expect(modelAssignmentRoleSupportsFallback("embeddings")).toBe(false);
    expect(modelAssignmentRoleSupportsFallback("vision")).toBe(false);
    expect(modelAssignmentRoleSupportsFallback("audio")).toBe(false);
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
