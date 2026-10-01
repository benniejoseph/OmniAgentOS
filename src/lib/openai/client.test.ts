import { afterEach, describe, expect, it, vi } from "vitest";

const openAiMocks = vi.hoisted(() => ({
  constructorOptions: vi.fn(),
  createEmbedding: vi.fn(),
  createResponse: vi.fn(),
  retrieveModel: vi.fn(),
  recordAiUsage: vi.fn(async () => undefined),
}));

vi.mock("@/lib/usage/ledger", () => ({
  recordAiUsageSafely: openAiMocks.recordAiUsage,
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    constructor(options: unknown) {
      openAiMocks.constructorOptions(options);
    }
    responses = { create: openAiMocks.createResponse };
    embeddings = { create: openAiMocks.createEmbedding };
    models = { retrieve: openAiMocks.retrieveModel };
  },
}));

const originalKey = process.env.OPENAI_API_KEY;
const originalGatewayUrl = process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
const originalGatewayToken = process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
const originalVercelEnvironment = process.env.VERCEL_ENV;
const gatewayToken = "b".repeat(64);

afterEach(() => {
  vi.resetModules();
  openAiMocks.constructorOptions.mockReset();
  openAiMocks.createEmbedding.mockReset();
  openAiMocks.createResponse.mockReset();
  openAiMocks.retrieveModel.mockReset();
  vi.useRealTimers();
  if (originalKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalKey;
  }
  restoreEnvironment(
    "OMNIAGENT_OPENAI_GATEWAY_URL",
    originalGatewayUrl,
  );
  restoreEnvironment(
    "OMNIAGENT_OPENAI_GATEWAY_TOKEN",
    originalGatewayToken,
  );
  restoreEnvironment("VERCEL_ENV", originalVercelEnvironment);
});

describe("OpenAI response privacy", () => {
  it("forces store=false even when a caller requests storage", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
    openAiMocks.createResponse.mockResolvedValue({});
    const { getOpenAIClient } = await import("@/lib/openai/client");
    const create = getOpenAIClient().responses.create as unknown as (
      body: Record<string, unknown>,
    ) => Promise<unknown>;

    await create({ model: "test-model", input: "private", store: true });

    expect(openAiMocks.constructorOptions).toHaveBeenCalledWith({
      apiKey: "test-key",
    });
    expect(openAiMocks.createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ store: false }),
      undefined,
    );
  });

  it("uses the gateway base and token without replacing upstream API auth", async () => {
    process.env.OPENAI_API_KEY = "upstream-api-key";
    process.env.OMNIAGENT_OPENAI_GATEWAY_URL =
      "https://gateway.asael.example/openai/";
    process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN = gatewayToken;
    const { getOpenAIClient } = await import("@/lib/openai/client");

    getOpenAIClient();

    expect(openAiMocks.constructorOptions).toHaveBeenCalledWith({
      apiKey: "upstream-api-key",
      baseURL: "https://gateway.asael.example/openai/v1",
      defaultHeaders: {
        "x-asael-gateway-token": gatewayToken,
      },
    });
  });

  it("tells only the gateway which work a call belongs to", async () => {
    process.env.OPENAI_API_KEY = "upstream-api-key";
    process.env.OMNIAGENT_OPENAI_GATEWAY_URL =
      "https://gateway.asael.example/openai/";
    process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN = gatewayToken;
    openAiMocks.createResponse.mockResolvedValue({});
    const { getOpenAIClient } = await import("@/lib/openai/client");
    const gateway = {
      apiKey: "upstream-api-key",
      baseURL: "https://gateway.asael.example/openai/v1",
    };

    const scoped = getOpenAIClient({ correlationId: "req:run-1.a_b-c" });
    await (scoped.responses.create as unknown as (
      body: Record<string, unknown>,
    ) => Promise<unknown>)({ model: "test-model", input: "private", store: true });
    // The gateway would not log these, so they are not sent at all.
    const shared = getOpenAIClient({ correlationId: "two words" });
    expect(getOpenAIClient({ correlationId: "a".repeat(129) })).toBe(shared);
    expect(getOpenAIClient({ correlationId: "a".repeat(128) })).not.toBe(shared);
    expect(getOpenAIClient()).toBe(shared);
    getOpenAIClient({ apiKey: "request-key", correlationId: "req-2" });

    expect(openAiMocks.constructorOptions.mock.calls.map(([options]) => options)).toEqual([
      {
        ...gateway,
        defaultHeaders: {
          "x-asael-gateway-token": gatewayToken,
          "x-omni-correlation-id": "req:run-1.a_b-c",
        },
      },
      { ...gateway, defaultHeaders: { "x-asael-gateway-token": gatewayToken } },
      {
        ...gateway,
        defaultHeaders: {
          "x-asael-gateway-token": gatewayToken,
          "x-omni-correlation-id": "a".repeat(128),
        },
      },
      { apiKey: "request-key" },
    ]);
    expect(openAiMocks.createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ store: false }),
      undefined,
    );
  });

  it("sends a turn's, a structured answer's and an embedding's correlation id to the gateway", async () => {
    process.env.OPENAI_API_KEY = "upstream-api-key";
    process.env.OMNIAGENT_OPENAI_GATEWAY_URL =
      "https://gateway.asael.example/openai/";
    process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN = gatewayToken;
    openAiMocks.createResponse
      .mockReturnValueOnce({
        async *[Symbol.asyncIterator]() {
          yield { type: "response.completed", response: { id: "response-1" } };
        },
      })
      .mockResolvedValueOnce({ id: "response-2", status: "completed", output_text: "{}" });
    openAiMocks.createEmbedding.mockResolvedValue({ data: [{ embedding: [0.1] }] });
    vi.doMock("@/lib/settings/specialized-runtime", () => ({
      resolveSpecializedRuntime: async () => ({
        configured: true,
        model: "text-embedding-3-large",
        usageReceipt: { credentialSource: "deployment_environment" },
        withApiKey: <T>(run: (apiKey?: string) => T) => run(undefined),
      }),
    }));
    const {
      createStructuredResponseWithMetrics,
      embedTextsWithRuntime,
      streamResponseTurn,
    } = await import("@/lib/openai/client");
    const usageScope = (correlationId: string) => ({
      tenantId: "tenant-a",
      actorId: "actor-a",
      sourceStreamId: "run:1",
      operation: "text_generation" as const,
      purpose: "Answer the owner",
      correlationId,
    });

    await streamResponseTurn({
      input: "private",
      onDelta: () => undefined,
      model: "gpt-5",
      usageScope: usageScope("req-turn"),
    });
    await createStructuredResponseWithMetrics({
      instructions: "Classify",
      input: "private",
      schema: { type: "object", properties: {}, additionalProperties: false },
      name: "classification",
      model: "gpt-5",
      usageScope: usageScope("req-structured"),
    });
    await expect(embedTextsWithRuntime(["private"], undefined, {
      ...usageScope("req-embedding"),
      operation: "embedding",
    })).resolves.toMatchObject({ vectors: [[0.1]] });

    expect(
      openAiMocks.constructorOptions.mock.calls.map(
        ([options]) => options.defaultHeaders["x-omni-correlation-id"],
      ),
    ).toEqual(["req-turn", "req-structured", "req-embedding"]);
  });

  it("sends no correlation id straight to OpenAI", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
    const { getOpenAIClient } = await import("@/lib/openai/client");

    expect(getOpenAIClient({ correlationId: "req-1" })).toBe(getOpenAIClient());
    expect(openAiMocks.constructorOptions.mock.calls).toEqual([[{ apiKey: "test-key" }]]);
  });

  it("sends an opaque prompt cache bucket while retaining stateless storage", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
    openAiMocks.createResponse.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "response.completed",
          response: {
            id: "response-1",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
            },
          },
        };
      },
    });
    const { streamResponseTurn } = await import("@/lib/openai/client");

    await streamResponseTurn({
      input: "private conversation",
      onDelta: () => undefined,
      model: "gpt-5",
      promptCacheKey: "asael-pc-v1-opaque",
    });

    expect(openAiMocks.createResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        store: false,
        prompt_cache_key: "asael-pc-v1-opaque",
      }),
      { signal: undefined },
    );
  });

  it("turns token-limited incomplete responses into actionable errors", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
    openAiMocks.createResponse.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "response.incomplete",
          response: {
            id: "response-limited",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 20, output_tokens: 100, total_tokens: 120 },
          },
        };
      },
    });
    const { streamResponseTurn } = await import("@/lib/openai/client");

    await expect(streamResponseTurn({
      input: "bounded request",
      onDelta: () => undefined,
      model: "gpt-5",
      maxOutputTokens: 100,
    })).rejects.toMatchObject({
      message: "OpenAI reached the response token limit. Narrow the request or split it into smaller steps.",
      provider: "openai",
      kind: "unknown",
      retryable: false,
    });
  });

  describe("an answer the output limit cut off", () => {
    const LIMIT_MESSAGE =
      "OpenAI reached the response token limit. Narrow the request or split it into smaller steps.";

    function cutOffStream(events: Record<string, unknown>[], reason = "max_output_tokens") {
      openAiMocks.createResponse.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield* events;
          yield {
            type: "response.incomplete",
            response: {
              id: "response-cut-off",
              incomplete_details: { reason },
              usage: { input_tokens: 20, output_tokens: 100, total_tokens: 120 },
            },
          };
        },
      });
    }

    async function turn(keepTruncatedAnswer?: boolean) {
      process.env.OPENAI_API_KEY = "test-key";
      delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
      delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
      const deltas: string[] = [];
      const { streamResponseTurn } = await import("@/lib/openai/client");
      const result = streamResponseTurn({
        input: "a long report",
        onDelta: (delta) => { deltas.push(delta); },
        model: "gpt-5",
        maxOutputTokens: 100,
        ...(keepTruncatedAnswer === undefined ? {} : { keepTruncatedAnswer }),
      });
      return { result, deltas };
    }

    const answerDelta = { type: "response.output_text.delta", delta: "The first half" };

    it("keeps the answer it streamed when asked", async () => {
      cutOffStream([answerDelta]);

      const { result, deltas } = await turn(true);

      await expect(result).resolves.toMatchObject({
        text: "The first half",
        functionCalls: [],
        truncated: true,
        responseId: "response-cut-off",
        usage: { inputTokens: 20, outputTokens: 100, totalTokens: 120 },
        attempts: [expect.objectContaining({ status: "completed" })],
      });
      expect(deltas).toEqual(["The first half"]);
    });

    it.each([
      ["without being asked", [answerDelta], undefined, "max_output_tokens"],
      ["when asked not to", [answerDelta], false, "max_output_tokens"],
      ["with no answer text", [
        { type: "response.output_text.delta", delta: " \n " },
      ], true, "max_output_tokens"],
      ["once a tool call started", [answerDelta, {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "item-call", type: "function_call", call_id: "call-a", name: "search" },
      }], true, "max_output_tokens"],
      ["for another reason", [answerDelta], true, "server_limit"],
    ] as const)("still fails %s", async (_, events, keep, reason) => {
      cutOffStream([...events], reason);

      const { result } = await turn(keep);

      await expect(result).rejects.toMatchObject({
        message: reason === "max_output_tokens"
          ? LIMIT_MESSAGE
          : "OpenAI returned an incomplete response.",
        kind: "unknown",
        retryable: false,
      });
    });

    it("marks only a cut-off answer as truncated", async () => {
      openAiMocks.createResponse.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield answerDelta;
          yield {
            type: "response.completed",
            response: {
              id: "response-whole",
              usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
            },
          };
        },
      });

      const { result } = await turn(true);

      expect(await result).not.toHaveProperty("truncated");
    });
  });

  it("does not expose raw credentials when production gateway configuration is invalid", async () => {
    process.env.OPENAI_API_KEY = "upstream-api-key";
    process.env.VERCEL_ENV = "production";
    process.env.OMNIAGENT_OPENAI_GATEWAY_URL =
      "https://owner:url-password@gateway.asael.example/openai";
    process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN = gatewayToken;
    const { getOpenAIClient } = await import("@/lib/openai/client");

    let failure: unknown;
    try {
      getOpenAIClient();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "OpenAI gateway configuration is invalid.",
    );
    expect((failure as Error).message).not.toContain("upstream-api-key");
    expect((failure as Error).message).not.toContain(gatewayToken);
    expect((failure as Error).message).not.toContain("url-password");
    expect((failure as Error).message).not.toContain("gateway.asael.example");
    expect(openAiMocks.constructorOptions).not.toHaveBeenCalled();
  });

  it("fails a readiness probe even when the client ignores cancellation", async () => {
    vi.useFakeTimers();
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
    openAiMocks.retrieveModel.mockReturnValue(new Promise(() => undefined));
    const { getOpenAIReadiness } = await import("@/lib/openai/client");

    const readiness = getOpenAIReadiness({
      timeoutMs: 1_000,
      maxAgeMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(readiness).resolves.toMatchObject({
      configured: true,
      reachable: false,
      error: "OpenAI readiness probe timed out.",
    });
  });
});

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("OpenAI tool turn settings", () => {
  const tool = {
    type: "function" as const,
    name: "flight_search",
    description: "Search flights",
    parameters: { type: "object" },
    strict: false as const,
  };

  function completedTurn() {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
    openAiMocks.createResponse.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "response.completed",
          response: {
            id: "response-1",
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        };
      },
    });
  }

  async function sentTurn(
    settings: { toolChoice?: "auto" | "none"; parallelToolCalls?: boolean },
    tools: readonly (typeof tool)[] | undefined,
  ) {
    completedTurn();
    const { streamResponseTurn } = await import("@/lib/openai/client");
    await streamResponseTurn({
      input: "Where?",
      onDelta: () => undefined,
      model: "gpt-5",
      ...(tools ? { tools: [...tools] } : {}),
      ...settings,
    });
    return openAiMocks.createResponse.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  it("asks for no call and at most one call", async () => {
    const body = await sentTurn(
      { toolChoice: "none", parallelToolCalls: false },
      [tool],
    );

    expect(body).toMatchObject({
      tools: [tool],
      tool_choice: "none",
      parallel_tool_calls: false,
    });
  });

  it("asks for no call on its own", async () => {
    const body = await sentTurn({ toolChoice: "none" }, [tool]);

    expect(body.tool_choice).toBe("none");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  it("asks for at most one call on its own", async () => {
    const body = await sentTurn({ parallelToolCalls: false }, [tool]);

    expect(body.parallel_tool_calls).toBe(false);
    expect(body).not.toHaveProperty("tool_choice");
  });

  it.each([
    ["the default", {}, [tool]],
    ["calls allowed", { toolChoice: "auto", parallelToolCalls: true }, [tool]],
    ["an empty tool list", { toolChoice: "none", parallelToolCalls: false }, []],
    ["no tool list", { toolChoice: "none", parallelToolCalls: false }, undefined],
  ] as const)("sends neither setting for %s", async (_label, settings, tools) => {
    const body = await sentTurn(settings, tools);

    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  it("passes both settings from a gateway tool turn", async () => {
    completedTurn();
    const { openAIModelAdapter } = await import("@/lib/models/adapters/openai");

    await openAIModelAdapter.generateToolTurn!({
      input: "Where?",
      preferredProvider: "openai",
      tools: [{
        type: "function",
        name: "flight_search",
        description: "Search flights",
        parameters: { type: "object" },
      }],
      toolChoice: "none",
      parallelToolCalls: false,
    }, { provider: "openai", model: "gpt-5", tier: "fast", features: ["tools"] });

    expect(openAiMocks.createResponse.mock.calls[0]?.[0]).toMatchObject({
      tools: [tool],
      tool_choice: "none",
      parallel_tool_calls: false,
    });
  });
});

describe("OpenAI reasoning effort and output room", () => {
  it.each([
    ["gpt-5", "minimal", 2_000, "minimal", 2_000],
    ["gpt-5", "low", 2_000, "low", 6_000],
    ["gpt-5", "xhigh", 2_000, "high", 18_000],
    ["gpt-5.1", "minimal", 2_000, "low", 6_000],
    ["gpt-5.5", "minimal", 2_000, "low", 6_000],
    ["gpt-5.5", "max", 2_000, "xhigh", 27_000],
    ["gpt-5.6-sol", "max", 2_000, "max", 27_000],
    ["gpt-5.2", "medium", 3_000, "medium", 11_000],
    ["gpt-5-mini", undefined, 2_000, "minimal", 2_000],
    ["gpt-4o-mini", "high", 2_000, undefined, 2_000],
  ] as const)(
    "sends %s asked for %s effort an effort it accepts and room to reason",
    async (model, requested, answerTokens, effort, maxOutputTokens) => {
      process.env.OPENAI_API_KEY = "test-key";
      delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
      delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
      openAiMocks.createResponse.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "response.completed",
            response: {
              id: "response-1",
              usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
            },
          };
        },
      });
      const { streamResponseTurn } = await import("@/lib/openai/client");

      await streamResponseTurn({
        input: "Plan the trip",
        onDelta: () => undefined,
        model,
        ...(requested ? { reasoningEffort: requested } : {}),
        maxOutputTokens: answerTokens,
      });

      const body = openAiMocks.createResponse.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(body.max_output_tokens).toBe(maxOutputTokens);
      if (effort) {
        expect(body.reasoning).toEqual({ effort });
      } else {
        expect(body).not.toHaveProperty("reasoning");
      }
    },
  );

  it("gives a structured answer room to reason past its own limit", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
    openAiMocks.createResponse.mockResolvedValue({
      id: "response-1",
      status: "completed",
      output_text: "{}",
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
    const { createStructuredResponseWithMetrics } = await import("@/lib/openai/client");

    await createStructuredResponseWithMetrics({
      instructions: "Classify",
      input: "private",
      schema: { type: "object", properties: {}, additionalProperties: false },
      name: "classification",
      model: "gpt-5.5",
      maxOutputTokens: 20_000,
    });

    expect(openAiMocks.createResponse.mock.calls[0]?.[0]).toMatchObject({
      reasoning: { effort: "low" },
      max_output_tokens: 20_000,
    });
  });
});

describe("OpenAI turn output replay", () => {
  const target = {
    provider: "openai" as const,
    model: "gpt-5",
    tier: "reasoning" as const,
    features: ["tools" as const],
  };
  const weatherTool = {
    type: "function" as const,
    name: "get_weather",
    description: "Look up the weather",
    parameters: { type: "object" },
  };
  const completed = (id: string) => ({
    type: "response.completed",
    response: {
      id,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  });
  const itemDone = (outputIndex: number, item: Record<string, unknown>) => ({
    type: "response.output_item.done",
    output_index: outputIndex,
    item,
  });
  const callAdded = (outputIndex: number | undefined, id: string, callId: string) => ({
    type: "response.output_item.added",
    ...(outputIndex === undefined ? {} : { output_index: outputIndex }),
    item: {
      id,
      type: "function_call",
      call_id: callId,
      name: "get_weather",
      arguments: "",
      status: "in_progress",
    },
  });
  const outputText = (text: string) => ({
    type: "output_text",
    text,
    annotations: [],
  });

  function respond(...streams: Array<Array<Record<string, unknown>>>) {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
    for (const events of streams) {
      openAiMocks.createResponse.mockReturnValueOnce({
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
      });
    }
  }

  const reasoningA = {
    type: "reasoning",
    id: "rs_a",
    summary: [],
    encrypted_content: "enc_a",
  };
  const preamble = {
    type: "message",
    id: "msg_a",
    role: "assistant",
    status: "completed",
    content: [outputText("Checking the weather.")],
    phase: "commentary",
  };
  const callA = {
    type: "function_call",
    id: "fc_a",
    call_id: "call_a",
    name: "get_weather",
    arguments: "{\"city\":\"Paris\"}",
  };
  const reasoningB = {
    type: "reasoning",
    id: "rs_b",
    summary: [],
    encrypted_content: "enc_b",
  };
  const callB = {
    type: "function_call",
    id: "fc_b",
    call_id: "call_b",
    name: "get_weather",
    arguments: "{\"city\":\"Rome\"}",
  };

  it("sends a turn's encrypted reasoning, phased messages and calls back in output order", async () => {
    respond([
      { type: "response.created", response: { id: "resp_1" } },
      itemDone(0, {
        ...reasoningA,
        summary: [{ type: "summary_text", text: "PRIVATE_SUMMARY" }],
        content: [{ type: "reasoning_text", text: "PRIVATE_REASONING" }],
        status: "completed",
      }),
      { type: "response.output_text.delta", output_index: 1, item_id: "msg_a", delta: "Checking the weather." },
      itemDone(1, {
        ...preamble,
        content: [{
          type: "output_text",
          text: "Checking the weather.",
          annotations: [{ type: "url_citation", url: "https://example.test" }],
          logprobs: [],
        }, { type: "reasoning_text", text: "PRIVATE_PART" }],
      }),
      callAdded(2, "fc_a", "call_a"),
      {
        type: "response.function_call_arguments.done",
        output_index: 2,
        item_id: "fc_a",
        arguments: "{\"city\":\"Paris\"}",
      },
      itemDone(3, reasoningB),
      { ...callAdded(4, "fc_b", "call_b"), item: { ...callB, status: "in_progress" } },
      completed("resp_1"),
    ], [
      { type: "response.output_text.delta", delta: "Sunny in both." },
      completed("resp_2"),
    ]);
    const { openAIModelAdapter } = await import("@/lib/models/adapters/openai");

    const first = await openAIModelAdapter.generateToolTurn!({
      input: "What is the weather in Paris and Rome?",
      preferredProvider: "openai",
      tools: [weatherTool],
    }, target);
    await openAIModelAdapter.generateToolTurn!({
      input: "What is the weather in Paris and Rome?",
      preferredProvider: "openai",
      tools: [weatherTool],
      continuation: first.continuation,
      toolResults: [
        { callId: "call_a", name: "get_weather", output: "sunny" },
        { callId: "call_b", name: "get_weather", output: "sunny" },
      ],
    }, target);

    const replayed = [reasoningA, preamble, callA, reasoningB, callB];
    expect(first.continuation?.state).toEqual([
      {
        type: "message",
        role: "user",
        content: "What is the weather in Paris and Rome?",
      },
      ...replayed,
    ]);
    expect(openAiMocks.createResponse.mock.calls[1]?.[0].input).toEqual([
      { role: "user", content: "What is the weather in Paris and Rome?" },
      ...replayed,
      { type: "function_call_output", call_id: "call_a", output: "sunny" },
      { type: "function_call_output", call_id: "call_b", output: "sunny" },
    ]);
    expect(JSON.stringify(first.continuation)).not.toMatch(/PRIVATE_/);
  });

  it.each([
    [
      "text and a call",
      [
        itemDone(0, { type: "reasoning", id: "rs_plain", summary: [] }),
        itemDone(1, reasoningA),
        itemDone(2, { ...preamble, id: undefined }),
        itemDone(3, { ...reasoningB, id: "" }),
        itemDone(4, { ...reasoningB, encrypted_content: "" }),
        itemDone(5, { ...preamble, id: "msg_bare", content: undefined }),
        itemDone(6, { ...preamble, id: "msg_refusal", content: [{ type: "refusal", refusal: "No." }] }),
        { type: "response.output_item.done", output_index: 7, item: null },
        { type: "response.output_text.delta", delta: "Checking." },
        callAdded(undefined, "fc_a", "call_a"),
      ],
      [
        reasoningA,
        { type: "message", role: "assistant", content: "Checking." },
        { ...callA, arguments: "" },
      ],
    ],
    [
      "text alone",
      [
        itemDone(0, reasoningA),
        { type: "response.output_text.delta", delta: "Done." },
      ],
      [reasoningA, { type: "message", role: "assistant", content: "Done." }],
    ],
    [
      "a call alone",
      [callAdded(undefined, "fc_a", "call_a")],
      [{ ...callA, arguments: "" }],
    ],
  ] as const)(
    "keeps the text of a stream with %s but no message item",
    async (_label, events, expected) => {
      respond([...events, completed("resp_legacy")]);
      const { streamResponseTurn } = await import("@/lib/openai/client");

      const turn = await streamResponseTurn({
        input: "Weather?",
        onDelta: () => undefined,
        model: "gpt-5",
      });

      expect(turn.outputItems).toEqual(expected);
    },
  );

  it("keeps a final answer's phase and drops one the API does not define", async () => {
    respond([
      itemDone(0, { ...preamble, id: "msg_final", phase: "final_answer" }),
      itemDone(1, { ...preamble, id: "msg_unphased", phase: "analysis" }),
      completed("resp_final"),
    ]);
    const { streamResponseTurn } = await import("@/lib/openai/client");

    const turn = await streamResponseTurn({
      input: "Weather?",
      onDelta: () => undefined,
      model: "gpt-5",
    });

    const { phase: _phase, ...unphased } = preamble;
    void _phase;
    expect(turn.outputItems).toEqual([
      { ...preamble, id: "msg_final", phase: "final_answer" },
      { ...unphased, id: "msg_unphased" },
    ]);
  });

  it("does not send the failed model's reasoning to its fallback", async () => {
    respond([
      itemDone(0, { ...reasoningA, id: "rs_primary_0" }),
      itemDone(1, { ...reasoningA, id: "rs_primary_1" }),
      { type: "response.failed", response: { id: "resp_failed" } },
    ], [
      itemDone(0, preamble),
      completed("resp_fallback"),
    ]);
    const { streamResponseTurn } = await import("@/lib/openai/client");

    const turn = await streamResponseTurn({
      input: "Weather?",
      onDelta: () => undefined,
      model: "gpt-5",
      fallbackModel: "gpt-5-mini",
    });

    expect(turn.fallbackUsed).toBe(true);
    expect(turn.outputItems).toEqual([preamble]);
  });

  it("reads a turn's messages as one reply and leaves its reasoning to OpenAI", async () => {
    const { canonicalConversationFromOpenAIItems } = await import("@/lib/openai/client");
    const message = (id: string, ...texts: string[]) => ({
      ...preamble,
      id,
      content: texts.map(outputText),
    });

    expect(canonicalConversationFromOpenAIItems([
      { type: "message", role: "user", content: "Weather?" },
      reasoningA,
      message("msg_a", "Checking "),
      reasoningB,
      message("msg_b", "the ", "weather."),
      callA,
      { type: "function_call_output", call_id: "call_a", output: "sunny" },
      message("msg_empty", ""),
      callB,
      { type: "function_call_output", call_id: "call_b", output: "sunny" },
      message("msg_c", "It is sunny."),
    ] as never)).toEqual([
      { type: "message", role: "user", content: "Weather?" },
      { type: "message", role: "assistant", content: "Checking the weather." },
      {
        type: "tool_call",
        callId: "call_a",
        name: "get_weather",
        argumentsJson: "{\"city\":\"Paris\"}",
      },
      {
        type: "tool_result",
        callId: "call_a",
        name: "get_weather",
        content: "sunny",
      },
      {
        type: "tool_call",
        callId: "call_b",
        name: "get_weather",
        argumentsJson: "{\"city\":\"Rome\"}",
      },
      {
        type: "tool_result",
        callId: "call_b",
        name: "get_weather",
        content: "sunny",
      },
      { type: "message", role: "assistant", content: "It is sunny." },
    ]);
  });
});

describe("OpenAI turn cost", () => {
  const failed = (id: string, usage: Record<string, unknown>) => ({
    type: "response.failed",
    response: { id, error: { code: "server_error", message: "Try again." }, usage },
  });

  function respond(...streams: Array<Array<Record<string, unknown>>>) {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      "gpt-5": { input: 1, output: 4 },
      "gpt-5-mini": { input: 0.5, cachedInput: 0.05, output: 2 },
    }));
    for (const events of streams) {
      openAiMocks.createResponse.mockReturnValueOnce({
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
      });
    }
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds a failed attempt's tokens and cost to its fallback's", async () => {
    respond([
      failed("resp_failed", {
        input_tokens: 100,
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 4 },
        total_tokens: 110,
      }),
    ], [{
      type: "response.completed",
      response: {
        id: "resp_fallback",
        usage: {
          input_tokens: 200,
          input_tokens_details: { cached_tokens: 40 },
          output_tokens: 20,
          total_tokens: 220,
        },
      },
    }]);
    const { streamResponseTurn } = await import("@/lib/openai/client");

    const turn = await streamResponseTurn({
      input: "Weather?",
      onDelta: () => undefined,
      model: "gpt-5",
      fallbackModel: "gpt-5-mini",
    });

    expect(turn.fallbackUsed).toBe(true);
    expect(turn.usage).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: 40,
      totalTokens: 330,
      reasoningTokens: 4,
    });
    // 100 × 1 + 10 × 4 = 140 per million, then 160 × 0.5 + 40 × 0.05 + 20 × 2 = 122.
    expect(turn.attempts.map((attempt) => attempt.estimatedCostUsd)).toEqual([0.00014, 0.000122]);
    expect(turn.estimatedCostUsd).toBe(0.000262);
  });

  it("adds up the tokens and cost of a turn whose fallback fails too", async () => {
    respond(
      [failed("resp_failed", { input_tokens: 100, output_tokens: 10, total_tokens: 110 })],
      [failed("resp_fallback_failed", { input_tokens: 200, output_tokens: 20, total_tokens: 220 })],
    );
    const { streamResponseTurn } = await import("@/lib/openai/client");

    const error = await streamResponseTurn({
      input: "Weather?",
      onDelta: () => undefined,
      model: "gpt-5",
      fallbackModel: "gpt-5-mini",
    }).catch((caught: unknown) => caught);

    const { getModelProviderResponseReceipt } = await import("@/lib/models/types");
    expect(getModelProviderResponseReceipt(error)).toMatchObject({
      usage: { inputTokens: 300, outputTokens: 30, cachedInputTokens: 0, totalTokens: 330 },
      // 140 per million, then 200 × 0.5 + 20 × 2 = 140.
      estimatedCostUsd: 0.00028,
    });
  });
});
