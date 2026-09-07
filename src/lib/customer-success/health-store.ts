import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import {
  customerAccountRevisionSchema,
  customerFactRevisionSchema,
  projectCustomerAccount360,
} from "@/lib/customer-success/contracts";
import {
  buildDefaultCustomerHealthPolicy,
  customerHealthScoreSchema,
  type CustomerHealthScore,
  type CustomerHealthSuggestion,
} from "@/lib/customer-success/health-contracts";
import { evaluateCustomerHealth } from "@/lib/customer-success/health-engine";
import {
  CustomerAccountConflictError,
  CustomerAccountNotFoundError,
  type CustomerAccountMutationAuthority,
  type CustomerAccountReadAuthority,
} from "@/lib/customer-success/store";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";

type CustomerHealthSql = ReturnType<typeof getSql>;

export async function getCurrentCustomerHealthScore(
  authority: CustomerAccountReadAuthority,
  accountId: string,
): Promise<CustomerHealthScore | undefined> {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT score_snapshot
        FROM omni_customer_health_scores
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${accountId}
          AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
        LIMIT 1
      `;
      return rows[0]
        ? customerHealthScoreSchema.parse(rows[0].score_snapshot)
        : undefined;
    },
  );
}

export async function listCustomerHealthScores(
  authority: CustomerAccountReadAuthority,
  input: { limit?: number } = {},
) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  const limit = Math.max(1, Math.min(200, input.limit || 100));
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT score_snapshot
        FROM omni_customer_health_scores
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
        ORDER BY evaluated_at DESC, account_id COLLATE "C"
        LIMIT ${limit}
      `;
      return Object.freeze(rows.map((row) =>
        customerHealthScoreSchema.parse(row.score_snapshot)
      ));
    },
  );
}

export async function listCustomerHealthScoreHistory(
  authority: CustomerAccountReadAuthority,
  accountId: string,
  input: { limit?: number } = {},
) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  const limit = Math.max(1, Math.min(100, input.limit || 20));
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT score_snapshot
        FROM omni_customer_health_score_revisions
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${accountId}
          AND allowed_purpose_ids @> ARRAY[${authority.purposeId}]::TEXT[]
        ORDER BY revision DESC
        LIMIT ${limit}
      `;
      return Object.freeze(rows.map((row) =>
        customerHealthScoreSchema.parse(row.score_snapshot)
      ));
    },
  );
}

export async function evaluateAndSaveCustomerHealth(input: {
  authority: CustomerAccountMutationAuthority;
  accountId: string;
  expectedAccountRevision: number;
  expectedAccountSha256: string;
  evaluationId: string;
  suggestions?: readonly CustomerHealthSuggestion[];
}): Promise<CustomerHealthScore> {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  const { authority } = input;
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    () => getSql().transaction(async (sql: CustomerHealthSql) => {
      await sql`
        SELECT pg_advisory_xact_lock(hashtextextended(
          ${`${authority.tenantId}:${authority.workspaceId}:${input.accountId}:health`}, 0
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
      if (account.ownerActorId !== authority.canonicalActorId) {
        throw new CustomerAccountConflictError(
          "Only the current account owner can evaluate authoritative health.",
        );
      }
      if (account.revision !== input.expectedAccountRevision ||
          account.accountSha256 !== input.expectedAccountSha256) {
        throw new CustomerAccountConflictError(
          "Customer account evidence changed. Refresh before evaluating health.",
        );
      }
      const existingRows = await sql`
        SELECT score_snapshot
        FROM omni_customer_health_score_revisions
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${input.accountId}
          AND evaluation_id = ${input.evaluationId}
        LIMIT 1
      `;
      if (existingRows[0]) {
        return customerHealthScoreSchema.parse(existingRows[0].score_snapshot);
      }
      const currentRows = await sql`
        SELECT score_snapshot
        FROM omni_customer_health_scores
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${input.accountId}
        FOR UPDATE
      `;
      const current = currentRows[0]
        ? customerHealthScoreSchema.parse(currentRows[0].score_snapshot)
        : undefined;
      const factRows = await sql`
        SELECT DISTINCT ON (fact_id) fact_snapshot
        FROM omni_customer_fact_revisions
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${input.accountId}
          AND allowed_purpose_ids @> ARRAY['customer_success.account.read']::TEXT[]
        ORDER BY fact_id COLLATE "C", revision DESC
      `;
      const clockRows = await sql`
        SELECT clock_timestamp() AS evaluated_at,
          (
            (SELECT count(*) FROM omni_customer_account_revisions
              WHERE tenant_id = ${authority.tenantId}
                AND workspace_id = ${authority.workspaceId}
                AND account_id = ${input.accountId})
            +
            (SELECT count(*) FROM omni_customer_fact_revisions
              WHERE tenant_id = ${authority.tenantId}
                AND workspace_id = ${authority.workspaceId}
                AND account_id = ${input.accountId})
          )::INTEGER AS history_count
      `;
      const evaluatedAt = timestamp(clockRows[0]?.evaluated_at);
      const account360 = projectCustomerAccount360({
        account,
        currentFacts: factRows.map((row) =>
          customerFactRevisionSchema.parse(row.fact_snapshot)
        ),
        historyCount: Number(clockRows[0]?.history_count || 0),
        evaluatedAt,
      });
      const policy = buildDefaultCustomerHealthPolicy();
      const score = evaluateCustomerHealth({
        account360,
        revision: (current?.revision || 0) + 1,
        evaluationId: input.evaluationId,
        evaluatedByActorId: authority.canonicalActorId,
        evaluatedAt,
        policy,
        suggestions: input.suggestions,
      });
      await sql`
        INSERT INTO omni_customer_health_policies (
          tenant_id, workspace_id, account_id, owner_actor_id,
          policy_id, policy_version, allowed_purpose_ids,
          policy_sha256, policy_snapshot, created_at
        ) VALUES (
          ${authority.tenantId}, ${authority.workspaceId}, ${input.accountId},
          ${authority.canonicalActorId}, ${policy.policyId}, ${policy.policyVersion},
          ${["customer_success.account.read"]}, ${policy.policySha256},
          ${policy}::JSONB, ${evaluatedAt}
        ) ON CONFLICT (tenant_id, workspace_id, account_id, policy_id) DO NOTHING
      `;
      await sql`
        INSERT INTO omni_customer_health_score_revisions (
          tenant_id, workspace_id, account_id, owner_actor_id,
          score_id, score_revision_id, revision, evaluation_id, policy_id,
          allowed_purpose_ids, account_sha256, input_sha256,
          score_basis_points, health_status, confidence_basis_points,
          coverage_basis_points, score_sha256, score_snapshot, evaluated_at
        ) VALUES (
          ${authority.tenantId}, ${authority.workspaceId}, ${input.accountId},
          ${authority.canonicalActorId}, ${score.scoreId}, ${score.scoreRevisionId},
          ${score.revision}, ${score.evaluationId}, ${score.policy.policyId},
          ${["customer_success.account.read"]}, ${score.accountSha256},
          ${score.inputSha256}, ${score.scoreBasisPoints}, ${score.status},
          ${score.confidenceBasisPoints}, ${score.coverageBasisPoints},
          ${score.scoreSha256}, ${score}::JSONB, ${score.evaluatedAt}
        )
      `;
      if (current) {
        const updated = await sql`
          UPDATE omni_customer_health_scores
          SET current_revision_id = ${score.scoreRevisionId},
              current_revision = ${score.revision},
              evaluation_id = ${score.evaluationId},
              policy_id = ${score.policy.policyId},
              account_sha256 = ${score.accountSha256},
              input_sha256 = ${score.inputSha256},
              score_basis_points = ${score.scoreBasisPoints},
              health_status = ${score.status},
              confidence_basis_points = ${score.confidenceBasisPoints},
              coverage_basis_points = ${score.coverageBasisPoints},
              score_sha256 = ${score.scoreSha256},
              score_snapshot = ${score}::JSONB,
              evaluated_at = ${score.evaluatedAt}
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND account_id = ${input.accountId}
            AND current_revision = ${current.revision}
          RETURNING account_id
        `;
        if (!updated[0]) {
          throw new CustomerAccountConflictError(
            "Customer health changed concurrently. Refresh and try again.",
          );
        }
      } else {
        await sql`
          INSERT INTO omni_customer_health_scores (
            tenant_id, workspace_id, account_id, owner_actor_id,
            score_id, current_revision_id, current_revision, evaluation_id,
            policy_id, allowed_purpose_ids, account_sha256, input_sha256,
            score_basis_points, health_status, confidence_basis_points,
            coverage_basis_points, score_sha256, score_snapshot,
            created_at, evaluated_at
          ) VALUES (
            ${authority.tenantId}, ${authority.workspaceId}, ${input.accountId},
            ${authority.canonicalActorId}, ${score.scoreId}, ${score.scoreRevisionId},
            ${score.revision}, ${score.evaluationId}, ${score.policy.policyId},
            ${["customer_success.account.read"]}, ${score.accountSha256},
            ${score.inputSha256}, ${score.scoreBasisPoints}, ${score.status},
            ${score.confidenceBasisPoints}, ${score.coverageBasisPoints},
            ${score.scoreSha256}, ${score}::JSONB, ${score.evaluatedAt},
            ${score.evaluatedAt}
          )
        `;
      }
      await appendScopedDomainEvent({
        id: `customer-health-evaluated:${score.scoreSha256}`,
        streamId: score.accountId,
        type: "customer.account.health.evaluated",
        executionScope: authority.executionScope,
        payload: {
          schemaVersion: 1,
          accountId: score.accountId,
          scoreRevisionId: score.scoreRevisionId,
          revision: score.revision,
          policyId: score.policy.policyId,
          policySha256: score.policy.policySha256,
          inputSha256: score.inputSha256,
          scoreBasisPoints: score.scoreBasisPoints,
          status: score.status,
          confidenceBasisPoints: score.confidenceBasisPoints,
          coverageBasisPoints: score.coverageBasisPoints,
          factorCount: score.factors.length,
          suggestionCount: score.suggestions.length,
          authority: score.authority,
          scoreSha256: score.scoreSha256,
        },
      }, { sql });
      return score;
    }) as Promise<CustomerHealthScore>,
  );
}

function assertReadAuthority(authority: CustomerAccountReadAuthority) {
  if (authority.purposeId !== "customer_success.account.read" ||
      !authority.tenantId || !authority.workspaceId ||
      !authority.readableActorIds.includes(authority.canonicalActorId)) {
    throw new Error("Customer health read authority is invalid.");
  }
}

function assertMutationAuthority(authority: CustomerAccountMutationAuthority) {
  const scope = parsePersistedExecutionScope(authority.executionScope);
  if (authority.purposeId !== "customer_success.account.manage" ||
      !authority.idempotencyKey.trim() ||
      !authority.readableActorIds.includes(authority.canonicalActorId) ||
      !scope || scope.tenantId !== authority.tenantId ||
      scope.workspaceId !== authority.workspaceId ||
      scope.initiatingActorId !== authority.canonicalActorId) {
    throw new Error("Customer health mutation authority is invalid.");
  }
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Database timestamp is invalid.");
  return date.toISOString();
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new Error("Customer health scoring requires the canonical database.");
  }
}
