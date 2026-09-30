import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openAI = vi.hoisted(() => ({ configured: vi.fn(), targets: vi.fn(), generateText: vi.fn(), generateStructured: vi.fn(), generateToolTurn: vi.fn() }));
const google = vi.hoisted(() => ({ configured: vi.fn(), targets: vi.fn(), generateText: vi.fn(), generateToolTurn: vi.fn() }));
const anthropic = vi.hoisted(() => ({ configured: vi.fn(), targets: vi.fn(), generateText: vi.fn(), generateStructured: vi.fn(), generateToolTurn: vi.fn() }));

vi.mock("@/lib/models/adapters/openai", () => ({
  openAIModelAdapter: adapter("openai", openAI, ["text", "json_schema", "tools", "vision"]),
}));
vi.mock("@/lib/models/adapters/google", () => ({
  googleModelAdapter: adapter("google", google, ["text", "tools"]),
}));
vi.mock("@/lib/models/adapters/anthropic", () => ({
  anthropicModelAdapter: adapter("anthropic", anthropic, ["text", "json_schema", "tools"]),
}));

import { generateModelStructured, generateModelText, generateModelToolTurn } from "@/lib/models/gateway";
import { attachModelProviderResponseReceipt } from "@/lib/models/types";

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

  it("adds a failed attempt's billed tokens to the call's usage", async () => {
    openAI.configured.mockReturnValue(true);
    openAI.targets.mockReturnValue([
      target("openai", "openai-primary", ["text"]),
      target("openai", "openai-backup", ["text"]),
    ]);
    openAI.generateText
      .mockRejectedValueOnce(attachModelProviderResponseReceipt(
        Object.assign(new Error("temporarily unavailable"), { status: 503 }),
        {
          latencyMs: 5,
          usage: {
            inputTokens: 5,
            outputTokens: 3,
            cachedInputTokens: 2,
            totalTokens: 8,
            cacheWriteInputTokens: 1,
            reasoningTokens: 2,
          },
        },
      ))
      .mockResolvedValueOnce(result("openai", "openai-backup"));

    const generated = await generateModelText({
      input: "private context",
      preferredProvider: "openai",
    });

    expect(generated.usage).toEqual({
      inputTokens: 6,
      outputTokens: 4,
      cachedInputTokens: 2,
      totalTokens: 10,
      cacheWriteInputTokens: 1,
      reasoningTokens: 2,
    });
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

  it("asks the caller before each fallback and ends the call when it declines", async () => {
    openAI.configured.mockReturnValue(true);
    openAI.targets.mockReturnValue([
      target("openai", "openai-primary", ["text"]),
      target("openai", "openai-backup", ["text"]),
      target("openai", "openai-last", ["text"]),
    ]);
    const outage = () =>
      Object.assign(new Error("primary unavailable"), { status: 503 });
    const call = (beforeRetry: () => Promise<boolean>) => generateModelText({
      input: "bounded private context",
      preferredProvider: "openai",
      beforeRetry,
    });

    const allow = vi.fn(async () => true);
    openAI.generateText
      .mockRejectedValueOnce(outage())
      .mockRejectedValueOnce(outage())
      .mockResolvedValueOnce(result("openai", "openai-last"));
    await expect(call(allow)).resolves.toMatchObject({ model: "openai-last" });
    expect(allow).toHaveBeenCalledTimes(2);
    expect(openAI.generateText).toHaveBeenCalledTimes(3);

    for (const decline of [
      vi.fn(async () => false),
      vi.fn(async (): Promise<boolean> => {
        throw new Error("budget store unavailable");
      }),
    ]) {
      openAI.generateText.mockReset();
      openAI.generateText
        .mockRejectedValueOnce(outage())
        .mockResolvedValue(result("openai", "openai-backup"));
      await expect(call(decline)).rejects.toMatchObject({
        message: "primary unavailable",
        provider: "openai",
        retryable: true,
        attempts: [{ model: "openai-primary", status: "failed" }],
      });
      expect(decline).toHaveBeenCalledTimes(1);
      expect(openAI.generateText).toHaveBeenCalledTimes(1);
    }
  });

  it("does not ask about a fallback it would not make", async () => {
    openAI.configured.mockReturnValue(true);
    openAI.targets.mockReturnValue([
      target("openai", "openai-primary", ["text"]),
      target("openai", "openai-backup", ["text"]),
    ]);
    const beforeRetry = vi.fn(async () => true);
    const call = (maxAttempts?: number) => generateModelText({
      input: "bounded private context",
      preferredProvider: "openai",
      maxAttempts,
      beforeRetry,
    });

    openAI.generateText.mockResolvedValueOnce(result("openai", "openai-primary"));
    await expect(call()).resolves.toMatchObject({ model: "openai-primary" });
    openAI.generateText.mockRejectedValueOnce(
      Object.assign(new Error("invalid request"), { status: 400 }),
    );
    await expect(call()).rejects.toMatchObject({ kind: "invalid_request" });
    openAI.generateText.mockRejectedValueOnce(
      Object.assign(new Error("primary unavailable"), { status: 503 }),
    );
    await expect(call(1)).rejects.toMatchObject({ retryable: true });

    expect(openAI.generateText).toHaveBeenCalledTimes(3);
    expect(beforeRetry).not.toHaveBeenCalled();
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

  it("passes every tool result to the adapter, including skipped calls", async () => {
    anthropic.configured.mockReturnValue(true);
    anthropic.generateToolTurn.mockResolvedValue(toolTurnResult("anthropic"));
    const toolResults = Array.from({ length: 6 }, (_, index) => ({
      callId: `toolu_${index + 1}`,
      name: "safe_tool",
      output: index < 5
        ? `result ${index + 1}`
        : "{\"error\":\"Per-turn tool call limit reached; call skipped.\"}",
      ...(index < 5 ? {} : { isError: true }),
    }));

    await generateModelToolTurn({
      input: "use six tools",
      preferredProvider: "anthropic",
      tools: [],
      toolResults,
    });

    expect(anthropic.generateToolTurn.mock.calls[0][0].toolResults).toEqual(toolResults);
  });

  it("discloses local computer images only to targets advertising vision", async () => {
    google.configured.mockReturnValue(true);
    google.generateToolTurn.mockResolvedValue(toolTurnResult("google"));
    const computerObservation = modelComputerObservation();
    google.targets.mockReturnValue([
      target("google", "text-tool-model", ["text", "tools"]),
    ]);

    await generateModelToolTurn({
      input: "inspect the page",
      preferredProvider: "google",
      tools: [],
      toolResults: [{
        callId: "call-computer",
        name: "local_macos_click",
        output: "clicked",
        computerObservation,
      }],
    });
    expect(google.generateToolTurn.mock.calls[0][0].toolResults[0])
      .not.toHaveProperty("computerObservation.screenshot");
    expect(google.generateToolTurn.mock.calls[0][0].toolResults[0])
      .toHaveProperty("computerObservation.accessibilitySnapshot");

    google.generateToolTurn.mockClear();
    google.targets.mockReturnValue([
      target("google", "vision-tool-model", ["text", "tools", "vision"]),
    ]);
    await generateModelToolTurn({
      input: "inspect the page",
      preferredProvider: "google",
      tools: [],
      toolResults: [{
        callId: "call-computer",
        name: "local_macos_click",
        output: "clicked",
        computerObservation,
      }],
    });
    expect(google.generateToolTurn.mock.calls[0][0].toolResults[0])
      .toHaveProperty("computerObservation.screenshot.mimeType", "image/webp");
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

describe("the wait before a model call tries again", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    openAI.configured.mockReturnValue(true);
    openAI.targets.mockReturnValue([
      target("openai", "openai-primary", ["text"]),
      target("openai", "openai-backup", ["text"]),
      target("openai", "openai-last", ["text"]),
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const busy = (retryAfterMs?: number) => Object.assign(new Error("busy"), {
    provider: "openai",
    kind: "overloaded",
    retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

  /** Starts a call and records how it settles, so time can move meanwhile. */
  function start(request: Partial<Parameters<typeof generateModelText>[0]> = {}) {
    const call: { settled: boolean; value?: unknown; error?: unknown } = {
      settled: false,
    };
    generateModelText({
      input: "private context",
      preferredProvider: "openai",
      ...request,
    }).then(
      (value) => Object.assign(call, { settled: true, value }),
      (error: unknown) => Object.assign(call, { settled: true, error }),
    );
    return call;
  }

  const calls = () => openAI.generateText.mock.calls.length;

  it("waits a jittered backoff that doubles before each try", async () => {
    openAI.generateText
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce(result("openai", "openai-last"));

    const call = start();
    await vi.advanceTimersByTimeAsync(124);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(249);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(calls()).toBe(3);
    expect(call.value).toMatchObject({ model: "openai-last" });
  });

  it.each([
    ["as long as the provider asked", 3_000, 3_000],
    ["no longer than the cap", 60_000, 8_000],
    ["not at all when the provider asked for none", 0, 0],
  ])("waits %s", async (_, retryAfterMs, waitMs) => {
    openAI.generateText
      .mockRejectedValueOnce(busy(retryAfterMs))
      .mockResolvedValueOnce(result("openai", "openai-backup"));

    const call = start();
    if (waitMs) {
      await vi.advanceTimersByTimeAsync(waitMs - 1);
      expect(calls()).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(waitMs ? 1 : 0);

    expect(calls()).toBe(2);
    expect(call.value).toMatchObject({ model: "openai-backup" });
  });

  it("tries another provider without waiting", async () => {
    process.env.OMNIAGENT_MODEL_PROVIDER_ORDER = "openai,google";
    openAI.targets.mockReturnValue([target("openai", "openai-primary", ["text"])]);
    google.configured.mockReturnValue(true);
    openAI.generateText.mockRejectedValueOnce(busy(3_000));
    google.generateText.mockResolvedValueOnce(result("google"));

    const call = start({
      preferredProvider: undefined,
      allowCrossProviderFallback: true,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(call.value).toMatchObject({ provider: "google" });
  });

  it("stops waiting and lets go of the signal when the caller aborts", async () => {
    const caller = new AbortController();
    openAI.generateText.mockRejectedValueOnce(busy(3_000));

    const call = start({ abortSignal: caller.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.error).toMatchObject({ message: "busy", retryable: true });
    expect(calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait once the caller has aborted", async () => {
    const caller = new AbortController();
    openAI.generateText.mockRejectedValueOnce(busy(3_000));

    const call = start({
      abortSignal: caller.signal,
      beforeRetry: async () => {
        caller.abort();
        return true;
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(call.error).toMatchObject({ message: "busy" });
    expect(calls()).toBe(1);
  });

  it("lets go of the caller's signal once it has waited", async () => {
    const caller = new AbortController();
    const added = vi.spyOn(caller.signal, "addEventListener");
    const removed = vi.spyOn(caller.signal, "removeEventListener");
    openAI.generateText
      .mockRejectedValueOnce(busy(1_000))
      .mockResolvedValueOnce(result("openai", "openai-backup"));

    const call = start({ abortSignal: caller.signal });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(call.value).toMatchObject({ model: "openai-backup" });
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls).toEqual([["abort", added.mock.calls[0][1]]]);
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
  features: Array<"text" | "json_schema" | "tools" | "vision">,
) {
  return { provider, model, tier: "fast", features };
}

function modelComputerObservation() {
  return {
    schemaVersion: 1 as const,
    source: "local_macos" as const,
    trust: "untrusted_data" as const,
    executionId: "execution-local",
    operation: "local.macos.click",
    snapshotRevision: "a".repeat(64),
    pageState: { origin: "https://example.test", title: "Example" },
    accessibilitySnapshot: "- button \"Continue\" [ref=e7]",
    screenshot: {
      mimeType: "image/webp" as const,
      dataBase64: Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50,
      ]).toString("base64"),
    },
  };
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
