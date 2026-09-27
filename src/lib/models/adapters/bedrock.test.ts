import { afterEach, describe, expect, it, vi } from "vitest";
import { createBedrockModelAdapter } from "@/lib/models/adapters/bedrock";
import { bindModelRuntime } from "@/lib/models/runtime-context";
import type { ModelTarget, ModelToolTurnRequest } from "@/lib/models/types";

describe("Amazon Bedrock prompt caching", () => {
  afterEach(() => vi.restoreAllMocks());

  it("places a cache point after stable instructions and counts cache usage", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "Done." }],
          },
        },
        stopReason: "end_turn",
        usage: {
          inputTokens: 3,
          cacheReadInputTokens: 100,
          cacheWriteInputTokens: 20,
          outputTokens: 5,
          totalTokens: 8,
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-amzn-requestid": "request-1",
        },
      },
    ));
    const adapter = createBedrockModelAdapter({
      fetchImplementation,
      now: () => new Date("2026-09-07T10:00:00.000Z"),
    });
    const target: ModelTarget = {
      provider: "aws_bedrock",
      model: "amazon.nova-lite-v1:0",
      tier: "fast",
      features: ["text", "tools"],
    };
    const request = bindModelRuntime<ModelToolTurnRequest>({
      input: "Continue the task.",
      instructions: "Use governed tools and answer concisely.",
      preferredProvider: "aws_bedrock",
      conversation: [{
        type: "message",
        role: "user",
        content: "Continue the task.",
      }],
      tools: [],
    }, {
      targets: [target],
      credentials: {
        aws_bedrock: {
          kind: "aws_bedrock",
          accessKeyId: "AKIATESTACCESSKEY",
          secretAccessKey: "bedrock-test-secret-access-key-123456",
          region: "us-east-1",
        },
      },
    });

    const result = await adapter.generateToolTurn!(request, target);
    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body));

    expect(body.system).toEqual([
      { text: "Use governed tools and answer concisely." },
      { cachePoint: { type: "default" } },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 123,
      outputTokens: 5,
      cachedInputTokens: 100,
      totalTokens: 128,
    });
    expect(result.continuation.provider).toBe("aws_bedrock");
    expect(JSON.stringify(result.continuation.state)).not.toContain(
      "cachePoint",
    );
  });

  it("uses redacted local computer structure once without persisting it", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "The page is ready." }],
          },
        },
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const adapter = createBedrockModelAdapter({
      fetchImplementation,
      now: () => new Date("2026-09-07T10:00:00.000Z"),
    });
    const target: ModelTarget = {
      provider: "aws_bedrock",
      model: "amazon.nova-lite-v1:0",
      tier: "fast",
      features: ["text", "tools"],
    };
    const request = bindModelRuntime<ModelToolTurnRequest>({
      input: "Continue.",
      preferredProvider: "aws_bedrock",
      tools: [],
      continuation: {
        provider: "aws_bedrock",
        state: [{
          role: "assistant",
          content: [{
            toolUse: {
              toolUseId: "call-computer",
              name: "local_macos_click",
              input: { ref: "e7" },
            },
          }],
        }],
        conversation: [
          { type: "message", role: "user", content: "Continue." },
          {
            type: "tool_call",
            callId: "call-computer",
            name: "local_macos_click",
            argumentsJson: "{\"ref\":\"e7\"}",
          },
        ],
      },
      toolResults: [{
        callId: "call-computer",
        name: "local_macos_click",
        output: "{\"clicked\":true}",
        computerObservation: {
          schemaVersion: 1,
          source: "local_macos",
          trust: "untrusted_data",
          executionId: "execution-local",
          operation: "local.macos.click",
          snapshotRevision: "a".repeat(64),
          accessibilitySnapshot: "- heading \"Ready\" [level=1]",
        },
      }],
    }, {
      targets: [target],
      credentials: {
        aws_bedrock: {
          kind: "aws_bedrock",
          accessKeyId: "AKIATESTACCESSKEY",
          secretAccessKey: "bedrock-test-secret-access-key-123456",
          region: "us-east-1",
        },
      },
    });

    const result = await adapter.generateToolTurn!(request, target);
    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body));
    expect(body.messages.at(-1).content[0].toolResult.content).toEqual([
      { text: "{\"clicked\":true}" },
      expect.objectContaining({
        text: expect.stringContaining("Untrusted local Mac observation"),
      }),
    ]);
    expect(JSON.stringify(result.continuation.state)).not.toContain("Ready");
  });
});

describe("Amazon Bedrock tool results", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers only the calls that end a continuation without a transcript", async () => {
    const fetchImplementation = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "Booked." }],
          },
        },
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const adapter = createBedrockModelAdapter({ fetchImplementation });
    const target: ModelTarget = {
      provider: "aws_bedrock",
      model: "amazon.nova-lite-v1:0",
      tier: "fast",
      features: ["text", "tools"],
    };
    const flights = {
      role: "assistant",
      content: [{
        toolUse: { toolUseId: "tooluse_a", name: "flight_search", input: {} },
      }],
    };
    const hotels = {
      role: "assistant",
      content: [{
        toolUse: { toolUseId: "tooluse_b", name: "hotel_search", input: {} },
      }],
    };
    // A continuation saved before continuations carried a transcript.
    const state = [
      { role: "user", content: [{ text: "Plan the Lisbon trip." }] },
      flights,
      {
        role: "user",
        content: [{
          toolResult: {
            toolUseId: "tooluse_a",
            content: [{ text: "Two flights." }],
            status: "success",
          },
        }],
      },
      hotels,
    ];
    const turn = (
      continuationState: Record<string, unknown>[],
      toolResults: ModelToolTurnRequest["toolResults"],
    ) => adapter.generateToolTurn!(bindModelRuntime<ModelToolTurnRequest>({
      input: "Continue.",
      preferredProvider: "aws_bedrock",
      tools: [],
      continuation: { provider: "aws_bedrock", state: continuationState },
      toolResults,
    }, {
      targets: [target],
      credentials: {
        aws_bedrock: {
          kind: "aws_bedrock",
          accessKeyId: "AKIATESTACCESSKEY",
          secretAccessKey: "bedrock-test-secret-access-key-123456",
          region: "us-east-1",
        },
      },
    }), target);
    const invalid = (message: string) => ({
      provider: "aws_bedrock",
      kind: "invalid_request",
      retryable: false,
      message,
    });

    // The earlier turn's call was already answered.
    await expect(turn(state, [{
      callId: "tooluse_a",
      name: "flight_search",
      output: "Two flights.",
    }])).rejects.toMatchObject(invalid(
      "A tool result answers no open tool call from the model's last turn.",
    ));
    await expect(turn(state, [])).rejects.toMatchObject(invalid(
      "1 tool call(s) from the model's last turn have no result.",
    ));
    expect(fetchImplementation).not.toHaveBeenCalled();

    await turn(state, [{
      callId: "tooluse_b",
      name: "hotel_search",
      output: "One hotel.",
    }]);
    const answered = JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body));
    expect(answered.messages).toHaveLength(5);
    expect(answered.messages.at(-1)).toEqual({
      role: "user",
      content: [{
        toolResult: {
          toolUseId: "tooluse_b",
          content: [{ text: "One hotel." }],
          status: "success",
        },
      }],
    });

    // A turn that ended in text has nothing to answer.
    const replied = [...state.slice(0, 3), {
      role: "assistant",
      content: [{ text: "Which dates?" }],
    }];
    await turn(replied, []);
    const unanswered = JSON.parse(String(fetchImplementation.mock.calls[1][1]?.body));
    expect(unanswered.messages).toHaveLength(4);
    expect(unanswered.messages.at(-1)).toEqual(replied.at(-1));
  });
});
