import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANION_PREFERENCES_CONTRACT, DEFAULT_COMPANION_PREFERENCES } from "./contracts";
import { companionEntryDestination, explicitCompanionReturn, readCompanionEntryDestination, safeCompanionReturn } from "./navigation";

const preferences = {
  schemaVersion: 1, contract: COMPANION_PREFERENCES_CONTRACT,
  snapshot: { revision: 0, persisted: false, updatedAt: null, preferences: DEFAULT_COMPANION_PREFERENCES },
  home: { state: "not_set", preferredThreadId: null, href: null, fallbackHref: "/app/command" },
  destination: { href: "/app/command", state: "configured" },
};
afterEach(() => vi.useRealTimers());
describe("Companion entry navigation", () => {
  it("preserves exact safe app deep links ahead of saved defaults", () => {
    const next = "/app/command?thread=22222222-2222-4222-8222-222222222222&run=run-a#reply";
    expect(safeCompanionReturn(next)).toBe(next);
    expect(companionEntryDestination(`?next=${encodeURIComponent(next)}`, preferences)).toBe(next);
    expect(companionEntryDestination("?returnTo=%2Fapp%23today-focus", preferences)).toBe("/app#today-focus");
    expect(companionEntryDestination("?next=%2Fapp", preferences)).toBe("/app");
    expect(explicitCompanionReturn("?next=https%3A%2F%2Fevil.test&returnTo=%2Fapp%2Factivity")).toBe("/app/activity");
    for (const encoded of ["/app/meetings/meeting%3Aweekly?view=notes#summary", "/app/results/agent%3Arun%2Fopaque?tab=evidence#artifact", "/app/meetings/Meeting%20notes"]) {
      expect(safeCompanionReturn(encoded)).toBe(encoded);
      expect(companionEntryDestination(`?next=${encodeURIComponent(encoded)}`, preferences)).toBe(encoded);
    }
  });
  it("rejects external, executable, normalized or ambiguous path destinations", () => {
    const deniedPaths = [
      "https://evil.test/app",
      "//evil.test/app",
      "javascript:alert(1)",
      "/application",
      "/api/auth/logout",
      "/app/../api",
      "/app/./command",
      "/app//command",
      "/app\\evil",
      "/app/%2e%2e/login",
      "/app/%252e%252e/login",
      "/app/%252fcommand",
      "/app/run%2F..%2Fapi",
      "/app/%255cfixture",
      "/app/%250Afixture",
      "/app\n",
      "/app/%zz",
    ];
    for (const path of deniedPaths) expect(safeCompanionReturn(path)).toBeUndefined();
  });
  it("uses only validated saved destinations and otherwise retains ordinary Today", () => {
    expect(companionEntryDestination("", preferences)).toBe("/app/command");
    expect(companionEntryDestination("", {})).toBe("/app");
    expect(companionEntryDestination("", { ...preferences, destination: { href: "https://evil.test", state: "configured" } })).toBe("/app");
    const id = "22222222-2222-4222-8222-222222222222";
    const home = { ...preferences, snapshot: { revision: 1, persisted: true, updatedAt: "2026-10-03T10:00:00.000Z", preferences: { ...DEFAULT_COMPANION_PREFERENCES, preferredThreadId: id } }, home: { state: "available", preferredThreadId: id, href: `/app/command?thread=${id}`, fallbackHref: "/app/command" }, destination: { href: `/app/command?thread=${id}`, state: "configured" } };
    expect(companionEntryDestination("", home)).toBe(`/app/command?thread=${id}`);
    expect(companionEntryDestination("", { ...home, home: { ...home.home, state: "unavailable", href: null }, destination: { href: "/app/command", state: "fallback" } })).toBe("/app/command");
  });
  it("skips all preference requests for explicit destinations and reads only GET otherwise", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(preferences));
    const controller = new AbortController();
    expect(await readCompanionEntryDestination("?next=%2Fapp%2Fprojects", controller.signal, fetcher)).toBe("/app/projects");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readCompanionEntryDestination("", controller.signal, fetcher)).toBe("/app/command");
    expect(fetcher).toHaveBeenCalledWith("/api/companion/preferences", expect.objectContaining({ cache: "no-store", headers: { accept: "application/json" } }));
    expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
  });
  it("falls back after bounded read failure and discards a body returned after disposal", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const pending = readCompanionEntryDestination("", new AbortController().signal, fetcher);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBe("/app");
    const controller = new AbortController();
    const response = Response.json(preferences);
    vi.spyOn(response, "json").mockImplementation(async () => { controller.abort(); return preferences; });
    expect(await readCompanionEntryDestination("", controller.signal, vi.fn<typeof fetch>().mockResolvedValue(response))).toBe("/app");
  });
});
