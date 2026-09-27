import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// The Bedrock adapter keeps the fetch it was created with, so fetch is
// stubbed before the gateway loads.
const fetchMock = vi.hoisted(() => {
  const mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  return mock;
});
const createResponse = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = { create: createResponse };
  },
}));

import { generateModelToolTurn } from "@/lib/models/gateway";
import { bindModelRuntime } from "@/lib/models/runtime-context";
import type {
  ModelToolResult,
  ModelToolTurnRequest,
  ProviderId,
} from "@/lib/models/types";

type ToolProvider = Exclude<ProviderId, "local">;

const TOOL_NAMES = [
  "flight_search",
  "hotel_search",
  "weather_lookup",
  "calendar_read",
  "currency_rates",
  "web_search",
];
const SKIPPED = "{\"error\":\"Per-turn tool call limit reached; call skipped.\"}";

/** How each provider's API is answered and what each one was sent. */
const providers: Record<ToolProvider, {
  model: string;
  respondWithCalls(names: readonly string[], firstIndex: number): void;
  respondWithText(): void;
  sentResults(): Array<{ callId: string; output: unknown }>;
  requests(): number;
}> = {
  anthropic: {
    model: "claude-test",
    respondWithCalls(names, firstIndex) {
      fetchMock.mockResolvedValueOnce(json({
        id: `msg_calls_${firstIndex}`,
        model: "claude-test",
        content: names.map((name, index) => ({
          type: "tool_use",
          id: `toolu_${firstIndex + index}`,
          name,
          input: {},
        })),
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    },
    respondWithText() {
      fetchMock.mockResolvedValueOnce(json({
        id: "msg_text",
        model: "claude-test",
        content: [{ type: "text", text: "The trip is planned." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 5 },
      }));
    },
    sentResults() {
      return sentBody().messages
        .flatMap((message: { content: unknown }) =>
          Array.isArray(message.content) ? message.content : [])
        .filter((block: { type: string }) => block.type === "tool_result")
        .map((block: { tool_use_id: string; content: unknown }) => ({
          callId: block.tool_use_id,
          output: block.content,
        }));
    },
    requests: () => fetchMock.mock.calls.length,
  },
  aws_bedrock: {
    model: "amazon.nova-lite-v1:0",
    respondWithCalls(names, firstIndex) {
      fetchMock.mockResolvedValueOnce(json({
        output: {
          message: {
            role: "assistant",
            content: names.map((name, index) => ({
              toolUse: { toolUseId: `tooluse_${firstIndex + index}`, name, input: {} },
            })),
          },
        },
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }));
    },
    respondWithText() {
      fetchMock.mockResolvedValueOnce(json({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "The trip is planned." }],
          },
        },
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      }));
    },
    sentResults() {
      return sentBody().messages
        .flatMap((message: { content: Record<string, unknown>[] }) => message.content)
        .filter((block: Record<string, unknown>) => "toolResult" in block)
        .map((block: {
          toolResult: { toolUseId: string; content: Array<{ text: string }> };
        }) => ({
          callId: block.toolResult.toolUseId,
          output: block.toolResult.content[0].text,
        }));
    },
    requests: () => fetchMock.mock.calls.length,
  },
  google: {
    model: "gemini-test",
    respondWithCalls(names, firstIndex) {
      fetchMock.mockResolvedValueOnce(json({
        id: `interaction-calls-${firstIndex}`,
        status: "completed",
        model: "gemini-test",
        steps: names.map((name, index) => ({
          type: "function_call",
          id: `fc-${firstIndex + index}`,
          name,
          arguments: {},
        })),
        usage: { total_input_tokens: 10, total_output_tokens: 5, total_tokens: 15 },
      }));
    },
    respondWithText() {
      fetchMock.mockResolvedValueOnce(json({
        id: "interaction-text",
        status: "completed",
        model: "gemini-test",
        steps: [{
          type: "model_output",
          content: [{ type: "text", text: "The trip is planned." }],
        }],
        usage: { total_input_tokens: 20, total_output_tokens: 5, total_tokens: 25 },
      }));
    },
    sentResults() {
      return sentBody().input
        .filter((step: { type: string }) => step.type === "function_result")
        .map((step: { call_id: string; result: Array<{ text: string }> }) => ({
          callId: step.call_id,
          output: step.result[0].text,
        }));
    },
    requests: () => fetchMock.mock.calls.length,
  },
  openai: {
    model: "gpt-test",
    respondWithCalls(names, firstIndex) {
      createResponse.mockReturnValueOnce(stream([
        ...names.map((name, index) => ({
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: `fc_${firstIndex + index}`,
            call_id: `call_${firstIndex + index}`,
            name,
            arguments: "{}",
          },
        })),
        completed(`resp_calls_${firstIndex}`),
      ]));
    },
    respondWithText() {
      createResponse.mockReturnValueOnce(stream([
        { type: "response.output_text.delta", delta: "The trip is planned." },
        completed("resp_text"),
      ]));
    },
    sentResults() {
      return createResponse.mock.calls.at(-1)![0].input
        .filter((item: { type: string }) => item.type === "function_call_output")
        .map((item: { call_id: string; output: unknown }) => ({
          callId: item.call_id,
          output: item.output,
        }));
    },
    requests: () => createResponse.mock.calls.length,
  },
};

const PROVIDERS = Object.keys(providers) as ToolProvider[];

function turnRequest(
  provider: ToolProvider,
  extra: Partial<ModelToolTurnRequest> = {},
) {
  return bindModelRuntime<ModelToolTurnRequest>({
    input: "Plan the Lisbon trip.",
    preferredProvider: provider,
    allowedProviders: [provider],
    tools: TOOL_NAMES.map((name) => ({
      type: "function",
      name,
      description: `Run ${name}.`,
      parameters: { type: "object", properties: {} },
    })),
    ...extra,
  }, {
    targets: [{
      provider,
      model: providers[provider].model,
      tier: "fast",
      features: ["text", "tools"],
    }],
    credentials: provider === "aws_bedrock"
      ? {
          aws_bedrock: {
            kind: "aws_bedrock",
            accessKeyId: "AKIATESTACCESSKEY",
            secretAccessKey: "bedrock-test-secret-access-key-123456",
            region: "us-east-1",
          },
        }
      : { [provider]: { kind: "api_key", apiKey: "test-key" } },
  });
}

/** A first turn in which the model calls six tools at once. */
async function sixCallTurn(provider: ToolProvider) {
  providers[provider].respondWithCalls(TOOL_NAMES, 1);
  const first = await generateModelToolTurn(turnRequest(provider));
  expect(first.toolCalls.map((call) => call.name)).toEqual(TOOL_NAMES);
  // The runner answers five calls and skips the one past its per-turn cap.
  const toolResults: ModelToolResult[] = first.toolCalls.map((call, index) => ({
    callId: call.callId,
    name: call.name,
    output: index < 5 ? `${call.name} answered` : SKIPPED,
    ...(index < 5 ? {} : { isError: true }),
  }));
  return { first, toolResults };
}

afterEach(() => {
  fetchMock.mockReset();
  createResponse.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("tool results through the model gateway", () => {
  it.each(PROVIDERS)("%s receives a result for each of six tool calls", async (provider) => {
    const { first, toolResults } = await sixCallTurn(provider);
    providers[provider].respondWithText();

    const second = await generateModelToolTurn(turnRequest(provider, {
      continuation: first.continuation,
      toolResults,
    }));

    expect(second.text).toBe("The trip is planned.");
    expect(providers[provider].sentResults()).toEqual(toolResults.map((result) => ({
      callId: result.callId,
      output: result.output,
    })));
  });

  it.each(PROVIDERS)("%s still sends the six results on the turn after them", async (provider) => {
    const { first, toolResults } = await sixCallTurn(provider);
    providers[provider].respondWithCalls(["web_search"], 7);
    const second = await generateModelToolTurn(turnRequest(provider, {
      continuation: first.continuation,
      toolResults,
    }));
    const [call] = second.toolCalls;
    const lastResult = { callId: call.callId, name: call.name, output: "web_search answered" };
    providers[provider].respondWithText();

    await generateModelToolTurn(turnRequest(provider, {
      continuation: second.continuation,
      toolResults: [lastResult],
    }));

    expect(providers[provider].sentResults()).toEqual(
      [...toolResults, lastResult].map((result) => ({
        callId: result.callId,
        output: result.output,
      })),
    );
  });

  it.each(PROVIDERS)("%s refuses a turn that leaves a tool call without a result", async (provider) => {
    const { first, toolResults } = await sixCallTurn(provider);
    const requests = providers[provider].requests();

    await expect(generateModelToolTurn(turnRequest(provider, {
      continuation: first.continuation,
      toolResults: toolResults.slice(0, 5),
    }))).rejects.toMatchObject({
      provider,
      kind: "invalid_request",
      retryable: false,
      message: "1 tool call(s) from the model's last turn have no result.",
    });
    expect(providers[provider].requests()).toBe(requests);
  });

  it("sends OpenAI each result once when it rebuilds the turn from the transcript", async () => {
    const { first, toolResults } = await sixCallTurn("openai");
    providers.openai.respondWithText();

    await generateModelToolTurn(turnRequest("openai", {
      continuation: {
        provider: "openai",
        state: [],
        conversation: first.continuation.conversation,
      },
      toolResults,
    }));

    expect(providers.openai.sentResults()).toEqual(toolResults.map((result) => ({
      callId: result.callId,
      output: result.output,
    })));
  });
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sentBody() {
  return JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body));
}

function stream(events: readonly Record<string, unknown>[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

function completed(id: string) {
  return {
    type: "response.completed",
    response: {
      id,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  };
}
