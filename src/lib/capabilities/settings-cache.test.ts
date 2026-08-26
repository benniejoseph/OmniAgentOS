import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
  runWithTenantScope: vi.fn(
    (_tenantId: string, operation: () => Promise<unknown>) => operation(),
  ),
  unstableCache: vi.fn(
    (loader: (tenantId: string) => Promise<unknown>) =>
      (tenantId: string) => loader(tenantId),
  ),
}));

vi.mock("next/cache", () => ({
  unstable_cache: cacheMocks.unstableCache,
}));

vi.mock("@/lib/db/client", () => ({
  runWithDatabaseTenantScope: cacheMocks.runWithTenantScope,
}));

vi.mock("@/lib/capabilities/settings-snapshot", () => ({
  readSettingsStorageSnapshot: cacheMocks.readSnapshot,
}));

import { loadSharedSettingsStorageSnapshot } from "@/lib/capabilities/settings-cache";

const readySnapshot = {
  vectorStore: {
    configured: true,
    dimensions: 1_536,
    hnswSupported: true,
    status: "ready",
  },
  memory: { total: 0, byType: {}, embedded: 0, status: "ready" },
  knowledge: {
    documents: 0,
    chunks: 0,
    characters: 0,
    embedded: 0,
    status: "ready",
  },
};

beforeEach(() => {
  cacheMocks.readSnapshot.mockReset().mockResolvedValue(readySnapshot);
  cacheMocks.runWithTenantScope.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shared Settings storage cache", () => {
  it("uses a persistent cache and re-enters the exact tenant scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    await expect(loadSharedSettingsStorageSnapshot("tenant-a")).resolves.toEqual({
      checkedAt: "2026-08-26T12:00:00.000Z",
      snapshot: readySnapshot,
    });
    await expect(loadSharedSettingsStorageSnapshot("tenant-b")).resolves.toEqual({
      checkedAt: "2026-08-26T12:00:00.000Z",
      snapshot: readySnapshot,
    });

    expect(cacheMocks.unstableCache).toHaveBeenCalledOnce();
    expect(cacheMocks.unstableCache).toHaveBeenCalledWith(
      expect.any(Function),
      ["settings-storage-snapshot-v2"],
      { revalidate: 15 },
    );
    expect(cacheMocks.runWithTenantScope).toHaveBeenNthCalledWith(
      1,
      "tenant-a",
      expect.any(Function),
    );
    expect(cacheMocks.runWithTenantScope).toHaveBeenNthCalledWith(
      2,
      "tenant-b",
      expect.any(Function),
    );
    expect(cacheMocks.readSnapshot).toHaveBeenNthCalledWith(1, "tenant-a");
    expect(cacheMocks.readSnapshot).toHaveBeenNthCalledWith(2, "tenant-b");
  });

  it("rejects blank scopes before reaching the shared cache", () => {
    expect(() => loadSharedSettingsStorageSnapshot("   ")).toThrow(
      "A tenant id is required",
    );
    expect(cacheMocks.runWithTenantScope).not.toHaveBeenCalled();
  });

  it("bounds a stalled shared-cache fill so failures remain retryable", async () => {
    vi.useFakeTimers();
    cacheMocks.readSnapshot.mockReturnValue(new Promise(() => undefined));

    const pending = loadSharedSettingsStorageSnapshot("tenant-stalled");
    const assertion = expect(pending).rejects.toThrow(
      "Settings storage cache fill timed out",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    vi.useRealTimers();
    cacheMocks.readSnapshot.mockResolvedValue(readySnapshot);
    await expect(
      loadSharedSettingsStorageSnapshot("tenant-stalled"),
    ).resolves.toMatchObject({ snapshot: readySnapshot });
    expect(cacheMocks.readSnapshot).toHaveBeenCalledTimes(2);
  });
});
