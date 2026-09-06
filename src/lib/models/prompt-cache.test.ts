import { afterEach, describe, expect, it, vi } from "vitest";
import {
  promptCacheKeyForScope,
  supportsBedrockPromptCache,
} from "@/lib/models/prompt-cache";

const scope = {
  tenantId: "tenant-private",
  actorId: "actor-private",
  sourceStreamId: "run:private",
  operation: "tool_turn" as const,
  purpose: "agent.turn",
};

describe("provider prompt caching", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("creates a stable content-free key scoped to one tenant run", () => {
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "prompt-cache-test-secret");
    const first = promptCacheKeyForScope(scope);
    const second = promptCacheKeyForScope(scope);
    const otherRun = promptCacheKeyForScope({
      ...scope,
      sourceStreamId: "run:other",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^asael-pc-v1-[A-Za-z0-9_-]{43}$/);
    expect(otherRun).not.toBe(first);
    expect(first).not.toContain(scope.tenantId);
    expect(first).not.toContain(scope.actorId);
    expect(first).not.toContain(scope.sourceStreamId);
  });

  it("omits a cache key when no server secret or scope is available", () => {
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "");
    expect(promptCacheKeyForScope(scope)).toBeUndefined();
    expect(promptCacheKeyForScope(undefined)).toBeUndefined();
  });

  it("recognizes only documented Bedrock cache-capable model families", () => {
    expect(supportsBedrockPromptCache("amazon.nova-lite-v1:0")).toBe(true);
    expect(supportsBedrockPromptCache(
      "us.anthropic.claude-sonnet-4-6-v1:0",
    )).toBe(true);
    expect(supportsBedrockPromptCache(
      "anthropic.claude-3-5-sonnet-20240620-v1:0",
    )).toBe(false);
    expect(supportsBedrockPromptCache("cohere.command-r-v1:0")).toBe(false);
  });
});
