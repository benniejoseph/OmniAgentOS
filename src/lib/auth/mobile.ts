import { randomUUID } from "node:crypto";
import { createOpaqueToken, hashSessionToken } from "@/lib/auth/crypto";
import {
  authenticatePassword,
  destroySession,
  getAuthControlPlane,
} from "@/lib/auth/store";
import type { AuthSessionIdentity } from "@/lib/auth/types";
import type {
  MobileAuthLedger,
  MobileDevice,
  MobileIdentity,
  MobileRevocationReason,
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
const wipeChallengeTtlMs = 10 * 60 * 1000;
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
          SELECT
            session.*,
            auth_user.status AS auth_user_status,
            membership.status AS membership_status
          FROM omni_mobile_sessions session
          LEFT JOIN omni_auth_users auth_user
            ON auth_user.id = session.user_id
          LEFT JOIN omni_auth_memberships membership
            ON membership.user_id = session.user_id
            AND membership.tenant_id = session.tenant_id
          WHERE session.refresh_token_hash = ${refreshHash}
             OR session.consumed_refresh_token_hashes ? ${refreshHash}
          LIMIT 1
          FOR UPDATE OF session
        ` as Record<string, unknown>[];
        const row = rows[0];
        if (!row) return { error: "invalid_refresh_token" as const };
        const session = mobileSessionFromRow(row);
        if (session.consumedRefreshTokenHashes.includes(refreshHash)) {
          await sql`
            UPDATE omni_mobile_sessions
            SET revoked_at = COALESCE(revoked_at, NOW()),
                revocation_reason = 'refresh_reuse',
                updated_at = NOW()
            WHERE id = ${session.id}
              AND tenant_id = ${session.tenantId}
              AND user_id = ${session.userId}
          `;
          return { error: "refresh_token_reuse" as const };
        }
        if (
          row.auth_user_status !== "active" ||
          row.membership_status !== "active"
        ) {
          await sql`
            UPDATE omni_mobile_sessions
            SET revoked_at = COALESCE(revoked_at, NOW()),
                revocation_reason = 'membership_changed',
                updated_at = NOW()
            WHERE id = ${session.id}
              AND tenant_id = ${session.tenantId}
              AND user_id = ${session.userId}
          `;
          return { error: "invalid_refresh_token" as const };
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

  const snapshot = await readMobileLedger();
  const candidate = snapshot.sessions.find((item) =>
    item.refreshTokenHash === refreshHash ||
    item.consumedRefreshTokenHashes.includes(refreshHash));
  const activeMembership = candidate
    ? await hasActiveMobileMembership(candidate)
    : false;
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
      return { ...ledger, sessions: ledger.sessions.map((item) => item.id === session.id ? { ...item, revokedAt: item.revokedAt || now.toISOString(), revocationReason: "refresh_reuse", updatedAt: now.toISOString() } : item) };
    }
    if (!activeMembership) {
      outcome = { error: "invalid_refresh_token" };
      return { ...ledger, sessions: ledger.sessions.map((item) => item.id === session.id ? { ...item, revokedAt: item.revokedAt || now.toISOString(), revocationReason: "membership_changed", updatedAt: now.toISOString() } : item) };
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
              AND EXISTS (
                SELECT 1 FROM omni_auth_users auth_user
                JOIN omni_auth_memberships membership
                  ON membership.user_id = auth_user.id
                  AND membership.tenant_id = ${identity.context.tenantId}
                WHERE auth_user.id = ${identity.user.id}
                  AND auth_user.status = 'active'
                  AND membership.status = 'active'
              )
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
              AND EXISTS (
                SELECT 1 FROM omni_auth_users auth_user
                JOIN omni_auth_memberships membership
                  ON membership.user_id = auth_user.id
                  AND membership.tenant_id = ${identity.context.tenantId}
                WHERE auth_user.id = ${identity.user.id}
                  AND auth_user.status = 'active'
                  AND membership.status = 'active'
              )
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

export async function revokeMobileSession(
  identity: MobileIdentity,
  reason: MobileRevocationReason = "logout",
) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await runWithDatabaseTenantScope(identity.context.tenantId, () =>
      getSql().transaction(async (sql: MobileSqlTransaction) => {
        await sql`
          UPDATE omni_mobile_sessions
          SET revoked_at = COALESCE(revoked_at, NOW()),
              revocation_reason = COALESCE(revocation_reason, ${reason}),
              updated_at = NOW()
          WHERE id = ${identity.session.id}
            AND tenant_id = ${identity.context.tenantId}
            AND user_id = ${identity.user.id}
            AND revoked_at IS NULL
        `;
        await revokeMobilePushRegistrations(
          sql,
          identity.context.tenantId,
          identity.user.id,
          identity.session.id,
        );
      }),
    );
    return;
  }
  const now = new Date().toISOString();
  await mutateMobileLedger((ledger) => ({ ...ledger, sessions: ledger.sessions.map((item) =>
    item.id === identity.session.id &&
    item.tenantId === identity.context.tenantId &&
    item.userId === identity.user.id &&
    !item.revokedAt
      ? { ...item, revokedAt: now, revocationReason: item.revocationReason || reason, updatedAt: now }
      : item) }));
}

export async function revokeMobileSessionsForUser(
  userId: string,
  tenantId: string,
  reason: MobileRevocationReason = "password_changed",
) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await runWithDatabaseTenantScope(tenantId, () =>
      getSql().transaction(async (sql: MobileSqlTransaction) => {
        await sql`UPDATE omni_mobile_sessions SET revoked_at = NOW(), revocation_reason = ${reason}, updated_at = NOW() WHERE user_id = ${userId} AND tenant_id = ${tenantId} AND revoked_at IS NULL`;
        await revokeMobilePushRegistrations(sql, tenantId, userId);
      }),
    );
    return;
  }
  const now = new Date().toISOString();
  await mutateMobileLedger((ledger) => ({
    ...ledger,
    sessions: ledger.sessions.map((item) =>
      item.userId === userId && item.tenantId === tenantId && !item.revokedAt
        ? { ...item, revokedAt: now, revocationReason: reason, updatedAt: now }
        : item),
  }));
}

export type MobileDeviceLifecycleAction = "revoke" | "remote_wipe";

export async function listMobileDeviceSessions(context: SecurityContext) {
  const userId = authenticatedUserId(context);
  const now = new Date();
  let sessions: MobileSessionRecord[];
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await runWithDatabaseTenantScope(context.tenantId, () => getSql()`
      SELECT *
      FROM omni_mobile_sessions
      WHERE tenant_id = ${context.tenantId}
        AND user_id = ${userId}
      ORDER BY COALESCE(last_seen_at, updated_at) DESC, id COLLATE "C"
      LIMIT 50
    `);
    sessions = rows.map(mobileSessionFromRow);
  } else {
    sessions = (await readMobileLedger()).sessions
      .filter((session) =>
        session.tenantId === context.tenantId && session.userId === userId)
      .sort((left, right) =>
        sessionActivityAt(right).localeCompare(sessionActivityAt(left)))
      .slice(0, 50);
  }
  return {
    schemaVersion: 1 as const,
    devices: sessions.map((session) => publicMobileDeviceSession(
      session,
      context.source === "mobile" && context.auth?.sessionId === session.id,
      now,
    )),
  };
}

export async function changeMobileDeviceLifecycle(
  context: SecurityContext,
  sessionId: string,
  action: MobileDeviceLifecycleAction,
) {
  const userId = authenticatedUserId(context);
  const now = new Date().toISOString();
  let session: MobileSessionRecord | undefined;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    session = await runWithDatabaseTenantScope(context.tenantId, () =>
      getSql().transaction(async (sql: MobileSqlTransaction) => {
        const rows = await sql`
          SELECT * FROM omni_mobile_sessions
          WHERE id = ${sessionId}
            AND tenant_id = ${context.tenantId}
            AND user_id = ${userId}
          LIMIT 1
          FOR UPDATE
        `;
        const current = rows[0] ? mobileSessionFromRow(rows[0]) : undefined;
        if (!current) return undefined;
        if (action === "revoke" && current.revokedAt) {
          await revokeMobilePushRegistrations(
            sql,
            context.tenantId,
            userId,
            sessionId,
          );
          return current;
        }
        const updated = action === "remote_wipe"
          ? await sql`
              UPDATE omni_mobile_sessions
              SET revoked_at = COALESCE(revoked_at, NOW()),
                  revocation_reason = 'remote_wipe',
                  wipe_requested_at = COALESCE(wipe_requested_at, NOW()),
                  replaced_by_session_id = NULL,
                  updated_at = NOW()
              WHERE id = ${sessionId}
                AND tenant_id = ${context.tenantId}
                AND user_id = ${userId}
              RETURNING *
            `
          : await sql`
              UPDATE omni_mobile_sessions
              SET revoked_at = NOW(),
                  revocation_reason = 'user_revoked',
                  replaced_by_session_id = NULL,
                  updated_at = NOW()
              WHERE id = ${sessionId}
                AND tenant_id = ${context.tenantId}
                AND user_id = ${userId}
                AND revoked_at IS NULL
              RETURNING *
            `;
        const result = updated[0] ? mobileSessionFromRow(updated[0]) : current;
        await revokeMobilePushRegistrations(
          sql,
          context.tenantId,
          userId,
          sessionId,
        );
        return result;
      }) as Promise<MobileSessionRecord | undefined>,
    );
  } else {
    await mutateMobileLedger((ledger) => ({
      ...ledger,
      sessions: ledger.sessions.map((current) => {
        if (
          current.id !== sessionId ||
          current.tenantId !== context.tenantId ||
          current.userId !== userId
        ) return current;
        if (action === "revoke" && current.revokedAt) {
          session = current;
          return current;
        }
        const next: MobileSessionRecord = action === "remote_wipe"
          ? {
              ...current,
              revokedAt: current.revokedAt || now,
              revocationReason: "remote_wipe",
              wipeRequestedAt: current.wipeRequestedAt || now,
              replacedBySessionId: undefined,
              updatedAt: now,
            }
          : {
              ...current,
              revokedAt: now,
              revocationReason: "user_revoked",
              replacedBySessionId: undefined,
              updatedAt: now,
            };
        session = next;
        return next;
      }),
    }));
  }
  return session
    ? publicMobileDeviceSession(
        session,
        context.source === "mobile" && context.auth?.sessionId === session.id,
        new Date(),
      )
    : undefined;
}

async function revokeMobilePushRegistrations(
  sql: MobileSqlTransaction,
  tenantId: string,
  userId: string,
  mobileSessionId?: string,
) {
  await sql`
    UPDATE omni_mobile_push_registrations
    SET state = 'revoked',
        lifecycle_revision = lifecycle_revision + 1,
        revoked_at = NOW(),
        updated_at = NOW()
    WHERE tenant_id = ${tenantId}
      AND user_id = ${userId}
      AND (${mobileSessionId || null}::text IS NULL OR mobile_session_id = ${mobileSessionId || null})
      AND state = 'active'
  `;
}

export async function getMobileWipeChallengeFromRequest(request: Request) {
  const accessToken = getBearerToken(request);
  if (!accessToken) return undefined;
  const accessHash = hashSessionToken(accessToken);
  const acknowledgementToken = createOpaqueToken();
  const challengeHash = hashSessionToken(acknowledgementToken);
  const expiresAt = new Date(Date.now() + wipeChallengeTtlMs).toISOString();
  let session: MobileSessionRecord | undefined;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    session = await runWithDatabaseSystemScope(
      "Resolve a revoked native access token only to deliver its remote-wipe challenge.",
      async () => {
        const rows = await getSql()`
          UPDATE omni_mobile_sessions
          SET wipe_challenge_hash = ${challengeHash},
              wipe_challenge_expires_at = ${expiresAt},
              updated_at = NOW()
          WHERE access_token_hash = ${accessHash}
            AND revocation_reason = 'remote_wipe'
            AND wipe_requested_at IS NOT NULL
            AND wipe_acknowledged_at IS NULL
          RETURNING *
        `;
        return rows[0] ? mobileSessionFromRow(rows[0]) : undefined;
      },
    );
  } else {
    await mutateMobileLedger((ledger) => ({
      ...ledger,
      sessions: ledger.sessions.map((current) => {
        if (
          current.accessTokenHash !== accessHash ||
          current.revocationReason !== "remote_wipe" ||
          !current.wipeRequestedAt ||
          current.wipeAcknowledgedAt
        ) return current;
        session = {
          ...current,
          wipeChallengeHash: challengeHash,
          wipeChallengeExpiresAt: expiresAt,
          updatedAt: new Date().toISOString(),
        };
        return session;
      }),
    }));
  }
  return session
    ? {
        schemaVersion: 1 as const,
        wipeRequired: true as const,
        deviceId: session.device.id,
        requestedAt: session.wipeRequestedAt!,
        acknowledgementToken,
      }
    : undefined;
}

export async function acknowledgeMobileWipe(
  acknowledgementToken: string,
  deviceId: string,
) {
  const challengeHash = hashSessionToken(acknowledgementToken);
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseSystemScope(
      "Acknowledge local erasure using a single-use remote-wipe challenge.",
      async () => {
        const rows = await getSql()`
          UPDATE omni_mobile_sessions
          SET wipe_acknowledged_at = NOW(),
              wipe_challenge_hash = NULL,
              wipe_challenge_expires_at = NULL,
              updated_at = NOW()
          WHERE wipe_challenge_hash = ${challengeHash}
            AND device_id = ${deviceId}
            AND revocation_reason = 'remote_wipe'
            AND wipe_acknowledged_at IS NULL
            AND wipe_challenge_expires_at > NOW()
          RETURNING id
        `;
        return Boolean(rows[0]);
      },
    );
  }
  let acknowledged = false;
  await mutateMobileLedger((ledger) => ({
    ...ledger,
    sessions: ledger.sessions.map((session) => {
      if (
        session.wipeChallengeHash !== challengeHash ||
        session.device.id !== deviceId ||
        session.revocationReason !== "remote_wipe" ||
        session.wipeAcknowledgedAt ||
        !session.wipeChallengeExpiresAt ||
        new Date(session.wipeChallengeExpiresAt).getTime() <= Date.now()
      ) return session;
      acknowledged = true;
      return {
        ...session,
        wipeAcknowledgedAt: now,
        wipeChallengeHash: undefined,
        wipeChallengeExpiresAt: undefined,
        updatedAt: now,
      };
    }),
  }));
  return acknowledged;
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
    await runWithDatabaseTenantScope(session.tenantId, () => getSql().transaction(async (sql: MobileSqlTransaction) => {
      await sql`
        UPDATE omni_mobile_sessions
        SET revoked_at = NOW(),
            revocation_reason = 'replaced',
            replaced_by_session_id = ${session.id},
            updated_at = NOW()
        WHERE user_id = ${session.userId}
          AND tenant_id = ${session.tenantId}
          AND device_id = ${device.id}
          AND revoked_at IS NULL
      `;
      await sql`
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
      `;
    }));
  } else {
    await mutateMobileLedger((ledger) => ({
      ...ledger,
      sessions: [
        session,
        ...ledger.sessions
          .filter((item) => new Date(item.refreshExpiresAt) > now)
          .map((item) => item.userId === session.userId &&
              item.tenantId === session.tenantId &&
              item.device.id === session.device.id &&
              !item.revokedAt
            ? {
                ...item,
                revokedAt: now.toISOString(),
                revocationReason: "replaced" as const,
                replacedBySessionId: session.id,
                updatedAt: now.toISOString(),
              }
            : item),
      ].slice(0, 500),
    }));
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
    native: {
      deviceId: session.device.id,
      platform: session.device.platform,
      appVersion: session.device.appVersion,
      buildNumber: session.device.buildNumber,
      clientContractVersion: session.device.clientContractVersion,
      clientAttestedAt: session.clientAttestedAt,
    },
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
  return { id: String(row.id), familyId: String(row.family_id), userId: String(row.user_id), tenantId: String(row.tenant_id), device: { id: String(row.device_id), name: String(row.device_name), platform: mobilePlatform(row.platform), appVersion: row.app_version ? String(row.app_version) : undefined, buildNumber: optionalPositiveInteger(row.app_build_number), clientContractVersion: optionalPositiveInteger(row.client_contract_version) }, accessTokenHash: String(row.access_token_hash), refreshTokenHash: String(row.refresh_token_hash), consumedRefreshTokenHashes: consumed, accessExpiresAt: date(row.access_expires_at), refreshExpiresAt: date(row.refresh_expires_at), createdAt: date(row.created_at), updatedAt: date(row.updated_at), lastSeenAt: row.last_seen_at ? date(row.last_seen_at) : undefined, clientAttestedAt: row.client_attested_at ? date(row.client_attested_at) : undefined, revokedAt: row.revoked_at ? date(row.revoked_at) : undefined, revocationReason: optionalRevocationReason(row.revocation_reason), wipeRequestedAt: row.wipe_requested_at ? date(row.wipe_requested_at) : undefined, wipeAcknowledgedAt: row.wipe_acknowledged_at ? date(row.wipe_acknowledged_at) : undefined, wipeChallengeHash: row.wipe_challenge_hash ? String(row.wipe_challenge_hash) : undefined, wipeChallengeExpiresAt: row.wipe_challenge_expires_at ? date(row.wipe_challenge_expires_at) : undefined, replacedBySessionId: row.replaced_by_session_id ? String(row.replaced_by_session_id) : undefined };
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
function optionalRevocationReason(value: unknown): MobileRevocationReason | undefined {
  return [
    "logout", "refresh_reuse", "password_changed", "membership_changed",
    "user_revoked", "remote_wipe", "replaced", "legacy_revoked",
  ].includes(String(value))
    ? String(value) as MobileRevocationReason
    : undefined;
}
function authenticatedUserId(context: SecurityContext) {
  const userId = context.auth?.userId;
  if (!userId) throw new Error("Native device lifecycle requires an authenticated user.");
  return userId;
}
function sessionActivityAt(session: MobileSessionRecord) {
  return session.lastSeenAt || session.updatedAt;
}
function publicMobileDeviceSession(
  session: MobileSessionRecord,
  current: boolean,
  now: Date,
) {
  const state = session.wipeAcknowledgedAt
    ? "wiped" as const
    : session.wipeRequestedAt
      ? "wipe_pending" as const
      : session.revokedAt
        ? "revoked" as const
        : new Date(session.refreshExpiresAt) <= now
          ? "expired" as const
          : "active" as const;
  return {
    id: session.id,
    current,
    state,
    device: session.device,
    createdAt: session.createdAt,
    lastSeenAt: sessionActivityAt(session),
    refreshExpiresAt: session.refreshExpiresAt,
    revokedAt: session.revokedAt || null,
    revocationReason: session.revocationReason || null,
    wipe: session.wipeRequestedAt
      ? {
          requestedAt: session.wipeRequestedAt,
          acknowledgedAt: session.wipeAcknowledgedAt || null,
          localErasure: session.wipeAcknowledgedAt
            ? "acknowledged" as const
            : "pending_device_acknowledgement" as const,
        }
      : null,
  };
}
async function hasActiveMobileMembership(session: MobileSessionRecord) {
  const control = await getAuthControlPlane({ tenantId: session.tenantId });
  return control.users.some((user) =>
    user.id === session.userId && user.status === "active") &&
    control.memberships.some((membership) =>
      membership.userId === session.userId &&
      membership.tenantId === session.tenantId &&
      membership.status === "active");
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
