import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  hasDatabaseUrl: vi.fn(() => false),
  sql: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: () => mocks.sql,
  hasDatabaseUrl: mocks.hasDatabaseUrl,
}));

import { tenantHasAtMostOneActiveMember } from "@/lib/auth/tenant-membership";

function membership(tenantId: string, userId: string, status = "active") {
  return {
    id: `${tenantId}:${userId}`,
    tenantId,
    userId,
    role: "admin",
    status,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  };
}

describe("tenant membership count", () => {
  let dataDir: string;
  const previousDataDir = process.env.OMNIAGENT_DATA_DIR;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.hasDatabaseUrl.mockReturnValue(false);
    dataDir = await mkdtemp(path.join(tmpdir(), "omni-tenant-membership-"));
    process.env.OMNIAGENT_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) {
      delete process.env.OMNIAGENT_DATA_DIR;
    } else {
      process.env.OMNIAGENT_DATA_DIR = previousDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it("counts only a tenant's active members in the file ledger", async () => {
    await expect(tenantHasAtMostOneActiveMember("tenant-a")).resolves.toBe(true);

    await writeFile(path.join(dataDir, "auth.json"), JSON.stringify({
      tenants: [],
      users: [],
      memberships: [
        membership("tenant-a", "user-1"),
        membership("tenant-a", "user-2", "disabled"),
        membership("tenant-b", "user-2"),
        membership("tenant-c", "user-3"),
        membership("tenant-c", "user-4"),
      ],
      sessions: [],
    }));

    await expect(tenantHasAtMostOneActiveMember("tenant-a")).resolves.toBe(true);
    await expect(tenantHasAtMostOneActiveMember("tenant-b")).resolves.toBe(true);
    await expect(tenantHasAtMostOneActiveMember("tenant-c")).resolves.toBe(false);
    await expect(tenantHasAtMostOneActiveMember("tenant-d")).resolves.toBe(true);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("asks the database for at most two of the tenant's active members", async () => {
    mocks.hasDatabaseUrl.mockReturnValue(true);
    for (const [rows, expected] of [[[], true], [[{}], true], [[{}, {}], false]] as const) {
      mocks.sql.mockResolvedValueOnce([...rows]);
      await expect(tenantHasAtMostOneActiveMember("tenant-c")).resolves.toBe(expected);
    }

    expect(mocks.ensureDatabaseSchema).toHaveBeenCalledTimes(3);
    const [strings, ...params] = mocks.sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?").replace(/\s+/g, " ").trim()).toBe(
      "SELECT 1 FROM omni_auth_memberships WHERE tenant_id = ? AND status = 'active' LIMIT 2",
    );
    expect(params).toEqual(["tenant-c"]);
  });
});
