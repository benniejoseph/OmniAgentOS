import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { revokeExactSalesforceOAuthGrantInTransaction } from "@/lib/connectors/oauth-store";
import { claimSalesforceSyncLease, type SalesforceMutationAuthority, type SalesforceConnection, type SalesforceSyncLease } from "@/lib/customer-success/salesforce-store";
import { SalesforceNativeError, buildSalesforceNativeAcceptance, buildSalesforceNativeIntent, salesforceNativeActionSchema,
  salesforceNativeCurrentSchema, salesforceNativeIntentSchema, salesforceNativeScopeSchema, salesforceNativeSettlementSchema,
  salesforceNativeShaSchema, sealSalesforceNativeConnection, type SalesforceNativeIntent,
  type SalesforceNativeRequest, type SalesforceNativeScope, type SalesforceNativeSettlement, type SalesforceNativeConnection } from "@/lib/customer-success/salesforce-native-contracts";
import { parsePersistedExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { SalesforceNativeSyncExecution } from "@/lib/customer-success/salesforce-sync";

type Sql = ReturnType<typeof getSql>;
type Row = Record<string, unknown>;
export type SalesforceNativeAuthority = { scope: SalesforceNativeScope; executionScope?: ExecutionScope };
type Claim = { status: "claimed"; connection: SalesforceConnection; lease: SalesforceSyncLease };
const same = (left: unknown, right: unknown) => canonicalJsonSha256(left) === canonicalJsonSha256(right);
function fail(message: string, code = "salesforce_action_conflict", status = 409): never { throw new SalesforceNativeError(code, status, message); }
function validate(authority: SalesforceNativeAuthority, mutation = false, connectionId?: string) {
  salesforceNativeScopeSchema.parse(authority.scope);
  const scope = parsePersistedExecutionScope(authority.executionScope), owner = authority.scope;
  if (mutation ? !scope || scope.tenantId !== owner.tenantId || scope.workspaceId !== owner.workspaceId ||
    scope.initiatingActorId !== owner.ownerActorId || scope.executingPrincipalType !== "user" || scope.executingPrincipalId !== owner.ownerActorId ||
    scope.projectId !== null || scope.missionId !== null || scope.delegationId !== null || scope.contextGrantIds.length || scope.capabilityGrantIds.length ||
    scope.purpose !== "customer.salesforce.native_action" || scope.causationId !== connectionId : authority.executionScope !== undefined) {
    fail("Exact current Salesforce action authority is required.", "salesforce_action_authority", 403);
  }
}
async function ready() {
  if (!hasDatabaseUrl()) fail("Durable Salesforce action storage is unavailable.", "salesforce_action_storage", 503);
  await ensureDatabaseSchema();
}
function transaction<T>(authority: SalesforceNativeAuthority, work: (sql: Sql) => Promise<T>) {
  return runWithDatabaseActorScope(authority.scope.tenantId, [authority.scope.ownerActorId], () =>
    getSql().transaction((sql: Sql) => runWithManagedDatabaseTransaction(sql, () => work(getSql()))) as Promise<T>);
}
function legacyAuthority(authority: SalesforceNativeAuthority): SalesforceMutationAuthority {
  return { tenantId: authority.scope.tenantId, workspaceId: authority.scope.workspaceId, canonicalActorId: authority.scope.ownerActorId,
    readableActorIds: [authority.scope.ownerActorId], executionScope: authority.executionScope! };
}
/** Current membership and exact owner are one SQL anchor, including receipt-only reads. */
async function current(sql: Sql, authority: SalesforceNativeAuthority, write: boolean, lock = false): Promise<{ review: SalesforceNativeConnection | null; connection: Row | null; busy: boolean }> {
  const scope = authority.scope;
  const rows = await sql`SELECT to_jsonb(connection_row) AS connection,
      grant_row.id AS grant_id,grant_row.status AS grant_status,grant_row.authorization_generation AS grant_generation,grant_row.scopes AS grant_scopes,
      (connection_row.sync_lease_owner_id IS NOT NULL AND connection_row.sync_lease_expires_at>clock_timestamp()) AS busy
    FROM omni_tenant_workspaces workspace
    JOIN omni_tenant_workspace_memberships member ON member.tenant_id=workspace.tenant_id AND member.workspace_id=workspace.workspace_id
      AND member.subject_kind='user' AND member.subject_actor_id=${scope.ownerActorId} AND member.state='active'
      AND member.access_level IN ('reader','contributor','manager') AND (NOT ${write} OR member.access_level IN ('contributor','manager'))
    JOIN omni_auth_users auth_user ON auth_user.actor_id=${scope.ownerActorId} AND auth_user.status='active'
    JOIN omni_auth_memberships tenant_member ON tenant_member.user_id=auth_user.id AND tenant_member.tenant_id=workspace.tenant_id
      AND tenant_member.status='active' AND (NOT ${write} OR tenant_member.role IN ('operator','admin','system'))
    LEFT JOIN omni_salesforce_connections connection_row ON connection_row.tenant_id=workspace.tenant_id AND connection_row.workspace_id=workspace.workspace_id
      AND connection_row.owner_actor_id=${scope.ownerActorId}
    LEFT JOIN omni_oauth_grants grant_row ON grant_row.tenant_id=workspace.tenant_id AND grant_row.actor_id=${scope.ownerActorId}
      AND grant_row.id=connection_row.oauth_grant_id AND grant_row.provider='salesforce'
    WHERE workspace.tenant_id=${scope.tenantId} AND workspace.workspace_id=${scope.workspaceId} AND workspace.state='active' LIMIT 2`;
  if (rows.length !== 1) fail("Current Salesforce workspace authority is unavailable.", "salesforce_action_authority", 403);
  const row = rows[0], connection = row.connection as Row | null;
  if (lock && connection) {
    // OAuth binding already takes grant before connection. Preserve that order.
    await sql`SELECT id FROM omni_oauth_grants WHERE tenant_id=${scope.tenantId} AND actor_id=${scope.ownerActorId}
      AND id=${String(connection.oauth_grant_id)} AND provider='salesforce' FOR UPDATE`;
    await sql`SELECT connection_id FROM omni_salesforce_connections WHERE tenant_id=${scope.tenantId} AND workspace_id=${scope.workspaceId}
      AND owner_actor_id=${scope.ownerActorId} AND connection_id=${String(connection.connection_id)} FOR UPDATE`;
    return current(sql, authority, write, false);
  }
  const review = connection && row.grant_id ? sealSalesforceNativeConnection({ ...scope,
    connectionId: String(connection.connection_id), oauthGrantId: String(row.grant_id), authorizationGeneration: Number(connection.authorization_generation),
    organizationIdSha256: String(connection.organization_id_sha256), instanceOrigin: String(connection.instance_origin),
    connectionState: connection.connection_state as "active" | "revoked" | "error", grantStatus: row.grant_status as "active" | "revoked",
    grantAuthorizationGeneration: Number(row.grant_generation), readScopesGranted: Array.isArray(row.grant_scopes) && row.grant_scopes.includes("api") && row.grant_scopes.includes("refresh_token"),
  }) : null;
  return { review, connection, busy: row.busy === true };
}
function decoded(row: Row, authority: SalesforceNativeAuthority) {
  const intent = salesforceNativeIntentSchema.parse(row.intent), action = salesforceNativeActionSchema.parse({ acceptance: row.acceptance, state: row.state, settlement: row.settlement ?? null });
  const expected = buildSalesforceNativeAcceptance(intent, action.acceptance.acceptedAt);
  if (!same(intent.scope, authority.scope) || !same(expected, action.acceptance) || row.id !== expected.id ||
    row.idempotency_key_sha256 !== expected.idempotencyKeySha256 || row.request_sha256 !== expected.requestSha256) fail("Stored Salesforce action identity is inconsistent.");
  return { intent, action };
}
async function exact(sql: Sql, authority: SalesforceNativeAuthority, keySha256: string) {
  const scope = authority.scope;
  const rows = await sql`SELECT * FROM omni_salesforce_native_actions WHERE tenant_id=${scope.tenantId} AND workspace_id=${scope.workspaceId}
    AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${keySha256} LIMIT 2`;
  if (rows.length > 1) fail("Salesforce action identity is ambiguous.");
  return rows[0] ? { ...decoded(rows[0], authority), row: rows[0] } : null;
}
async function summary(sql: Sql, authority: SalesforceNativeAuthority, canWrite: boolean) {
  const value = await current(sql, authority, false), scope = authority.scope;
  const pending = await sql`SELECT * FROM omni_salesforce_native_actions WHERE tenant_id=${scope.tenantId} AND workspace_id=${scope.workspaceId}
    AND owner_actor_id=${scope.ownerActorId} AND state='accepted' ORDER BY accepted_at,id LIMIT 2`;
  if (pending.length > 1) fail("Unresolved Salesforce action identity is ambiguous.");
  const blockedAction = pending[0] ? decoded(pending[0], authority).action : null, review = value.review;
  const available = canWrite && review?.connectionState === "active" && review.grantStatus === "active" &&
    review.authorizationGeneration === review.grantAuthorizationGeneration && !value.busy && !blockedAction;
  return salesforceNativeCurrentSchema.parse({ connection: review, blockedAction, busy: value.busy,
    availableActions: available ? [...(review.readScopesGranted ? ["sync", "reconcile"] : []), ...(review.grantAuthorizationGeneration < 2_147_483_647 ? ["disconnect"] : [])] : [] });
}
export async function reviewSalesforceNativeActions(authority: SalesforceNativeAuthority, canWrite: boolean) {
  validate(authority); await ready();
  return transaction(authority, async (sql) => ({ current: await summary(sql, authority, canWrite), action: null }));
}
export async function readSalesforceNativeAction(authority: SalesforceNativeAuthority, keySha256: string, canWrite: boolean) {
  validate(authority); salesforceNativeShaSchema.parse(keySha256); await ready();
  return transaction(authority, async (sql) => {
    const currentValue = await summary(sql, authority, canWrite), prior = await exact(sql, authority, keySha256);
    // Reread current authority after receipt lookup; absence is never no-admission proof.
    await current(sql, authority, false);
    return { current: currentValue, action: prior?.action ?? null };
  });
}
export async function admitSalesforceNativeAction(input: { authority: SalesforceNativeAuthority; request: SalesforceNativeRequest; idempotencyKey: string }) {
  const { authority } = input, intent = buildSalesforceNativeIntent({ ...input, scope: authority.scope }), scope = authority.scope;
  validate(authority, true, intent.request.review.connectionId); await ready();
  return transaction(authority, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`salesforce-native:${scope.tenantId}:${scope.workspaceId}:${scope.ownerActorId}`},0))`;
    await current(sql, authority, false, true);
    const prior = await exact(sql, authority, intent.idempotencyKeySha256);
    if (prior) {
      if (!same(prior.intent, intent)) fail("This Salesforce key already names another exact intent.");
      return { action: prior.action, intent, newlyAccepted: false, claim: null as Claim | null, providerToken: null as string | null };
    }
    const value = await current(sql, authority, true), observed = await summary(sql, authority, true);
    if (!same(value.review, intent.request.review) || !observed.availableActions.includes(intent.request.action)) fail("The reviewed Salesforce connection changed or an action remains unresolved.");
    let claim: Claim | null = null, providerToken: string | null = null;
    if (intent.request.action === "disconnect") {
      ({ providerToken } = await revokeExactSalesforceOAuthGrantInTransaction(sql, { tenantId: scope.tenantId, actorId: scope.ownerActorId,
        grantId: intent.request.review.oauthGrantId, expectedAuthorizationGeneration: intent.request.review.grantAuthorizationGeneration }));
      const updated = await sql`UPDATE omni_salesforce_connections SET connection_state='revoked',sync_status='idle',sync_error=NULL,
        sync_lease_owner_id=NULL,sync_lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=${scope.tenantId} AND workspace_id=${scope.workspaceId} AND owner_actor_id=${scope.ownerActorId}
          AND connection_id=${intent.request.review.connectionId} AND oauth_grant_id=${intent.request.review.oauthGrantId}
          AND authorization_generation=${intent.request.review.authorizationGeneration} AND connection_state='active' RETURNING connection_id`;
      if (updated.length !== 1) fail("The reviewed Salesforce connection could not be revoked.");
    } else {
      const claimed = await claimSalesforceSyncLease(legacyAuthority(authority));
      if (claimed.status !== "claimed" || claimed.connection.connectionId !== intent.request.review.connectionId ||
        claimed.connection.authorizationGeneration !== intent.request.review.authorizationGeneration) fail("The exact Salesforce lease could not be admitted.");
      claim = claimed;
    }
    const acceptance = buildSalesforceNativeAcceptance(intent, new Date().toISOString());
    await sql`INSERT INTO omni_salesforce_native_actions(id,tenant_id,workspace_id,owner_actor_id,connection_id,oauth_grant_id,authorization_generation,
      idempotency_key_sha256,request_sha256,intent,acceptance,accepted_at,state,settlement,lease_owner_id,lease_generation)
      VALUES(${acceptance.id},${scope.tenantId},${scope.workspaceId},${scope.ownerActorId},${intent.request.review.connectionId},${intent.request.review.oauthGrantId},
        ${intent.request.review.authorizationGeneration},${intent.idempotencyKeySha256},${acceptance.requestSha256},${intent}::JSONB,${acceptance}::JSONB,
        ${acceptance.acceptedAt},'accepted',NULL,${claim?.lease.ownerId ?? null},${claim?.lease.generation ?? null})`;
    await appendScopedDomainEvent({ id: `${acceptance.id}:accepted`, streamId: acceptance.id, type: "customer.salesforce.native.accepted",
      executionScope: authority.executionScope!, payload: { actionId: acceptance.id, action: acceptance.action, requestSha256: acceptance.requestSha256,
        acceptanceSha256: acceptance.acceptanceSha256, localRevoked: acceptance.localRevoked } }, { sql });
    await current(sql, authority, true);
    return { action: salesforceNativeActionSchema.parse({ acceptance, state: "accepted", settlement: null }), intent, newlyAccepted: true, claim, providerToken };
  });
}
async function fence(sql: Sql, authority: SalesforceNativeAuthority, intent: SalesforceNativeIntent, claim: Claim, requireLease = true) {
  const value = await current(sql, authority, true, true), prior = await exact(sql, authority, intent.idempotencyKeySha256);
  if (!prior || prior.action.state !== "accepted" || !same(prior.intent, intent) || !same(value.review, intent.request.review) ||
    prior.row.lease_owner_id !== claim.lease.ownerId || Number(prior.row.lease_generation) !== claim.lease.generation ||
    (requireLease && (!value.busy || value.connection?.sync_lease_owner_id !== claim.lease.ownerId || Number(value.connection?.sync_lease_generation) !== claim.lease.generation))) {
    fail("The accepted Salesforce lease, authorization or current authority changed.");
  }
}
export function salesforceNativeSyncExecution(authority: SalesforceNativeAuthority, intent: SalesforceNativeIntent, claim: Claim): SalesforceNativeSyncExecution {
  validate(authority, true, intent.request.review.connectionId);
  return { claim, beforeProvider: () => transaction(authority, (sql) => fence(sql, authority, intent, claim)),
    commit: <T>(work: () => Promise<T>) => transaction(authority, async (sql) => {
      await fence(sql, authority, intent, claim); const result = await work(); await fence(sql, authority, intent, claim, false); return result;
    }) };
}
export function salesforceNativeLegacyAuthority(authority: SalesforceNativeAuthority) { return legacyAuthority(authority); }
export async function mayRevokeSalesforceNativeProviderToken(authority: SalesforceNativeAuthority, intent: SalesforceNativeIntent) {
  validate(authority, true, intent.request.review.connectionId);
  return transaction(authority, async (sql) => {
    const value = await current(sql, authority, true), prior = await exact(sql, authority, intent.idempotencyKeySha256), review = value.review;
    return intent.request.action === "disconnect" && prior?.action.state === "accepted" && same(prior.intent, intent) && Boolean(review &&
      review.connectionId === intent.request.review.connectionId && review.oauthGrantId === intent.request.review.oauthGrantId &&
      review.authorizationGeneration === intent.request.review.authorizationGeneration && review.connectionState === "revoked" &&
      review.grantStatus === "revoked" && review.grantAuthorizationGeneration === intent.request.review.grantAuthorizationGeneration + 1);
  });
}
export async function settleSalesforceNativeAction(authority: SalesforceNativeAuthority, intent: SalesforceNativeIntent, input: SalesforceNativeSettlement) {
  validate(authority, true, intent.request.review.connectionId); const settlement = salesforceNativeSettlementSchema.parse(input);
  if (settlement.action !== intent.request.action) fail("Salesforce outcome belongs to another action.");
  return transaction(authority, async (sql) => {
    const value = await current(sql, authority, true, true), prior = await exact(sql, authority, intent.idempotencyKeySha256);
    if (!prior || !same(prior.intent, intent)) fail("The exact accepted Salesforce action is unavailable.");
    if (prior.action.state === "settled") { if (!same(prior.action.settlement, settlement)) fail("Salesforce outcome was already settled differently."); return prior.action; }
    if (intent.request.action !== "disconnect" && !same(value.review, intent.request.review)) fail("Salesforce authorization changed before result settlement.");
    const action = salesforceNativeActionSchema.parse({ acceptance: prior.action.acceptance, state: "settled", settlement });
    const updated = await sql`UPDATE omni_salesforce_native_actions SET state='settled',settlement=${settlement}::JSONB
      WHERE id=${action.acceptance.id} AND tenant_id=${authority.scope.tenantId} AND owner_actor_id=${authority.scope.ownerActorId} AND state='accepted' RETURNING id`;
    if (updated.length !== 1) fail("Salesforce outcome changed concurrently.");
    await appendScopedDomainEvent({ id: `${action.acceptance.id}:settled`, streamId: action.acceptance.id, type: "customer.salesforce.native.settled",
      executionScope: authority.executionScope!, payload: { actionId: action.acceptance.id, action: action.acceptance.action,
        acceptanceSha256: action.acceptance.acceptanceSha256, settlementSha256: canonicalJsonSha256(settlement) } }, { sql });
    await current(sql, authority, true); return action;
  });
}
