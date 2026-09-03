import { randomUUID } from "node:crypto";
import { createOpaqueToken, hashSessionToken } from "@/lib/auth/crypto";
import { authenticatePassword, destroySession } from "@/lib/auth/store";
import type { AuthSessionIdentity } from "@/lib/auth/types";
import type {
  MobileAuthLedger,
  MobileDevice,
  MobileIdentity,
  MobileSessionRecord,
  MobileTokenPair,
} from "@/lib/auth/mobile-types";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

const accessTtlMs = boundedTtl("OMNIAGENT_MOBILE_ACCESS_TTL_SECONDS", 15 * 60, 60, 60 * 60) * 1000;
const refreshTtlMs = boundedTtl("OMNIAGENT_MOBILE_REFRESH_TTL_DAYS", 30, 1, 90) * 24 * 60 * 60 * 1000;
type MobileSqlTransaction = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<Record<string, unknown>[]>;
};
type RefreshRotationResult =
  | { error: "invalid_refresh_token" | "refresh_token_reuse" }
  | { session: MobileSessionRecord };

export class MobileRefreshError extends Error {
  constructor(
    public readonly code: "invalid_refresh_token" | "refresh_token_reuse",
  ) {
    super(code === "refresh_token_reuse" ? "Refresh token reuse detected." : "Refresh token is invalid or expired.");
    this.name = "MobileRefreshError";
  }
}

export async function authenticateMobilePassword({
  email,
  password,
  device,
}: {
  email: string;
  password: string;
  device: MobileDevice;
}) {
  // Password verification remains centralized in the hardened browser auth
  // implementation. Its temporary cookie-style session is removed before a
  // native token family is returned.
  const authenticated = await authenticatePassword({ email, password });
  if (!authenticated) return null;
  try {
    return await createMobileSession(authenticated.identity, device);
  } finally {
    await destroySession(authenticated.token);
  }
}

export async function getMobileIdentityFromRequest(request?: Request) {
  const token = getBearerToken(request);
  return token ? getMobileAccessIdentity(token) : null;
}

export function getBearerToken(request?: Request) {
  const authorization = request?.headers.get("authorization")?.trim();
  if (!authorization) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization);
  return match?.[1];
}

export function hasBearerAuthorization(request?: Request) {
  return Boolean(request?.headers.has("authorization"));
}

export async function rotateMobileRefreshToken(refreshToken: string, deviceId: string) {
  const refreshHash = hashSessionToken(refreshToken);
  const now = new Date();
  const nextAccessToken = createOpaqueToken();
  const nextRefreshToken = createOpaqueToken();
  const nextAccessExpiresAt = new Date(now.getTime() + accessTtlMs).toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const result = await runWithDatabaseSystemScope(
      "Rotate a native refresh token before its tenant is known.",
      () => getSql().transaction(async (sql: MobileSqlTransaction) => {
        const rows = await sql`
          SELECT * FROM omni_mobile_sessions
          WHERE refresh_token_hash = ${refreshHash}
             OR consumed_refresh_token_hashes ? ${refreshHash}
          LIMIT 1
          FOR UPDATE
        ` as Record<string, unknown>[];
        const row = rows[0];
        if (!row) return { error: "invalid_refresh_token" as const };
        const session = mobileSessionFromRow(row);
        if (session.consumedRefreshTokenHashes.includes(refreshHash)) {
          await sql`UPDATE omni_mobile_sessions SET revoked_at = NOW(), updated_at = NOW() WHERE id = ${session.id}`;
          return { error: "refresh_token_reuse" as const };
        }
        if (session.revokedAt || session.device.id !== deviceId || new Date(session.refreshExpiresAt) <= now) {
          return { error: "invalid_refresh_token" as const };
        }
        const consumed = [...session.consumedRefreshTokenHashes, refreshHash];
        await sql`
          UPDATE omni_mobile_sessions
          SET access_token_hash = ${hashSessionToken(nextAccessToken)},
              refresh_token_hash = ${hashSessionToken(nextRefreshToken)},
              consumed_refresh_token_hashes = ${JSON.stringify(consumed)}::jsonb,
              access_expires_at = ${nextAccessExpiresAt}, updated_at = NOW()
          WHERE id = ${session.id}
        `;
        return { session };
      }) as Promise<RefreshRotationResult>,
    );
    if ("error" in result) throw new MobileRefreshError(result.error);
    return tokenPair(nextAccessToken, nextRefreshToken, nextAccessExpiresAt, result.session.refreshExpiresAt);
  }

  let outcome: { session?: MobileSessionRecord; error?: MobileRefreshError["code"] } = {};
  await mutateMobileLedger((ledger) => {
    const session = ledger.sessions.find((item) =>
      item.refreshTokenHash === refreshHash || item.consumedRefreshTokenHashes.includes(refreshHash));
    if (!session) {
      outcome = { error: "invalid_refresh_token" };
      return ledger;
    }
    if (session.consumedRefreshTokenHashes.includes(refreshHash)) {
      outcome = { error: "refresh_token_reuse" };
      return { ...ledger, sessions: ledger.sessions.map((item) => item.id === session.id ? { ...item, revokedAt: now.toISOString(), updatedAt: now.toISOString() } : item) };
    }
    if (session.revokedAt || session.device.id !== deviceId || new Date(session.refreshExpiresAt) <= now) {
      outcome = { error: "invalid_refresh_token" };
      return ledger;
    }
    const rotated = {
      ...session,
      accessTokenHash: hashSessionToken(nextAccessToken),
      refreshTokenHash: hashSessionToken(nextRefreshToken),
      consumedRefreshTokenHashes: [...session.consumedRefreshTokenHashes, refreshHash],
      accessExpiresAt: nextAccessExpiresAt,
      updatedAt: now.toISOString(),
    };
    outcome = { session: rotated };
    return { ...ledger, sessions: ledger.sessions.map((item) => item.id === session.id ? rotated : item) };
  });
  if (outcome.error || !outcome.session) throw new MobileRefreshError(outcome.error || "invalid_refresh_token");
  return tokenPair(nextAccessToken, nextRefreshToken, nextAccessExpiresAt, outcome.session.refreshExpiresAt);
}

export async function revokeMobileSession(accessToken: string) {
  const accessHash = hashSessionToken(accessToken);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await runWithDatabaseSystemScope(
      "Revoke a native access token before its tenant is known.",
      () => getSql()`UPDATE omni_mobile_sessions SET revoked_at = NOW(), updated_at = NOW() WHERE access_token_hash = ${accessHash}`,
    );
    return;
  }
  const now = new Date().toISOString();
  await mutateMobileLedger((ledger) => ({ ...ledger, sessions: ledger.sessions.map((item) => item.accessTokenHash === accessHash ? { ...item, revokedAt: now, updatedAt: now } : item) }));
}

export async function revokeMobileSessionsForUser(userId: string, tenantId: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await runWithDatabaseTenantScope(
      tenantId,
      () => getSql()`UPDATE omni_mobile_sessions SET revoked_at = NOW(), updated_at = NOW() WHERE user_id = ${userId} AND tenant_id = ${tenantId} AND revoked_at IS NULL`,
    );
    return;
  }
  const now = new Date().toISOString();
  await mutateMobileLedger((ledger) => ({
    ...ledger,
    sessions: ledger.sessions.map((item) =>
      item.userId === userId && item.tenantId === tenantId && !item.revokedAt
        ? { ...item, revokedAt: now, updatedAt: now }
        : item),
  }));
}

async function createMobileSession(identity: AuthSessionIdentity, device: MobileDevice) {
  const now = new Date();
  const accessToken = createOpaqueToken();
  const refreshToken = createOpaqueToken();
  const session: MobileSessionRecord = {
    id: randomUUID(), familyId: randomUUID(), userId: identity.user.id,
    tenantId: identity.tenant.id, device,
    accessTokenHash: hashSessionToken(accessToken), refreshTokenHash: hashSessionToken(refreshToken),
    consumedRefreshTokenHashes: [],
    accessExpiresAt: new Date(now.getTime() + accessTtlMs).toISOString(),
    refreshExpiresAt: new Date(now.getTime() + refreshTtlMs).toISOString(),
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await runWithDatabaseTenantScope(session.tenantId, () => getSql()`
      INSERT INTO omni_mobile_sessions (
        id, family_id, user_id, tenant_id, device_id, device_name, platform, app_version,
        access_token_hash, refresh_token_hash, consumed_refresh_token_hashes,
        access_expires_at, refresh_expires_at, created_at, updated_at
      ) VALUES (
        ${session.id}, ${session.familyId}, ${session.userId}, ${session.tenantId}, ${device.id}, ${device.name},
        ${device.platform}, ${device.appVersion || null}, ${session.accessTokenHash}, ${session.refreshTokenHash},
        ${JSON.stringify([])}::jsonb, ${session.accessExpiresAt}, ${session.refreshExpiresAt}, ${session.createdAt}, ${session.updatedAt}
      )
    `);
  } else {
    await mutateMobileLedger((ledger) => ({ ...ledger, sessions: [session, ...ledger.sessions.filter((item) => new Date(item.refreshExpiresAt) > now)].slice(0, 500) }));
  }
  return {
    tokens: tokenPair(accessToken, refreshToken, session.accessExpiresAt, session.refreshExpiresAt),
    identity: mobileIdentity(session, identity),
  };
}

async function getMobileAccessIdentity(accessToken: string): Promise<MobileIdentity | null> {
  const hash = hashSessionToken(accessToken);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseSystemScope("Resolve a native bearer token before its tenant is known.", async () => {
      const rows = await getSql()`
        SELECT s.*, u.email, u.name AS user_name, u.status AS user_status, u.last_login_at,
          u.created_at AS user_created_at, u.updated_at AS user_updated_at,
          t.name AS tenant_name, t.slug AS tenant_slug, t.created_at AS tenant_created_at, t.updated_at AS tenant_updated_at,
          m.id AS membership_id, m.role, m.status AS membership_status,
          m.created_at AS membership_created_at, m.updated_at AS membership_updated_at
        FROM omni_mobile_sessions s
        JOIN omni_auth_users u ON u.id = s.user_id
        JOIN omni_auth_tenants t ON t.id = s.tenant_id
        JOIN omni_auth_memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
        WHERE s.access_token_hash = ${hash} AND s.access_expires_at > NOW() AND s.revoked_at IS NULL
          AND u.status = 'active' AND m.status = 'active' LIMIT 1
      `;
      return rows[0] ? mobileIdentityFromRow(rows[0]) : null;
    });
  }
  const ledger = await readMobileLedger();
  const session = ledger.sessions.find((item) => item.accessTokenHash === hash && !item.revokedAt && new Date(item.accessExpiresAt).getTime() > Date.now());
  if (!session) return null;
  const control = await import("@/lib/auth/store").then((module) => module.getAuthControlPlane({ tenantId: session.tenantId }));
  const user = control.users.find((item) => item.id === session.userId && item.status === "active");
  const membership = control.memberships.find((item) => item.userId === session.userId && item.status === "active");
  const tenant = control.tenants.find((item) => item.id === session.tenantId);
  return user && membership && tenant ? mobileIdentity(session, { user, membership, tenant } as AuthSessionIdentity) : null;
}

function mobileIdentity(session: MobileSessionRecord, identity: Pick<AuthSessionIdentity, "user" | "tenant" | "membership">): MobileIdentity {
  return { session, user: identity.user, tenant: identity.tenant, membership: identity.membership, context: {
    tenantId: identity.tenant.id, actorId: identity.user.email, role: identity.membership.role, source: "session",
    auth: { userId: identity.user.id, email: identity.user.email, sessionId: session.id, tenantName: identity.tenant.name },
  } };
}

function mobileIdentityFromRow(row: Record<string, unknown>) {
  const session = mobileSessionFromRow(row);
  return mobileIdentity(session, {
    user: { id: String(row.user_id), email: String(row.email), name: row.user_name ? String(row.user_name) : undefined, status: String(row.user_status) as "active" | "disabled", lastLoginAt: row.last_login_at ? date(row.last_login_at) : undefined, createdAt: date(row.user_created_at), updatedAt: date(row.user_updated_at) },
    tenant: { id: String(row.tenant_id), name: String(row.tenant_name), slug: String(row.tenant_slug), createdAt: date(row.tenant_created_at), updatedAt: date(row.tenant_updated_at) },
    membership: { id: String(row.membership_id), tenantId: String(row.tenant_id), userId: String(row.user_id), role: String(row.role) as MobileIdentity["membership"]["role"], status: String(row.membership_status) as "active" | "disabled", createdAt: date(row.membership_created_at), updatedAt: date(row.membership_updated_at) },
  } as AuthSessionIdentity);
}

function mobileSessionFromRow(row: Record<string, unknown>): MobileSessionRecord {
  const consumed = Array.isArray(row.consumed_refresh_token_hashes) ? row.consumed_refresh_token_hashes.map(String) : [];
  return { id: String(row.id), familyId: String(row.family_id), userId: String(row.user_id), tenantId: String(row.tenant_id), device: { id: String(row.device_id), name: String(row.device_name), platform: String(row.platform) as "android" | "ios", appVersion: row.app_version ? String(row.app_version) : undefined }, accessTokenHash: String(row.access_token_hash), refreshTokenHash: String(row.refresh_token_hash), consumedRefreshTokenHashes: consumed, accessExpiresAt: date(row.access_expires_at), refreshExpiresAt: date(row.refresh_expires_at), createdAt: date(row.created_at), updatedAt: date(row.updated_at), revokedAt: row.revoked_at ? date(row.revoked_at) : undefined };
}

function tokenPair(accessToken: string, refreshToken: string, accessExpiresAt: string, refreshExpiresAt: string): MobileTokenPair {
  return { tokenType: "Bearer", accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}
function date(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function boundedTtl(name: string, fallback: number, min: number, max: number) { const value = Number(process.env[name]); return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : fallback; }
function getMobileFile() { return getDataPath("mobile-auth.json"); }
function readMobileLedger() { return readJsonFile<MobileAuthLedger>(getMobileFile(), { sessions: [] }); }
function mutateMobileLedger(mutator: (ledger: MobileAuthLedger) => MobileAuthLedger) { return updateJsonFile(getMobileFile(), { sessions: [] }, mutator); }
