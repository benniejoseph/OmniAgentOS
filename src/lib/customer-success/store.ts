import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import {
  buildCustomerAccountRevision,
  buildCustomerFactRevision,
  customerAccountRevisionSchema,
  customerFactRevisionSchema,
  projectCustomerAccount360,
  type CustomerAccount360,
  type CustomerAccountRevision,
  type CustomerCrmPermissions,
  type CustomerDataPurposeId,
  type CustomerFactOwner,
  type CustomerFactRevision,
  type CustomerFactSource,
  type CustomerFactValue,
} from "@/lib/customer-success/contracts";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

type CustomerSql = ReturnType<typeof getSql>;

export type CustomerAccountReadAuthority = Readonly<{
  tenantId: string;
  workspaceId: string;
  canonicalActorId: string;
  readableActorIds: readonly string[];
  purposeId: "customer_success.account.read";
}>;

export type CustomerAccountMutationAuthority = Readonly<{
  tenantId: string;
  workspaceId: string;
  canonicalActorId: string;
  readableActorIds: readonly string[];
  purposeId: "customer_success.account.manage";
  idempotencyKey: string;
  executionScope: ExecutionScope;
}>;

export class CustomerAccountNotFoundError extends Error {
  constructor() {
    super("Customer account was not found in this workspace.");
    this.name = "CustomerAccountNotFoundError";
  }
}

export class CustomerAccountConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerAccountConflictError";
  }
}

export async function listCustomerAccounts(
  authority: CustomerAccountReadAuthority,
  input: { limit?: number; lifecycle?: CustomerAccountRevision["lifecycle"] } = {},
) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  const limit = Math.max(1, Math.min(200, input.limit || 100));
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = input.lifecycle
        ? await getSql()`
            SELECT account_snapshot
            FROM omni_customer_accounts
            WHERE tenant_id = ${authority.tenantId}
              AND workspace_id = ${authority.workspaceId}
              AND lifecycle = ${input.lifecycle}
              AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
            ORDER BY revised_at DESC, account_id COLLATE "C"
            LIMIT ${limit}
          `
        : await getSql()`
            SELECT account_snapshot
            FROM omni_customer_accounts
            WHERE tenant_id = ${authority.tenantId}
              AND workspace_id = ${authority.workspaceId}
              AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
            ORDER BY revised_at DESC, account_id COLLATE "C"
            LIMIT ${limit}
          `;
      return Object.freeze(rows.map((row) =>
        customerAccountRevisionSchema.parse(row.account_snapshot)
      ));
    },
  );
}

export async function getCustomerAccount360(
  authority: CustomerAccountReadAuthority,
  accountId: string,
): Promise<CustomerAccount360 | undefined> {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    () => readAccount360(getSql(), authority, accountId),
  );
}

export async function saveCustomerAccount(input: {
  authority: CustomerAccountMutationAuthority;
  accountId: string;
  mutationId: string;
  expectedRevision?: number;
  name: string;
  lifecycle: CustomerAccountRevision["lifecycle"];
  accountOwner: CustomerFactOwner;
  crmPermissions: CustomerCrmPermissions;
  organizationEntityId?: string | null;
}): Promise<CustomerAccountRevision> {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  const { authority } = input;
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    () => getSql().transaction(async (sql: CustomerSql) => {
      await sql`
        SELECT pg_advisory_xact_lock(hashtextextended(
          ${`${authority.tenantId}:${authority.workspaceId}:${input.accountId}`}, 0
        ))
      `;
      const existingMutation = await sql`
        SELECT account_snapshot
        FROM omni_customer_account_revisions
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${input.accountId}
          AND mutation_id = ${input.mutationId}
        LIMIT 1
      `;
      if (existingMutation[0]) {
        return customerAccountRevisionSchema.parse(existingMutation[0].account_snapshot);
      }
      const currentRows = await sql`
        SELECT account_snapshot
        FROM omni_customer_accounts
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${input.accountId}
        FOR UPDATE
      `;
      const current = currentRows[0]
        ? customerAccountRevisionSchema.parse(currentRows[0].account_snapshot)
        : undefined;
      if (!current && input.expectedRevision !== undefined) {
        throw new CustomerAccountConflictError("Customer account does not exist for revision.");
      }
      if (current && input.expectedRevision === undefined) {
        throw new CustomerAccountConflictError("Customer account already exists.");
      }
      if (current && current.revision !== input.expectedRevision) {
        throw new CustomerAccountConflictError("Customer account changed. Refresh and try again.");
      }
      if (current && current.ownerActorId !== authority.canonicalActorId) {
        throw new CustomerAccountConflictError("Customer account ownership cannot be transferred implicitly.");
      }
      const clock = await sql`SELECT clock_timestamp() AS revised_at`;
      const revisedAt = timestamp(clock[0]?.revised_at);
      const account = buildCustomerAccountRevision({
        tenantId: authority.tenantId,
        workspaceId: authority.workspaceId,
        accountId: input.accountId,
        accountEntityId: current?.accountEntityId || input.accountId,
        organizationEntityId: input.organizationEntityId === undefined
          ? current?.organizationEntityId || null
          : input.organizationEntityId,
        revision: (current?.revision || 0) + 1,
        mutationId: input.mutationId,
        name: input.name,
        lifecycle: input.lifecycle,
        accountOwner: input.accountOwner,
        crmPermissions: input.crmPermissions,
        ownerActorId: current?.ownerActorId || authority.canonicalActorId,
        revisedByActorId: authority.canonicalActorId,
        revisedAt,
      });
      await sql`
        INSERT INTO omni_customer_account_revisions (
          tenant_id, workspace_id, account_id, revision_id, revision,
          mutation_id, owner_actor_id, allowed_purpose_ids,
          account_sha256, account_snapshot, revised_at
        ) VALUES (
          ${authority.tenantId}, ${authority.workspaceId}, ${account.accountId},
          ${account.revisionId}, ${account.revision}, ${account.mutationId},
          ${account.ownerActorId}, ${account.crmPermissions.customerDataPurposeIds},
          ${account.accountSha256}, ${account}::JSONB, ${account.revisedAt}
        )
      `;
      if (current) {
        const updated = await sql`
          UPDATE omni_customer_accounts
          SET current_revision = ${account.revision},
              current_revision_id = ${account.revisionId},
              name = ${account.name},
              lifecycle = ${account.lifecycle},
              allowed_purpose_ids = ${account.crmPermissions.customerDataPurposeIds},
              account_sha256 = ${account.accountSha256},
              account_snapshot = ${account}::JSONB,
              revised_at = ${account.revisedAt}
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND account_id = ${account.accountId}
            AND current_revision = ${current.revision}
          RETURNING account_id
        `;
        if (!updated[0]) {
          throw new CustomerAccountConflictError("Customer account changed concurrently.");
        }
      } else {
        await sql`
          INSERT INTO omni_customer_accounts (
            tenant_id, workspace_id, account_id, owner_actor_id,
            current_revision, current_revision_id, name, lifecycle,
            allowed_purpose_ids, account_sha256, account_snapshot,
            created_at, revised_at
          ) VALUES (
            ${authority.tenantId}, ${authority.workspaceId}, ${account.accountId},
            ${account.ownerActorId}, ${account.revision}, ${account.revisionId},
            ${account.name}, ${account.lifecycle},
            ${account.crmPermissions.customerDataPurposeIds},
            ${account.accountSha256}, ${account}::JSONB,
            ${account.revisedAt}, ${account.revisedAt}
          )
        `;
      }
      await appendScopedDomainEvent({
        id: `customer-account-${current ? "revised" : "created"}:${account.accountSha256}`,
        streamId: account.accountId,
        type: current ? "customer.account.revised" : "customer.account.created",
        executionScope: authority.executionScope,
        payload: {
          schemaVersion: 1,
          accountId: account.accountId,
          revisionId: account.revisionId,
          revision: account.revision,
          lifecycle: account.lifecycle,
          accountSha256: account.accountSha256,
          allowedPurposeIds: account.crmPermissions.customerDataPurposeIds,
          externalWriteState: account.crmPermissions.externalWriteState,
        },
      }, { sql });
      return account;
    }) as Promise<CustomerAccountRevision>,
  );
}

export async function recordCustomerFact(input: {
  authority: CustomerAccountMutationAuthority;
  accountId: string;
  factId: string;
  mutationId: string;
  expectedRevision?: number;
  factKey: string;
  state?: "active" | "retracted";
  value: CustomerFactValue;
  source: CustomerFactSource;
  owner: CustomerFactOwner;
  confidenceBasisPoints: number;
  validFrom: string;
  validTo?: string | null;
  staleAfter?: string | null;
}): Promise<CustomerFactRevision> {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  const { authority } = input;
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    () => getSql().transaction(async (sql: CustomerSql) => {
      await sql`
        SELECT pg_advisory_xact_lock(hashtextextended(
          ${`${authority.tenantId}:${authority.workspaceId}:${input.accountId}:${input.factId}`}, 0
        ))
      `;
      const accountRows = await sql`
        SELECT account_snapshot
        FROM omni_customer_accounts
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${input.accountId}
          AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
        FOR UPDATE
      `;
      if (!accountRows[0]) throw new CustomerAccountNotFoundError();
      const account = customerAccountRevisionSchema.parse(accountRows[0].account_snapshot);
      assertFactPurposes(account, input.source.allowedPurposeIds);
      const existingMutation = await sql`
        SELECT fact_snapshot
        FROM omni_customer_fact_revisions
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${input.accountId}
          AND mutation_id = ${input.mutationId}
        LIMIT 1
      `;
      if (existingMutation[0]) {
        return customerFactRevisionSchema.parse(existingMutation[0].fact_snapshot);
      }
      const currentRows = await sql`
        SELECT fact_snapshot
        FROM omni_customer_fact_revisions
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${input.accountId}
          AND fact_id = ${input.factId}
        ORDER BY revision DESC
        LIMIT 1
        FOR UPDATE
      `;
      const current = currentRows[0]
        ? customerFactRevisionSchema.parse(currentRows[0].fact_snapshot)
        : undefined;
      if (!current && input.expectedRevision !== undefined) {
        throw new CustomerAccountConflictError("Customer fact does not exist for revision.");
      }
      if (current && input.expectedRevision === undefined) {
        throw new CustomerAccountConflictError("Customer fact already exists.");
      }
      if (current && current.revision !== input.expectedRevision) {
        throw new CustomerAccountConflictError("Customer fact changed. Refresh and try again.");
      }
      if (current && (current.factKey !== input.factKey || current.kind !== input.value.kind)) {
        throw new CustomerAccountConflictError("Customer fact identity and kind cannot change.");
      }
      const clock = await sql`SELECT clock_timestamp() AS recorded_at`;
      const recordedAt = timestamp(clock[0]?.recorded_at);
      const fact = buildCustomerFactRevision({
        tenantId: authority.tenantId,
        workspaceId: authority.workspaceId,
        accountId: input.accountId,
        factId: input.factId,
        revision: (current?.revision || 0) + 1,
        mutationId: input.mutationId,
        factKey: input.factKey,
        state: input.state,
        value: input.value,
        source: { ...input.source, ingestedAt: recordedAt },
        owner: input.owner,
        confidenceBasisPoints: input.confidenceBasisPoints,
        validFrom: input.validFrom,
        validTo: input.validTo,
        staleAfter: input.staleAfter,
        recordedByActorId: authority.canonicalActorId,
        recordedAt,
      });
      await sql`
        INSERT INTO omni_customer_fact_revisions (
          tenant_id, workspace_id, account_id, fact_id, fact_revision_id,
          revision, mutation_id, owner_actor_id, fact_key, fact_kind,
          fact_state, allowed_purpose_ids, value_sha256,
          source_revision_sha256, fact_sha256, fact_snapshot, recorded_at
        ) VALUES (
          ${authority.tenantId}, ${authority.workspaceId}, ${fact.accountId},
          ${fact.factId}, ${fact.factRevisionId}, ${fact.revision},
          ${fact.mutationId}, ${account.ownerActorId}, ${fact.factKey},
          ${fact.kind}, ${fact.state}, ${fact.source.allowedPurposeIds},
          ${fact.valueSha256}, ${fact.source.sourceRevisionSha256},
          ${fact.factSha256}, ${fact}::JSONB, ${fact.recordedAt}
        )
      `;
      await appendScopedDomainEvent({
        id: `customer-fact-recorded:${fact.factSha256}`,
        streamId: fact.accountId,
        type: "customer.account.fact.recorded",
        executionScope: authority.executionScope,
        payload: {
          schemaVersion: 1,
          accountId: fact.accountId,
          factId: fact.factId,
          factRevisionId: fact.factRevisionId,
          factKey: fact.factKey,
          factKind: fact.kind,
          factState: fact.state,
          sourceKind: fact.source.sourceKind,
          sourceRevisionSha256: fact.source.sourceRevisionSha256,
          valueSha256: fact.valueSha256,
          confidenceBasisPoints: fact.confidenceBasisPoints,
          factSha256: fact.factSha256,
        },
      }, { sql });
      return fact;
    }) as Promise<CustomerFactRevision>,
  );
}

async function readAccount360(
  sql: CustomerSql,
  authority: CustomerAccountReadAuthority,
  accountId: string,
) {
  const accountRows = await sql`
    SELECT account_snapshot
    FROM omni_customer_accounts
    WHERE tenant_id = ${authority.tenantId}
      AND workspace_id = ${authority.workspaceId}
      AND account_id = ${accountId}
      AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
    LIMIT 1
  `;
  if (!accountRows[0]) return undefined;
  const account = customerAccountRevisionSchema.parse(accountRows[0].account_snapshot);
  const factRows = await sql`
    SELECT DISTINCT ON (fact_id) fact_snapshot
    FROM omni_customer_fact_revisions
    WHERE tenant_id = ${authority.tenantId}
      AND workspace_id = ${authority.workspaceId}
      AND account_id = ${accountId}
      AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
    ORDER BY fact_id COLLATE "C", revision DESC
  `;
  const historyRows = await sql`
    SELECT (
      (SELECT count(*) FROM omni_customer_account_revisions
       WHERE tenant_id = ${authority.tenantId}
         AND workspace_id = ${authority.workspaceId}
         AND account_id = ${accountId})
      +
      (SELECT count(*) FROM omni_customer_fact_revisions
       WHERE tenant_id = ${authority.tenantId}
         AND workspace_id = ${authority.workspaceId}
         AND account_id = ${accountId})
    )::INTEGER AS history_count,
    clock_timestamp() AS evaluated_at
  `;
  return projectCustomerAccount360({
    account,
    currentFacts: factRows.map((row) =>
      customerFactRevisionSchema.parse(row.fact_snapshot)
    ),
    historyCount: Number(historyRows[0]?.history_count || 0),
    evaluatedAt: timestamp(historyRows[0]?.evaluated_at),
  });
}

function assertFactPurposes(
  account: CustomerAccountRevision,
  purposes: readonly CustomerDataPurposeId[],
) {
  if (!purposes.includes("customer_success.account.read")) {
    throw new CustomerAccountConflictError(
      "Customer facts must remain readable for their explicit account purpose.",
    );
  }
  if (purposes.some((purpose) =>
    !account.crmPermissions.customerDataPurposeIds.includes(purpose)
  )) {
    throw new CustomerAccountConflictError(
      "Customer fact purposes exceed the account permission boundary.",
    );
  }
}

function assertReadAuthority(authority: CustomerAccountReadAuthority) {
  if (authority.purposeId !== "customer_success.account.read" ||
      !authority.tenantId || !authority.workspaceId ||
      !authority.readableActorIds.includes(authority.canonicalActorId)) {
    throw new Error("Customer account read authority is invalid.");
  }
}

function assertMutationAuthority(authority: CustomerAccountMutationAuthority) {
  if (authority.purposeId !== "customer_success.account.manage" ||
      !authority.idempotencyKey.trim()) {
    throw new Error("Customer account mutation authority is invalid.");
  }
  const scope = parsePersistedExecutionScope(authority.executionScope);
  if (!scope || scope.tenantId !== authority.tenantId ||
      scope.workspaceId !== authority.workspaceId ||
      scope.initiatingActorId !== authority.canonicalActorId ||
      !authority.readableActorIds.includes(authority.canonicalActorId)) {
    throw new Error("Customer account execution scope is invalid.");
  }
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Database timestamp is invalid.");
  return date.toISOString();
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new Error("Customer Account 360 requires the canonical database.");
  }
}
