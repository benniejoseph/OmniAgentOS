import type { DelegationExecutionContractV2 } from "@/lib/delegation/execution-contract";
import {
  buildDelegationExecutionRecordV1,
  initialDelegationExecutionEventV1,
  parseDelegationExecutionRecordV1,
  transitionDelegationExecutionRecordV1,
  zeroDelegationBudgetReservation,
  type DelegationExecutionEventV1,
  type DelegationExecutionRecordV1,
  type DelegationExecutionTransition,
} from "@/lib/delegation/execution-record";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  createRunBudgetState,
  reserveRunBudget,
  runBudgetCountersV1Schema,
  type RunBudgetCountersV1,
} from "@/lib/runs/budgets";
import {
  deriveExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type DelegationExecutionSql = ReturnType<typeof getSql>;

export class DelegationExecutionConflictError extends Error {
  readonly code = "delegation_execution_conflict";

  constructor(message = "The delegation execution changed. Refresh and try again.") {
    super(message);
    this.name = "DelegationExecutionConflictError";
  }
}

export class DelegationExecutionUnavailableError extends Error {
  readonly code = "delegation_execution_unavailable";

  constructor(message = "Delegation executions require the canonical database authority.") {
    super(message);
    this.name = "DelegationExecutionUnavailableError";
  }
}

/**
 * Atomically reserves a non-refundable slice of the root run budget and
 * persists the immutable child execution envelope. Retrying an identical
 * contract is idempotent and never reserves the budget twice.
 */
export async function createDelegationExecution(input: {
  contract: DelegationExecutionContractV2;
  parentExecutionScope: ExecutionScope;
  rootBudgetLimits: RunBudgetCountersV1;
  compatibilityTaskId?: string | null;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertParentScope(input.contract, input.parentExecutionScope);
  const ownerActorId = requiredActor(input.parentExecutionScope);
  const rootBudgetLimits = runBudgetCountersV1Schema.parse(input.rootBudgetLimits);
  return runWithDatabaseActorScope(
    input.contract.lineage.tenantId,
    [ownerActorId],
    () => getSql().transaction(async (sql: DelegationExecutionSql) => {
      const existing = await readDelegationExecution(
        sql,
        input.contract.lineage.tenantId,
        input.contract.delegateIdentity.runId,
        false,
        true,
      );
      if (existing) {
        if (
          existing.contractSha256 !== input.contract.contractSha256 ||
          existing.ownerActorId !== ownerActorId
        ) {
          throw new DelegationExecutionConflictError(
            "Delegation execution ID is already bound to another authority envelope.",
          );
        }
        return existing;
      }

      const now = input.contract.deadline.createdAt;
      const limitsSha256 = canonicalJsonSha256(rootBudgetLimits);
      await sql`
        INSERT INTO omni_delegation_budget_ledgers (
          tenant_id, owner_actor_id, root_execution_id, limits,
          limits_sha256, reserved, lifecycle_revision, created_at, updated_at
        ) VALUES (
          ${input.contract.lineage.tenantId}, ${ownerActorId},
          ${input.contract.lineage.rootExecutionId}, ${rootBudgetLimits}::jsonb,
          ${limitsSha256}, ${zeroDelegationBudgetReservation()}::jsonb,
          0, ${now}, ${now}
        )
        ON CONFLICT (tenant_id, owner_actor_id, root_execution_id) DO NOTHING
      `;
      const ledgerRows = await sql`
        SELECT limits, limits_sha256, reserved, lifecycle_revision, updated_at
        FROM omni_delegation_budget_ledgers
        WHERE tenant_id = ${input.contract.lineage.tenantId}
          AND owner_actor_id = ${ownerActorId}
          AND root_execution_id = ${input.contract.lineage.rootExecutionId}
        LIMIT 1 FOR UPDATE
      `;
      if (ledgerRows.length !== 1) {
        throw new DelegationExecutionConflictError(
          "Delegation root budget ledger could not be acquired.",
        );
      }
      const ledger = ledgerRows[0];
      const persistedLimits = runBudgetCountersV1Schema.parse(ledger.limits);
      const reserved = runBudgetCountersV1Schema.parse(ledger.reserved);
      if (
        String(ledger.limits_sha256) !== limitsSha256 ||
        canonicalJsonSha256(persistedLimits) !== limitsSha256
      ) {
        throw new DelegationExecutionConflictError(
          "Delegation root budget authority changed after the first allocation.",
        );
      }
      const reservation = delegationRootBudgetReservation(input.contract.budgets);
      const nextBudget = reserveRunBudget(
        createRunBudgetState(persistedLimits, {
          used: reserved,
          startedAt: now,
        }),
        reservation,
        Date.parse(now),
      );
      const previousRevision = Number(ledger.lifecycle_revision);
      const budgetRows = await sql`
        UPDATE omni_delegation_budget_ledgers
        SET reserved = ${nextBudget.used}::jsonb,
            lifecycle_revision = ${previousRevision + 1},
            updated_at = ${now}
        WHERE tenant_id = ${input.contract.lineage.tenantId}
          AND owner_actor_id = ${ownerActorId}
          AND root_execution_id = ${input.contract.lineage.rootExecutionId}
          AND lifecycle_revision = ${previousRevision}
        RETURNING lifecycle_revision
      `;
      if (budgetRows.length !== 1) {
        throw new DelegationExecutionConflictError(
          "Delegation root budget reservation raced with another child.",
        );
      }
      const record = buildDelegationExecutionRecordV1({
        contract: input.contract,
        budgetLedgerRevision: Number(budgetRows[0].lifecycle_revision),
        compatibilityTaskId: input.compatibilityTaskId,
      });
      const rows = await sql`
        INSERT INTO omni_delegation_executions (
          tenant_id, execution_id, owner_actor_id, root_execution_id,
          parent_execution_id, child_run_id, delegation_id,
          compatibility_task_id, contract_id, contract_sha256,
          context_capsule_id, context_capsule_sha256, delegate_agent_id,
          delegate_principal_id, runtime_assignment_id,
          runtime_assignment_sha256, mode, budget_limits,
          budget_limits_sha256, budget_ledger_revision, state,
          lifecycle_revision, contract, context_capsule, runtime_assignment,
          result, result_sha256, verification, verification_sha256,
          failure_code, created_at, accept_by, complete_by, updated_at,
          terminal_at
        ) VALUES (
          ${record.tenantId}, ${record.executionId}, ${record.ownerActorId},
          ${record.rootExecutionId}, ${record.parentExecutionId},
          ${record.childRunId}, ${record.delegationId},
          ${record.compatibilityTaskId}, ${record.contractId},
          ${record.contractSha256}, ${record.contextCapsuleId},
          ${record.contextCapsuleSha256}, ${record.delegateAgentId},
          ${record.delegatePrincipalId}, ${record.runtimeAssignmentId},
          ${record.runtimeAssignmentSha256}, ${record.mode},
          ${record.budgetLimits}::jsonb, ${record.budgetLimitsSha256},
          ${record.budgetLedgerRevision}, ${record.state},
          ${record.lifecycleRevision}, ${record.contract}::jsonb,
          ${record.contract.contextCapsule}::jsonb,
          ${record.contract.runtimeAssignment}::jsonb, NULL, NULL, NULL,
          NULL, NULL, ${record.createdAt}, ${record.acceptBy},
          ${record.completeBy}, ${record.updatedAt}, NULL
        )
        RETURNING *
      `;
      if (rows.length !== 1) {
        throw new DelegationExecutionConflictError(
          "Delegation execution could not be persisted.",
        );
      }
      await appendDelegationExecutionEvent(
        sql,
        initialDelegationExecutionEventV1(record),
        input.parentExecutionScope,
        input.contract,
      );
      return executionFromRow(rows[0]);
    }) as Promise<DelegationExecutionRecordV1>,
  );
}

export async function transitionDelegationExecution(input: {
  tenantId: string;
  executionId: string;
  expectedRevision: number;
  transition: DelegationExecutionTransition;
  executionScope: ExecutionScope;
  at?: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const ownerActorId = requiredActor(input.executionScope);
  return runWithDatabaseActorScope(
    input.tenantId,
    [ownerActorId],
    () => getSql().transaction(async (sql: DelegationExecutionSql) => {
      const current = await readDelegationExecution(
        sql,
        input.tenantId,
        input.executionId,
        true,
      );
      if (!current) {
        throw new DelegationExecutionConflictError(
          "Delegation execution was not found.",
        );
      }
      assertTransitionScope(current, input.executionScope, input.transition);
      if (current.lifecycleRevision !== input.expectedRevision) {
        throw new DelegationExecutionConflictError();
      }
      const { record: next, event } = transitionDelegationExecutionRecordV1({
        record: current,
        transition: input.transition,
        at: input.at,
      });
      const rows = await sql`
        UPDATE omni_delegation_executions
        SET state = ${next.state},
            lifecycle_revision = ${next.lifecycleRevision},
            result = ${next.result}::jsonb,
            result_sha256 = ${next.resultSha256},
            verification = ${next.verification}::jsonb,
            verification_sha256 = ${next.verificationSha256},
            failure_code = ${next.failureCode},
            updated_at = ${next.updatedAt},
            terminal_at = ${next.terminalAt}
        WHERE tenant_id = ${next.tenantId}
          AND execution_id = ${next.executionId}
          AND state = ${current.state}
          AND lifecycle_revision = ${current.lifecycleRevision}
        RETURNING *
      `;
      if (rows.length !== 1) throw new DelegationExecutionConflictError();
      await appendDelegationExecutionEvent(
        sql,
        event,
        input.executionScope,
        current.contract,
      );
      return executionFromRow(rows[0]);
    }) as Promise<DelegationExecutionRecordV1>,
  );
}

export async function getDelegationExecution(input: {
  tenantId: string;
  ownerActorId: string;
  executionId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    input.tenantId,
    [input.ownerActorId],
    async () => {
      const record = await readDelegationExecution(
        getSql(),
        input.tenantId,
        input.executionId,
        false,
      );
      if (!record || record.ownerActorId !== input.ownerActorId) {
        throw new DelegationExecutionConflictError(
          "Delegation execution was not found.",
        );
      }
      return record;
    },
  );
}

export async function listDelegationExecutions(input: {
  tenantId: string;
  ownerActorId: string;
  parentExecutionId?: string;
  limit?: number;
}) {
  if (!delegationExecutionPersistenceAvailable()) return [];
  await ensureDatabaseSchema();
  const limit = Math.min(Math.max(input.limit || 60, 1), 100);
  return runWithDatabaseActorScope(
    input.tenantId,
    [input.ownerActorId],
    async () => {
      const rows = input.parentExecutionId
        ? await getSql()`
            SELECT * FROM omni_delegation_executions
            WHERE tenant_id = ${input.tenantId}
              AND owner_actor_id = ${input.ownerActorId}
              AND parent_execution_id = ${input.parentExecutionId}
            ORDER BY updated_at DESC, execution_id ASC
            LIMIT ${limit}
          `
        : await getSql()`
            SELECT * FROM omni_delegation_executions
            WHERE tenant_id = ${input.tenantId}
              AND owner_actor_id = ${input.ownerActorId}
            ORDER BY updated_at DESC, execution_id ASC
            LIMIT ${limit}
          `;
      return rows.map(executionFromRow);
    },
  );
}

export function delegationExecutionPersistenceAvailable() {
  return hasDatabaseUrl();
}

export function delegationRootBudgetReservation(
  child: RunBudgetCountersV1,
): RunBudgetCountersV1 {
  const parsed = runBudgetCountersV1Schema.parse(child);
  return runBudgetCountersV1Schema.parse({
    ...parsed,
    agents: Math.max(1, parsed.agents),
    fanOut: 1,
  });
}

async function readDelegationExecution(
  sql: DelegationExecutionSql,
  tenantId: string,
  executionId: string,
  forUpdate = false,
  optional = false,
) {
  const rows = forUpdate
    ? await sql`
        SELECT * FROM omni_delegation_executions
        WHERE tenant_id = ${tenantId} AND execution_id = ${executionId}
        LIMIT 1 FOR UPDATE
      `
    : await sql`
        SELECT * FROM omni_delegation_executions
        WHERE tenant_id = ${tenantId} AND execution_id = ${executionId}
        LIMIT 1
      `;
  if (!rows[0]) {
    if (optional) return undefined;
    throw new DelegationExecutionConflictError(
      "Delegation execution was not found.",
    );
  }
  return executionFromRow(rows[0]);
}

function executionFromRow(row: Record<string, unknown>) {
  const contract = row.contract as DelegationExecutionContractV2;
  if (
    canonicalJsonSha256(row.context_capsule) !== canonicalJsonSha256(contract.contextCapsule) ||
    canonicalJsonSha256(row.runtime_assignment) !== canonicalJsonSha256(contract.runtimeAssignment)
  ) {
    throw new DelegationExecutionConflictError(
      "Delegation execution envelope columns do not match the immutable contract.",
    );
  }
  return parseDelegationExecutionRecordV1({
    schemaVersion: Number(row.schema_version),
    version: "delegation-execution-record:1",
    tenantId: String(row.tenant_id),
    executionId: String(row.execution_id),
    ownerActorId: String(row.owner_actor_id),
    rootExecutionId: String(row.root_execution_id),
    parentExecutionId: String(row.parent_execution_id),
    childRunId: String(row.child_run_id),
    delegationId: String(row.delegation_id),
    compatibilityTaskId: row.compatibility_task_id
      ? String(row.compatibility_task_id)
      : null,
    contractId: String(row.contract_id),
    contractSha256: String(row.contract_sha256),
    contextCapsuleId: String(row.context_capsule_id),
    contextCapsuleSha256: String(row.context_capsule_sha256),
    delegateAgentId: String(row.delegate_agent_id),
    delegatePrincipalId: String(row.delegate_principal_id),
    runtimeAssignmentId: String(row.runtime_assignment_id),
    runtimeAssignmentSha256: String(row.runtime_assignment_sha256),
    mode: String(row.mode),
    budgetLimits: row.budget_limits,
    budgetLimitsSha256: String(row.budget_limits_sha256),
    budgetLedgerRevision: Number(row.budget_ledger_revision),
    state: String(row.state),
    lifecycleRevision: Number(row.lifecycle_revision),
    contract,
    result: row.result || null,
    resultSha256: row.result_sha256 ? String(row.result_sha256) : null,
    verification: row.verification || null,
    verificationSha256: row.verification_sha256
      ? String(row.verification_sha256)
      : null,
    failureCode: row.failure_code ? String(row.failure_code) : null,
    createdAt: asTimestamp(row.created_at),
    acceptBy: asTimestamp(row.accept_by),
    completeBy: asTimestamp(row.complete_by),
    updatedAt: asTimestamp(row.updated_at),
    terminalAt: row.terminal_at ? asTimestamp(row.terminal_at) : null,
  });
}

function appendDelegationExecutionEvent(
  sql: DelegationExecutionSql,
  event: DelegationExecutionEventV1,
  authorityScope: ExecutionScope,
  contract: DelegationExecutionContractV2,
) {
  const executionScope = deriveExecutionScope(authorityScope, {
    causationId: event.eventId,
    purpose: `delegation.execution.${event.to}.v1`,
  });
  return appendScopedDomainEvent({
    id: event.eventId,
    streamId: `delegation-execution:${event.delegationId}`,
    type: `delegation.execution.${event.to}`,
    payload: {
      schemaVersion: event.schemaVersion,
      version: event.version,
      eventSha256: event.eventSha256,
      executionId: event.executionId,
      delegationId: event.delegationId,
      rootExecutionId: event.rootExecutionId,
      parentExecutionId: event.parentExecutionId,
      childRunId: event.childRunId,
      delegateAgentId: event.delegateAgentId,
      from: event.from,
      to: event.to,
      lifecycleRevision: event.lifecycleRevision,
      detailSha256: event.detailSha256,
      contractSha256: contract.contractSha256,
      contextCapsuleSha256: contract.contextCapsule.capsuleSha256,
      runtimeAssignmentSha256: contract.runtimeAssignment.assignmentSha256,
      at: event.at,
    },
    executionScope,
  }, { sql });
}

function assertParentScope(
  contract: DelegationExecutionContractV2,
  scope: ExecutionScope,
) {
  if (
    scope.tenantId !== contract.lineage.tenantId ||
    scope.initiatingActorId !== contract.lineage.initiatingActorId ||
    scope.executingPrincipalType !== "agent" ||
    scope.executingPrincipalId !== contract.lineage.parentPrincipalId ||
    scope.delegationId !== null ||
    scope.correlationId !== contract.lineage.parentExecutionId ||
    scope.workspaceId !== contract.lineage.workspaceId ||
    scope.projectId !== contract.lineage.projectId
  ) {
    throw new DelegationExecutionConflictError(
      "Delegation execution does not match its parent run authority.",
    );
  }
}

function assertTransitionScope(
  record: DelegationExecutionRecordV1,
  scope: ExecutionScope,
  transition: DelegationExecutionTransition,
) {
  if (
    scope.tenantId !== record.tenantId ||
    scope.initiatingActorId !== record.ownerActorId ||
    scope.correlationId !== record.rootExecutionId
  ) {
    throw new DelegationExecutionConflictError(
      "Delegation transition is outside its tenant, owner, or root run.",
    );
  }
  const parentControl = ["verified", "rejected", "canceled", "expired"].includes(
    transition.to,
  );
  if (parentControl) {
    if (
      scope.executingPrincipalId !== record.contract.lineage.parentPrincipalId ||
      scope.delegationId !== null
    ) {
      throw new DelegationExecutionConflictError(
        "Only the parent authority may verify, reject, cancel, or expire a child.",
      );
    }
    return;
  }
  if (
    scope.executingPrincipalId !== record.delegatePrincipalId ||
    scope.delegationId !== record.delegationId
  ) {
    throw new DelegationExecutionConflictError(
      "Only the exact delegated principal may advance child execution.",
    );
  }
}

function requiredActor(scope: ExecutionScope) {
  const actorId = scope.initiatingActorId?.trim();
  if (!actorId) {
    throw new DelegationExecutionConflictError(
      "Delegation execution persistence requires an initiating actor.",
    );
  }
  return actorId;
}

function asTimestamp(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function requireDatabase() {
  if (!hasDatabaseUrl()) throw new DelegationExecutionUnavailableError();
}
