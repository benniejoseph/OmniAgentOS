import { describe, expect, it } from "vitest";
import { createOpaqueToken, hashPassword, hashSessionToken, verifyPassword } from "@/lib/auth/crypto";

describe("auth crypto", () => {
  it("verifies a hashed password round-trip", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("anything", "")).toBe(false);
    expect(await verifyPassword("anything", "md5$salt$hash")).toBe(false);
    expect(await verifyPassword("anything", "scrypt-v1$missing-hash")).toBe(false);
  });

  it("produces unique salted hashes for the same password", async () => {
    const first = await hashPassword("same password");
    const second = await hashPassword("same password");
    expect(first).not.toEqual(second);
  });

  it("creates url-safe opaque tokens and stable digests", () => {
    const token = createOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hashSessionToken(token)).toEqual(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toEqual(hashSessionToken(createOpaqueToken()));
  });
});
