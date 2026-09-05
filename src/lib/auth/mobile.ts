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
  evaluateNativeClientCompatibility,
  isFreshNativeClientAttestation,
  isNativeClientAttestation,
  nativeClientPolicy,
  NATIVE_CLIENT_ADOPTION_MAX_SESSION_FAMILIES,
  NATIVE_CLIENT_ADOPTION_SCHEMA_VERSION,
  NATIVE_CLIENT_ADOPTION_WINDOW_DAYS,
  type NativeClientAttestation,
} from "@/lib/auth/native-client-contract";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import type { SecurityContext } from "@/lib/security/types";

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

export async function rotateMobileRefreshToken(
  refreshToken: string,
  deviceId: string,
  client?: NativeClientAttestation,
) {
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
          await sql`
            UPDATE omni_mobile_sessions
            SET revoked_at = NOW(), updated_at = NOW()
            WHERE id = ${session.id}
              AND tenant_id = ${session.tenantId}
              AND user_id = ${session.userId}
          `;
          return { error: "refresh_token_reuse" as const };
        }
        if (
          session.revokedAt ||
          session.device.id !== deviceId ||
          (client && client.platform !== session.device.platform) ||
          new Date(session.refreshExpiresAt) <= now
        ) {
          return { error: "invalid_refresh_token" as const };
        }
        const consumed = [...session.consumedRefreshTokenHashes, refreshHash];
        const updatedRows = client
          ? await sql`
              UPDATE omni_mobile_sessions
              SET access_token_hash = ${hashSessionToken(nextAccessToken)},
                  refresh_token_hash = ${hashSessionToken(nextRefreshToken)},
                  consumed_refresh_token_hashes = ${consumed}::jsonb,
                  access_expires_at = ${nextAccessExpiresAt},
                  app_version = ${client.appVersion},
                  app_build_number = ${client.buildNumber},
                  client_contract_version = ${client.clientContractVersion},
                  last_seen_at = NOW(),
                  client_attested_at = NOW(),
                  updated_at = NOW()
              WHERE id = ${session.id}
                AND tenant_id = ${session.tenantId}
                AND user_id = ${session.userId}
              RETURNING *
            `
          : await sql`
              UPDATE omni_mobile_sessions
              SET access_token_hash = ${hashSessionToken(nextAccessToken)},
                  refresh_token_hash = ${hashSessionToken(nextRefreshToken)},
                  consumed_refresh_token_hashes = ${consumed}::jsonb,
                  access_expires_at = ${nextAccessExpiresAt},
                  app_build_number = NULL,
                  client_contract_version = 0,
                  last_seen_at = NOW(),
                  client_attested_at = NULL,
                  updated_at = NOW()
              WHERE id = ${session.id}
                AND tenant_id = ${session.tenantId}
                AND user_id = ${session.userId}
              RETURNING *
            `;
        const updated = updatedRows[0];
        if (!updated) return { error: "invalid_refresh_token" as const };
        return { session: mobileSessionFromRow(updated) };
      }) as Promise<RefreshRotationResult>,
    );
    if ("error" in result) throw new MobileRefreshError(result.error);
    return {
      tokens: tokenPair(
        nextAccessToken,
        nextRefreshToken,
        nextAccessExpiresAt,
        result.session.refreshExpiresAt,
      ),
      session: result.session,
    };
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
    if (
      session.revokedAt ||
      session.device.id !== deviceId ||
      (client && client.platform !== session.device.platform) ||
      new Date(session.refreshExpiresAt) <= now
    ) {
      outcome = { error: "invalid_refresh_token" };
      return ledger;
    }
    const rotated = {
      ...session,
      accessTokenHash: hashSessionToken(nextAccessToken),
      refreshTokenHash: hashSessionToken(nextRefreshToken),
      consumedRefreshTokenHashes: [...session.consumedRefreshTokenHashes, refreshHash],
      accessExpiresAt: nextAccessExpiresAt,
      device: client
        ? { ...session.device, ...client }
        : legacyMobileDevice(session.device),
      updatedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      clientAttestedAt: client ? now.toISOString() : undefined,
    };
    outcome = { session: rotated };
    return { ...ledger, sessions: ledger.sessions.map((item) => item.id === session.id ? rotated : item) };
  });
  if (outcome.error || !outcome.session) throw new MobileRefreshError(outcome.error || "invalid_refresh_token");
  return {
    tokens: tokenPair(
      nextAccessToken,
      nextRefreshToken,
      nextAccessExpiresAt,
      outcome.session.refreshExpiresAt,
    ),
    session: outcome.session,
  };
}

export async function recordMobileSessionSeen(
  identity: MobileIdentity,
  client?: NativeClientAttestation,
) {
  if (client && client.platform !== identity.session.device.platform) {
    throw new MobileRefreshError("invalid_refresh_token");
  }
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await runWithDatabaseTenantScope(
      identity.context.tenantId,
      () => client
        ? getSql()`
            UPDATE omni_mobile_sessions
            SET app_version = ${client.appVersion},
                app_build_number = ${client.buildNumber},
                client_contract_version = ${client.clientContractVersion},
                last_seen_at = NOW(),
                client_attested_at = NOW(),
                updated_at = NOW()
            WHERE id = ${identity.session.id}
              AND tenant_id = ${identity.context.tenantId}
              AND user_id = ${identity.user.id}
              AND revoked_at IS NULL
            RETURNING *
          `
        : getSql()`
            UPDATE omni_mobile_sessions
            SET app_build_number = NULL,
                client_contract_version = 0,
                last_seen_at = NOW(),
                client_attested_at = NULL,
                updated_at = NOW()
            WHERE id = ${identity.session.id}
              AND tenant_id = ${identity.context.tenantId}
              AND user_id = ${identity.user.id}
              AND revoked_at IS NULL
            RETURNING *
          `,
    );
    if (!rows[0]) throw new MobileRefreshError("invalid_refresh_token");
    return { ...identity, session: mobileSessionFromRow(rows[0]) };
  }
  let observedSession: MobileSessionRecord | undefined;
  await mutateMobileLedger((ledger) => ({
    ...ledger,
    sessions: ledger.sessions.map((session) => {
      if (session.id === identity.session.id &&
      session.tenantId === identity.context.tenantId &&
      session.userId === identity.user.id &&
      !session.revokedAt) {
        observedSession = {
          ...session,
          device: client
            ? { ...session.device, ...client }
            : legacyMobileDevice(session.device),
          lastSeenAt: now,
          clientAttestedAt: client ? now : undefined,
          updatedAt: now,
        };
        return observedSession;
      }
      return session;
    }),
  }));
  if (!observedSession) throw new MobileRefreshError("invalid_refresh_token");
  return { ...identity, session: observedSession };
}

export async function getNativeClientAdoption(
  context: Pick<SecurityContext, "tenantId">,
) {
  const asOf = new Date();
  const cutoff = new Date(
    asOf.getTime() - NATIVE_CLIENT_ADOPTION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const policy = nativeClientPolicy();
  if (policy.configurationStatus !== "valid") {
    return {
      schemaVersion: NATIVE_CLIENT_ADOPTION_SCHEMA_VERSION,
      available: false as const,
      authoritative: false as const,
      reason: "invalid_native_client_policy" as const,
      evidenceState: "held" as const,
      enrollmentState: "held" as const,
      agentCatalogEnrollment: "held" as const,
      asOf: asOf.toISOString(),
      cutoff: cutoff.toISOString(),
      policy,
    };
  }
  if (!hasDatabaseUrl()) {
    return {
      schemaVersion: NATIVE_CLIENT_ADOPTION_SCHEMA_VERSION,
      available: false as const,
      authoritative: false as const,
      reason: "durable_storage_required" as const,
      evidenceState: "held" as const,
      enrollmentState: "held" as const,
      agentCatalogEnrollment: "held" as const,
      asOf: asOf.toISOString(),
      cutoff: cutoff.toISOString(),
      policy,
    };
  }

  await ensureDatabaseSchema();
  const rows = await runWithDatabaseTenantScope(context.tenantId, () => getSql()`
    WITH ranked_devices AS (
      SELECT
        session.platform,
        session.app_version,
        session.app_build_number,
        session.client_contract_version,
        session.client_attested_at,
        ROW_NUMBER() OVER (
          PARTITION BY session.user_id, session.device_id
          ORDER BY
            COALESCE(session.last_seen_at, session.updated_at) DESC,
            session.updated_at DESC,
            session.id COLLATE "C" ASC
        ) AS enrollment_rank
      FROM omni_mobile_sessions session
      JOIN omni_auth_users auth_user
        ON auth_user.id = session.user_id
        AND auth_user.status = 'active'
      JOIN omni_auth_memberships membership
        ON membership.user_id = session.user_id
        AND membership.tenant_id = session.tenant_id
        AND membership.status = 'active'
      WHERE session.tenant_id = ${context.tenantId}
        AND session.revoked_at IS NULL
        AND session.refresh_expires_at > ${asOf.toISOString()}
    )
    SELECT
      platform,
      app_version,
      app_build_number,
      client_contract_version,
      client_attested_at,
      enrollment_rank
    FROM ranked_devices
    ORDER BY
      enrollment_rank ASC,
      platform COLLATE "C",
      app_version COLLATE "C" NULLS LAST
    LIMIT ${NATIVE_CLIENT_ADOPTION_MAX_SESSION_FAMILIES + 1}
  `);

  if (rows.length > NATIVE_CLIENT_ADOPTION_MAX_SESSION_FAMILIES) {
    return {
      schemaVersion: NATIVE_CLIENT_ADOPTION_SCHEMA_VERSION,
      available: false as const,
      authoritative: true as const,
      reason: "session_family_limit_exceeded" as const,
      evidenceState: "held" as const,
      enrollmentState: "held" as const,
      agentCatalogEnrollment: "held" as const,
      asOf: asOf.toISOString(),
      cutoff: cutoff.toISOString(),
      policy,
    };
  }

  const emptyCounts = () => ({
    total: 0,
    attested: 0,
    compatible: 0,
    upgradeRequired: 0,
    unknown: 0,
  });
  const deviceCounts = emptyCounts();
  const sessionFamilyCounts = emptyCounts();
  const byPlatform = {
    android: emptyCounts(),
    ios: emptyCounts(),
    unknown: emptyCounts(),
  };
  for (const row of rows) {
    if (row.platform !== "android" && row.platform !== "ios") {
      incrementUnknownCompatibilityCounts(sessionFamilyCounts);
      if (Number(row.enrollment_rank) === 1) {
        incrementUnknownCompatibilityCounts(deviceCounts);
        incrementUnknownCompatibilityCounts(byPlatform.unknown);
      }
      continue;
    }
    const platform = row.platform;
    const descriptor: Parameters<
      typeof evaluateNativeClientCompatibility
    >[0] = {
      platform,
      appVersion: row.app_version ? String(row.app_version) : undefined,
      buildNumber: optionalPositiveInteger(row.app_build_number),
      clientContractVersion: optionalPositiveInteger(
        row.client_contract_version,
      ),
    };
    const status = isFreshNativeClientAttestation(
      row.client_attested_at ? String(row.client_attested_at) : undefined,
      asOf,
    )
      ? evaluateNativeClientCompatibility(descriptor)
      : "unknown";
    incrementCompatibilityCounts(sessionFamilyCounts, descriptor, status);
    if (Number(row.enrollment_rank) !== 1) continue;
    incrementCompatibilityCounts(deviceCounts, descriptor, status);
    incrementCompatibilityCounts(byPlatform[platform], descriptor, status);
  }

  const adoptionBasisPoints = deviceCounts.total === 0
    ? null
    : Math.floor((deviceCounts.compatible * 10_000) / deviceCounts.total);

  return {
    schemaVersion: NATIVE_CLIENT_ADOPTION_SCHEMA_VERSION,
    available: true as const,
    authoritative: true as const,
    evidenceState: "held" as const,
    enrollmentState: "held" as const,
    agentCatalogEnrollment: "held" as const,
    asOf: asOf.toISOString(),
    cutoff: cutoff.toISOString(),
    policy,
    population: {
      activeSessionFamilies: sessionFamilyCounts.total,
      activeDevices: deviceCounts.total,
      compatibleDevices: deviceCounts.compatible,
      upgradeRequiredDevices: deviceCounts.upgradeRequired,
      legacyOrUnknownDevices: deviceCounts.unknown,
      incompatibleActiveSessionFamilies:
        sessionFamilyCounts.total - sessionFamilyCounts.compatible,
      adoptionBasisPoints,
    },
    sessionFamilies: sessionFamilyCounts,
    devices: deviceCounts,
    byPlatform,
  };
}

export async function revokeMobileSession(identity: MobileIdentity) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await runWithDatabaseTenantScope(identity.context.tenantId, () => getSql()`
      UPDATE omni_mobile_sessions
      SET revoked_at = NOW(), updated_at = NOW()
      WHERE id = ${identity.session.id}
        AND tenant_id = ${identity.context.tenantId}
        AND user_id = ${identity.user.id}
        AND revoked_at IS NULL
    `);
    return;
  }
  const now = new Date().toISOString();
  await mutateMobileLedger((ledger) => ({ ...ledger, sessions: ledger.sessions.map((item) =>
    item.id === identity.session.id &&
    item.tenantId === identity.context.tenantId &&
    item.userId === identity.user.id &&
    !item.revokedAt
      ? { ...item, revokedAt: now, updatedAt: now }
      : item) }));
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
    lastSeenAt: now.toISOString(),
    clientAttestedAt: isNativeClientAttestation(device)
      ? now.toISOString()
      : undefined,
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await runWithDatabaseTenantScope(session.tenantId, () => getSql()`
      INSERT INTO omni_mobile_sessions (
        id, family_id, user_id, tenant_id, device_id, device_name, platform, app_version,
        app_build_number, client_contract_version, last_seen_at, client_attested_at,
        access_token_hash, refresh_token_hash, consumed_refresh_token_hashes,
        access_expires_at, refresh_expires_at, created_at, updated_at
      ) VALUES (
        ${session.id}, ${session.familyId}, ${session.userId}, ${session.tenantId}, ${device.id}, ${device.name},
        ${device.platform}, ${device.appVersion || null}, ${device.buildNumber || null},
        ${device.clientContractVersion || 0}, ${session.lastSeenAt}, ${session.clientAttestedAt || null},
        ${session.accessTokenHash}, ${session.refreshTokenHash},
        ${[]}::jsonb, ${session.accessExpiresAt}, ${session.refreshExpiresAt}, ${session.createdAt}, ${session.updatedAt}
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
    tenantId: identity.tenant.id, actorId: identity.user.email, role: identity.membership.role, source: "mobile",
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
  return { id: String(row.id), familyId: String(row.family_id), userId: String(row.user_id), tenantId: String(row.tenant_id), device: { id: String(row.device_id), name: String(row.device_name), platform: mobilePlatform(row.platform), appVersion: row.app_version ? String(row.app_version) : undefined, buildNumber: optionalPositiveInteger(row.app_build_number), clientContractVersion: optionalPositiveInteger(row.client_contract_version) }, accessTokenHash: String(row.access_token_hash), refreshTokenHash: String(row.refresh_token_hash), consumedRefreshTokenHashes: consumed, accessExpiresAt: date(row.access_expires_at), refreshExpiresAt: date(row.refresh_expires_at), createdAt: date(row.created_at), updatedAt: date(row.updated_at), lastSeenAt: row.last_seen_at ? date(row.last_seen_at) : undefined, clientAttestedAt: row.client_attested_at ? date(row.client_attested_at) : undefined, revokedAt: row.revoked_at ? date(row.revoked_at) : undefined };
}

function tokenPair(accessToken: string, refreshToken: string, accessExpiresAt: string, refreshExpiresAt: string): MobileTokenPair {
  return { tokenType: "Bearer", accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}
function date(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function optionalPositiveInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}
function mobilePlatform(value: unknown): MobileDevice["platform"] {
  if (value === "android" || value === "ios") return value;
  throw new Error("Native session platform is invalid.");
}
function legacyMobileDevice(device: MobileDevice): MobileDevice {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    appVersion: device.appVersion,
  };
}
function incrementCompatibilityCounts(
  counts: {
    total: number;
    attested: number;
    compatible: number;
    upgradeRequired: number;
    unknown: number;
  },
  descriptor: Parameters<typeof evaluateNativeClientCompatibility>[0],
  status: ReturnType<typeof evaluateNativeClientCompatibility>,
) {
  counts.total += 1;
  if (isNativeClientAttestation(descriptor)) counts.attested += 1;
  if (status === "compatible") counts.compatible += 1;
  else if (status === "upgrade_required") counts.upgradeRequired += 1;
  else counts.unknown += 1;
}
function incrementUnknownCompatibilityCounts(counts: {
  total: number;
  unknown: number;
}) {
  counts.total += 1;
  counts.unknown += 1;
}
function boundedTtl(name: string, fallback: number, min: number, max: number) { const value = Number(process.env[name]); return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : fallback; }
function getMobileFile() { return getDataPath("mobile-auth.json"); }
function readMobileLedger() { return readJsonFile<MobileAuthLedger>(getMobileFile(), { sessions: [] }); }
function mutateMobileLedger(mutator: (ledger: MobileAuthLedger) => MobileAuthLedger) { return updateJsonFile(getMobileFile(), { sessions: [] }, mutator); }
