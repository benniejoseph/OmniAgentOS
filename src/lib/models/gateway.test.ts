import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openAI = vi.hoisted(() => ({ configured: vi.fn(), targets: vi.fn(), generateText: vi.fn(), generateStructured: vi.fn(), generateToolTurn: vi.fn() }));
const google = vi.hoisted(() => ({ configured: vi.fn(), targets: vi.fn(), generateText: vi.fn(), generateToolTurn: vi.fn() }));
const anthropic = vi.hoisted(() => ({ configured: vi.fn(), targets: vi.fn(), generateText: vi.fn(), generateStructured: vi.fn(), generateToolTurn: vi.fn() }));

vi.mock("@/lib/models/adapters/openai", () => ({
  openAIModelAdapter: adapter("openai", openAI, ["text", "json_schema", "tools"]),
}));
vi.mock("@/lib/models/adapters/google", () => ({
  googleModelAdapter: adapter("google", google, ["text", "tools"]),
}));
vi.mock("@/lib/models/adapters/anthropic", () => ({
  anthropicModelAdapter: adapter("anthropic", anthropic, ["text", "json_schema", "tools"]),
}));

import { generateModelStructured, generateModelText, generateModelToolTurn } from "@/lib/models/gateway";

beforeEach(() => {
  openAI.configured.mockReturnValue(false);
  google.configured.mockReturnValue(false);
  anthropic.configured.mockReturnValue(false);
  openAI.targets.mockReturnValue([target("openai", "openai-model", ["text", "json_schema", "tools"])]);
  google.targets.mockReturnValue([target("google", "google-model", ["text", "tools"])]);
  anthropic.targets.mockReturnValue([target("anthropic", "anthropic-model", ["text", "json_schema", "tools"])]);
});

afterEach(() => {
  vi.resetAllMocks();
  delete process.env.OMNIAGENT_MODEL_PROVIDER_ORDER;
});

describe("model gateway", () => {
  it("filters unavailable providers and routes by required capability", async () => {
    openAI.configured.mockReturnValue(false);
    google.configured.mockReturnValue(true);
    anthropic.configured.mockReturnValue(true);
    anthropic.generateStructured.mockResolvedValue(result("anthropic"));
    const generated = await generateModelStructured({
      input: "classify",
      instructions: "Return JSON",
      name: "classification",
      schema: { type: "object" },
    });
    expect(generated.provider).toBe("anthropic");
    expect(google.generateText).not.toHaveBeenCalled();
  });

  it("does not cross providers by default after a retryable failure", async () => {
    process.env.OMNIAGENT_MODEL_PROVIDER_ORDER = "google,openai";
    google.configured.mockReturnValue(true);
    openAI.configured.mockReturnValue(true);
    anthropic.configured.mockReturnValue(false);
    google.generateText.mockRejectedValue(Object.assign(new Error("temporarily unavailable"), { status: 503 }));
    openAI.generateText.mockResolvedValue(result("openai"));
    await expect(generateModelText({ input: "private context" })).rejects.toMatchObject({
      provider: "google",
      retryable: true,
    });
    expect(openAI.generateText).not.toHaveBeenCalled();
  });

  it("treats an explicit preferred provider as a boundary by default", async () => {
    openAI.configured.mockReturnValue(true);
    google.configured.mockReturnValue(false);
    await expect(generateModelText({
      input: "private context",
      preferredProvider: "google",
    })).rejects.toMatchObject({
      provider: "google",
      kind: "unavailable",
    });
    expect(openAI.generateText).not.toHaveBeenCalled();
  });

  it("crosses providers only when the request explicitly opts in", async () => {
    process.env.OMNIAGENT_MODEL_PROVIDER_ORDER = "google,openai";
    google.configured.mockReturnValue(true);
    openAI.configured.mockReturnValue(true);
    google.generateText.mockRejectedValue(Object.assign(new Error("temporarily unavailable"), { status: 503 }));
    openAI.generateText.mockResolvedValue(result("openai"));
    const generated = await generateModelText({
      input: "hello",
      allowCrossProviderFallback: true,
    });
    expect(generated.provider).toBe("openai");
    expect(generated.attempts.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
  });

  it("never routes outside the request provider allowlist", async () => {
    process.env.OMNIAGENT_MODEL_PROVIDER_ORDER = "google,openai";
    google.configured.mockReturnValue(true);
    openAI.configured.mockReturnValue(true);
    google.generateText.mockResolvedValue(result("google"));
    openAI.generateText.mockResolvedValue(result("openai"));
    const generated = await generateModelText({
      input: "private context",
      allowedProviders: ["openai"],
      allowCrossProviderFallback: true,
    });
    expect(generated.provider).toBe("openai");
    expect(google.generateText).not.toHaveBeenCalled();
  });

  it("retries another target from the same provider without cross-provider consent", async () => {
    openAI.configured.mockReturnValue(true);
    google.configured.mockReturnValue(true);
    openAI.targets.mockReturnValue([
      target("openai", "openai-primary", ["text"]),
      target("openai", "openai-backup", ["text"]),
    ]);
    openAI.generateText
      .mockRejectedValueOnce(Object.assign(new Error("temporarily unavailable"), { status: 503 }))
      .mockResolvedValueOnce(result("openai", "openai-backup"));
    const generated = await generateModelText({
      input: "private context",
      preferredProvider: "openai",
    });
    expect(generated.model).toBe("openai-backup");
    expect(generated.attempts.map((attempt) => attempt.provider)).toEqual(["openai", "openai"]);
    expect(google.generateText).not.toHaveBeenCalled();
  });

  it("never starts a fallback outside the caller's attempt budget", async () => {
    openAI.configured.mockReturnValue(true);
    openAI.targets.mockReturnValue([
      target("openai", "openai-primary", ["text"]),
      target("openai", "openai-backup", ["text"]),
    ]);
    openAI.generateText.mockRejectedValue(
      Object.assign(new Error("temporarily unavailable"), { status: 503 }),
    );

    await expect(generateModelText({
      input: "bounded private context",
      preferredProvider: "openai",
      maxAttempts: 1,
    })).rejects.toMatchObject({ provider: "openai", retryable: true });
    expect(openAI.generateText).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on invalid or safety failures", async () => {
    process.env.OMNIAGENT_MODEL_PROVIDER_ORDER = "google,openai";
    google.configured.mockReturnValue(true);
    openAI.configured.mockReturnValue(true);
    anthropic.configured.mockReturnValue(false);
    google.generateText.mockRejectedValue(Object.assign(new Error("invalid request"), { status: 400 }));
    await expect(generateModelText({ input: "hello" })).rejects.toMatchObject({ kind: "invalid_request" });
    expect(openAI.generateText).not.toHaveBeenCalled();
  });

  it("keeps governed tool turns on their explicitly selected provider", async () => {
    google.configured.mockReturnValue(true);
    openAI.configured.mockReturnValue(true);
    google.generateToolTurn.mockRejectedValue(
      Object.assign(new Error("temporarily unavailable"), { status: 503 }),
    );
    openAI.generateToolTurn.mockResolvedValue(toolTurnResult("openai"));

    await expect(generateModelToolTurn({
      input: "private context",
      preferredProvider: "google",
      allowCrossProviderFallback: true,
      tools: [],
    })).rejects.toMatchObject({ provider: "google", retryable: true });
    expect(openAI.generateToolTurn).not.toHaveBeenCalled();
  });

  it("sanitizes bounded tool metadata and results before adapter disclosure", async () => {
    google.configured.mockReturnValue(true);
    google.generateToolTurn.mockResolvedValue(toolTurnResult("google"));
    await generateModelToolTurn({
      input: "use a tool",
      preferredProvider: "google",
      tools: [{
        type: "function",
        name: "safe_tool",
        description: `line\n${"x".repeat(2_000)}`,
        parameters: { type: "object" },
      }],
      toolResults: [{
        callId: "call-1",
        name: "safe_tool",
        output: "y".repeat(9_000),
      }],
    });

    const disclosed = google.generateToolTurn.mock.calls[0][0];
    expect(disclosed.allowedProviders).toEqual(["google"]);
    expect(disclosed.allowCrossProviderFallback).toBe(false);
    expect(disclosed.tools[0].description).not.toContain("\n");
    expect(disclosed.tools[0].description).toHaveLength(1_000);
    expect(disclosed.toolResults[0].output).toHaveLength(8_000);
  });

  it("rejects opaque continuation state from another provider", async () => {
    google.configured.mockReturnValue(true);
    await expect(generateModelToolTurn({
      input: "continue",
      preferredProvider: "google",
      tools: [],
      continuation: { provider: "anthropic", state: [] },
    })).rejects.toMatchObject({
      provider: "google",
      kind: "invalid_request",
      retryable: false,
    });
    expect(google.generateToolTurn).not.toHaveBeenCalled();
  });

  it("rejects new provider continuations without a canonical replay transcript", async () => {
    google.configured.mockReturnValue(true);
    google.generateToolTurn.mockResolvedValue({
      ...result("google"),
      toolCalls: [],
      continuation: { provider: "google", state: [] },
    });

    await expect(generateModelToolTurn({
      input: "continue safely",
      preferredProvider: "google",
      tools: [],
    })).rejects.toMatchObject({
      provider: "google",
      kind: "invalid_request",
      retryable: false,
    });
  });

  it("rejects unlabeled observations before provider disclosure", async () => {
    google.configured.mockReturnValue(true);

    await expect(generateModelToolTurn({
      input: "summarize",
      preferredProvider: "google",
      tools: [],
      conversation: [{
        type: "observation",
        source: "web",
        content: "untrusted",
      } as never],
    })).rejects.toMatchObject({
      provider: "google",
      kind: "invalid_request",
    });
    expect(google.generateToolTurn).not.toHaveBeenCalled();
  });
});

function adapter(id: "openai" | "google" | "anthropic", mock: Record<string, ReturnType<typeof vi.fn>>, features: string[]) {
  return {
    id,
    configured: mock.configured,
    targets: (tier: "fast" | "reasoning") =>
      mock.targets(tier) || [{ provider: id, model: `${id}-model`, tier, features }],
    generateText: mock.generateText,
    generateStructured: mock.generateStructured,
    generateToolTurn: mock.generateToolTurn,
    classifyError(error: unknown) {
      const candidate = error as {
        status?: number;
        message?: string;
        provider?: string;
        kind?: string;
        retryable?: boolean;
      };
      if (
        candidate.provider === id &&
        typeof candidate.kind === "string" &&
        typeof candidate.retryable === "boolean"
      ) return error;
      const retryable = candidate.status === 429 || Number(candidate.status) >= 500;
      return Object.assign(new Error(candidate.message || "failed"), {
        provider: id,
        kind: candidate.status === 400 ? "invalid_request" : retryable ? "unavailable" : "unknown",
        retryable,
      });
    },
  };
}

function target(
  provider: "openai" | "google" | "anthropic",
  model: string,
  features: Array<"text" | "json_schema" | "tools">,
) {
  return { provider, model, tier: "fast", features };
}

function toolTurnResult(provider: "openai" | "google" | "anthropic") {
  return {
    ...result(provider),
    toolCalls: [],
    continuation: {
      provider,
      state: [],
      conversation: [{
        type: "message" as const,
        role: "assistant" as const,
        content: "ok",
      }],
    },
  };
}

function result(provider: "openai" | "google" | "anthropic", model = `${provider}-model`) {
  return {
    text: "ok",
    provider,
    model,
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
    latencyMs: 10,
    costKnown: false,
  };
}
