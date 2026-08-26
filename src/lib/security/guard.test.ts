import { afterEach, describe, expect, it } from "vitest";
import {
  assertTrustedSessionMutation,
  shouldDeferAllowedAudit,
} from "@/lib/security/guard";

const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  if (originalAppUrl === undefined) {
    delete process.env.NEXT_PUBLIC_APP_URL;
  } else {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  }
});

describe("cookie-authenticated mutation origin checks", () => {
  it("accepts same-origin session mutations", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
    const request = mutationRequest("https://app.example.test");

    expect(() =>
      assertTrustedSessionMutation(request, { source: "session" }),
    ).not.toThrow();
  });

  it("rejects missing and sibling origins for session mutations", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";

    expect(() =>
      assertTrustedSessionMutation(
        new Request("https://app.example.test/api/tools", { method: "POST" }),
        { source: "session" },
      ),
    ).toThrow(/trusted application origin/i);

    expect(() =>
      assertTrustedSessionMutation(
        mutationRequest("https://attacker.example.test"),
        { source: "session" },
      ),
    ).toThrow(/trusted application origin/i);
  });

  it("exempts safe methods and internally authenticated callers", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";

    expect(() =>
      assertTrustedSessionMutation(
        new Request("https://app.example.test/api/tools"),
        { source: "session" },
      ),
    ).not.toThrow();
    expect(() =>
      assertTrustedSessionMutation(
        new Request("https://app.example.test/api/tools", { method: "POST" }),
        { source: "headers" },
      ),
    ).not.toThrow();
  });

  it("can protect cookie-only routes such as logout", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";

    expect(() =>
      assertTrustedSessionMutation(mutationRequest("https://app.example.test")),
    ).not.toThrow();
    expect(() =>
      assertTrustedSessionMutation(mutationRequest("https://evil.example.test")),
    ).toThrow(/trusted application origin/i);
  });
});

describe("allowed audit scheduling", () => {
  it("defers only routine safe reads", () => {
    expect(
      shouldDeferAllowedAudit({ method: "GET" }, "read", 0),
    ).toBe(true);
    expect(
      shouldDeferAllowedAudit({ method: "POST" }, "read", 0),
    ).toBe(false);
    expect(
      shouldDeferAllowedAudit({ method: "GET" }, "manage.security", 0),
    ).toBe(false);
    expect(
      shouldDeferAllowedAudit({ method: "HEAD" }, "read", 2),
    ).toBe(false);
  });
});

function mutationRequest(origin: string) {
  return new Request("https://app.example.test/api/tools", {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
    },
  });
}
