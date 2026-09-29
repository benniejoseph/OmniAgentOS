import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dataDir = "";
const previousDataDir = process.env.OMNIAGENT_DATA_DIR;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousKeyring = process.env.OMNIAGENT_CREDENTIAL_KEYRING;
const accountEmail = "refresh-owner@example.test";
const scope = "https://www.googleapis.com/auth/drive.readonly";

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "asael-oauth-grant-refresh-"));
  process.env.OMNIAGENT_DATA_DIR = dataDir;
  delete process.env.DATABASE_URL;
  process.env.OMNIAGENT_CREDENTIAL_KEYRING = JSON.stringify({
    activeKeyId: "oauth-refresh-v1",
    keys: {
      "oauth-refresh-v1": createHash("sha256")
        .update("oauth-grant-refresh-test-key")
        .digest("base64url"),
    },
  });
});

afterAll(() => {
  restore("OMNIAGENT_DATA_DIR", previousDataDir);
  restore("DATABASE_URL", previousDatabaseUrl);
  restore("OMNIAGENT_CREDENTIAL_KEYRING", previousKeyring);
});

describe("OAuth token refresh", () => {
  it("leaves a connection disconnected when its refresh finishes after the disconnect", async () => {
    const store = await import("@/lib/connectors/oauth-store");
    const owner = ownerFor("revoked");
    const connected = await connect(owner, "first-access-token");
    expect(connected.authorizationGeneration).toBe(1);

    await store.revokeOAuthGrant(owner.tenantId, owner.actorId, owner.provider);
    await expect(store.saveOAuthGrant({
      ...owner,
      accountEmail,
      tokens: { access_token: "refreshed-access-token", expires_in: 3_600 },
      authorizationMode: "refresh",
      connectionId: connected.id,
      expectedAuthorizationGeneration: connected.authorizationGeneration,
    })).rejects.toMatchObject({
      name: "OAuthCredentialError",
      code: "grant_not_found",
    });

    await expect(store.listOAuthGrants(owner.tenantId, owner.actorId)).resolves.toEqual([]);
    await expect(store.getOAuthGrantSecrets(owner.tenantId, owner.actorId, owner.provider))
      .resolves.toBeUndefined();
    expect(await ledgerGrant(connected.id)).toMatchObject({
      status: "revoked",
      authorizationGeneration: 2,
    });
  });

  it("keeps a reconnected account's tokens when a refresh read before the disconnect finishes", async () => {
    const store = await import("@/lib/connectors/oauth-store");
    const owner = ownerFor("reconnected");
    const connected = await connect(owner, "first-access-token");
    await store.revokeOAuthGrant(owner.tenantId, owner.actorId, owner.provider);
    const reconnected = await connect(owner, "reconnected-access-token");
    expect(reconnected).toMatchObject({
      id: connected.id,
      status: "active",
      authorizationGeneration: 2,
    });

    await expect(store.saveOAuthGrant({
      ...owner,
      accountEmail,
      tokens: { access_token: "stale-refresh-access-token", expires_in: 3_600 },
      authorizationMode: "refresh",
      connectionId: connected.id,
      expectedAuthorizationGeneration: connected.authorizationGeneration,
    })).rejects.toMatchObject({ code: "grant_not_found" });

    const secrets = await store.getOAuthGrantSecrets(owner.tenantId, owner.actorId, owner.provider);
    expect(secrets?.tokens.access_token).toBe("reconnected-access-token");
    expect(secrets?.grant.authorizationGeneration).toBe(2);
  });

  it("leaves a connection disconnected by an earlier release disconnected", async () => {
    const store = await import("@/lib/connectors/oauth-store");
    const owner = ownerFor("legacy-revoked");
    const connected = await connect(owner, "first-access-token");
    // Earlier releases disconnected without moving the authorization on.
    await updateLedgerGrant(connected.id, { status: "revoked" });

    await expect(store.saveOAuthGrant({
      ...owner,
      accountEmail,
      tokens: { access_token: "resurrecting-access-token", expires_in: 3_600 },
      authorizationMode: "refresh",
      connectionId: connected.id,
      expectedAuthorizationGeneration: connected.authorizationGeneration,
    })).rejects.toMatchObject({ code: "grant_not_found" });

    await expect(store.getOAuthGrantSecrets(owner.tenantId, owner.actorId, owner.provider))
      .resolves.toBeUndefined();
    expect(await ledgerGrant(connected.id)).toMatchObject({
      status: "revoked",
      authorizationGeneration: 1,
    });
  });

  it("refreshes the exact connection it read, at the authorization it read", async () => {
    const store = await import("@/lib/connectors/oauth-store");
    const owner = ownerFor("current");
    const connected = await connect(owner, "first-access-token");
    const refresh = {
      ...owner,
      accountEmail,
      tokens: { access_token: "refreshed-access-token", expires_in: 3_600 },
      authorizationMode: "refresh" as const,
      connectionId: connected.id,
      expectedAuthorizationGeneration: connected.authorizationGeneration,
    };

    for (const mismatch of [
      { connectionId: "another-connection" },
      { connectionId: "" },
      { expectedAuthorizationGeneration: connected.authorizationGeneration + 1 },
    ]) {
      await expect(store.saveOAuthGrant({ ...refresh, ...mismatch }))
        .rejects.toMatchObject({ code: "grant_not_found" });
    }
    await expect(store.getOAuthGrantSecrets(owner.tenantId, owner.actorId, owner.provider))
      .resolves.toMatchObject({ tokens: { access_token: "first-access-token" } });

    await expect(store.saveOAuthGrant(refresh)).resolves.toMatchObject({
      id: connected.id,
      status: "active",
      authorizationGeneration: 1,
    });
    await expect(store.getOAuthGrantSecrets(owner.tenantId, owner.actorId, owner.provider))
      .resolves.toMatchObject({
        tokens: {
          access_token: "refreshed-access-token",
          refresh_token: "retained-refresh-token",
        },
      });
  });
});

function ownerFor(name: string) {
  return {
    tenantId: `tenant-refresh-${name}`,
    actorId: `actor-refresh-${name}`,
    provider: "google" as const,
  };
}

async function connect(owner: ReturnType<typeof ownerFor>, accessToken: string) {
  const store = await import("@/lib/connectors/oauth-store");
  return store.saveOAuthGrant({
    ...owner,
    accountEmail,
    tokens: {
      access_token: accessToken,
      refresh_token: "retained-refresh-token",
      scope,
      expires_in: 3_600,
    },
  });
}

async function readLedger() {
  return JSON.parse(
    await readFile(path.join(dataDir, "oauth-grants.json"), "utf8"),
  ) as { grants: Array<Record<string, unknown>> };
}

async function ledgerGrant(id: string) {
  return (await readLedger()).grants.find((grant) => grant.id === id);
}

async function updateLedgerGrant(id: string, change: Record<string, unknown>) {
  const ledger = await readLedger();
  await writeFile(
    path.join(dataDir, "oauth-grants.json"),
    JSON.stringify({
      ...ledger,
      grants: ledger.grants.map((grant) => (grant.id === id ? { ...grant, ...change } : grant)),
    }),
  );
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
