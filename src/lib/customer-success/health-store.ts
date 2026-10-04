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
  type CustomerAccountRevision,
} from "@/lib/customer-success/contracts";
import {
  buildDefaultCustomerHealthPolicy,
  customerHealthScoreSchema,
  type CustomerHealthScore,
  type CustomerHealthSuggestion,
} from "@/lib/customer-success/health-contracts";
import {
  CUSTOMER_HEALTH_REVISION_MAX, CustomerHealthEvaluationRefusedError,
  buildCustomerHealthEvaluationIntent, buildCustomerHealthEvaluationAcceptance,
  customerHealthEvaluationIntentSchema, customerHealthEvaluationCurrentAccountSchema, customerHealthEvaluationIdSchema,
  type CustomerHealthEvaluationRequest, type CustomerHealthEvaluationIntent,
  type CustomerHealthEvaluationAcceptance, type CustomerHealthEvaluationCurrentAccount,
} from "@/lib/customer-success/health-mutation-contracts";
export { CustomerHealthEvaluationRefusedError } from "@/lib/customer-success/health-mutation-contracts";
import { evaluateCustomerHealth } from "@/lib/customer-success/health-engine";
import {
  CUSTOMER_ACCOUNT_FACT_LIMIT,
  CustomerAccountConflictError,
  CustomerAccountNotFoundError,
  CustomerAccountProjectionLimitError,
  type CustomerAccountMutationAuthority,
  type CustomerAccountReadAuthority,
} from "@/lib/customer-success/store";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

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

type HealthEvaluationInput = {
  authority: CustomerAccountMutationAuthority;
  accountId: string;
  expectedAccountRevision: number;
  expectedAccountSha256: string;
  evaluationId: string;
  suggestions?: readonly CustomerHealthSuggestion[];
};
type HealthEvaluationOutcome = {
  score: CustomerHealthScore;
  currentAccount: CustomerHealthEvaluationCurrentAccount;
  acceptance: CustomerHealthEvaluationAcceptance | null;
  replayed: boolean;
};

export async function evaluateAndSaveCustomerHealth(input: HealthEvaluationInput): Promise<CustomerHealthScore> {
  return (await evaluateHealthTransaction(input)).score;
}

async function evaluateHealthTransaction(input: HealthEvaluationInput, nativeIntent?: CustomerHealthEvaluationIntent): Promise<HealthEvaluationOutcome> {
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
      if (nativeIntent && (account.tenantId !== authority.tenantId || account.workspaceId !== authority.workspaceId || account.accountId !== input.accountId)) {
        throw new CustomerAccountConflictError("Current Account identity is inconsistent.");
      }
      if (!nativeIntent && (account.revision !== input.expectedAccountRevision ||
          account.accountSha256 !== input.expectedAccountSha256)) {
        throw new CustomerAccountConflictError(
          "Customer account evidence changed. Refresh before evaluating health.",
        );
      }
      // Native absence proof and current authority share one statement/snapshot.
      // A revoked RLS view must not hide an earlier acceptance and turn it into
      // a proven no-admission refusal. Keep legacy lookup behavior unchanged.
      const existingRows = nativeIntent ? await sql`
        SELECT revision.score_snapshot, revision.owner_actor_id,
          revision.request_intent, revision.request_sha256
        FROM omni_customer_accounts account
        JOIN omni_tenant_workspaces workspace ON workspace.tenant_id = account.tenant_id
          AND workspace.workspace_id = account.workspace_id AND workspace.state = 'active'
        JOIN omni_tenant_workspace_memberships membership ON membership.tenant_id = workspace.tenant_id
          AND membership.workspace_id = workspace.workspace_id AND membership.subject_kind = 'user'
          AND membership.subject_actor_id = ${authority.canonicalActorId} AND membership.state = 'active'
          AND membership.access_level IN ('contributor', 'manager')
        LEFT JOIN omni_customer_health_score_revisions revision ON revision.tenant_id = account.tenant_id
          AND revision.workspace_id = account.workspace_id AND revision.account_id = account.account_id
          AND revision.evaluation_id = ${input.evaluationId}
          AND revision.allowed_purpose_ids @> ARRAY['customer_success.account.read']::TEXT[]
        WHERE account.tenant_id = ${authority.tenantId} AND account.workspace_id = ${authority.workspaceId}
          AND account.account_id = ${input.accountId} AND account.owner_actor_id = ${authority.canonicalActorId}
          AND account.allowed_purpose_ids @> ARRAY['customer_success.account.manage']::TEXT[]
        LIMIT 2
      ` : await sql`
        SELECT score_snapshot, owner_actor_id, request_intent, request_sha256
        FROM omni_customer_health_score_revisions
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND account_id = ${input.accountId}
          AND evaluation_id = ${input.evaluationId}
        LIMIT 1
      `;
      if (nativeIntent && existingRows.length !== 1) {
        throw new CustomerAccountConflictError("Current workspace management authority is required.");
      }
      if (existingRows[0]?.score_snapshot) {
        const score = customerHealthScoreSchema.parse(existingRows[0].score_snapshot);
        const acceptance = nativeIntent ? storedHealthAcceptance(existingRows[0], nativeIntent) : null;
        if (nativeIntent && (!acceptance || acceptance.requestSha256 !== canonicalJsonSha256(nativeIntent))) {
          throw new CustomerAccountConflictError("This evaluation key has no matching exact accepted health intent.");
        }
        return { score, currentAccount: currentHealthAccount(account, acceptance), acceptance, replayed: true };
      }
      if (nativeIntent && (account.revision !== nativeIntent.request.expectedAccountRevision ||
        account.accountSha256 !== nativeIntent.request.expectedAccountSha256)) {
        throw healthRefusal(nativeIntent, "customer_health_account_changed", "The reviewed Account changed. Refresh it before evaluating health.");
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
      if (nativeIntent) {
        await requireNativeHealthMembership(sql, authority);
        if ((current?.revision ?? 0) >= CUSTOMER_HEALTH_REVISION_MAX) {
          throw healthRefusal(nativeIntent, "customer_health_revision_exhausted", "This health score cannot create another revision.");
        }
      }
      const factRows = await sql`
        SELECT fact_snapshot
        FROM (
          SELECT DISTINCT ON (fact_id COLLATE "C") fact_id, fact_snapshot
          FROM omni_customer_fact_revisions
          WHERE tenant_id = ${authority.tenantId}
            AND workspace_id = ${authority.workspaceId}
            AND account_id = ${input.accountId}
            AND allowed_purpose_ids @> ARRAY['customer_success.account.read']::TEXT[]
          ORDER BY fact_id COLLATE "C", revision DESC
        ) AS latest_readable_facts
        WHERE fact_snapshot->>'state' = 'active'
          AND fact_snapshot->'source'->'allowedPurposeIds' @> to_jsonb(ARRAY['customer_success.account.read']::TEXT[])
        ORDER BY fact_id COLLATE "C"
        LIMIT ${CUSTOMER_ACCOUNT_FACT_LIMIT + 1}
      `;
      // Select heads before filtering eligibility: a retracted latest revision
      // must not revive an older fact. The sentinel rejects incomplete evidence
      // before evaluation or any persisted score, policy, or event.
      if (factRows.length > CUSTOMER_ACCOUNT_FACT_LIMIT) {
        if (nativeIntent) throw healthRefusal(nativeIntent, "customer_health_projection_limit", "The Account exceeds the bounded health evidence projection.");
        throw new CustomerAccountProjectionLimitError();
      }
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
      const acceptance = nativeIntent ? buildCustomerHealthEvaluationAcceptance(nativeIntent, score) : null;
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
          coverage_basis_points, score_sha256, score_snapshot, evaluated_at,
          request_intent, request_sha256
        ) VALUES (
          ${authority.tenantId}, ${authority.workspaceId}, ${input.accountId},
          ${authority.canonicalActorId}, ${score.scoreId}, ${score.scoreRevisionId},
          ${score.revision}, ${score.evaluationId}, ${score.policy.policyId},
          ${["customer_success.account.read"]}, ${score.accountSha256},
          ${score.inputSha256}, ${score.scoreBasisPoints}, ${score.status},
          ${score.confidenceBasisPoints}, ${score.coverageBasisPoints},
          ${score.scoreSha256}, ${score}::JSONB, ${score.evaluatedAt},
          ${nativeIntent ?? null}::JSONB, ${nativeIntent ? canonicalJsonSha256(nativeIntent) : null}
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
          ...(nativeIntent ? { evaluationId: nativeIntent.evaluationId, requestSha256: canonicalJsonSha256(nativeIntent) } : {}),
        },
      }, { sql });
      return { score, currentAccount: currentHealthAccount(account, acceptance), acceptance, replayed: false };
    }) as Promise<HealthEvaluationOutcome>,
  );
}

/** Native intent admission retains the reviewed request independently of evaluated evidence. */
export async function submitCustomerHealthEvaluation(input: {
  authority: CustomerAccountMutationAuthority; accountId: string; request: CustomerHealthEvaluationRequest;
}): Promise<{ currentAccount: CustomerHealthEvaluationCurrentAccount; acceptance: CustomerHealthEvaluationAcceptance; replayed: boolean }> {
  assertNativeHealthAuthority(input.authority, input.accountId, true);
  const intent = buildCustomerHealthEvaluationIntent({ ...input.authority, accountId: input.accountId, request: input.request });
  const result = await evaluateHealthTransaction({
    authority: input.authority, accountId: intent.accountId,
    expectedAccountRevision: intent.request.expectedAccountRevision, expectedAccountSha256: intent.request.expectedAccountSha256,
    evaluationId: intent.evaluationId, suggestions: [],
  }, intent);
  if (!result.acceptance) throw new Error("Native health admission did not produce an exact acceptance.");
  return { currentAccount: result.currentAccount, acceptance: result.acceptance, replayed: result.replayed };
}

/** One scoped statement binds the current readable owner/pin to one historical evaluation. */
export async function readCustomerHealthEvaluationAcceptance(authority: CustomerAccountReadAuthority, input: {
  accountId: string; evaluationId: string;
}): Promise<{ currentAccount: CustomerHealthEvaluationCurrentAccount; acceptance: CustomerHealthEvaluationAcceptance | null }> {
  assertNativeHealthAuthority(authority, input.accountId, false);
  customerHealthEvaluationIdSchema.parse(input.evaluationId);
  requireDatabase(); await ensureDatabaseSchema();
  return runWithDatabaseActorScope(authority.tenantId, [authority.canonicalActorId], async () => {
    const rows = await getSql()`
      SELECT account.account_snapshot, revision.score_snapshot, revision.owner_actor_id,
        revision.request_intent, revision.request_sha256
      FROM omni_customer_accounts account
      JOIN omni_tenant_workspaces workspace ON workspace.tenant_id = account.tenant_id
        AND workspace.workspace_id = account.workspace_id AND workspace.state = 'active'
      JOIN omni_tenant_workspace_memberships membership ON membership.tenant_id = workspace.tenant_id
        AND membership.workspace_id = workspace.workspace_id AND membership.subject_kind = 'user'
        AND membership.subject_actor_id = ${authority.canonicalActorId} AND membership.state = 'active'
        AND membership.access_level IN ('reader', 'contributor', 'manager')
      LEFT JOIN omni_customer_health_score_revisions revision ON revision.tenant_id = account.tenant_id
        AND revision.workspace_id = account.workspace_id AND revision.account_id = account.account_id
        AND revision.owner_actor_id = ${authority.canonicalActorId} AND revision.evaluation_id = ${input.evaluationId}
        AND revision.allowed_purpose_ids @> ARRAY['customer_success.account.read']::TEXT[]
      WHERE account.tenant_id = ${authority.tenantId} AND account.workspace_id = ${authority.workspaceId}
        AND account.account_id = ${input.accountId} AND account.owner_actor_id = ${authority.canonicalActorId}
        AND account.allowed_purpose_ids @> ARRAY['customer_success.account.read']::TEXT[]
      LIMIT 2
    `;
    if (rows.length !== 1) throw new CustomerAccountNotFoundError();
    const account = customerAccountRevisionSchema.parse(rows[0].account_snapshot);
    if (account.ownerActorId !== authority.canonicalActorId || account.tenantId !== authority.tenantId ||
      account.workspaceId !== authority.workspaceId || account.accountId !== input.accountId) throw new CustomerAccountNotFoundError();
    const acceptance = rows[0].score_snapshot ? storedHealthAcceptance(rows[0], { ...authority, ...input }) : null;
    return { currentAccount: currentHealthAccount(account, acceptance), acceptance };
  });
}

function healthRefusal(intent: CustomerHealthEvaluationIntent, code: CustomerHealthEvaluationRefusedError["code"], message: string) {
  return new CustomerHealthEvaluationRefusedError({ code, message, evaluationId: intent.evaluationId, requestSha256: canonicalJsonSha256(intent) });
}

function storedHealthAcceptance(row: Record<string, unknown>, expected: {
  tenantId: string; workspaceId: string; accountId: string; evaluationId: string; canonicalActorId: string;
}) {
  if (row.request_intent === null && row.request_sha256 === null) return null;
  const stored = customerHealthEvaluationIntentSchema.safeParse(row.request_intent);
  if (!stored.success || row.request_sha256 !== canonicalJsonSha256(stored.data) || row.owner_actor_id !== expected.canonicalActorId ||
    stored.data.tenantId !== expected.tenantId || stored.data.workspaceId !== expected.workspaceId || stored.data.accountId !== expected.accountId ||
    stored.data.evaluationId !== expected.evaluationId || stored.data.canonicalActorId !== expected.canonicalActorId) {
    throw new CustomerAccountConflictError("This evaluation has no valid exact native acceptance for the current owner.");
  }
  return buildCustomerHealthEvaluationAcceptance(stored.data, customerHealthScoreSchema.parse(row.score_snapshot));
}

function currentHealthAccount(account: CustomerAccountRevision, acceptance: CustomerHealthEvaluationAcceptance | null) {
  const current = customerHealthEvaluationCurrentAccountSchema.parse({
    accountId: account.accountId, revisionId: account.revisionId, revision: account.revision, accountSha256: account.accountSha256,
  });
  if (acceptance && (current.revision < acceptance.accountRevision ||
    (current.revision === acceptance.accountRevision && current.accountSha256 !== acceptance.accountSha256))) {
    throw new CustomerAccountConflictError("Current Account lineage conflicts with its accepted health evaluation.");
  }
  return current;
}

async function requireNativeHealthMembership(sql: CustomerHealthSql, authority: CustomerAccountMutationAuthority) {
  // Recheck after the health/account or score-head lock wait. Authority tables
  // remain SELECT-only; denied visibility is not proof of absent acceptance.
  const rows = await sql`SELECT membership.access_level FROM omni_tenant_workspaces workspace
    JOIN omni_tenant_workspace_memberships membership ON membership.tenant_id = workspace.tenant_id
      AND membership.workspace_id = workspace.workspace_id AND membership.subject_kind = 'user'
      AND membership.subject_actor_id = ${authority.canonicalActorId} AND membership.state = 'active'
      AND membership.access_level IN ('contributor', 'manager')
    WHERE workspace.tenant_id = ${authority.tenantId} AND workspace.workspace_id = ${authority.workspaceId}
      AND workspace.state = 'active' LIMIT 2`;
  if (rows.length !== 1) throw new CustomerAccountConflictError("Current workspace management authority is required.");
}

function assertNativeHealthAuthority(authority: CustomerAccountReadAuthority | CustomerAccountMutationAuthority, accountId: string, mutation: boolean) {
  if (!/^customer-account:[a-f0-9]{64}$/.test(accountId) ||
    !/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(authority.canonicalActorId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(authority.tenantId) ||
    !/^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(authority.workspaceId) || authority.workspaceId.length > 240 ||
    authority.readableActorIds.length !== 1 || authority.readableActorIds[0] !== authority.canonicalActorId ||
    authority.purposeId !== (mutation ? "customer_success.account.manage" : "customer_success.account.read")) {
    throw new CustomerAccountConflictError("Current canonical Account health authority is required.");
  }
  if (mutation) {
    const value = authority as CustomerAccountMutationAuthority, scope = parsePersistedExecutionScope(value.executionScope);
    if (!scope || scope.tenantId !== authority.tenantId || scope.workspaceId !== authority.workspaceId ||
      scope.initiatingActorId !== authority.canonicalActorId || scope.executingPrincipalType !== "user" ||
      scope.executingPrincipalId !== authority.canonicalActorId || scope.purpose !== "customer.health.evaluate" ||
      scope.causationId !== accountId || scope.projectId !== null || scope.missionId !== null || scope.delegationId !== null ||
      scope.contextGrantIds.length !== 0 || scope.capabilityGrantIds.length !== 0) {
      throw new CustomerAccountConflictError("Current direct user health evaluation authority is required.");
    }
  }
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
