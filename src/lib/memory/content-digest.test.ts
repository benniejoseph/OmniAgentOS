import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryContentDigest } from "@/lib/memory/content-digest";

const SECRET = "content-digest-test-secret-0123456789abcdef";
const FACT = "The office day is Tuesday.";

afterEach(() => {
  vi.unstubAllEnvs();
});

function withSecret(secret: string) {
  vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", secret);
}

describe("memory content digests", () => {
  it("cannot be recomputed from the text alone", () => {
    withSecret(SECRET);
    const digest = memoryContentDigest("tenant-a", FACT);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(memoryContentDigest("tenant-a", FACT));
    expect(digest).not.toBe(createHash("sha256").update(FACT).digest("hex"));
    expect(memoryContentDigest("tenant-a", `${FACT} `)).not.toBe(digest);
  });

  it("differs per tenant and per server secret", () => {
    withSecret(SECRET);
    const digest = memoryContentDigest("tenant-a", FACT);

    expect(memoryContentDigest("tenant-b", FACT)).not.toBe(digest);
    withSecret(`${SECRET}-rotated`);
    expect(memoryContentDigest("tenant-a", FACT)).not.toBe(digest);
  });

  it("refuses to digest in production without the server secret", () => {
    withSecret(" ");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => memoryContentDigest("tenant-a", FACT))
      .toThrow("OMNIAGENT_INTERNAL_AUTH_SECRET must be configured");

    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "1");
    expect(() => memoryContentDigest("tenant-a", FACT))
      .toThrow("OMNIAGENT_INTERNAL_AUTH_SECRET must be configured");
  });

  it("uses a local key outside production", () => {
    withSecret("");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    const local = memoryContentDigest("tenant-a", FACT);

    expect(local).toMatch(/^[0-9a-f]{64}$/);
    withSecret(SECRET);
    expect(memoryContentDigest("tenant-a", FACT)).not.toBe(local);
  });
});
