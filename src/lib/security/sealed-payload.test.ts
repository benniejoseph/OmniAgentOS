import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSealedPayload,
  openJsonPayload,
  sealJsonPayload,
} from "@/lib/security/sealed-payload";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sealed execution payloads", () => {
  it("round-trips JSON without storing plaintext", () => {
    vi.stubEnv(
      "OMNIAGENT_EXECUTION_PAYLOAD_SECRET",
      "a-production-grade-test-secret-with-32-bytes",
    );
    const input = {
      url: "https://api.example.test",
      headers: { authorization: "Bearer exact-secret-value" },
    };

    const sealed = sealJsonPayload(input);

    expect(JSON.stringify(sealed)).not.toContain("exact-secret-value");
    expect(isSealedPayload(sealed)).toBe(true);
    expect(openJsonPayload(sealed)).toEqual(input);
  });

  it("rejects tampered ciphertext", () => {
    vi.stubEnv(
      "OMNIAGENT_EXECUTION_PAYLOAD_SECRET",
      "a-production-grade-test-secret-with-32-bytes",
    );
    const sealed = sealJsonPayload({ value: "original" });
    const tamperedBytes = Buffer.from(sealed.ciphertext, "base64url");
    tamperedBytes[0] ^= 1;
    const tampered = {
      ...sealed,
      ciphertext: tamperedBytes.toString("base64url"),
    };

    expect(() => openJsonPayload(tampered)).toThrow(/could not be authenticated/i);
  });

  it("rejects non-canonical base64url encodings", () => {
    vi.stubEnv(
      "OMNIAGENT_EXECUTION_PAYLOAD_SECRET",
      "a-production-grade-test-secret-with-32-bytes",
    );
    const sealed = sealJsonPayload({ value: "original" });
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(sealed.tag.at(-1) || "");
    const nonCanonical = {
      ...sealed,
      tag: `${sealed.tag.slice(0, -1)}${alphabet[lastIndex + 1]}`,
    };

    expect(Buffer.from(nonCanonical.tag, "base64url")).toEqual(
      Buffer.from(sealed.tag, "base64url"),
    );
    expect(isSealedPayload(nonCanonical)).toBe(false);
    expect(() => openJsonPayload(nonCanonical)).toThrow(/payload is invalid/i);
  });

  it("binds ciphertext to the approved execution identity", () => {
    vi.stubEnv(
      "OMNIAGENT_EXECUTION_PAYLOAD_SECRET",
      "a-production-grade-test-secret-with-32-bytes",
    );
    const sealed = sealJsonPayload(
      { value: "original" },
      "execution:approved",
    );

    expect(() =>
      openJsonPayload(sealed, "execution:different"),
    ).toThrow(/could not be authenticated/i);
  });

  it("fails closed without a production encryption secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_EXECUTION_PAYLOAD_SECRET", "");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");

    expect(() => sealJsonPayload({ value: "blocked" })).toThrow(
      /must be configured/i,
    );
  });
});
