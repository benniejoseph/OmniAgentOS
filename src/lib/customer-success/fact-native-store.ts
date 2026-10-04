import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import { customerAccountRevisionSchema, customerFactRevisionSchema, type CustomerAccountRevision } from "@/lib/customer-success/contracts";
import { buildCustomerFactNativeAcceptance, buildCustomerFactNativeIntent, buildCustomerFactNativeSource,
  customerFactNativeAccountIdSchema, customerFactNativeCurrentAccountSchema, customerFactNativeIntentSchema,
  customerFactNativeWorkspaceSchema, type CustomerFactNativeAcceptance, type CustomerFactNativeRequest } from "@/lib/customer-success/fact-mutation-contracts";
import { CustomerAccountConflictError, CustomerAccountNotFoundError, recordCustomerFactInTransaction,
  type CustomerAccountMutationAuthority, type CustomerAccountReadAuthority } from "@/lib/customer-success/store";
import { redactSensitive } from "@/lib/security/context";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type Sql = ReturnType<typeof getSql>;
type Authority = CustomerAccountReadAuthority | CustomerAccountMutationAuthority;
type Row = Record<string, unknown>;
function assertAuthority(authority: Authority, accountId: string, mutation: boolean) {
  customerFactNativeAccountIdSchema.parse(accountId); customerFactNativeWorkspaceSchema.parse(authority.workspaceId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(authority.tenantId) ||
    !/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(authority.canonicalActorId) ||
    authority.readableActorIds.length !== 1 || authority.readableActorIds[0] !== authority.canonicalActorId ||
    authority.purposeId !== (mutation ? "customer_success.account.manage" : "customer_success.account.read")) {
    throw new CustomerAccountConflictError("Current canonical manual fact authority is required.");
  }
  if (mutation) {
    const scope = parsePersistedExecutionScope((authority as CustomerAccountMutationAuthority).executionScope);
    if (!scope || scope.tenantId !== authority.tenantId || scope.workspaceId !== authority.workspaceId ||
      scope.initiatingActorId !== authority.canonicalActorId || scope.executingPrincipalType !== "user" ||
      scope.executingPrincipalId !== authority.canonicalActorId || scope.projectId !== null || scope.missionId !== null ||
      scope.delegationId !== null || scope.contextGrantIds.length || scope.capabilityGrantIds.length ||
      scope.purpose !== "customer.account.fact.record" || scope.causationId !== accountId) {
      throw new CustomerAccountConflictError("Direct manual fact authority must name this exact Account.");
    }
  }
}
async function ready() {
  if (!hasDatabaseUrl()) throw new CustomerAccountConflictError("Native manual facts require durable database storage.");
  await ensureDatabaseSchema();
}
function compact(account: CustomerAccountRevision, acceptance: CustomerFactNativeAcceptance | null) {
  const current = customerFactNativeCurrentAccountSchema.parse({ accountId: account.accountId, revisionId: account.revisionId,
    revision: account.revision, accountSha256: account.accountSha256 });
  if (acceptance && (current.revision < acceptance.reviewedAccountRevision ||
    (current.revision === acceptance.reviewedAccountRevision && current.accountSha256 !== acceptance.reviewedAccountSha256))) {
    throw new CustomerAccountConflictError("Current Account precedes its accepted manual fact pin.");
  }
  return current;
}
function acceptance(row: Row, authority: Authority, accountId: string, keySha256: string) {
  if (row.native_intent == null && row.native_intent_sha256 == null) return null;
  const intent = customerFactNativeIntentSchema.parse(row.native_intent);
  if (canonicalJsonSha256(intent) !== row.native_intent_sha256 || intent.tenantId !== authority.tenantId ||
    intent.workspaceId !== authority.workspaceId || intent.accountId !== accountId || intent.canonicalActorId !== authority.canonicalActorId ||
    row.fact_owner_actor_id !== authority.canonicalActorId || intent.idempotencyKeySha256 !== keySha256) {
    throw new CustomerAccountConflictError("The fact key has another immutable owner or intent.");
  }
  return buildCustomerFactNativeAcceptance(intent, customerFactRevisionSchema.parse(row.fact_snapshot));
}
// A single current-authority anchor prevents a hidden historical row from
// being mistaken for a key's absence after workspace membership changes.
async function anchored(sql: Sql, authority: Authority, input: {
  accountId: string; keySha256: string; mutationId: string | null; mutation: boolean;
}) {
  const rows = await sql`SELECT account.account_snapshot,fact.fact_snapshot,fact.native_intent,fact.native_intent_sha256,fact.owner_actor_id AS fact_owner_actor_id
    FROM omni_customer_accounts account
    JOIN omni_tenant_workspaces workspace ON workspace.tenant_id=account.tenant_id AND workspace.workspace_id=account.workspace_id AND workspace.state='active'
    JOIN omni_tenant_workspace_memberships membership ON membership.tenant_id=workspace.tenant_id AND membership.workspace_id=workspace.workspace_id
      AND membership.subject_kind='user' AND membership.subject_actor_id=${authority.canonicalActorId} AND membership.state='active'
      AND (membership.access_level IN ('contributor','manager') OR (${input.mutation}=FALSE AND membership.access_level='reader'))
    LEFT JOIN omni_customer_fact_revisions fact ON fact.tenant_id=account.tenant_id AND fact.workspace_id=account.workspace_id
      AND fact.owner_actor_id=${authority.canonicalActorId}
      AND ((fact.native_intent->>'idempotencyKeySha256')=${input.keySha256}
        OR (${input.mutation}=TRUE AND fact.account_id=account.account_id AND fact.mutation_id=${input.mutationId}))
      AND (${input.mutation}=TRUE OR fact.account_id=account.account_id)
      AND fact.allowed_purpose_ids @> ARRAY['customer_success.account.read']::TEXT[]
    WHERE account.tenant_id=${authority.tenantId} AND account.workspace_id=${authority.workspaceId} AND account.account_id=${input.accountId}
      AND account.owner_actor_id=${authority.canonicalActorId} AND account.allowed_purpose_ids @> ARRAY['customer_success.account.read']::TEXT[]
      AND (${input.mutation}=FALSE OR account.allowed_purpose_ids @> ARRAY['customer_success.account.manage']::TEXT[]) LIMIT 2`;
  if (rows.length !== 1) return null;
  const account = customerAccountRevisionSchema.parse(rows[0].account_snapshot);
  if (account.accountId !== input.accountId || account.tenantId !== authority.tenantId ||
    account.workspaceId !== authority.workspaceId || account.ownerActorId !== authority.canonicalActorId) throw new CustomerAccountNotFoundError();
  return { row: rows[0], account };
}
export async function readCustomerFactNativeAcceptance(authority: CustomerAccountReadAuthority, input: { accountId: string; keySha256: string }) {
  assertAuthority(authority, input.accountId, false);
  if (!/^[a-f0-9]{64}$/.test(input.keySha256)) throw new CustomerAccountConflictError("Exact fact acceptance key is invalid.");
  await ready();
  return runWithDatabaseActorScope(authority.tenantId, [authority.canonicalActorId], async () => {
    const value = await anchored(getSql(), authority, { ...input, mutationId: null, mutation: false });
    if (!value) return null;
    const accepted = value.row.fact_snapshot ? acceptance(value.row, authority, input.accountId, input.keySha256) : null;
    return { currentAccount: compact(value.account, accepted), acceptance: accepted };
  });
}
export async function submitCustomerFactNativeMutation(input: { authority: CustomerAccountMutationAuthority; accountId: string; request: CustomerFactNativeRequest }) {
  const { authority, accountId } = input;
  const intent = buildCustomerFactNativeIntent({ ...authority, accountId, request: input.request });
  assertAuthority(authority, accountId, true); await ready();
  type Result = { currentAccount: ReturnType<typeof compact>; acceptance: CustomerFactNativeAcceptance; replayed: boolean };
  return runWithDatabaseActorScope(authority.tenantId, [authority.canonicalActorId], () => getSql().transaction(async (sql: Sql): Promise<Result> => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-fact-key:${authority.tenantId}:${authority.workspaceId}:${authority.canonicalActorId}:${intent.idempotencyKeySha256}`},0))`;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${authority.tenantId}:${authority.workspaceId}:${accountId}:${intent.factId}`},0))`;
    const locked = await sql`SELECT account_id FROM omni_customer_accounts WHERE tenant_id=${authority.tenantId} AND workspace_id=${authority.workspaceId}
      AND account_id=${accountId} AND owner_actor_id=${authority.canonicalActorId}
      AND allowed_purpose_ids @> ARRAY['customer_success.account.read','customer_success.account.manage']::TEXT[] FOR UPDATE`;
    if (locked.length !== 1) throw new CustomerAccountNotFoundError();
    const before = await anchored(sql, authority, { accountId, keySha256: intent.idempotencyKeySha256, mutationId: intent.mutationId, mutation: true });
    if (!before) throw new CustomerAccountNotFoundError();
    if (before.row.fact_snapshot) {
      const accepted = acceptance(before.row, authority, accountId, intent.idempotencyKeySha256);
      if (!accepted || accepted.requestSha256 !== canonicalJsonSha256(intent)) throw new CustomerAccountConflictError("This key has no matching native fact acceptance.");
      return { currentAccount: compact(before.account, accepted), acceptance: accepted, replayed: true };
    }
    if (before.account.revision !== intent.request.expectedAccountRevision || before.account.accountSha256 !== intent.request.expectedAccountSha256) {
      throw new CustomerAccountConflictError("The reviewed Account changed before fact admission.");
    }
    if (canonicalJsonSha256(redactSensitive(intent.request)) !== canonicalJsonSha256(intent.request)) {
      throw new CustomerAccountConflictError("Manual fact content would change during redaction. Review the exact safe content first.");
    }
    const request = intent.request;
    const fact = await recordCustomerFactInTransaction(sql, { authority, accountId, factId: intent.factId, mutationId: intent.mutationId,
      expectedRevision: request.expectedFactRevision ?? undefined, factKey: request.factKey, state: request.operation === "retract" ? "retracted" : "active",
      value: request.value, owner: request.owner, confidenceBasisPoints: request.confidenceBasisPoints,
      validFrom: request.validFrom, validTo: request.validTo, staleAfter: request.staleAfter,
      source: buildCustomerFactNativeSource(intent, request.manualSource.observedAt), nativeIntent: intent });
    const after = await anchored(sql, authority, { accountId, keySha256: intent.idempotencyKeySha256, mutationId: intent.mutationId, mutation: true });
    if (!after || after.account.accountSha256 !== before.account.accountSha256 || after.account.revision !== before.account.revision) {
      throw new CustomerAccountConflictError("Current Account or workspace authority changed before fact commit.");
    }
    const accepted = acceptance(after.row, authority, accountId, intent.idempotencyKeySha256);
    if (!accepted || accepted.factSha256 !== fact.factSha256 || accepted.requestSha256 !== canonicalJsonSha256(intent)) throw new Error("Exact native fact acceptance was not persisted.");
    return { currentAccount: compact(after.account, accepted), acceptance: accepted, replayed: false };
  }) as Promise<Result>);
}
