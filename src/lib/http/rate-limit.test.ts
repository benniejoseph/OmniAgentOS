import { describe, expect, it } from "vitest";
import { checkRateLimit } from "@/lib/http/rate-limit";

describe("checkRateLimit", () => {
  it("allows up to the limit then rejects with a retry hint", () => {
    const key = `test:${Math.random()}`;
    for (let index = 0; index < 5; index += 1) {
      expect(checkRateLimit({ key, limit: 5 }).allowed).toBe(true);
    }
    const rejected = checkRateLimit({ key, limit: 5 });
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks keys independently", () => {
    const first = `a:${Math.random()}`;
    const second = `b:${Math.random()}`;
    expect(checkRateLimit({ key: first, limit: 1 }).allowed).toBe(true);
    expect(checkRateLimit({ key: first, limit: 1 }).allowed).toBe(false);
    expect(checkRateLimit({ key: second, limit: 1 }).allowed).toBe(true);
  });

  it("frees the window after it elapses", () => {
    const key = `t:${Math.random()}`;
    expect(checkRateLimit({ key, limit: 1, windowMs: 1 }).allowed).toBe(true);
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait past the 1ms window
    }
    expect(checkRateLimit({ key, limit: 1, windowMs: 1 }).allowed).toBe(true);
  });
});
