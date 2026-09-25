import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => {
  const entries = new Map<string, unknown>();
  const invocationKeys: string[] = [];
  return {
    entries,
    invocationKeys,
    unstableCache: vi.fn(
      (
        callback: (...args: unknown[]) => Promise<unknown>,
        keyParts: string[] = [],
      ) =>
        async (...args: unknown[]) => {
          // Next keys an entry by the callback source, key parts, and arguments.
          const key = `${callback.toString()}-${keyParts.join(",")}-${JSON.stringify(args)}`;
          invocationKeys.push(key);
          if (!entries.has(key)) entries.set(key, await callback(...args));
          return entries.get(key);
        },
    ),
  };
});

vi.mock("next/cache", () => ({
  unstable_cache: cacheMocks.unstableCache,
}));

import { actorScopedCache } from "@/lib/db/actor-scoped-cache";
import {
  getDatabaseActorContext,
  runWithDatabaseActorScope,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";

beforeEach(() => {
  cacheMocks.entries.clear();
  cacheMocks.invocationKeys.length = 0;
  cacheMocks.unstableCache.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Stands in for a row-level-security read: it returns only the rows the
// active actor scope may see.
function scopedRead() {
  return vi.fn(async (label: string) => ({
    label,
    visibleTo: getDatabaseActorContext(),
  }));
}

describe("actor-scoped data cache", () => {
  it("keeps one actor's filled entry away from another actor", async () => {
    const load = scopedRead();
    const cached = actorScopedCache(load, ["scope-test-v1"], { revalidate: 15 });

    const first = await runWithDatabaseActorScope("tenant-a", ["actor-a"], () =>
      cached("summary"));
    const repeat = await runWithDatabaseActorScope("tenant-a", ["actor-a"], () =>
      cached("summary"));
    const other = await runWithDatabaseActorScope("tenant-a", ["actor-b"], () =>
      cached("summary"));
    const otherTenant = await runWithDatabaseActorScope(
      "tenant-b",
      ["actor-a"],
      () => cached("summary"),
    );

    expect(first).toEqual({ label: "summary", visibleTo: ["actor-a"] });
    expect(repeat).toEqual(first);
    expect(other).toEqual({ label: "summary", visibleTo: ["actor-b"] });
    expect(otherTenant).toEqual({ label: "summary", visibleTo: ["actor-a"] });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("shares one entry for the same readable actor set in any order", async () => {
    const load = scopedRead();
    const cached = actorScopedCache(load, ["scope-test-v1"], { revalidate: 15 });

    await runWithDatabaseActorScope("tenant-a", ["web-actor", "app-actor"], () =>
      cached("summary"));
    const reordered = await runWithDatabaseActorScope(
      "tenant-a",
      ["app-actor", "web-actor"],
      () => cached("summary"),
    );

    expect(load).toHaveBeenCalledOnce();
    expect(reordered).toEqual({
      label: "summary",
      visibleTo: ["app-actor", "web-actor"],
    });
  });

  it("fills under the keyed scope wherever Next runs the fill", async () => {
    const load = scopedRead();
    const cached = actorScopedCache(load, ["scope-test-v1"], { revalidate: 15 });
    await runWithDatabaseActorScope("tenant-a", ["actor-a"], () =>
      cached("summary"));
    const fill = cacheMocks.unstableCache.mock.calls[0][0];

    // A background revalidation outside the request scope still reads as A.
    await expect(fill("summary")).resolves.toEqual({
      label: "summary",
      visibleTo: ["actor-a"],
    });
  });

  it("keeps actor ids out of the cache key", async () => {
    const cached = actorScopedCache(scopedRead(), ["scope-test-v1"], {
      revalidate: 15,
    });

    await runWithDatabaseActorScope("tenant-a", ["person@example.com"], () =>
      cached("summary"));

    expect(cacheMocks.invocationKeys).toHaveLength(1);
    expect(cacheMocks.invocationKeys[0]).toContain("scope-test-v1");
    expect(cacheMocks.invocationKeys[0]).not.toContain("person@example.com");
  });

  it("reads uncached without an actor scope", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const load = scopedRead();
    const cached = actorScopedCache(load, ["scope-test-v1"], { revalidate: 15 });

    await cached("summary");
    await cached("summary");
    await runWithDatabaseSystemScope("actor-scoped cache test", () =>
      cached("summary"));

    expect(load).toHaveBeenCalledTimes(3);
    expect(cacheMocks.unstableCache).not.toHaveBeenCalled();
  });
});
