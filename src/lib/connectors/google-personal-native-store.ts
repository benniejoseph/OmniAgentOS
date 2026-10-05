import { getSql,runWithManagedDatabaseTransaction } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { claimOAuthSyncLease,revokeExactGoogleOAuthGrantInTransaction,type OAuthSyncLease } from "@/lib/connectors/oauth-store";
import { googleSyncSourcesForScopes } from "@/lib/connectors/google-workspace-capabilities";
import { buildGooglePersonalNativeAcceptance,buildGooglePersonalNativeIntent,GooglePersonalNativeError,googlePersonalNativeActionSchema,googlePersonalNativeCurrentSchema,
  googlePersonalNativeIntentSchema,googlePersonalNativeSettlementSchema,sealGooglePersonalNativeReview,type GooglePersonalNativeIntent,type GooglePersonalNativeRequest,
  type GooglePersonalNativeScope,type GooglePersonalNativeSettlement,type GooglePersonalNativeReview } from "@/lib/connectors/google-personal-native-contracts";
import { assertNativePrivateActionMutation,nativePrivateActionTransaction,type PrivateActionSql as Sql } from "@/lib/memory/private-action-store";
import { privateActionShaSchema } from "@/lib/memory/private-action-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { GooglePersonalNativeExecution } from "@/lib/connectors/personal-sync";
export type GooglePersonalNativeAuthority = { scope: GooglePersonalNativeScope;accountEmail: string;executionScope?: ExecutionScope };
type Row = Record<string,unknown>;
const same = (a: unknown,b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function fail(message: string,code = "google_personal_action_conflict",status = 409): never { throw new GooglePersonalNativeError(code,status,message); }
function readOnly(authority: GooglePersonalNativeAuthority) { if (authority.executionScope) fail("Google reads require read-only authority.","google_personal_read_authority",403); }
function mutation(authority: GooglePersonalNativeAuthority,connectionId: string) { return assertNativePrivateActionMutation(authority,"connector.google.personal.native_action",connectionId); }
function transaction<T>(a: GooglePersonalNativeAuthority,write: boolean,work: (sql: Sql) => Promise<T>) { return nativePrivateActionTransaction(a,write,work); }
async function current(sql: Sql,a: GooglePersonalNativeAuthority,connectionId?: string,lock = false): Promise<{ row: Row|null;review: GooglePersonalNativeReview|null;busy: boolean }> {
  const s = a.scope;
  const rows = await sql`SELECT id,account_email,status,authorization_generation,scopes,sync_lease_owner_id,sync_lease_generation,sync_lease_expires_at,
      (sync_lease_owner_id IS NOT NULL AND sync_lease_expires_at>clock_timestamp()) AS busy
    FROM omni_oauth_grants WHERE tenant_id=${s.tenantId} AND actor_id=${s.ownerActorId} AND provider='google'
      AND connection_purpose='personal' AND account_email=${a.accountEmail} AND (${connectionId ?? null}::TEXT IS NULL OR id=${connectionId ?? null})
    ORDER BY (status='active') DESC,updated_at DESC,id LIMIT 2`;
  if (rows.length>1 && (connectionId || rows[0].status === "active" && rows[1].status === "active")) fail("The current Google account has ambiguous connections.");
  const row = rows[0];
  if (row && lock) { await sql`SELECT id FROM omni_oauth_grants WHERE tenant_id=${s.tenantId} AND actor_id=${s.ownerActorId} AND id=${String(row.id)} FOR UPDATE`;
    return current(sql,a,String(row.id),false); }
  const scopes = row && Array.isArray(row.scopes) ? [...new Set(row.scopes.map(String))].sort() : [];
  return { row: row ?? null,review: row ? sealGooglePersonalNativeReview({ connectionId: String(row.id),accountEmail: String(row.account_email),status: row.status as "active"|"revoked",
    authorizationGeneration: Number(row.authorization_generation),sourceScopeSha256: canonicalJsonSha256(scopes),permittedSources: [...googleSyncSourcesForScopes(scopes)] }) : null,busy: row?.busy === true };
}
function decoded(row: Row,a: GooglePersonalNativeAuthority) {
  const intent = googlePersonalNativeIntentSchema.parse(row.intent),action = googlePersonalNativeActionSchema.parse({ acceptance: row.acceptance,state: row.state,settlement: row.settlement ?? null });
  if (!same(intent.scope,a.scope) || !same(buildGooglePersonalNativeAcceptance(intent,action.acceptance.acceptedAt),action.acceptance) || row.id !== action.acceptance.id ||
    row.idempotency_key_sha256 !== intent.idempotencyKeySha256 || row.request_sha256 !== action.acceptance.requestSha256) fail("Stored Google action receipt is inconsistent.");
  return { intent,action };
}
async function exact(sql: Sql,a: GooglePersonalNativeAuthority,key: string) {
  const rows = await sql`SELECT * FROM omni_google_personal_native_actions WHERE tenant_id=${a.scope.tenantId} AND owner_actor_id=${a.scope.ownerActorId} AND idempotency_key_sha256=${key} LIMIT 2`;
  if (rows.length>1) fail("Google receipt identity is ambiguous."); return rows[0] ? { ...decoded(rows[0],a),row: rows[0] } : null;
}
async function summary(sql: Sql,a: GooglePersonalNativeAuthority,canWrite: boolean) {
  const value = await current(sql,a);
  const pending = await sql`SELECT * FROM omni_google_personal_native_actions WHERE tenant_id=${a.scope.tenantId} AND owner_actor_id=${a.scope.ownerActorId} AND state='accepted' LIMIT 2`;
  if (pending.length>1) fail("Unresolved Google action identity is ambiguous.");
  const calendar = await sql`SELECT id FROM omni_meeting_calendar_sync_acceptances WHERE tenant_id=${a.scope.tenantId} AND owner_actor_id=${a.scope.ownerActorId}
    AND connection_id=${value.review?.connectionId ?? ""} AND state IN ('accepted','unconfirmed') LIMIT 1`;
  const blockedAction = pending[0] ? decoded(pending[0],a).action : null,busy = value.busy || calendar.length>0;
  const eligible = canWrite && value.review?.status === "active" && !busy && !blockedAction;
  return googlePersonalNativeCurrentSchema.parse({ connection: value.review,blockedAction,busy,availableActions: eligible ?
    [...(value.review!.permittedSources.length ? ["sync"] : []),...(value.review!.authorizationGeneration<2_147_483_647 ? ["disconnect"] : [])] : [] });
}
export function reviewGooglePersonalNativeActions(a: GooglePersonalNativeAuthority,canWrite: boolean) {
  readOnly(a); return transaction(a,false,async (sql) => ({ current: await summary(sql,a,canWrite),action: null }));
}
export function readGooglePersonalNativeAction(a: GooglePersonalNativeAuthority,key: string,canWrite: boolean) {
  readOnly(a); privateActionShaSchema.parse(key); return transaction(a,false,async (sql) => ({ current: await summary(sql,a,canWrite),action: (await exact(sql,a,key))?.action ?? null }));
}
export function admitGooglePersonalNativeAction(input: { authority: GooglePersonalNativeAuthority;request: GooglePersonalNativeRequest;idempotencyKey: string }) {
  const a = input.authority,intent = buildGooglePersonalNativeIntent({ ...input,scope: a.scope }),s = a.scope;
  mutation(a,intent.request.review.connectionId);
  return transaction(a,true,async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-google-personal:${s.tenantId}:${s.ownerActorId}`},0))`;
    const prior = await exact(sql,a,intent.idempotencyKeySha256);
    if (prior) { if (!same(prior.intent,intent)) fail("This Google key already accepted another reviewed intent.");
      return { intent,action: prior.action,newlyAccepted: false,lease: null as OAuthSyncLease|null,providerToken: null as string|null }; }
    const value = await current(sql,a,intent.request.review.connectionId,true),review = await summary(sql,a,true);
    if (!same(value.review,intent.request.review) || !review.availableActions.includes(intent.request.action) ||
      review.connection?.connectionId !== intent.request.review.connectionId) fail("The reviewed Google authorization changed or previous work remains unresolved.");
    let lease: OAuthSyncLease|null = null,providerToken: string|null = null;
    if (intent.request.action === "disconnect") ({ providerToken } = await revokeExactGoogleOAuthGrantInTransaction(sql,{ tenantId: s.tenantId,actorId: s.ownerActorId,
      grantId: intent.request.review.connectionId,accountEmail: a.accountEmail,expectedAuthorizationGeneration: intent.request.review.authorizationGeneration }));
    else { const claimed = await claimOAuthSyncLease({ tenantId: s.tenantId,actorId: s.ownerActorId,provider: "google",connectionId: intent.request.review.connectionId,
      expectedAuthorizationGeneration: intent.request.review.authorizationGeneration },{ sql });
      if (claimed.status !== "claimed") fail("The exact Google synchronization lease is unavailable."); lease = claimed.lease; }
    const acceptance = buildGooglePersonalNativeAcceptance(intent,new Date().toISOString());
    await sql`INSERT INTO omni_google_personal_native_actions(id,tenant_id,owner_actor_id,canonical_actor_id,connection_id,authorization_generation,idempotency_key_sha256,
      request_sha256,intent,acceptance,accepted_at,state,settlement,lease_owner_id,lease_generation)
      VALUES(${acceptance.id},${s.tenantId},${s.ownerActorId},${s.canonicalActorId},${intent.request.review.connectionId},${intent.request.review.authorizationGeneration},
        ${intent.idempotencyKeySha256},${acceptance.requestSha256},${intent}::JSONB,${acceptance}::JSONB,${acceptance.acceptedAt},'accepted',NULL,${lease?.ownerId ?? null},${lease?.generation ?? null})`;
    await appendScopedDomainEvent({ id: `${acceptance.id}:accepted`,streamId: acceptance.id,type: "google.personal.native.accepted",executionScope: a.executionScope!,
      payload: { actionId: acceptance.id,action: acceptance.action,requestSha256: acceptance.requestSha256,acceptanceSha256: acceptance.acceptanceSha256,localRevoked: acceptance.localRevoked } },{ sql });
    return { intent,action: googlePersonalNativeActionSchema.parse({ acceptance,state: "accepted",settlement: null }),newlyAccepted: true,lease,providerToken };
  });
}
async function fence(sql: Sql,a: GooglePersonalNativeAuthority,intent: GooglePersonalNativeIntent,lease: OAuthSyncLease,requireLease = true) {
  const value = await current(sql,a,intent.request.review.connectionId,true),prior = await exact(sql,a,intent.idempotencyKeySha256);
  if (!prior || prior.action.state !== "accepted" || !same(prior.intent,intent) || !same(value.review,intent.request.review) ||
    prior.row.lease_owner_id !== lease.ownerId || Number(prior.row.lease_generation) !== lease.generation || Number(value.row?.sync_lease_generation) !== lease.generation ||
    requireLease && (!value.busy || value.row?.sync_lease_owner_id !== lease.ownerId)) fail("The exact Google owner, authorization or accepted lease changed.");
}
export function googlePersonalNativeSyncExecution(a: GooglePersonalNativeAuthority,intent: GooglePersonalNativeIntent,lease: OAuthSyncLease): GooglePersonalNativeExecution {
  mutation(a,intent.request.review.connectionId);
  return { lease,expectedSources: intent.request.review.permittedSources,expectedScopeSha256: intent.request.review.sourceScopeSha256,
    beforeProvider: () => transaction(a,true,(sql) => fence(sql,a,intent,lease)),
    commit: <T>(work: () => Promise<T>,releaseLease = false) => transaction(a,true,async (sql) => {
      await fence(sql,a,intent,lease);
      return runWithManagedDatabaseTransaction(sql,async () => { const value = await work(); await fence(getSql(),a,intent,lease,!releaseLease); return value; });
    }) };
}
export function mayRevokeGooglePersonalNativeToken(a: GooglePersonalNativeAuthority,intent: GooglePersonalNativeIntent) {
  mutation(a,intent.request.review.connectionId);
  return transaction(a,true,async (sql) => {
    const value = await current(sql,a,intent.request.review.connectionId,true),prior = await exact(sql,a,intent.idempotencyKeySha256);
    return intent.request.action === "disconnect" && prior?.action.state === "accepted" && same(prior.intent,intent) && Boolean(value.review &&
      value.review.status === "revoked" && value.review.authorizationGeneration === intent.request.review.authorizationGeneration+1 &&
      value.review.accountEmail === intent.request.review.accountEmail && value.review.sourceScopeSha256 === intent.request.review.sourceScopeSha256);
  });
}
export function settleGooglePersonalNativeAction(a: GooglePersonalNativeAuthority,intent: GooglePersonalNativeIntent,input: GooglePersonalNativeSettlement) {
  mutation(a,intent.request.review.connectionId); const settlement = googlePersonalNativeSettlementSchema.parse(input);
  return transaction(a,true,async (sql) => {
    const value = await current(sql,a,intent.request.review.connectionId,true),prior = await exact(sql,a,intent.idempotencyKeySha256);
    if (!prior || !same(prior.intent,intent)) fail("The exact Google acceptance is unavailable.");
    if (prior.action.state === "settled") { if (!same(prior.action.settlement,settlement)) fail("Google action settled differently."); return prior.action; }
    if (intent.request.action === "sync" && !same(value.review,intent.request.review)) fail("Google authorization changed before settlement.");
    const action = googlePersonalNativeActionSchema.parse({ acceptance: prior.action.acceptance,state: "settled",settlement });
    const updated = await sql`UPDATE omni_google_personal_native_actions SET state='settled',settlement=${settlement}::JSONB
      WHERE id=${action.acceptance.id} AND tenant_id=${a.scope.tenantId} AND owner_actor_id=${a.scope.ownerActorId} AND state='accepted' RETURNING id`;
    if (updated.length !== 1) fail("Google action changed during settlement.");
    await appendScopedDomainEvent({ id: `${action.acceptance.id}:settled`,streamId: action.acceptance.id,type: "google.personal.native.settled",executionScope: a.executionScope!,
      payload: { actionId: action.acceptance.id,acceptanceSha256: action.acceptance.acceptanceSha256,settlementSha256: canonicalJsonSha256(settlement) } },{ sql }); return action;
  });
}
