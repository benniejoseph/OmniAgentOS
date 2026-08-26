import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadSettingsStorageSnapshot,
  readSettingsStorageSnapshot,
} from "@/lib/capabilities/settings-snapshot";

const readySnapshot = {
  vectorStore: {
    configured: true,
    extensionInstalled: true,
    extensionVersion: "0.8.1",
    dimensions: 1_536,
    hnswSupported: true,
    memoryColumnDimensions: 1_536,
    knowledgeColumnDimensions: 1_536,
    memoryIndexed: true,
    knowledgeIndexed: true,
    status: "ready" as const,
  },
  memory: {
    total: 4,
    byType: { fact: 3, decision: 1 },
    embedded: 4,
    status: "ready" as const,
  },
  knowledge: {
    documents: 2,
    chunks: 7,
    characters: 900,
    embedded: 7,
    status: "ready" as const,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("settings storage snapshot", () => {
  it("reads the local tenant snapshot without a cache boundary", async () => {
    const previousDataDir = process.env.OMNIAGENT_DATA_DIR;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-settings-snapshot-"),
    );
    delete process.env.DATABASE_URL;

    try {
      await expect(
        readSettingsStorageSnapshot("tenant-local"),
      ).resolves.toMatchObject({
        vectorStore: { configured: false, status: "not_configured" },
        memory: { total: 0, status: "ready" },
        knowledge: { documents: 0, status: "ready" },
      });
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.OMNIAGENT_DATA_DIR;
      } else {
        process.env.OMNIAGENT_DATA_DIR = previousDataDir;
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });

  it("caches successful reads by tenant without crossing tenant keys", async () => {
    const loader = vi.fn(async () => readySnapshot);

    const first = await loadSettingsStorageSnapshot("cache-tenant-a", {
      loader,
      timeoutMs: 100,
    });
    const second = await loadSettingsStorageSnapshot("cache-tenant-b", {
      loader,
      timeoutMs: 100,
    });
    const repeated = await loadSettingsStorageSnapshot("cache-tenant-a", {
      loader,
      timeoutMs: 100,
    });

    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenNthCalledWith(1, "cache-tenant-a");
    expect(loader).toHaveBeenNthCalledWith(2, "cache-tenant-b");
    expect(first).toMatchObject({
      memory: { total: 4, status: "ready" },
      storageSnapshot: { status: "ready", source: "local" },
    });
    expect(second).toMatchObject({
      knowledge: { documents: 2, status: "ready" },
      storageSnapshot: { status: "ready", source: "local" },
    });
    expect(repeated).toEqual(first);
  });

  it("returns an explicit unavailable snapshot when the bounded read stalls", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let finish!: (value: typeof readySnapshot) => void;
    const loader = vi.fn(
      () =>
        new Promise<typeof readySnapshot>((resolve) => {
          finish = resolve;
        }),
    );

    const pending = loadSettingsStorageSnapshot("tenant-timeout", {
      loader,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toMatchObject({
      vectorStore: {
        configured: null,
        status: "unavailable",
        unavailableReason: "timeout",
      },
      memory: {
        total: null,
        status: "unavailable",
        unavailableReason: "timeout",
      },
      knowledge: {
        documents: null,
        status: "unavailable",
        unavailableReason: "timeout",
      },
      storageSnapshot: {
        status: "degraded",
        reason: "timeout",
      },
    });
    finish(readySnapshot);
  });

  it("classifies read failures without returning or logging provider details", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const loader = vi
      .fn<() => Promise<typeof readySnapshot>>()
      .mockRejectedValueOnce(new Error("postgres://private-host/secret"))
      .mockResolvedValueOnce(readySnapshot);

    const result = await loadSettingsStorageSnapshot("tenant-error", {
      loader,
      timeoutMs: 100,
    });
    const retry = await loadSettingsStorageSnapshot("tenant-error", {
      loader,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      memory: { total: null, unavailableReason: "error" },
      storageSnapshot: { status: "degraded", reason: "error" },
    });
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-host");
    expect(loader).toHaveBeenCalledTimes(2);
    expect(retry.storageSnapshot.status).toBe("ready");
  });
});
