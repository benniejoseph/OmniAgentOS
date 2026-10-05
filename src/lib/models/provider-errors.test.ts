import { describe, expect, it, vi } from "vitest";
import { classifyProviderError } from "@/lib/models/provider-errors";

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

  it.each([
    ["OpenAI's error code", "openai", {
      status: 400,
      code: "context_length_exceeded",
      message: "Request too large.",
    }],
    ["OpenAI's context window", "openai", {
      status: 400,
      message: "Your input exceeds the context window of this model.",
    }],
    ["a maximum context length", "openai", {
      status: 400,
      message: "This model's maximum context length is 128000 tokens.",
    }],
    ["an error code named in the message", "openai", {
      status: 400,
      message: "Error code: context_length_exceeded.",
    }],
    ["Claude's prompt length", "anthropic", {
      status: 400,
      message: "prompt is too long: 208000 tokens > 200000 maximum",
    }],
    ["Gemini's input token count", "google", {
      status: 400,
      message: "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
    }],
  ] as const)("names an input too long for the model from %s", (_, provider, error) => {
    expect(classifyProviderError(provider, error)).toMatchObject({
      provider,
      kind: "context_length",
      retryable: false,
      status: 400,
    });
  });

  it.each([
    ["Claude's 529", { status: 529, message: "Overloaded" }],
    ["a bare 529", { status: 529, message: "Anthropic returned 529." }],
    ["an overloaded 503", {
      status: 503,
      message: "The model is overloaded. Please try again later.",
    }],
    ["a streamed temporary overload", {
      message: "The model is recovering from a temporary overload. Please retry after a brief delay.",
    }],
  ])("names %s an overloaded provider that a retry can help", (_, error) => {
    expect(classifyProviderError("anthropic", error)).toMatchObject({
      kind: "overloaded",
      retryable: true,
      status: "status" in error ? error.status : undefined,
    });
  });

  it("calls a missed call deadline a timeout", () => {
    expect(classifyProviderError("google", new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    ))).toMatchObject({
      provider: "google",
      kind: "timeout",
      retryable: true,
      message: "The model provider did not answer before the call deadline.",
    });
  });

  describe("the wait a provider asks for", () => {
    const waitFor = (status: number, headers: unknown) =>
      classifyProviderError("openai", { status, message: "Slow down.", headers });

    it.each([
      ["retry-after-ms", { "retry-after-ms": "1500" }, 1_500],
      ["a zero retry-after-ms", { "retry-after-ms": "0" }, 0],
      ["retry-after seconds", { "retry-after": "3" }, 3_000],
      ["retry-after-ms over retry-after", {
        "retry-after-ms": "250",
        "retry-after": "9",
      }, 250],
      ["retry-after once retry-after-ms is not a number", {
        "retry-after-ms": "soon",
        "retry-after": "2",
      }, 2_000],
      ["a retry-after date", {
        "retry-after": "Wed, 30 Sep 2026 12:00:10 GMT",
      }, 10_000],
      ["a retry-after date already past", {
        "retry-after": "Wed, 30 Sep 2026 11:59:00 GMT",
      }, 0],
    ])("reads %s", (_, headers, retryAfterMs) => {
      vi.useFakeTimers({ now: Date.parse("2026-09-30T12:00:00Z") });
      try {
        expect(waitFor(429, new Headers(headers))).toMatchObject({
          kind: "rate_limit",
          retryAfterMs,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      ["no retry-after", new Headers()],
      ["a retry-after that is no time", new Headers({ "retry-after": "soon" })],
      ["a negative retry-after", new Headers({ "retry-after": "-1" })],
      ["headers that are not Headers", { "retry-after": "3" }],
    ])("reads none from %s", (_, headers) => {
      const failure = waitFor(429, headers);
      expect(failure).toMatchObject({ kind: "rate_limit", retryable: true });
      expect(failure).not.toHaveProperty("retryAfterMs");
    });

    it.each([
      [529, "overloaded"],
      [503, "unavailable"],
    ])("reads it from a %s", (status, kind) => {
      expect(waitFor(status, new Headers({ "retry-after": "4" }))).toMatchObject({
        kind,
        retryAfterMs: 4_000,
      });
    });

    it("gives no wait to a failure a retry cannot help", () => {
      expect(classifyProviderError("openai", {
        status: 400,
        message: "invalid request",
        headers: new Headers({ "retry-after": "4" }),
      })).not.toHaveProperty("retryAfterMs");
    });
  });

  it("keeps unrelated type errors non-retryable", () => {
    expect(classifyProviderError("openai", new TypeError("Invalid URL"))).toMatchObject({
      kind: "unknown",
      retryable: false,
    });
  });
});
