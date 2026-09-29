import { describe, expect, it } from "vitest";
import {
  canonicalConversationFromOpenAIItems,
  openAIResponseInput,
  type ConversationItem,
} from "@/lib/openai/client";

describe("OpenAI local Computer Use observations", () => {
  it("maps one ephemeral observation to text and image input parts", () => {
    const item = {
      type: "ephemeral_computer_function_output",
      call_id: "call-computer",
      output: "{\"clicked\":true}",
      observation: {
        schemaVersion: 1,
        source: "local_macos",
        trust: "untrusted_data",
        executionId: "execution-local",
        operation: "local.macos.click",
        snapshotRevision: "a".repeat(64),
        accessibilitySnapshot: "- heading \"Ready\" [level=1]",
        screenshot: {
          mimeType: "image/webp",
          dataBase64: "UklGRgAAAABXRUJQ",
        },
      },
    } as const;
    const input = openAIResponseInput([item]);

    expect(input).toEqual([{
      type: "function_call_output",
      call_id: "call-computer",
      output: [
        { type: "input_text", text: "{\"clicked\":true}" },
        expect.objectContaining({
          type: "input_text",
          text: expect.stringContaining("Untrusted local Mac observation"),
        }),
        {
          type: "input_image",
          detail: "high",
          image_url: "data:image/webp;base64,UklGRgAAAABXRUJQ",
        },
      ],
    }]);
    expect(canonicalConversationFromOpenAIItems([
      {
        type: "function_call",
        id: "call-computer",
        call_id: "call-computer",
        name: "local_macos_click",
        arguments: "{}",
      },
      item,
    ])).toEqual([
      {
        type: "tool_call",
        callId: "call-computer",
        name: "local_macos_click",
        argumentsJson: "{}",
      },
      {
        type: "tool_result",
        callId: "call-computer",
        name: "local_macos_click",
        content: "{\"clicked\":true}",
      },
    ]);
  });
});

describe("OpenAI canonical conversation", () => {
  it("compacts a long run's calls to the conversation's item limit", () => {
    const calls = Array.from({ length: 70 }, (_, leg): ConversationItem[] => [
      {
        type: "function_call",
        id: `fc-${leg}`,
        call_id: `call-${leg}`,
        name: "search",
        arguments: `{"leg":${leg}}`,
      },
      { type: "function_call_output", call_id: `call-${leg}`, output: `Leg ${leg} found.` },
    ]).flat();

    const conversation = canonicalConversationFromOpenAIItems([
      { type: "message", role: "user", content: "Plan the Lisbon trip." },
      ...calls,
    ]);

    // 141 items and the list of steps make 142; the 23 oldest calls go.
    expect(conversation).toHaveLength(96);
    expect(conversation[1]).toMatchObject({
      type: "observation",
      source: "tool",
      untrusted: true,
      content: expect.stringMatching(
        /^Earlier steps of this run[^\n]*\n- search\(\{"leg":0\}\) returned: Leg 0 found\.\n(?:.*\n){21}- search\(\{"leg":22\}\) returned: Leg 22 found\.$/,
      ),
    });
    expect(conversation[2]).toEqual({
      type: "tool_call",
      callId: "call-23",
      name: "search",
      argumentsJson: "{\"leg\":23}",
    });
  });
});
