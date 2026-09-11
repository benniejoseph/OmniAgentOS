import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealJsonPayload } from "@/lib/security/sealed-payload";

let dataDir = "";
const previousKeyring = process.env.OMNIAGENT_CREDENTIAL_KEYRING;
const previousLegacySecret = process.env.OMNIAGENT_EXECUTION_PAYLOAD_SECRET;

beforeAll(async () => {
  dataDir = await mkdtemp(
    path.join(tmpdir(), "asael-oauth-sync-lease-"),
  );
  process.env.OMNIAGENT_DATA_DIR = dataDir;
  delete process.env.DATABASE_URL;
  process.env.OMNIAGENT_CREDENTIAL_KEYRING = JSON.stringify({
    activeKeyId: "oauth-v1",
    keys: {
      "oauth-v1": createHash("sha256")
        .update("oauth-store-test-key")
        .digest("base64url"),
    },
  });
});

afterAll(() => {
  restore("OMNIAGENT_CREDENTIAL_KEYRING", previousKeyring);
  restore("OMNIAGENT_EXECUTION_PAYLOAD_SECRET", previousLegacySecret);
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
        refresh_token: "retained-refresh-token",
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
      grant: { authorizationGeneration: 1, syncStatus: "syncing" },
      tokens: { refresh_token: "retained-refresh-token" },
      syncCursor: JSON.stringify({ drivePageToken: "page-2" }),
    });
    await expect(store.claimOAuthSyncLease(owner)).resolves.toEqual({
      status: "busy",
    });

    await store.saveOAuthGrant({
      ...owner,
      authorizationMode: "reauthorize",
      tokens: {
        access_token: "expanded-access-token",
        scope: "drive.readonly gmail.readonly",
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

  it("persists a validated source checkpoint without treating its discriminator as payload", async () => {
    const store = await import("@/lib/connectors/oauth-store");
    const owner = {
      tenantId: "tenant-source-coverage",
      actorId: "actor-source-coverage",
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

    const attemptedAt = "2026-09-08T03:58:40.000Z";
    await expect(store.updateOAuthSyncState({
      ...owner,
      status: "syncing",
      sourceSettlements: [{
        source: "drive",
        schemaVersion: 1,
        status: "syncing",
        backfillState: "in_progress",
        lastAttemptedAt: attemptedAt,
        lastSuccessfulAt: attemptedAt,
        failureCode: "none",
      }],
    })).resolves.toMatchObject({
      sourceCoverage: {
        drive: {
          schemaVersion: 1,
          status: "syncing",
          backfillState: "in_progress",
          lastAttemptedAt: attemptedAt,
          lastSuccessfulAt: attemptedAt,
          failureCode: "none",
        },
      },
    });
  });

  it("rewraps a readable legacy token envelope with the active credential key", async () => {
    const store = await import("@/lib/connectors/oauth-store");
    const owner = {
      tenantId: "tenant-legacy-token",
      actorId: "actor-legacy-token",
      provider: "google" as const,
    };
    await store.saveOAuthGrant({
      ...owner,
      tokens: {
        access_token: "initial-access-token",
        scope: "drive.readonly",
        expires_in: 3_600,
      },
    });
    process.env.OMNIAGENT_EXECUTION_PAYLOAD_SECRET =
      "legacy-oauth-store-secret-at-least-thirty-two-bytes";
    const ledgerPath = path.join(dataDir, "oauth-grants.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      grants: Array<Record<string, unknown>>;
    };
    const legacy = sealJsonPayload(
      { access_token: "legacy-access-token", scope: "drive.readonly" },
      `oauth-grant:${owner.tenantId}:${owner.actorId}:${owner.provider}`,
    );
    const record = ledger.grants.find((grant) =>
      grant.tenantId === owner.tenantId && grant.actorId === owner.actorId
    );
    if (!record) throw new Error("Expected OAuth test grant.");
    record.sealedTokens = legacy;
    await writeFile(ledgerPath, JSON.stringify(ledger), "utf8");

    await expect(store.getOAuthGrantSecrets(
      owner.tenantId,
      owner.actorId,
      owner.provider,
    )).resolves.toMatchObject({
      tokens: { access_token: "legacy-access-token" },
    });
    const rewrapped = await readFile(ledgerPath, "utf8");
    const rewrappedLedger = JSON.parse(rewrapped) as {
      grants: Array<{ tenantId?: string; sealedTokens?: { keyId?: string } }>;
    };
    expect(rewrappedLedger.grants.find((grant) =>
      grant.tenantId === owner.tenantId
    )?.sealedTokens?.keyId).toBe("oauth-v1");
    expect(rewrapped).not.toContain("legacy-access-token");
  });

  it("keeps a reauthorization bound to the original verified Google subject", async () => {
    const store = await import("@/lib/connectors/oauth-store");
    const owner = {
      tenantId: "tenant-google-subject",
      actorId: "actor-google-subject",
      provider: "google" as const,
    };
    await store.saveOAuthGrant({
      ...owner,
      tokens: {
        access_token: "owner-access",
        google_account_sub: "stable-owner-subject",
        scope: "drive.readonly",
        expires_in: 3_600,
      },
    });

    await expect(store.saveOAuthGrant({
      ...owner,
      tokens: {
        access_token: "different-access",
        google_account_sub: "different-google-subject",
        scope: "drive.readonly",
        expires_in: 3_600,
      },
    })).rejects.toMatchObject({ code: "account_identity_changed" });
    await expect(store.getOAuthGrantSecrets(
      owner.tenantId,
      owner.actorId,
      owner.provider,
    )).resolves.toMatchObject({
      tokens: {
        access_token: "owner-access",
        google_account_sub: "stable-owner-subject",
      },
    });
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
