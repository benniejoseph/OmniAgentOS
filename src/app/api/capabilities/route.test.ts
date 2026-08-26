import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  after: vi.fn(),
  loadSettingsSnapshot: vi.fn(),
  loadSharedSnapshot: vi.fn(),
}));

vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  unstable_cache: (loader: (...args: unknown[]) => unknown) => loader,
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: routeMocks.after,
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (request: Request) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/context")>()),
  canPerform: () => true,
  requirePermission: () => undefined,
  resolveSecurityContext: async () => ({
    tenantId: "tenant-a",
    actorId: "owner-a",
    role: "admin",
  }),
}));

vi.mock("@/lib/capabilities/settings-snapshot", () => ({
  loadSettingsStorageSnapshot: routeMocks.loadSettingsSnapshot,
}));

vi.mock("@/lib/capabilities/settings-cache", () => ({
  loadSharedSettingsStorageSnapshot: routeMocks.loadSharedSnapshot,
}));

import { GET } from "@/app/api/capabilities/route";

const degradedSnapshot = {
  vectorStore: {
    configured: null,
    dimensions: 1_536,
    hnswSupported: true,
    status: "unavailable",
    unavailableReason: "timeout",
  },
  memory: {
    total: null,
    byType: null,
    embedded: null,
    status: "unavailable",
    unavailableReason: "timeout",
  },
  knowledge: {
    documents: null,
    chunks: null,
    characters: null,
    embedded: null,
    status: "unavailable",
    unavailableReason: "timeout",
  },
  storageSnapshot: {
    status: "degraded",
    source: "postgres",
    reason: "timeout",
    checkedAt: "2026-08-26T12:00:00.000Z",
  },
};

beforeEach(() => {
  routeMocks.after.mockReset();
  routeMocks.loadSettingsSnapshot.mockReset();
  routeMocks.loadSharedSnapshot.mockReset();
});

describe("Settings capabilities cache fill", () => {
  it("keeps the exact shared fill alive after a bounded degraded response", async () => {
    let resolveFill!: (value: unknown) => void;
    const fill = new Promise((resolve) => {
      resolveFill = resolve;
    });
    routeMocks.loadSharedSnapshot.mockReturnValue(fill);
    routeMocks.loadSettingsSnapshot.mockImplementation(
      async (tenantId: string, options: { loader: (id: string) => Promise<unknown> }) => {
        expect(tenantId).toBe("tenant-a");
        expect(options.loader(tenantId)).toBe(fill);
        return degradedSnapshot;
      },
    );

    const response = await GET(
      new Request("http://localhost/api/capabilities?view=settings"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      storageSnapshot: { status: "degraded", reason: "timeout" },
    });
    expect(routeMocks.loadSharedSnapshot).toHaveBeenCalledWith("tenant-a");
    expect(routeMocks.after).toHaveBeenCalledOnce();

    resolveFill({});
    await expect(routeMocks.after.mock.calls[0][0]()).resolves.toBeUndefined();
  });

  it("sanitizes a failed post-response fill", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fill = Promise.reject(new Error("postgres://private-host/secret"));
    routeMocks.loadSharedSnapshot.mockReturnValue(fill);
    routeMocks.loadSettingsSnapshot.mockImplementation(
      async (tenantId: string, options: { loader: (id: string) => Promise<unknown> }) => {
        void options.loader(tenantId);
        return degradedSnapshot;
      },
    );

    await GET(new Request("http://localhost/api/capabilities?view=settings"));
    await expect(routeMocks.after.mock.calls[0][0]()).resolves.toBeUndefined();

    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).toContain(
      "capabilities.settings_storage_cache_fill_failed",
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-host");
    warning.mockRestore();
  });
});
