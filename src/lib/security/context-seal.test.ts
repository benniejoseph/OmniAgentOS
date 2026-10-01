import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findInjectionCanary,
  injectionCanaryRunLatched,
  injectionCanaryToken,
  latchInjectionCanaryRun,
  renderInjectionCanary,
} from "@/lib/security/context-seal";

const TENANT = "tenant-canary-a";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("injection canary token", () => {
  it("is a stable per-tenant base32 token under the server secret", () => {
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "secret-one");
    const token = injectionCanaryToken(TENANT);

    expect(token).toMatch(/^[a-z2-7]{24}$/);
    expect(injectionCanaryToken(` ${TENANT} `)).toBe(token);
    expect(injectionCanaryToken("tenant-canary-b")).not.toBe(token);
    expect(injectionCanaryToken("")).toBe(injectionCanaryToken("default"));
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "secret-two");
    expect(injectionCanaryToken(TENANT)).not.toBe(token);
  });

  it.each([
    ["NODE_ENV", "production"],
    ["VERCEL", "1"],
    ["VERCEL_ENV", "production"],
  ])("needs the server secret in production (%s)", (name, value) => {
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    expect(injectionCanaryToken(TENANT)).toMatch(/^[a-z2-7]{24}$/);

    vi.stubEnv(name, value);

    expect(() => injectionCanaryToken(TENANT)).toThrow(/OMNIAGENT_INTERNAL_AUTH_SECRET/);
  });

  it("renders the token in the planted line", () => {
    expect(renderInjectionCanary(TENANT)).toContain(injectionCanaryToken(TENANT));
  });
});

describe("finding the injection canary", () => {
  const token = injectionCanaryToken(TENANT);
  const find = (value: unknown) => findInjectionCanary(TENANT, value);

  it("finds the token as written, in any case, in a nested string or a key", () => {
    expect(find({ body: `notes ${token} end` })).toBe("plain");
    expect(find({ to: ["a@example.test"], body: { text: [token.toUpperCase()] } })).toBe("plain");
    expect(find({ [token]: true })).toBe("plain");
  });

  it("finds the token broken up, widened, or URL-encoded", () => {
    expect(find({ q: token.split("").join(" ") })).toBe("separated");
    expect(find({ q: `${token.slice(0, 9)}​${token.slice(9)}` })).toBe("separated");
    // Fullwidth forms fold to ASCII.
    const fullwidth = [...token].map((char) =>
      String.fromCodePoint(char.codePointAt(0)! + 0xfee0)
    ).join("");
    expect(find({ q: fullwidth })).toBe("plain");
    const encoded = [...token].map((char) =>
      `%${char.charCodeAt(0).toString(16)}`
    ).join("");
    expect(find({ url: `https://collector.example/?d=${encoded}` })).toBe("plain");
    expect(find({ url: `https://collector.example/?d=${encodeURIComponent(encoded)}` }))
      .toBe("plain");
    // A value that does not decode is read as written.
    expect(find({ q: `%e0%a4 ${token}` })).toBe("plain");
    expect(find({ q: `%e0%a4 ${encoded}` })).toBe("hex");
  });

  it("finds the token in hex", () => {
    expect(find({ d: `ff${Buffer.from(token).toString("hex")}00` })).toBe("hex");
    expect(find({ d: Buffer.from(token).toString("hex").toUpperCase() })).toBe("hex");
  });

  it("finds the token at every base64 alignment, in either alphabet", () => {
    for (const prefix of ["", "a", "ab", "abc"]) {
      for (const suffix of ["", "z", "zy"]) {
        const bytes = Buffer.from(`${prefix}${token}${suffix}`);
        expect(find({ d: bytes.toString("base64") }), `${prefix}|${suffix}`).toBe("base64");
        expect(find({ d: bytes.toString("base64url") }), `${prefix}|${suffix} url`).toBe("base64");
      }
    }
    const wrapped = Buffer.from(`context: ${token}`).toString("base64").replace(/(.{8})/g, "$1\n");
    expect(find({ d: wrapped })).toBe("base64");
  });

  it("ignores another tenant's token, a partial token, and values with no text", () => {
    expect(find({ body: injectionCanaryToken("tenant-canary-b") })).toBeUndefined();
    expect(find({ body: token.slice(0, 23) })).toBeUndefined();
    expect(find({ body: Buffer.from(token.slice(1)).toString("base64") })).toBeUndefined();
    expect(find({ count: 3, ok: true, none: null })).toBe(undefined);
    expect(find(undefined)).toBeUndefined();
    expect(find({ q: "100% sure %e0%a4" })).toBeUndefined();
  });
});

describe("injection canary run latch", () => {
  it("latches a run in its own tenant only", () => {
    latchInjectionCanaryRun(TENANT, "run-latch-a");

    expect(injectionCanaryRunLatched(TENANT, "run-latch-a")).toBe(true);
    expect(injectionCanaryRunLatched(` ${TENANT}`, "run-latch-a")).toBe(true);
    expect(injectionCanaryRunLatched("tenant-canary-b", "run-latch-a")).toBe(false);
    expect(injectionCanaryRunLatched(TENANT, "run-latch-b")).toBe(false);
  });

  it("keeps the most recently latched runs when it is full", () => {
    latchInjectionCanaryRun(TENANT, "run-latch-kept");
    for (let index = 0; index < 511; index += 1) {
      latchInjectionCanaryRun(TENANT, `run-latch-fill-${index}`);
    }
    // A run latched again moves to the newest end, so the next run evicts
    // the oldest fill instead.
    latchInjectionCanaryRun(TENANT, "run-latch-kept");
    latchInjectionCanaryRun(TENANT, "run-latch-new");

    expect(injectionCanaryRunLatched(TENANT, "run-latch-kept")).toBe(true);
    expect(injectionCanaryRunLatched(TENANT, "run-latch-fill-0")).toBe(false);
    expect(injectionCanaryRunLatched(TENANT, "run-latch-fill-1")).toBe(true);
    expect(injectionCanaryRunLatched(TENANT, "run-latch-new")).toBe(true);
  });
});
