import { describe, expect, it } from "vitest";
import { classifyProviderError } from "@/lib/models/adapters/openai";
import {
  canonicalConversationFromOpenAIItems,
  openAIResponseInput,
} from "@/lib/openai/client";

describe("model provider error classification", () => {
  it("retries ordinary fetch and nested network failures", () => {
    const fetchFailure = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" }),
    });
    expect(classifyProviderError("openai", fetchFailure)).toMatchObject({
      kind: "unavailable",
      retryable: true,
    });

    expect(classifyProviderError("google", {
      message: "request failed",
      cause: { code: "ECONNRESET" },
    })).toMatchObject({ kind: "unavailable", retryable: true });
  });

  it("never converts auth, invalid, or safety responses into retries", () => {
    expect(classifyProviderError("openai", {
      status: 401,
      message: "fetch failed while authenticating",
    })).toMatchObject({ kind: "authentication", retryable: false });
    expect(classifyProviderError("openai", {
      status: 400,
      message: "invalid request",
    })).toMatchObject({ kind: "invalid_request", retryable: false });
    expect(classifyProviderError("anthropic", {
      message: "request blocked by safety policy",
    })).toMatchObject({ kind: "safety", retryable: false });
  });

  it("keeps unrelated type errors non-retryable", () => {
    expect(classifyProviderError("openai", new TypeError("Invalid URL"))).toMatchObject({
      kind: "unknown",
      retryable: false,
    });
  });
});

describe("OpenAI browser observations", () => {
  it("maps one ephemeral observation to text and image input parts", () => {
    const item = {
      type: "ephemeral_browser_function_output",
      call_id: "call-browser",
      output: "{\"clicked\":true}",
      observation: {
        schemaVersion: 1,
        source: "browser",
        trust: "untrusted_data",
        executionId: "execution-browser",
        operation: "browser_click",
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
      call_id: "call-browser",
      output: [
        { type: "input_text", text: "{\"clicked\":true}" },
        expect.objectContaining({
          type: "input_text",
          text: expect.stringContaining("Untrusted browser observation"),
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
        id: "call-browser",
        call_id: "call-browser",
        name: "browser_click",
        arguments: "{}",
      },
      item,
    ])).toEqual([
      {
        type: "tool_call",
        callId: "call-browser",
        name: "browser_click",
        argumentsJson: "{}",
      },
      {
        type: "tool_result",
        callId: "call-browser",
        name: "browser_click",
        content: "{\"clicked\":true}",
      },
    ]);
  });
});
