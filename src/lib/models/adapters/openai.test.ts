import { describe, expect, it } from "vitest";
import { classifyProviderError } from "@/lib/models/adapters/openai";

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
