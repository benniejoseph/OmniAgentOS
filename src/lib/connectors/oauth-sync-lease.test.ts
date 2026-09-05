import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let dataDir = "";

beforeAll(async () => {
  dataDir = await mkdtemp(
    path.join(tmpdir(), "asael-oauth-sync-lease-"),
  );
  process.env.OMNIAGENT_DATA_DIR = dataDir;
  delete process.env.DATABASE_URL;
});

describe("OAuth source synchronization lease", () => {
  it("fences cursor writes and permits a later generation after release", async () => {
    const store = await import("@/lib/connectors/oauth-store");
    const owner = {
      tenantId: "tenant-sync",
      actorId: "actor-sync",
      provider: "google" as const,
    };
    await store.saveOAuthGrant({
      ...owner,
      tokens: {
        access_token: "test-access-token",
        scope: "drive.readonly",
        expires_in: 3_600,
      },
    });

    const first = await store.claimOAuthSyncLease(owner);
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("Expected first lease.");
    await expect(store.claimOAuthSyncLease(owner)).resolves.toEqual({
      status: "busy",
    });

    await expect(store.updateOAuthSyncState({
      ...owner,
      status: "syncing",
      cursor: JSON.stringify({ drivePageToken: "wrong-fence" }),
      lease: { ...first.lease, ownerId: "different-owner" },
    })).resolves.toBeUndefined();
    await expect(store.getOAuthGrantSecrets(
      owner.tenantId,
      owner.actorId,
      owner.provider,
    )).resolves.toMatchObject({ syncCursor: undefined });

    await expect(store.updateOAuthSyncState({
      ...owner,
      status: "syncing",
      cursor: JSON.stringify({ drivePageToken: "page-2" }),
      lease: first.lease,
    })).resolves.toMatchObject({ syncStatus: "syncing" });
    await expect(store.getOAuthGrantSecrets(
      owner.tenantId,
      owner.actorId,
      owner.provider,
    )).resolves.toMatchObject({
      syncCursor: JSON.stringify({ drivePageToken: "page-2" }),
    });
    const rawLedger = await readFile(
      path.join(dataDir, "oauth-grants.json"),
      "utf8",
    );
    expect(rawLedger).toContain("sealedSyncCursor");
    expect(rawLedger).not.toContain("drivePageToken");
    expect(rawLedger).not.toContain("page-2");
    await expect(store.updateOAuthSyncState({
      ...owner,
      status: "healthy",
      lease: first.lease,
      releaseLease: true,
    })).resolves.toMatchObject({ syncStatus: "healthy" });

    const second = await store.claimOAuthSyncLease(owner);
    expect(second).toMatchObject({
      status: "claimed",
      lease: { generation: first.lease.generation + 1 },
    });
    if (second.status !== "claimed") throw new Error("Expected second lease.");

    await store.saveOAuthGrant({
      ...owner,
      authorizationMode: "reauthorize",
      tokens: {
        access_token: "replacement-access-token",
        scope: "drive.readonly",
        expires_in: 3_600,
      },
    });
    await expect(store.getOAuthGrantSecrets(
      owner.tenantId,
      owner.actorId,
      owner.provider,
    )).resolves.toMatchObject({
      grant: { authorizationGeneration: 2, syncStatus: "idle" },
      syncCursor: undefined,
    });
    await expect(store.claimOAuthSyncLease(owner)).resolves.toMatchObject({
      status: "claimed",
      lease: { generation: second.lease.generation + 1 },
    });
  });
});
