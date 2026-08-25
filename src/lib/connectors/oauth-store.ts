import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import type { OAuthProvider } from "@/lib/connectors/oauth-providers";
import { openJsonPayload, sealJsonPayload } from "@/lib/security/sealed-payload";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";

export type OAuthGrant = { id: string; tenantId: string; actorId: string; provider: OAuthProvider; scopes: string[]; status: "active" | "revoked"; expiresAt?: string; syncStatus?: "idle" | "syncing" | "healthy" | "error"; syncError?: string; lastSyncedAt?: string; syncedItems?: number; createdAt: string; updatedAt: string };
type InternalGrant = OAuthGrant & { sealedTokens: ReturnType<typeof sealJsonPayload>; syncCursor?: string };
const filePath = () => getDataPath("oauth-grants.json");

export async function saveOAuthGrant(input: { tenantId: string; actorId: string; provider: OAuthProvider; tokens: Record<string, unknown> }) {
  const now = new Date().toISOString();
  const existingSecrets = await getOAuthGrantSecrets(input.tenantId, input.actorId, input.provider).catch(() => undefined);
  const tokens = { ...(existingSecrets?.tokens || {}), ...input.tokens };
  const expiresIn = Number(tokens.expires_in || 0);
  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
  const scopes = String(tokens.scope || existingSecrets?.grant.scopes.join(" ") || "").split(/\s+/).filter(Boolean);
  const id = randomUUID();
  const sealedTokens = sealJsonPayload(tokens, `oauth-grant:${input.tenantId}:${input.actorId}:${input.provider}`);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`INSERT INTO omni_oauth_grants (id, tenant_id, actor_id, provider, scopes, sealed_tokens, expires_at, status, created_at, updated_at)
      VALUES (${id}, ${input.tenantId}, ${input.actorId}, ${input.provider}, ${scopes}, ${sealedTokens}::jsonb, ${expiresAt || null}, 'active', ${now}, ${now})
      ON CONFLICT (tenant_id, actor_id, provider) DO UPDATE SET scopes = EXCLUDED.scopes, sealed_tokens = EXCLUDED.sealed_tokens, expires_at = EXCLUDED.expires_at, status = 'active', updated_at = EXCLUDED.updated_at RETURNING *`;
    return publicGrant(rows[0]);
  }
  let saved!: InternalGrant;
  await updateJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] }, (ledger) => {
    const existing = ledger.grants.find((grant) => grant.tenantId === input.tenantId && grant.actorId === input.actorId && grant.provider === input.provider);
    saved = { id: existing?.id || id, tenantId: input.tenantId, actorId: input.actorId, provider: input.provider, scopes, sealedTokens, syncCursor: existing?.syncCursor, syncStatus: existing?.syncStatus || "idle", syncError: existing?.syncError, lastSyncedAt: existing?.lastSyncedAt, syncedItems: existing?.syncedItems || 0, status: "active", expiresAt, createdAt: existing?.createdAt || now, updatedAt: now };
    return { grants: [saved, ...ledger.grants.filter((grant) => grant.id !== existing?.id)].slice(0, 100) };
  });
  return stripTokens(saved);
}

export async function listOAuthGrants(tenantId: string, actorId: string) {
  if (hasDatabaseUrl()) { await ensureDatabaseSchema(); const rows = await getSql()`SELECT * FROM omni_oauth_grants WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND provider = 'google' AND status = 'active' ORDER BY updated_at DESC`; return rows.map(publicGrant); }
  const ledger = await readJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] });
  return ledger.grants.filter((grant) => grant.tenantId === tenantId && grant.actorId === actorId && grant.provider === "google" && grant.status === "active").map(stripTokens);
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
    await getSql()`UPDATE omni_oauth_grants SET status = 'revoked', sealed_tokens = ${sealJsonPayload({}, `oauth-grant:${tenantId}:${actorId}:${provider}`)}::jsonb, sync_cursor = NULL, updated_at = ${now} WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND provider = ${provider}`;
    return;
  }
  await updateJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] }, (ledger) => ({ grants: ledger.grants.map((grant) => grant.tenantId === tenantId && grant.actorId === actorId && grant.provider === provider ? { ...grant, status: "revoked", sealedTokens: sealJsonPayload({}, `oauth-grant:${tenantId}:${actorId}:${provider}`), syncCursor: undefined, updatedAt: now } : grant) }));
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
  return { grant: stripTokens(internal), tokens, syncCursor: internal.syncCursor };
}

export async function updateOAuthSyncState(input: { tenantId: string; actorId: string; provider: OAuthProvider; status: "syncing" | "healthy" | "error"; cursor?: string; error?: string; syncedItems?: number }) {
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`UPDATE omni_oauth_grants SET sync_status = ${input.status}, sync_error = ${input.error || null}, sync_cursor = COALESCE(${input.cursor || null}, sync_cursor), synced_items = synced_items + ${input.syncedItems || 0}, last_synced_at = CASE WHEN ${input.status} = 'healthy' THEN ${now}::timestamptz ELSE last_synced_at END, updated_at = ${now} WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId} AND provider = ${input.provider} AND status = 'active' RETURNING *`;
    return rows[0] ? publicGrant(rows[0]) : undefined;
  }
  let updated: OAuthGrant | undefined;
  await updateJsonFile<{ grants: InternalGrant[] }>(filePath(), { grants: [] }, (ledger) => ({ grants: ledger.grants.map((grant) => {
    if (grant.tenantId !== input.tenantId || grant.actorId !== input.actorId || grant.provider !== input.provider || grant.status !== "active") return grant;
    const next: InternalGrant = { ...grant, syncStatus: input.status, syncError: input.error, syncCursor: input.cursor || grant.syncCursor, syncedItems: (grant.syncedItems || 0) + (input.syncedItems || 0), lastSyncedAt: input.status === "healthy" ? now : grant.lastSyncedAt, updatedAt: now };
    updated = stripTokens(next); return next;
  }) }));
  return updated;
}

function stripTokens(grant: InternalGrant): OAuthGrant {
  return { id: grant.id, tenantId: grant.tenantId, actorId: grant.actorId, provider: grant.provider, scopes: grant.scopes, status: grant.status, expiresAt: grant.expiresAt, syncStatus: grant.syncStatus || "idle", syncError: grant.syncError, lastSyncedAt: grant.lastSyncedAt, syncedItems: grant.syncedItems || 0, createdAt: grant.createdAt, updatedAt: grant.updatedAt };
}
function publicGrant(row: Record<string, unknown>): OAuthGrant { return { id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), provider: String(row.provider) as OAuthProvider, scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [], status: String(row.status) as "active" | "revoked", expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : undefined, syncStatus: String(row.sync_status || "idle") as OAuthGrant["syncStatus"], syncError: row.sync_error ? String(row.sync_error) : undefined, lastSyncedAt: row.last_synced_at ? new Date(String(row.last_synced_at)).toISOString() : undefined, syncedItems: Number(row.synced_items || 0), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() }; }
function internalGrantFromRow(row: Record<string, unknown>): InternalGrant { return { ...publicGrant(row), sealedTokens: row.sealed_tokens as InternalGrant["sealedTokens"], syncCursor: row.sync_cursor ? String(row.sync_cursor) : undefined }; }
