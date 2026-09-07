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

  it("uses redacted browser structure once without persisting it", async () => {
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
              toolUseId: "call-browser",
              name: "browser_click",
              input: { ref: "e7" },
            },
          }],
        }],
        conversation: [
          { type: "message", role: "user", content: "Continue." },
          {
            type: "tool_call",
            callId: "call-browser",
            name: "browser_click",
            argumentsJson: "{\"ref\":\"e7\"}",
          },
        ],
      },
      toolResults: [{
        callId: "call-browser",
        name: "browser_click",
        output: "{\"clicked\":true}",
        browserObservation: {
          schemaVersion: 1,
          source: "browser",
          trust: "untrusted_data",
          executionId: "execution-browser",
          operation: "browser_click",
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
        text: expect.stringContaining("Untrusted browser observation"),
      }),
    ]);
    expect(JSON.stringify(result.continuation.state)).not.toContain("Ready");
  });
});
