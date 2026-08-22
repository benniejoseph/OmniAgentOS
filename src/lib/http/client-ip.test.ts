import { afterEach, describe, expect, it } from "vitest";
import { getTrustedClientIp } from "@/lib/http/client-ip";

const originalVercel = process.env.VERCEL;
const originalVercelEnv = process.env.VERCEL_ENV;
const originalTrustProxy = process.env.OMNIAGENT_TRUST_PROXY_HEADERS;

afterEach(() => {
  restore("VERCEL", originalVercel);
  restore("VERCEL_ENV", originalVercelEnv);
  restore("OMNIAGENT_TRUST_PROXY_HEADERS", originalTrustProxy);
});

describe("getTrustedClientIp", () => {
  it("does not let a request header impersonate a trusted platform", () => {
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.OMNIAGENT_TRUST_PROXY_HEADERS;
    const request = new Request("https://app.example.test", {
      headers: {
        "x-vercel-id": "attacker-controlled",
        "x-forwarded-for": "203.0.113.8",
      },
    });

    expect(getTrustedClientIp(request)).toBe("unavailable");
  });

  it("uses the first platform-overwritten forwarding address on Vercel", () => {
    process.env.VERCEL = "1";
    const request = new Request("https://app.example.test", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.8, 198.51.100.4",
        "x-forwarded-for": "192.0.2.99",
      },
    });

    expect(getTrustedClientIp(request)).toBe("203.0.113.8");
  });

  it("trusts forwarding headers only when a non-Vercel proxy is configured", () => {
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    process.env.OMNIAGENT_TRUST_PROXY_HEADERS = "true";
    const request = new Request("https://app.example.test", {
      headers: { "x-real-ip": "198.51.100.7" },
    });

    expect(getTrustedClientIp(request)).toBe("198.51.100.7");
  });

  it("rejects malformed forwarding values instead of creating attacker-chosen keys", () => {
    process.env.VERCEL = "1";
    const request = new Request("https://app.example.test", {
      headers: {
        "x-vercel-forwarded-for": "one-key-per-request.example",
      },
    });

    expect(getTrustedClientIp(request)).toBe("unavailable");
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
