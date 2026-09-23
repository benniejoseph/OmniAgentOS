import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import {
  isOAuthProvider,
  type GoogleConnectionPurpose,
  type OAuthProvider,
} from "@/lib/connectors/oauth-providers";
import {
  openOAuthTokens,
  sealOAuthTokens,
  type SealedOAuthTokens,
} from "@/lib/connectors/oauth-token-vault";
import { oauthGrantActorReadOrder } from "@/lib/connectors/oauth-actor-scope";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { openJsonPayload, sealJsonPayload } from "@/lib/security/sealed-payload";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";

export const OAUTH_PERSONAL_SOURCE_IDS = ["mail", "calendar", "drive"] as const;
export type OAuthPersonalSourceId = (typeof OAUTH_PERSONAL_SOURCE_IDS)[number];
export type OAuthSourceCoverageCheckpoint = Readonly<{
  schemaVersion: 1;
  status: "syncing" | "healthy" | "error";
  backfillState: "unknown" | "in_progress" | "complete";
  lastAttemptedAt: string;
  lastSuccessfulAt?: string;
  failureCode?: "none" | "provider_unauthorized" | "provider_forbidden" | "provider_rate_limited" | "provider_unavailable" | "processing_failed";
}>;
export type OAuthSourceCoverage = Partial<Record<OAuthPersonalSourceId, OAuthSourceCoverageCheckpoint>>;
export type OAuthGrant = {
  id: string;
  tenantId: string;
  actorId: string;
  provider: OAuthProvider;
  accountEmail?: string;
  connectionLabel: string;
  connectionPurpose: GoogleConnectionPurpose;
  scopes: string[];
  status: "active" | "revoked";
  authorizationGeneration: number;
  expiresAt?: string;
  syncStatus?: "idle" | "syncing" | "healthy" | "error";
  syncError?: string;
  lastSyncedAt?: string;
  syncedItems?: number;
  sourceCoverage?: OAuthSourceCoverage;
  createdAt: string;
  updatedAt: string;
};
export type RequestOAuthGrant = Omit<OAuthGrant, "sourceCoverage"> & {
  sourceCoverage: OAuthSourceCoverage;
  manageable: boolean;
};
export type OAuthSyncLease = Readonly<{
  ownerId: string;
  generation: number;
  expiresAt: string;
}>;
type InternalGrant = OAuthGrant & {
  sealedTokens: SealedOAuthTokens;
  sealedSyncCursor?: ReturnType<typeof sealJsonPayload>;
  /** Legacy file-mode compatibility; new cursor writes are sealed. */
  syncCursor?: string;
  syncLeaseOwnerId?: string;
  syncLeaseExpiresAt?: string;
  syncLeaseGeneration?: number;
};
const filePath = () => getDataPath("oauth-grants.json");
const OAUTH_SYNC_LEASE_MS = 10 * 60_000;

export type OAuthCredentialState =
  | "active"
  | "refresh_required"
  | "reconnect_required";

export class OAuthCredentialError extends Error {
  readonly status = 401;

  constructor(
    message: string,
    readonly code:
      | "grant_not_found"
      | "credential_missing"
      | "account_identity_changed"
      | "capability_not_granted",
    readonly reconnectRequired = true,
  ) {
    super(message);
    this.name = "OAuthCredentialError";
  }
}

export class OAuthGrantReadConflictError extends Error {
  readonly status = 409;

  constructor(message = "OAuth connection ownership is ambiguous.") {
    super(message);
    this.name = "OAuthGrantReadConflictError";
  }
}

export type OAuthGrantSelector = Readonly<{
  connectionId?: string;
  connectionPurpose?: GoogleConnectionPurpose;
}>;

export async function saveOAuthGrant(input: {
  tenantId: string;
  actorId: string;
  provider: OAuthProvider;
  tokens: Record<string, unknown>;
  authorizationMode?: "reauthorize" | "refresh";
  connectionId?: string;
  connectionPurpose?: GoogleConnectionPurpose;
  connectionLabel?: string;
  accountEmail?: string;
}) {
  const now = new Date().toISOString();
  const authorizationMode = input.authorizationMode || "reauthorize";
  const connectionPurpose = input.connectionPurpose || "personal";
  const incomingEmail = normalizeAccountEmail(
    input.accountEmail || tokenString(input.tokens.google_account_email),
  );
  if (input.provider === "google" && !incomingEmail && authorizationMode !== "refresh") {
    throw new OAuthCredentialError(
      "The Google account email could not be bound to this connection.",
      "account_identity_changed",
    );
  }
  const connectionLabel = normalizeConnectionLabel(
    input.connectionLabel || (connectionPurpose === "work" ? "Work" : "Personal"),
  );
  const existingSecrets = await getOAuthGrantSecrets(
    input.tenantId,
    input.actorId,
    input.provider,
    input.connectionId
      ? { connectionId: input.connectionId }
      : { connectionPurpose },
  );
  const retainedGrant = existingSecrets?.grant || await findRetainedOAuthGrant(
    input.tenantId,
    input.actorId,
    input.provider,
    input.connectionId
      ? { connectionId: input.connectionId }
      : { connectionPurpose },
  );
  const incomingTokens = Object.fromEntries(
    Object.entries(input.tokens).filter(([name, value]) =>
      value !== undefined &&
      value !== null &&
      (name !== "refresh_token" || (typeof value === "string" && value.trim()))
    ),
  );
  const tokens = { ...(existingSecrets?.tokens || {}), ...incomingTokens };
  const existingSubject = tokenString(existingSecrets?.tokens.google_account_sub);
  const incomingSubject = tokenString(input.tokens.google_account_sub);
  const existingEmail = normalizeAccountEmail(existingSecrets?.grant.accountEmail || "");
  if (
    input.provider === "google" &&
    (
      (existingSubject && incomingSubject && existingSubject !== incomingSubject) ||
      (existingEmail && incomingEmail && existingEmail !== incomingEmail) ||
      (existingSecrets && existingSecrets.grant.connectionPurpose !== connectionPurpose)
    )
  ) {
    throw new OAuthCredentialError(
      "The Google account identity changed during authorization.",
      "account_identity_changed",
    );
  }
  const expiresIn = Number(tokens.expires_in || 0);
  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
  const scopes = [...new Set(
    String(tokens.scope || existingSecrets?.grant.scopes.join(" ") || "")
      .split(/\s+/)
      .filter(Boolean),
  )].sort();
  const resetAuthorization = Boolean(
    existingSecrets &&
      authorizationMode === "reauthorize" &&
      !sameStringSet(existingSecrets.grant.scopes, scopes),
  );
  const id = retainedGrant?.id || input.connectionId || randomUUID();
  const accountEmail = incomingEmail || existingEmail || undefined;
  const grantIdentity = {
    ...input,
    id,
    connectionPurpose,
  };
  const sealedTokens = sealOAuthTokens(tokens, oauthGrantBinding(grantIdentity));
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      INSERT INTO omni_oauth_grants (
        id, tenant_id, actor_id, provider, account_email, connection_label,
        connection_purpose, scopes, sealed_tokens, expires_at,
        status, authorization_generation, created_at, updated_at
      ) VALUES (
        ${id}, ${input.tenantId}, ${input.actorId}, ${input.provider},
        ${accountEmail || null}, ${connectionLabel}, ${connectionPurpose},
        ${scopes}, ${sealedTokens}::jsonb, ${expiresAt || null}, 'active', 1,
        ${now}, ${now}
      )
      ON CONFLICT (tenant_id, actor_id, provider, connection_purpose) DO UPDATE SET
        account_email = COALESCE(EXCLUDED.account_email, omni_oauth_grants.account_email),
        connection_label = EXCLUDED.connection_label,
        scopes = EXCLUDED.scopes,
        sealed_tokens = EXCLUDED.sealed_tokens,
        expires_at = EXCLUDED.expires_at,
        status = 'active',
        authorization_generation = CASE
          WHEN ${resetAuthorization}
            THEN omni_oauth_grants.authorization_generation + 1
          ELSE omni_oauth_grants.authorization_generation
        END,
        sync_cursor = CASE
          WHEN ${resetAuthorization}
            THEN NULL
          ELSE omni_oauth_grants.sync_cursor
        END,
        sync_status = CASE
          WHEN ${resetAuthorization}
            THEN 'idle'
          ELSE omni_oauth_grants.sync_status
        END,
        source_sync_health = CASE
          WHEN ${resetAuthorization}
            THEN '{}'::jsonb
          ELSE omni_oauth_grants.source_sync_health
        END,
        sync_error = CASE
          WHEN ${resetAuthorization}
            THEN NULL
          ELSE omni_oauth_grants.sync_error
        END,
        last_synced_at = CASE
          WHEN ${resetAuthorization}
            THEN NULL
          ELSE omni_oauth_grants.last_synced_at
        END,
        synced_items = CASE
          WHEN ${resetAuthorization}
            THEN 0
          ELSE omni_oauth_grants.synced_items
        END,
        sync_lease_owner_id = CASE
          WHEN ${resetAuthorization}
            THEN NULL
          ELSE omni_oauth_grants.sync_lease_owner_id
        END,
        sync_lease_expires_at = CASE
          WHEN ${resetAuthorization}
            THEN NULL
          ELSE omni_oauth_grants.sync_lease_expires_at
        END,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `;
    return publicGrant(rows[0]);
  }
  let saved!: InternalGrant;
  await updateJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] }, (ledger) => {
    const existing = ledger.grants.find((grant) =>
      grant.tenantId === input.tenantId &&
      grant.actorId === input.actorId &&
      grant.provider === input.provider &&
      (input.connectionId
        ? grant.id === input.connectionId
        : (grant.connectionPurpose || "personal") === connectionPurpose)
    );
    const preserveSyncState = Boolean(existing && !resetAuthorization);
    saved = { id: existing?.id || id, tenantId: input.tenantId, actorId: input.actorId, provider: input.provider, accountEmail, connectionLabel, connectionPurpose, scopes, sealedTokens, sealedSyncCursor: preserveSyncState ? existing?.sealedSyncCursor : undefined, syncCursor: preserveSyncState ? existing?.syncCursor : undefined, syncStatus: preserveSyncState ? existing?.syncStatus || "idle" : "idle", syncError: preserveSyncState ? existing?.syncError : undefined, lastSyncedAt: preserveSyncState ? existing?.lastSyncedAt : undefined, syncedItems: preserveSyncState ? existing?.syncedItems || 0 : 0, sourceCoverage: preserveSyncState ? existing?.sourceCoverage || {} : {}, status: "active", authorizationGeneration: existing ? Math.max(1, Number(existing.authorizationGeneration || 1)) + (resetAuthorization ? 1 : 0) : 1, expiresAt, createdAt: existing?.createdAt || now, updatedAt: now, ...(preserveSyncState ? { syncLeaseOwnerId: existing?.syncLeaseOwnerId, syncLeaseExpiresAt: existing?.syncLeaseExpiresAt, syncLeaseGeneration: existing?.syncLeaseGeneration } : { syncLeaseGeneration: existing?.syncLeaseGeneration || 0 }) };
    return { grants: [saved, ...ledger.grants.filter((grant) => grant.id !== existing?.id)].slice(0, 100) };
  });
  return stripTokens(saved);
}

export async function listOAuthGrants(tenantId: string, actorId: string) {
  if (hasDatabaseUrl()) { await ensureDatabaseSchema(); const rows = await getSql()`SELECT * FROM omni_oauth_grants WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND provider IN ('google', 'salesforce') AND status = 'active' ORDER BY updated_at DESC`; return rows.map(publicGrant); }
  const ledger = await readJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] });
  return ledger.grants.filter((grant) => grant.tenantId === tenantId && grant.actorId === actorId && isOAuthProvider(grant.provider) && grant.status === "active").map(stripTokens);
}

/**
 * Returns display-only request metadata. Token opening, synchronization,
 * refresh, revocation, authorization callbacks, and all writes stay on the
 * exact-owner functions in this module.
 */
export async function listOAuthGrantsForRequest(input: {
  tenantId: string;
  actorId: string;
  requestActorBinding?: CanonicalRequestActorBindingV1;
}): Promise<RequestOAuthGrant[]> {
  if (!hasDatabaseUrl()) {
    const ledger = await readJsonFile<{ grants: InternalGrant[] }>(
      filePath(),
      { grants: [] },
    );
    const records = ledger.grants
      .filter((grant) =>
        grant.tenantId === input.tenantId &&
        grant.actorId === input.actorId &&
        isOAuthProvider(grant.provider) &&
        grant.status === "active"
      )
      .map((grant) => {
        const row = oauthGrantLedgerRow(grant);
        assertRequestOAuthGrantRow(
          row,
          input.tenantId,
          input.actorId,
          input.actorId,
        );
        return publicGrant(row);
      });
    assertRequestOAuthGrantRecords(
      records,
      input.tenantId,
      input.actorId,
      input.actorId,
    );
    return records
      .sort(compareOAuthGrantMetadata)
      .map((grant) => requestOAuthGrant(grant, input.actorId));
  }

  const [canonicalActorId, exactActorId] = oauthGrantActorReadOrder(
    input.actorId,
    input.requestActorBinding,
  );
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT id, tenant_id, actor_id, provider, account_email,
      connection_label, connection_purpose, scopes, status,
      authorization_generation, expires_at, sync_status, sync_error,
      last_synced_at, synced_items, source_sync_health, created_at, updated_at
    FROM omni_oauth_grants
    WHERE tenant_id = ${input.tenantId}
      AND actor_id IN (${canonicalActorId}, ${exactActorId})
      AND provider IN ('google', 'salesforce')
      AND status = 'active'
      AND tenant_id COLLATE "C" = ${input.tenantId}::text COLLATE "C"
      AND (
        actor_id COLLATE "C" = ${canonicalActorId}::text COLLATE "C"
        OR actor_id COLLATE "C" = ${exactActorId}::text COLLATE "C"
      )
    ORDER BY updated_at DESC, id COLLATE "C"
  `;
  const records = rows.map((row) => {
    assertRequestOAuthGrantRow(
      row,
      input.tenantId,
      canonicalActorId,
      exactActorId,
    );
    return publicGrant(row);
  });
  assertRequestOAuthGrantRecords(
    records,
    input.tenantId,
    canonicalActorId,
    exactActorId,
  );
  return records.map((grant) => requestOAuthGrant(grant, exactActorId));
}

export async function listOAuthGrantsForTenant(tenantId: string) {
  if (hasDatabaseUrl()) { await ensureDatabaseSchema(); const rows = await getSql()`SELECT * FROM omni_oauth_grants WHERE tenant_id = ${tenantId} AND provider = 'google' AND status = 'active' ORDER BY last_synced_at ASC NULLS FIRST, updated_at ASC`; return rows.map(publicGrant); }
  const ledger = await readJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] });
  return ledger.grants.filter((grant) => grant.tenantId === tenantId && grant.provider === "google" && grant.status === "active").sort((left, right) => (left.lastSyncedAt || "").localeCompare(right.lastSyncedAt || "")).map(stripTokens);
}

export async function revokeOAuthGrant(
  tenantId: string,
  actorId: string,
  provider: OAuthProvider,
  selector?: OAuthGrantSelector,
) {
  const now = new Date().toISOString();
  const existing = await getOAuthGrantSecrets(tenantId, actorId, provider, selector);
  if (!existing) return;
  const sealedTokens = sealOAuthTokens({}, oauthGrantBinding(existing.grant));
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`UPDATE omni_oauth_grants SET status = 'revoked', sealed_tokens = ${sealedTokens}::jsonb, sync_cursor = NULL, sync_lease_owner_id = NULL, sync_lease_expires_at = NULL, updated_at = ${now} WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND provider = ${provider} AND id = ${existing.grant.id}`;
    return;
  }
  await updateJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] }, (ledger) => ({ grants: ledger.grants.map((grant) => grant.id === existing.grant.id && grant.tenantId === tenantId && grant.actorId === actorId && grant.provider === provider ? { ...grant, status: "revoked", sealedTokens, sealedSyncCursor: undefined, syncCursor: undefined, syncLeaseOwnerId: undefined, syncLeaseExpiresAt: undefined, updatedAt: now } : grant) }));
}

export async function getOAuthGrantSecrets(
  tenantId: string,
  actorId: string,
  provider: OAuthProvider,
  selector?: OAuthGrantSelector,
) {
  let candidates: InternalGrant[];
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_oauth_grants WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND provider = ${provider} AND status = 'active' ORDER BY updated_at DESC, id`;
    candidates = rows.map(internalGrantFromRow);
  } else {
    const ledger = await readJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] });
    candidates = ledger.grants.filter((grant) => grant.tenantId === tenantId && grant.actorId === actorId && grant.provider === provider && grant.status === "active");
  }
  const internal = resolveInternalGrant(candidates, selector);
  if (!internal) return undefined;
  const opened = openOAuthGrantTokens(internal);
  if (opened.needsRewrap) {
    await rewrapOAuthTokens(internal, opened.tokens);
  }
  return {
    grant: stripTokens(internal),
    tokens: opened.tokens,
    credentialState: oauthCredentialState(opened.tokens, internal.expiresAt),
    syncCursor: openedSyncCursor(internal),
  };
}

async function findRetainedOAuthGrant(
  tenantId: string,
  actorId: string,
  provider: OAuthProvider,
  selector: OAuthGrantSelector,
) {
  let candidates: OAuthGrant[];
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_oauth_grants WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND provider = ${provider} ORDER BY updated_at DESC, id`;
    candidates = rows.map(publicGrant);
  } else {
    const ledger = await readJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] });
    candidates = ledger.grants
      .filter((grant) => grant.tenantId === tenantId && grant.actorId === actorId && grant.provider === provider)
      .map(stripTokens);
  }
  const selected = candidates.filter((grant) =>
    (!selector.connectionId || grant.id === selector.connectionId) &&
    (!selector.connectionPurpose || grant.connectionPurpose === selector.connectionPurpose)
  );
  if (selected.length > 1) {
    throw new OAuthGrantReadConflictError("OAuth connection identity is ambiguous.");
  }
  return selected[0];
}

export async function claimOAuthSyncLease(input: {
  tenantId: string;
  actorId: string;
  provider: OAuthProvider;
  connectionId: string;
}): Promise<
  | { status: "claimed"; lease: OAuthSyncLease }
  | { status: "busy" }
> {
  const ownerId = randomUUID();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_oauth_grants
      SET sync_lease_owner_id = ${ownerId},
          sync_lease_expires_at = clock_timestamp() + INTERVAL '10 minutes',
          sync_lease_generation = sync_lease_generation + 1,
          sync_status = 'syncing',
          sync_error = NULL,
          updated_at = clock_timestamp()
      WHERE tenant_id = ${input.tenantId}
        AND actor_id = ${input.actorId}
        AND provider = ${input.provider}
        AND id = ${input.connectionId}
        AND status = 'active'
        AND (
          sync_lease_owner_id IS NULL
          OR sync_lease_expires_at <= clock_timestamp()
        )
      RETURNING sync_lease_generation, sync_lease_expires_at
    `;
    if (rows.length !== 1) return { status: "busy" };
    return {
      status: "claimed",
      lease: {
        ownerId,
        generation: Number(rows[0].sync_lease_generation),
        expiresAt: new Date(String(rows[0].sync_lease_expires_at)).toISOString(),
      },
    };
  }

  const now = Date.now();
  let lease: OAuthSyncLease | undefined;
  await updateJsonFile<{ grants: InternalGrant[] }>(
    filePath(),
    { grants: [] },
    (ledger) => ({
      grants: ledger.grants.map((grant) => {
        if (
          grant.tenantId !== input.tenantId ||
          grant.actorId !== input.actorId ||
          grant.provider !== input.provider ||
          grant.id !== input.connectionId ||
          grant.status !== "active" ||
          (
            grant.syncLeaseOwnerId &&
            Date.parse(grant.syncLeaseExpiresAt || "") > now
          )
        ) {
          return grant;
        }
        lease = {
          ownerId,
          generation: Math.max(0, grant.syncLeaseGeneration || 0) + 1,
          expiresAt: new Date(now + OAUTH_SYNC_LEASE_MS).toISOString(),
        };
        return {
          ...grant,
          syncLeaseOwnerId: lease.ownerId,
          syncLeaseExpiresAt: lease.expiresAt,
          syncLeaseGeneration: lease.generation,
          syncStatus: "syncing",
          syncError: undefined,
          updatedAt: new Date(now).toISOString(),
        };
      }),
    }),
  );
  return lease ? { status: "claimed", lease } : { status: "busy" };
}

export async function updateOAuthSyncState(input: {
  tenantId: string;
  actorId: string;
  provider: OAuthProvider;
  connectionId: string;
  status: "syncing" | "healthy" | "error";
  cursor?: string;
  error?: string;
  syncedItems?: number;
  lease?: OAuthSyncLease;
  releaseLease?: boolean;
  sourceSettlements?: readonly (OAuthSourceCoverageCheckpoint & {
    source: OAuthPersonalSourceId;
  })[];
}) {
  const now = new Date().toISOString();
  const sourceSettlements = normalizeSourceSettlements(input.sourceSettlements || []);
  if (input.releaseLease && !input.lease) {
    throw new Error("OAuth sync lease release requires an exact fence.");
  }
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const sealedCursor = input.cursor
      ? JSON.stringify(sealJsonPayload(input.cursor, syncCursorBinding({ ...input, id: input.connectionId })))
      : undefined;
    const persist = async (sql: ReturnType<typeof getSql>) => {
      let rows = input.lease
        ? await sql`UPDATE omni_oauth_grants SET sync_status = ${input.status}, sync_error = ${input.error || null}, sync_cursor = COALESCE(${sealedCursor || null}, sync_cursor), synced_items = synced_items + ${input.syncedItems || 0}, last_synced_at = CASE WHEN ${input.status} = 'healthy' THEN ${now}::timestamptz ELSE last_synced_at END, sync_lease_owner_id = CASE WHEN ${Boolean(input.releaseLease)} THEN NULL ELSE sync_lease_owner_id END, sync_lease_expires_at = CASE WHEN ${Boolean(input.releaseLease)} THEN NULL ELSE sync_lease_expires_at END, updated_at = ${now} WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId} AND provider = ${input.provider} AND id = ${input.connectionId} AND status = 'active' AND sync_lease_owner_id = ${input.lease.ownerId} AND sync_lease_generation = ${input.lease.generation} AND sync_lease_expires_at > clock_timestamp() RETURNING *`
        : await sql`UPDATE omni_oauth_grants SET sync_status = ${input.status}, sync_error = ${input.error || null}, sync_cursor = COALESCE(${sealedCursor || null}, sync_cursor), synced_items = synced_items + ${input.syncedItems || 0}, last_synced_at = CASE WHEN ${input.status} = 'healthy' THEN ${now}::timestamptz ELSE last_synced_at END, updated_at = ${now} WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId} AND provider = ${input.provider} AND id = ${input.connectionId} AND status = 'active' RETURNING *`;
      if (!rows[0]) return undefined;
      for (const settlement of sourceSettlements) {
        rows = await sql`
          UPDATE omni_oauth_grants
          SET source_sync_health = jsonb_set(
            COALESCE(source_sync_health, '{}'::jsonb),
            ARRAY[${settlement.source}]::text[],
            COALESCE(source_sync_health -> ${settlement.source}, '{}'::jsonb)
              || ${withoutSource(settlement)}::jsonb,
            true
          )
          WHERE tenant_id = ${input.tenantId}
            AND id = ${String(rows[0].id)}
            AND actor_id = ${input.actorId}
            AND provider = ${input.provider}
            AND id = ${input.connectionId}
            AND status = 'active'
          RETURNING *
        `;
        if (!rows[0]) return undefined;
      }
      return publicGrant(rows[0]);
    };
    return sourceSettlements.length
      ? await getSql().transaction(persist) as OAuthGrant | undefined
      : persist(getSql());
  }
  let updated: OAuthGrant | undefined;
  await updateJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] }, (ledger) => ({ grants: ledger.grants.map((grant) => {
    if (grant.tenantId !== input.tenantId || grant.actorId !== input.actorId || grant.provider !== input.provider || grant.id !== input.connectionId || grant.status !== "active") return grant;
    if (
      input.lease &&
      (
        grant.syncLeaseOwnerId !== input.lease.ownerId ||
        grant.syncLeaseGeneration !== input.lease.generation ||
        Date.parse(grant.syncLeaseExpiresAt || "") <= Date.now()
      )
    ) {
      return grant;
    }
    const next: InternalGrant = { ...grant, syncStatus: input.status, syncError: input.error, sealedSyncCursor: input.cursor ? sealJsonPayload(input.cursor, syncCursorBinding(grant)) : grant.sealedSyncCursor, syncCursor: input.cursor ? undefined : grant.syncCursor, syncedItems: (grant.syncedItems || 0) + (input.syncedItems || 0), sourceCoverage: mergeSourceCoverage(grant.sourceCoverage, sourceSettlements), lastSyncedAt: input.status === "healthy" ? now : grant.lastSyncedAt, updatedAt: now, ...(input.releaseLease ? { syncLeaseOwnerId: undefined, syncLeaseExpiresAt: undefined } : {}) };
    updated = stripTokens(next); return next;
  }) }));
  return updated;
}

function stripTokens(grant: InternalGrant): OAuthGrant {
  return { id: grant.id, tenantId: grant.tenantId, actorId: grant.actorId, provider: grant.provider, accountEmail: normalizeAccountEmail(grant.accountEmail || "") || undefined, connectionLabel: normalizeConnectionLabel(grant.connectionLabel || "Personal"), connectionPurpose: grant.connectionPurpose || "personal", scopes: grant.scopes, status: grant.status, authorizationGeneration: Math.max(1, Number(grant.authorizationGeneration || 1)), expiresAt: grant.expiresAt, syncStatus: grant.syncStatus || "idle", syncError: grant.syncError, lastSyncedAt: grant.lastSyncedAt, syncedItems: grant.syncedItems || 0, sourceCoverage: parseSourceCoverage(grant.sourceCoverage), createdAt: grant.createdAt, updatedAt: grant.updatedAt };
}
function publicGrant(row: Record<string, unknown>): OAuthGrant { return { id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), provider: String(row.provider) as OAuthProvider, accountEmail: normalizeAccountEmail(String(row.account_email || "")) || undefined, connectionLabel: normalizeConnectionLabel(String(row.connection_label || "Personal")), connectionPurpose: row.connection_purpose === "work" ? "work" : "personal", scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [], status: String(row.status) as "active" | "revoked", authorizationGeneration: Math.max(1, Number(row.authorization_generation || 1)), expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : undefined, syncStatus: String(row.sync_status || "idle") as OAuthGrant["syncStatus"], syncError: row.sync_error ? String(row.sync_error) : undefined, lastSyncedAt: row.last_synced_at ? new Date(String(row.last_synced_at)).toISOString() : undefined, syncedItems: Number(row.synced_items || 0), sourceCoverage: parseSourceCoverage(row.source_sync_health), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() }; }
function internalGrantFromRow(row: Record<string, unknown>): InternalGrant {
  const grant = publicGrant(row);
  const storedCursor = row.sync_cursor ? String(row.sync_cursor) : undefined;
  const cursor = storedCursor
    ? storedDatabaseSyncCursor(storedCursor)
    : {};
  return {
    ...grant,
    sealedTokens: row.sealed_tokens as InternalGrant["sealedTokens"],
    ...cursor,
    syncLeaseOwnerId: row.sync_lease_owner_id
      ? String(row.sync_lease_owner_id)
      : undefined,
    syncLeaseExpiresAt: row.sync_lease_expires_at
      ? new Date(String(row.sync_lease_expires_at)).toISOString()
      : undefined,
    syncLeaseGeneration: Number(row.sync_lease_generation || 0),
  };
}

function openedSyncCursor(grant: InternalGrant) {
  if (grant.sealedSyncCursor) {
    let opened: unknown;
    try {
      opened = openJsonPayload(grant.sealedSyncCursor, syncCursorBinding(grant));
    } catch {
      opened = openJsonPayload(grant.sealedSyncCursor, legacySyncCursorBinding(grant));
    }
    if (typeof opened !== "string") {
      throw new Error("Connected source cursor is invalid.");
    }
    return opened;
  }
  return grant.syncCursor;
}

function storedDatabaseSyncCursor(
  value: string,
): Pick<InternalGrant, "sealedSyncCursor" | "syncCursor"> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.version === 1 && parsed.algorithm === "aes-256-gcm") {
      return {
        sealedSyncCursor: parsed as InternalGrant["sealedSyncCursor"],
      };
    }
  } catch {
    // Legacy cursor strings were stored as plaintext JSON.
  }
  return { syncCursor: value };
}

function syncCursorBinding(
  owner: Pick<OAuthGrant, "id" | "tenantId" | "actorId" | "provider">,
) {
  return `oauth-sync-cursor:${owner.tenantId}:${owner.actorId}:${owner.provider}:${owner.id}`;
}

function oauthGrantBinding(
  owner: Pick<OAuthGrant, "id" | "tenantId" | "actorId" | "provider">,
) {
  return `oauth-grant:${owner.tenantId}:${owner.actorId}:${owner.provider}:${owner.id}`;
}

function legacySyncCursorBinding(
  owner: Pick<OAuthGrant, "tenantId" | "actorId" | "provider">,
) {
  return `oauth-sync-cursor:${owner.tenantId}:${owner.actorId}:${owner.provider}`;
}

function legacyOAuthGrantBinding(
  owner: Pick<OAuthGrant, "tenantId" | "actorId" | "provider">,
) {
  return `oauth-grant:${owner.tenantId}:${owner.actorId}:${owner.provider}`;
}

function openOAuthGrantTokens(grant: InternalGrant) {
  try {
    return openOAuthTokens(grant.sealedTokens, oauthGrantBinding(grant));
  } catch {
    const opened = openOAuthTokens(grant.sealedTokens, legacyOAuthGrantBinding(grant));
    return { ...opened, needsRewrap: true };
  }
}

function oauthCredentialState(
  tokens: Record<string, unknown>,
  accessTokenExpiresAt?: string,
): OAuthCredentialState {
  const accessToken = tokenString(tokens.access_token);
  const expiresAt = accessTokenExpiresAt ? Date.parse(accessTokenExpiresAt) : 0;
  if (
    accessToken &&
    (!accessTokenExpiresAt || (Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000))
  ) {
    return "active";
  }
  return tokenString(tokens.refresh_token)
    ? "refresh_required"
    : "reconnect_required";
}

async function rewrapOAuthTokens(
  grant: InternalGrant,
  tokens: Record<string, unknown>,
) {
  const sealedTokens = sealOAuthTokens(tokens, oauthGrantBinding(grant));
  if (hasDatabaseUrl()) {
    try {
      await getSql()`
        UPDATE omni_oauth_grants
        SET sealed_tokens = ${sealedTokens}::jsonb
        WHERE id = ${grant.id}
          AND tenant_id = ${grant.tenantId}
          AND actor_id = ${grant.actorId}
          AND provider = ${grant.provider}
          AND status = 'active'
          AND sealed_tokens = ${grant.sealedTokens}::jsonb
      `;
    } catch {
      // Rotation is opportunistic. A readable retained key remains valid and
      // the next exact-owner access can retry without blocking the operation.
    }
    return;
  }
  try {
    await updateJsonFile<{ grants: InternalGrant[] }>(
      filePath(),
      { grants: [] },
      (ledger) => ({
        grants: ledger.grants.map((candidate) =>
          candidate.id === grant.id &&
          candidate.tenantId === grant.tenantId &&
          candidate.actorId === grant.actorId &&
          candidate.provider === grant.provider &&
          candidate.status === "active" &&
          JSON.stringify(candidate.sealedTokens) === JSON.stringify(grant.sealedTokens)
            ? { ...candidate, sealedTokens }
            : candidate
        ),
      }),
    );
  } catch {
    // Preserve the readable retained envelope and retry on a later access.
  }
}

function tokenString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAccountEmail(value: string) {
  const normalized = value.trim().toLowerCase();
  return isNormalizedAccountEmail(normalized) ? normalized : "";
}

function isNormalizedAccountEmail(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 320 &&
    value === value.trim().toLowerCase() &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeConnectionLabel(value: string) {
  const label = value
    .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(label || "Personal").slice(0, 80).join("");
}

function isSafeConnectionLabel(value: unknown): value is string {
  return typeof value === "string" &&
    value === normalizeConnectionLabel(value) &&
    value.length >= 1 &&
    value.length <= 80;
}

function resolveInternalGrant(
  candidates: readonly InternalGrant[],
  selector?: OAuthGrantSelector,
) {
  const selected = candidates.filter((grant) =>
    (!selector?.connectionId || grant.id === selector.connectionId) &&
    (!selector?.connectionPurpose ||
      (grant.connectionPurpose || "personal") === selector.connectionPurpose)
  );
  if (selected.length > 1) {
    throw new OAuthGrantReadConflictError(
      "Choose an exact connected account before continuing.",
    );
  }
  return selected[0];
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const oauthSyncStatuses = ["idle", "syncing", "healthy", "error"] as const;

function requestOAuthGrant(
  grant: OAuthGrant,
  requestActorId: string,
): RequestOAuthGrant {
  return {
    id: grant.id,
    tenantId: grant.tenantId,
    actorId: requestActorId,
    provider: grant.provider,
    accountEmail: grant.accountEmail,
    connectionLabel: grant.connectionLabel,
    connectionPurpose: grant.connectionPurpose,
    scopes: [...grant.scopes],
    status: grant.status,
    authorizationGeneration: grant.authorizationGeneration,
    expiresAt: grant.expiresAt,
    syncStatus: grant.syncStatus,
    syncError: grant.syncError
      ? safeOAuthDisplayText(grant.syncError, 600)
      : undefined,
    lastSyncedAt: grant.lastSyncedAt,
    syncedItems: grant.syncedItems,
    sourceCoverage: parseSourceCoverage(grant.sourceCoverage),
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
    manageable: grant.actorId === requestActorId,
  };
}

function assertRequestOAuthGrantRow(
  row: Record<string, unknown>,
  expectedTenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  const id = typeof row.id === "string" ? row.id : "";
  const tenantId = typeof row.tenant_id === "string" ? row.tenant_id : "";
  const actorId = typeof row.actor_id === "string" ? row.actor_id : "";
  const provider = typeof row.provider === "string" ? row.provider : "";
  const accountEmail = row.account_email;
  const connectionLabel = row.connection_label;
  const connectionPurpose = row.connection_purpose;
  const scopes = row.scopes;
  const status = typeof row.status === "string" ? row.status : "";
  const syncStatus = typeof row.sync_status === "string"
    ? row.sync_status
    : "";
  const syncError = row.sync_error;
  const sourceCoverage = row.source_sync_health;
  const authorizationGeneration = storedOAuthInteger(
    row.authorization_generation,
  );
  const syncedItems = storedOAuthInteger(row.synced_items);
  const createdAt = oauthDateMillis(row.created_at);
  const updatedAt = oauthDateMillis(row.updated_at);
  const lastSyncedAt = oauthDateMillis(row.last_synced_at);
  if (
    !uuidPattern.test(id) ||
    tenantId !== expectedTenantId ||
    (actorId !== canonicalActorId && actorId !== exactActorId) ||
    !isOAuthProvider(provider) ||
    !(accountEmail === null || accountEmail === undefined || isNormalizedAccountEmail(accountEmail)) ||
    !isSafeConnectionLabel(connectionLabel) ||
    !(connectionPurpose === "personal" || connectionPurpose === "work") ||
    status !== "active" ||
    !isSafeOAuthScopes(scopes) ||
    !oauthSyncStatuses.includes(syncStatus as (typeof oauthSyncStatuses)[number]) ||
    !(syncError === null || syncError === undefined || typeof syncError === "string") ||
    !isSourceCoverage(sourceCoverage) ||
    (typeof syncError === "string" && Array.from(syncError).length > 16_000) ||
    (syncStatus !== "error" && syncError !== null && syncError !== undefined) ||
    authorizationGeneration === undefined ||
    authorizationGeneration < 1 ||
    syncedItems === undefined ||
    !isOptionalOAuthDate(row.expires_at) ||
    !isOptionalOAuthDate(row.last_synced_at) ||
    !isRequiredOAuthDate(row.created_at) ||
    !isRequiredOAuthDate(row.updated_at) ||
    createdAt > updatedAt ||
    (syncStatus === "healthy" && !isRequiredOAuthDate(row.last_synced_at)) ||
    (isRequiredOAuthDate(row.last_synced_at) &&
      (lastSyncedAt < createdAt || lastSyncedAt > updatedAt))
  ) {
    throw new OAuthGrantReadConflictError(
      "OAuth connection metadata could not be resolved safely.",
    );
  }
}

function assertRequestOAuthGrantRecords(
  records: OAuthGrant[],
  tenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  const ids = new Set<string>();
  const providerPurposes = new Set<string>();
  const providerEmails = new Set<string>();
  for (const record of records) {
    if (
      record.tenantId !== tenantId ||
      (record.actorId !== canonicalActorId && record.actorId !== exactActorId)
    ) {
      throw new OAuthGrantReadConflictError(
        "OAuth connection metadata could not be resolved safely.",
      );
    }
    if (ids.has(record.id)) {
      throw new OAuthGrantReadConflictError(
        "Duplicate OAuth connection identifiers were found.",
      );
    }
    const providerPurpose = `${record.provider}:${record.connectionPurpose}`;
    if (providerPurposes.has(providerPurpose)) {
      throw new OAuthGrantReadConflictError(
        "OAuth connection purpose ownership is ambiguous.",
      );
    }
    const providerEmail = record.accountEmail
      ? `${record.provider}:${record.accountEmail}`
      : undefined;
    if (providerEmail && providerEmails.has(providerEmail)) {
      throw new OAuthGrantReadConflictError("OAuth account identity is ambiguous.");
    }
    ids.add(record.id);
    providerPurposes.add(providerPurpose);
    if (providerEmail) providerEmails.add(providerEmail);
  }
}

function oauthGrantLedgerRow(grant: OAuthGrant) {
  return {
    id: grant.id,
    tenant_id: grant.tenantId,
    actor_id: grant.actorId,
    provider: grant.provider,
    account_email: grant.accountEmail ?? null,
    connection_label: grant.connectionLabel || "Personal",
    connection_purpose: grant.connectionPurpose || "personal",
    scopes: grant.scopes,
    status: grant.status,
    authorization_generation: grant.authorizationGeneration === undefined
      ? 1
      : grant.authorizationGeneration,
    expires_at: grant.expiresAt ?? null,
    sync_status: grant.syncStatus === undefined ? "idle" : grant.syncStatus,
    sync_error: grant.syncError === undefined ? null : grant.syncError,
    last_synced_at: grant.lastSyncedAt === undefined
      ? null
      : grant.lastSyncedAt,
    synced_items: grant.syncedItems === undefined ? 0 : grant.syncedItems,
    source_sync_health: parseSourceCoverage(grant.sourceCoverage),
    created_at: grant.createdAt,
    updated_at: grant.updatedAt,
  };
}

function compareOAuthGrantMetadata(left: OAuthGrant, right: OAuthGrant) {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }
  return left.id.localeCompare(right.id);
}

function isSafeOAuthScope(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 600 &&
    value.trim() === value &&
    /^[A-Za-z0-9][A-Za-z0-9:/._-]*$/.test(value);
}

function isSafeOAuthScopes(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= 64 &&
    value.every(isSafeOAuthScope) &&
    new Set(value).size === value.length;
}

function storedOAuthInteger(value: unknown) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (
    typeof value === "string" &&
    /^(0|[1-9][0-9]*)$/.test(value) &&
    value.length <= 16
  ) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function safeOAuthDisplayText(value: string, maxLength: number) {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(sanitized || "The last sync needs attention.")
    .slice(0, maxLength)
    .join("");
}

function isOptionalOAuthDate(value: unknown) {
  return value === null || value === undefined || isRequiredOAuthDate(value);
}

function isRequiredOAuthDate(value: unknown) {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizeSourceSettlements(
  values: readonly (OAuthSourceCoverageCheckpoint & { source: OAuthPersonalSourceId })[],
) {
  const seen = new Set<OAuthPersonalSourceId>();
  return values.map((value) => {
    if (!OAUTH_PERSONAL_SOURCE_IDS.includes(value.source) || seen.has(value.source)) {
      throw new Error("OAuth source coverage settlements must name each supported source at most once.");
    }
    seen.add(value.source);
    return {
      source: value.source,
      ...parseSourceCoverageCheckpoint(withoutSource(value)),
    };
  });
}

function mergeSourceCoverage(
  current: OAuthSourceCoverage | undefined,
  settlements: readonly (OAuthSourceCoverageCheckpoint & { source: OAuthPersonalSourceId })[],
): OAuthSourceCoverage {
  const next = { ...parseSourceCoverage(current) };
  for (const settlement of settlements) {
    const previous = next[settlement.source];
    next[settlement.source] = parseSourceCoverageCheckpoint({
      ...previous,
      ...withoutSource(settlement),
    });
  }
  return next;
}

function withoutSource(
  settlement: OAuthSourceCoverageCheckpoint & { source: OAuthPersonalSourceId },
): OAuthSourceCoverageCheckpoint {
  const { source: _source, ...checkpoint } = settlement;
  void _source;
  return checkpoint;
}

function parseSourceCoverage(value: unknown): OAuthSourceCoverage {
  if (value === null || value === undefined) return {};
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new OAuthGrantReadConflictError("OAuth source coverage metadata is invalid.");
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new OAuthGrantReadConflictError("OAuth source coverage metadata is invalid.");
  }
  const entries = Object.entries(candidate as Record<string, unknown>);
  if (entries.some(([key]) => !OAUTH_PERSONAL_SOURCE_IDS.includes(key as OAuthPersonalSourceId))) {
    throw new OAuthGrantReadConflictError("OAuth source coverage metadata contains an unknown source.");
  }
  return Object.fromEntries(entries.map(([key, checkpoint]) => [
    key,
    parseSourceCoverageCheckpoint(checkpoint),
  ])) as OAuthSourceCoverage;
}

function isSourceCoverage(value: unknown) {
  try {
    parseSourceCoverage(value);
    return true;
  } catch {
    return false;
  }
}

function parseSourceCoverageCheckpoint(value: unknown): OAuthSourceCoverageCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthGrantReadConflictError("OAuth source coverage checkpoint is invalid.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowedKeys = new Set([
    "schemaVersion", "status", "backfillState", "lastAttemptedAt",
    "lastSuccessfulAt", "failureCode",
  ]);
  const statuses = ["syncing", "healthy", "error"];
  const backfillStates = ["unknown", "in_progress", "complete"];
  const failureCodes = [
    undefined, "none", "provider_unauthorized", "provider_forbidden",
    "provider_rate_limited", "provider_unavailable", "processing_failed",
  ];
  if (
    keys.some((key) => !allowedKeys.has(key)) ||
    record.schemaVersion !== 1 ||
    !statuses.includes(String(record.status)) ||
    !backfillStates.includes(String(record.backfillState)) ||
    !isRequiredOAuthDate(record.lastAttemptedAt) ||
    !isOptionalOAuthDate(record.lastSuccessfulAt) ||
    !failureCodes.includes(record.failureCode as (typeof failureCodes)[number]) ||
    (record.status === "healthy" && !isRequiredOAuthDate(record.lastSuccessfulAt)) ||
    (record.status === "error" && (!record.failureCode || record.failureCode === "none")) ||
    (record.status !== "error" && record.failureCode !== undefined && record.failureCode !== "none")
  ) {
    throw new OAuthGrantReadConflictError("OAuth source coverage checkpoint is invalid.");
  }
  return {
    schemaVersion: 1,
    status: record.status as OAuthSourceCoverageCheckpoint["status"],
    backfillState: record.backfillState as OAuthSourceCoverageCheckpoint["backfillState"],
    lastAttemptedAt: new Date(String(record.lastAttemptedAt)).toISOString(),
    ...(record.lastSuccessfulAt
      ? { lastSuccessfulAt: new Date(String(record.lastSuccessfulAt)).toISOString() }
      : {}),
    ...(record.failureCode
      ? { failureCode: record.failureCode as NonNullable<OAuthSourceCoverageCheckpoint["failureCode"]> }
      : {}),
  };
}

function oauthDateMillis(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}
