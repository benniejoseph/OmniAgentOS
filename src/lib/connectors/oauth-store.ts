import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import type { OAuthProvider } from "@/lib/connectors/oauth-providers";
import { oauthGrantActorReadOrder } from "@/lib/connectors/oauth-actor-scope";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { openJsonPayload, sealJsonPayload } from "@/lib/security/sealed-payload";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";

export type OAuthGrant = { id: string; tenantId: string; actorId: string; provider: OAuthProvider; scopes: string[]; status: "active" | "revoked"; authorizationGeneration: number; expiresAt?: string; syncStatus?: "idle" | "syncing" | "healthy" | "error"; syncError?: string; lastSyncedAt?: string; syncedItems?: number; createdAt: string; updatedAt: string };
export type RequestOAuthGrant = OAuthGrant & { manageable: boolean };
export type OAuthSyncLease = Readonly<{
  ownerId: string;
  generation: number;
  expiresAt: string;
}>;
type InternalGrant = OAuthGrant & {
  sealedTokens: ReturnType<typeof sealJsonPayload>;
  sealedSyncCursor?: ReturnType<typeof sealJsonPayload>;
  /** Legacy file-mode compatibility; new cursor writes are sealed. */
  syncCursor?: string;
  syncLeaseOwnerId?: string;
  syncLeaseExpiresAt?: string;
  syncLeaseGeneration?: number;
};
const filePath = () => getDataPath("oauth-grants.json");
const OAUTH_SYNC_LEASE_MS = 10 * 60_000;

export class OAuthGrantReadConflictError extends Error {
  readonly status = 409;

  constructor(message = "OAuth connection ownership is ambiguous.") {
    super(message);
    this.name = "OAuthGrantReadConflictError";
  }
}

export async function saveOAuthGrant(input: { tenantId: string; actorId: string; provider: OAuthProvider; tokens: Record<string, unknown>; authorizationMode?: "reauthorize" | "refresh" }) {
  const now = new Date().toISOString();
  const authorizationMode = input.authorizationMode || "reauthorize";
  const existingSecrets = await getOAuthGrantSecrets(input.tenantId, input.actorId, input.provider).catch(() => undefined);
  const tokens = { ...(existingSecrets?.tokens || {}), ...input.tokens };
  const expiresIn = Number(tokens.expires_in || 0);
  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
  const scopes = String(tokens.scope || existingSecrets?.grant.scopes.join(" ") || "").split(/\s+/).filter(Boolean);
  const id = randomUUID();
  const sealedTokens = sealJsonPayload(tokens, `oauth-grant:${input.tenantId}:${input.actorId}:${input.provider}`);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      INSERT INTO omni_oauth_grants (
        id, tenant_id, actor_id, provider, scopes, sealed_tokens, expires_at,
        status, authorization_generation, created_at, updated_at
      ) VALUES (
        ${id}, ${input.tenantId}, ${input.actorId}, ${input.provider},
        ${scopes}, ${sealedTokens}::jsonb, ${expiresAt || null}, 'active', 1,
        ${now}, ${now}
      )
      ON CONFLICT (tenant_id, actor_id, provider) DO UPDATE SET
        scopes = EXCLUDED.scopes,
        sealed_tokens = EXCLUDED.sealed_tokens,
        expires_at = EXCLUDED.expires_at,
        status = 'active',
        authorization_generation = CASE
          WHEN ${authorizationMode} = 'reauthorize'
            THEN omni_oauth_grants.authorization_generation + 1
          ELSE omni_oauth_grants.authorization_generation
        END,
        sync_cursor = CASE
          WHEN ${authorizationMode} = 'reauthorize'
            THEN NULL
          ELSE omni_oauth_grants.sync_cursor
        END,
        sync_status = CASE
          WHEN ${authorizationMode} = 'reauthorize'
            THEN 'idle'
          ELSE omni_oauth_grants.sync_status
        END,
        sync_error = CASE
          WHEN ${authorizationMode} = 'reauthorize'
            THEN NULL
          ELSE omni_oauth_grants.sync_error
        END,
        sync_lease_owner_id = CASE
          WHEN ${authorizationMode} = 'reauthorize'
            THEN NULL
          ELSE omni_oauth_grants.sync_lease_owner_id
        END,
        sync_lease_expires_at = CASE
          WHEN ${authorizationMode} = 'reauthorize'
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
    const existing = ledger.grants.find((grant) => grant.tenantId === input.tenantId && grant.actorId === input.actorId && grant.provider === input.provider);
    saved = { id: existing?.id || id, tenantId: input.tenantId, actorId: input.actorId, provider: input.provider, scopes, sealedTokens, sealedSyncCursor: authorizationMode === "refresh" ? existing?.sealedSyncCursor : undefined, syncCursor: authorizationMode === "refresh" ? existing?.syncCursor : undefined, syncStatus: authorizationMode === "refresh" ? existing?.syncStatus || "idle" : "idle", syncError: authorizationMode === "refresh" ? existing?.syncError : undefined, lastSyncedAt: existing?.lastSyncedAt, syncedItems: existing?.syncedItems || 0, status: "active", authorizationGeneration: existing ? Math.max(1, Number(existing.authorizationGeneration || 1)) + (authorizationMode === "reauthorize" ? 1 : 0) : 1, expiresAt, createdAt: existing?.createdAt || now, updatedAt: now, ...(authorizationMode === "refresh" ? { syncLeaseOwnerId: existing?.syncLeaseOwnerId, syncLeaseExpiresAt: existing?.syncLeaseExpiresAt, syncLeaseGeneration: existing?.syncLeaseGeneration } : { syncLeaseGeneration: existing?.syncLeaseGeneration || 0 }) };
    return { grants: [saved, ...ledger.grants.filter((grant) => grant.id !== existing?.id)].slice(0, 100) };
  });
  return stripTokens(saved);
}

export async function listOAuthGrants(tenantId: string, actorId: string) {
  if (hasDatabaseUrl()) { await ensureDatabaseSchema(); const rows = await getSql()`SELECT * FROM omni_oauth_grants WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND provider = 'google' AND status = 'active' ORDER BY updated_at DESC`; return rows.map(publicGrant); }
  const ledger = await readJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] });
  return ledger.grants.filter((grant) => grant.tenantId === tenantId && grant.actorId === actorId && grant.provider === "google" && grant.status === "active").map(stripTokens);
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
        grant.provider === "google" &&
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
    SELECT id, tenant_id, actor_id, provider, scopes, status,
      authorization_generation, expires_at, sync_status, sync_error,
      last_synced_at, synced_items, created_at, updated_at
    FROM omni_oauth_grants
    WHERE tenant_id = ${input.tenantId}
      AND actor_id IN (${canonicalActorId}, ${exactActorId})
      AND provider = 'google'
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

export async function revokeOAuthGrant(tenantId: string, actorId: string, provider: OAuthProvider) {
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`UPDATE omni_oauth_grants SET status = 'revoked', sealed_tokens = ${sealJsonPayload({}, `oauth-grant:${tenantId}:${actorId}:${provider}`)}::jsonb, sync_cursor = NULL, sync_lease_owner_id = NULL, sync_lease_expires_at = NULL, updated_at = ${now} WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND provider = ${provider}`;
    return;
  }
  await updateJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] }, (ledger) => ({ grants: ledger.grants.map((grant) => grant.tenantId === tenantId && grant.actorId === actorId && grant.provider === provider ? { ...grant, status: "revoked", sealedTokens: sealJsonPayload({}, `oauth-grant:${tenantId}:${actorId}:${provider}`), sealedSyncCursor: undefined, syncCursor: undefined, syncLeaseOwnerId: undefined, syncLeaseExpiresAt: undefined, updatedAt: now } : grant) }));
}

export async function getOAuthGrantSecrets(tenantId: string, actorId: string, provider: OAuthProvider) {
  let internal: InternalGrant | undefined;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_oauth_grants WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND provider = ${provider} AND status = 'active' LIMIT 1`;
    if (rows[0]) internal = internalGrantFromRow(rows[0]);
  } else {
    const ledger = await readJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] });
    internal = ledger.grants.find((grant) => grant.tenantId === tenantId && grant.actorId === actorId && grant.provider === provider && grant.status === "active");
  }
  if (!internal) return undefined;
  const tokens = openJsonPayload(internal.sealedTokens, `oauth-grant:${tenantId}:${actorId}:${provider}`) as Record<string, unknown>;
  return {
    grant: stripTokens(internal),
    tokens,
    syncCursor: openedSyncCursor(internal),
  };
}

export async function claimOAuthSyncLease(input: {
  tenantId: string;
  actorId: string;
  provider: OAuthProvider;
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
  status: "syncing" | "healthy" | "error";
  cursor?: string;
  error?: string;
  syncedItems?: number;
  lease?: OAuthSyncLease;
  releaseLease?: boolean;
}) {
  const now = new Date().toISOString();
  if (input.releaseLease && !input.lease) {
    throw new Error("OAuth sync lease release requires an exact fence.");
  }
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const sealedCursor = input.cursor
      ? JSON.stringify(sealJsonPayload(input.cursor, syncCursorBinding(input)))
      : undefined;
    const rows = input.lease
      ? await getSql()`UPDATE omni_oauth_grants SET sync_status = ${input.status}, sync_error = ${input.error || null}, sync_cursor = COALESCE(${sealedCursor || null}, sync_cursor), synced_items = synced_items + ${input.syncedItems || 0}, last_synced_at = CASE WHEN ${input.status} = 'healthy' THEN ${now}::timestamptz ELSE last_synced_at END, sync_lease_owner_id = CASE WHEN ${Boolean(input.releaseLease)} THEN NULL ELSE sync_lease_owner_id END, sync_lease_expires_at = CASE WHEN ${Boolean(input.releaseLease)} THEN NULL ELSE sync_lease_expires_at END, updated_at = ${now} WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId} AND provider = ${input.provider} AND status = 'active' AND sync_lease_owner_id = ${input.lease.ownerId} AND sync_lease_generation = ${input.lease.generation} AND sync_lease_expires_at > clock_timestamp() RETURNING *`
      : await getSql()`UPDATE omni_oauth_grants SET sync_status = ${input.status}, sync_error = ${input.error || null}, sync_cursor = COALESCE(${sealedCursor || null}, sync_cursor), synced_items = synced_items + ${input.syncedItems || 0}, last_synced_at = CASE WHEN ${input.status} = 'healthy' THEN ${now}::timestamptz ELSE last_synced_at END, updated_at = ${now} WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId} AND provider = ${input.provider} AND status = 'active' RETURNING *`;
    return rows[0] ? publicGrant(rows[0]) : undefined;
  }
  let updated: OAuthGrant | undefined;
  await updateJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] }, (ledger) => ({ grants: ledger.grants.map((grant) => {
    if (grant.tenantId !== input.tenantId || grant.actorId !== input.actorId || grant.provider !== input.provider || grant.status !== "active") return grant;
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
    const next: InternalGrant = { ...grant, syncStatus: input.status, syncError: input.error, sealedSyncCursor: input.cursor ? sealJsonPayload(input.cursor, syncCursorBinding(input)) : grant.sealedSyncCursor, syncCursor: input.cursor ? undefined : grant.syncCursor, syncedItems: (grant.syncedItems || 0) + (input.syncedItems || 0), lastSyncedAt: input.status === "healthy" ? now : grant.lastSyncedAt, updatedAt: now, ...(input.releaseLease ? { syncLeaseOwnerId: undefined, syncLeaseExpiresAt: undefined } : {}) };
    updated = stripTokens(next); return next;
  }) }));
  return updated;
}

function stripTokens(grant: InternalGrant): OAuthGrant {
  return { id: grant.id, tenantId: grant.tenantId, actorId: grant.actorId, provider: grant.provider, scopes: grant.scopes, status: grant.status, authorizationGeneration: Math.max(1, Number(grant.authorizationGeneration || 1)), expiresAt: grant.expiresAt, syncStatus: grant.syncStatus || "idle", syncError: grant.syncError, lastSyncedAt: grant.lastSyncedAt, syncedItems: grant.syncedItems || 0, createdAt: grant.createdAt, updatedAt: grant.updatedAt };
}
function publicGrant(row: Record<string, unknown>): OAuthGrant { return { id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), provider: String(row.provider) as OAuthProvider, scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [], status: String(row.status) as "active" | "revoked", authorizationGeneration: Math.max(1, Number(row.authorization_generation || 1)), expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : undefined, syncStatus: String(row.sync_status || "idle") as OAuthGrant["syncStatus"], syncError: row.sync_error ? String(row.sync_error) : undefined, lastSyncedAt: row.last_synced_at ? new Date(String(row.last_synced_at)).toISOString() : undefined, syncedItems: Number(row.synced_items || 0), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() }; }
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
    const opened = openJsonPayload(
      grant.sealedSyncCursor,
      syncCursorBinding(grant),
    );
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
  owner: Pick<OAuthGrant, "tenantId" | "actorId" | "provider">,
) {
  return `oauth-sync-cursor:${owner.tenantId}:${owner.actorId}:${owner.provider}`;
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
  const scopes = row.scopes;
  const status = typeof row.status === "string" ? row.status : "";
  const syncStatus = typeof row.sync_status === "string"
    ? row.sync_status
    : "";
  const syncError = row.sync_error;
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
    provider !== "google" ||
    status !== "active" ||
    !isSafeOAuthScopes(scopes) ||
    !oauthSyncStatuses.includes(syncStatus as (typeof oauthSyncStatuses)[number]) ||
    !(syncError === null || syncError === undefined || typeof syncError === "string") ||
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
  const providers = new Set<OAuthProvider>();
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
    if (providers.has(record.provider)) {
      throw new OAuthGrantReadConflictError(
        "OAuth connection provider ownership is ambiguous.",
      );
    }
    ids.add(record.id);
    providers.add(record.provider);
  }
}

function oauthGrantLedgerRow(grant: OAuthGrant) {
  return {
    id: grant.id,
    tenant_id: grant.tenantId,
    actor_id: grant.actorId,
    provider: grant.provider,
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

function oauthDateMillis(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}
