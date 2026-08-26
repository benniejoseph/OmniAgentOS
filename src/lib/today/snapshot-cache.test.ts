import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => {
  const entries = new Map<string, unknown>();
  return {
    entries,
    revalidateTag: vi.fn(),
    unstableCache: vi.fn(
      (
        loader: () => Promise<unknown>,
        keyParts: string[],
        options: { revalidate: number; tags: string[] },
      ) => {
        void options;
        return async () => {
          const key = JSON.stringify(keyParts);
          if (entries.has(key)) return entries.get(key);
          const value = await loader();
          entries.set(key, value);
          return value;
        };
      },
    ),
  };
});

vi.mock("next/cache", () => ({
  revalidateTag: cacheMocks.revalidateTag,
  unstable_cache: cacheMocks.unstableCache,
}));

import {
  invalidateTodaySnapshot,
  invalidateTodaySnapshotsForTenant,
  loadCachedTodaySnapshot,
  todaySnapshotOwnerCacheTag,
  todaySnapshotTenantCacheTag,
} from "@/lib/today/snapshot-cache";

beforeEach(() => {
  cacheMocks.entries.clear();
  cacheMocks.revalidateTag.mockClear();
  cacheMocks.unstableCache.mockClear();
});

describe("Today snapshot cache", () => {
  it("reuses warm data only within the exact tenant and actor scope", async () => {
    const ownerA = { tenantId: "tenant-a", actorId: "owner-a" };
    const ownerB = { tenantId: "tenant-a", actorId: "owner-b" };
    const otherTenant = { tenantId: "tenant-b", actorId: "owner-a" };
    const loadA = vi.fn(async () => ({ owner: "a" }));
    const loadB = vi.fn(async () => ({ owner: "b" }));
    const loadOther = vi.fn(async () => ({ owner: "other" }));

    await expect(loadCachedTodaySnapshot(ownerA, loadA)).resolves.toEqual({ owner: "a" });
    await expect(loadCachedTodaySnapshot(ownerA, loadA)).resolves.toEqual({ owner: "a" });
    await expect(loadCachedTodaySnapshot(ownerB, loadB)).resolves.toEqual({ owner: "b" });
    await expect(loadCachedTodaySnapshot(otherTenant, loadOther)).resolves.toEqual({ owner: "other" });

    expect(loadA).toHaveBeenCalledOnce();
    expect(loadB).toHaveBeenCalledOnce();
    expect(loadOther).toHaveBeenCalledOnce();
    expect(cacheMocks.unstableCache).toHaveBeenNthCalledWith(
      1,
      loadA,
      ["today-snapshot-v1", "tenant-a", "owner-a"],
      {
        revalidate: 15,
        tags: [
          todaySnapshotOwnerCacheTag(ownerA),
          todaySnapshotTenantCacheTag(ownerA.tenantId),
        ],
      },
    );
  });

  it("hashes private scope identifiers in bounded stable tags", () => {
    const first = todaySnapshotOwnerCacheTag({
      tenantId: "private-tenant",
      actorId: "private-actor",
    });
    const repeated = todaySnapshotOwnerCacheTag({
      tenantId: "private-tenant",
      actorId: "private-actor",
    });
    const different = todaySnapshotOwnerCacheTag({
      tenantId: "private-tenant",
      actorId: "other-actor",
    });

    expect(first).toBe(repeated);
    expect(first).not.toBe(different);
    expect(first).not.toContain("private-tenant");
    expect(first).not.toContain("private-actor");
    expect(first.length).toBeLessThan(256);
  });

  it("immediately expires owner and tenant projections after mutations", () => {
    const scope = { tenantId: "tenant-a", actorId: "owner-a" };

    invalidateTodaySnapshot(scope);
    invalidateTodaySnapshotsForTenant(scope.tenantId);

    expect(cacheMocks.revalidateTag).toHaveBeenNthCalledWith(
      1,
      todaySnapshotOwnerCacheTag(scope),
      { expire: 0 },
    );
    expect(cacheMocks.revalidateTag).toHaveBeenNthCalledWith(
      2,
      todaySnapshotTenantCacheTag(scope.tenantId),
      { expire: 0 },
    );
  });
});
