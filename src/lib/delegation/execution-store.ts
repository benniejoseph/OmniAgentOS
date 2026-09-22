import { createHash } from "node:crypto";

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
const DELEGATION_CANCELLATION_MESSAGE = "Canceled by the operator.";

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

export class DelegationExecutionNotFoundError extends Error {
  readonly code = "delegation_execution_not_found";

  constructor(message = "Delegation execution was not found.") {
    super(message);
    this.name = "DelegationExecutionNotFoundError";
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

/**
 * Cancels one active V2 execution, its exact child run, and its matching queue
 * delivery in one actor-scoped transaction. The expected lifecycle revision
 * and request/idempotency digests make retries exact without persisting raw
 * request content or keys.
 */
export async function cancelDelegationExecution(input: {
  tenantId: string;
  ownerActorId: string;
  executionId: string;
  expectedRevision: number;
  requestSha256: string;
  idempotencyKeySha256: string;
  executionScope: ExecutionScope;
  at?: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertSha256(input.requestSha256, "cancellation request");
  assertSha256(input.idempotencyKeySha256, "cancellation idempotency key");
  return runWithDatabaseActorScope(
    input.tenantId,
    [input.ownerActorId],
    () => getSql().transaction(async (sql: DelegationExecutionSql) => {
      const current = await readDelegationExecution(
        sql,
        input.tenantId,
        input.executionId,
        true,
        true,
      );
      if (!current || current.ownerActorId !== input.ownerActorId) {
        throw new DelegationExecutionNotFoundError();
      }
      assertCancellationScope(current, input.executionScope);
      const reason = cancellationTransitionReason(input);
      const detailSha256 = canonicalJsonSha256({ to: "canceled", reason });

      const run = await lockDelegationChildRun(sql, current);
      const job = await lockDelegationDelivery(sql, current);
      if (current.state === "canceled") {
        if (
          input.expectedRevision !== current.lifecycleRevision - 1 ||
          run.status !== "canceled" ||
          (job && job.status !== "canceled") ||
          !await hasExactCancellationEvent(sql, current, detailSha256)
        ) {
          throw new DelegationExecutionConflictError(
            "Delegation cancellation retry does not match the committed transition.",
          );
        }
        return Object.freeze({
          execution: current,
          canceledChildRun: false,
          canceledDeliveryCount: 0,
          idempotent: true,
        });
      }
      if (!["queued", "running", "waiting"].includes(current.state)) {
        throw new DelegationExecutionConflictError(
          "Delegation execution is no longer cancellable.",
        );
      }
      if (current.lifecycleRevision !== input.expectedRevision) {
        throw new DelegationExecutionConflictError();
      }
      if (["completed", "failed"].includes(run.status)) {
        throw new DelegationExecutionConflictError(
          "Delegation child run already reached a terminal result.",
        );
      }
      if (job && ["completed", "failed"].includes(job.status)) {
        throw new DelegationExecutionConflictError(
          "Delegation delivery already reached a terminal result.",
        );
      }

      const at = input.at || new Date().toISOString();
      const { record: next, event } = transitionDelegationExecutionRecordV1({
        record: current,
        transition: { to: "canceled", reason },
        at,
      });
      const executionRows = await sql`
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
          AND owner_actor_id = ${next.ownerActorId}
          AND execution_id = ${next.executionId}
          AND contract_sha256 = ${next.contractSha256}
          AND child_run_id = ${next.childRunId}
          AND state = ${current.state}
          AND lifecycle_revision = ${current.lifecycleRevision}
        RETURNING *
      `;
      if (executionRows.length !== 1) throw new DelegationExecutionConflictError();

      let canceledChildRun = false;
      if (run.status !== "canceled") {
        const runRows = await sql`
          UPDATE omni_agent_runs
          SET status = 'canceled', response = NULL, grounding = NULL,
              error = ${DELEGATION_CANCELLATION_MESSAGE}, continuation = NULL,
              completed_at = ${next.updatedAt}
          WHERE tenant_id = ${next.tenantId}
            AND owner_actor_id = ${next.ownerActorId}
            AND id = ${next.childRunId}
            AND agent_id = ${next.delegateAgentId}
            AND status = ${run.status}
            AND status NOT IN ('completed', 'failed', 'canceled')
          RETURNING id
        `;
        if (runRows.length !== 1) {
          throw new DelegationExecutionConflictError(
            "Delegation child run changed during cancellation.",
          );
        }
        canceledChildRun = true;
        await appendDelegationChildRunCancellationEvent(
          sql,
          next,
          input.executionScope,
          input.requestSha256,
        );
      }

      let canceledDeliveryCount = 0;
      if (job && job.status !== "canceled") {
        const jobRows = await sql`
          UPDATE omni_operation_jobs
          SET status = 'canceled', locked_at = NULL, lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = 'Delegation canceled by the operator.',
              completed_at = ${next.updatedAt}, updated_at = ${next.updatedAt}
          WHERE tenant_id = ${next.tenantId}
            AND id = ${job.id}
            AND type = 'agent.execute'
            AND status = ${job.status}
            AND status IN ('queued', 'running')
            AND payload ->> 'kind' = 'delegation_execution_v2'
            AND payload ->> 'executionId' = ${next.executionId}
            AND payload ->> 'contractSha256' = ${next.contractSha256}
          RETURNING id
        `;
        if (jobRows.length !== 1) {
          throw new DelegationExecutionConflictError(
            "Delegation delivery changed during cancellation.",
          );
        }
        canceledDeliveryCount = 1;
      }
      await appendDelegationExecutionEvent(
        sql,
        event,
        input.executionScope,
        current.contract,
      );
      return Object.freeze({
        execution: executionFromRow(executionRows[0]),
        canceledChildRun,
        canceledDeliveryCount,
        idempotent: false,
      });
    }) as Promise<Readonly<{
      execution: DelegationExecutionRecordV1;
      canceledChildRun: boolean;
      canceledDeliveryCount: number;
      idempotent: boolean;
    }>>,
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

export async function findDelegationExecution(input: {
  tenantId: string;
  ownerActorId: string;
  executionId: string;
}) {
  if (!delegationExecutionPersistenceAvailable()) return undefined;
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
        true,
      );
      return record?.ownerActorId === input.ownerActorId ? record : undefined;
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

function assertCancellationScope(
  record: DelegationExecutionRecordV1,
  scope: ExecutionScope,
) {
  if (
    scope.tenantId !== record.tenantId ||
    scope.initiatingActorId !== record.ownerActorId ||
    scope.delegationId !== null
  ) {
    throw new DelegationExecutionConflictError(
      "Delegation cancellation is outside its tenant, owner, or root authority.",
    );
  }
  const ownerControl =
    scope.executingPrincipalType === "user" &&
    scope.executingPrincipalId === record.ownerActorId &&
    record.contract.cancellation.allowedInitiators.includes("owner");
  const parentControl =
    scope.executingPrincipalType === "agent" &&
    scope.executingPrincipalId === record.contract.lineage.parentPrincipalId &&
    record.contract.cancellation.allowedInitiators.includes("parent") &&
    scope.correlationId === record.rootExecutionId &&
    scope.workspaceId === record.contract.lineage.workspaceId &&
    scope.projectId === record.contract.lineage.projectId &&
    scope.missionId === record.contract.lineage.workItemId;
  if (!ownerControl && !parentControl) {
    throw new DelegationExecutionConflictError(
      "Only the exact owner or parent Agent authority may cancel a child.",
    );
  }
}

async function lockDelegationChildRun(
  sql: DelegationExecutionSql,
  record: DelegationExecutionRecordV1,
) {
  const rows = await sql`
    SELECT id, tenant_id, owner_actor_id, agent_id, status
    FROM omni_agent_runs
    WHERE tenant_id = ${record.tenantId}
      AND owner_actor_id = ${record.ownerActorId}
      AND id = ${record.childRunId}
      AND agent_id = ${record.delegateAgentId}
    LIMIT 1 FOR UPDATE
  `;
  if (rows.length !== 1) {
    throw new DelegationExecutionConflictError(
      "Delegation child run identity could not be fenced.",
    );
  }
  const status = String(rows[0].status);
  if (![
    "queued",
    "running",
    "waiting_clarification",
    "waiting_approval",
    "resuming",
    "completed",
    "failed",
    "canceled",
  ].includes(status)) {
    throw new DelegationExecutionConflictError(
      "Delegation child run state is unsupported.",
    );
  }
  return Object.freeze({ id: String(rows[0].id), status });
}

async function lockDelegationDelivery(
  sql: DelegationExecutionSql,
  record: DelegationExecutionRecordV1,
) {
  const rows = await sql`
    SELECT id, status
    FROM omni_operation_jobs
    WHERE tenant_id = ${record.tenantId}
      AND type = 'agent.execute'
      AND payload ->> 'kind' = 'delegation_execution_v2'
      AND payload ->> 'executionId' = ${record.executionId}
      AND payload ->> 'runId' = ${record.childRunId}
      AND payload ->> 'contractSha256' = ${record.contractSha256}
    ORDER BY created_at ASC
    FOR UPDATE
  `;
  if (rows.length > 1) {
    throw new DelegationExecutionConflictError(
      "Delegation execution has more than one canonical delivery.",
    );
  }
  if (!rows[0]) return undefined;
  const status = String(rows[0].status);
  if (!["queued", "running", "completed", "failed", "canceled"].includes(status)) {
    throw new DelegationExecutionConflictError(
      "Delegation delivery state is unsupported.",
    );
  }
  return Object.freeze({ id: String(rows[0].id), status });
}

async function hasExactCancellationEvent(
  sql: DelegationExecutionSql,
  record: DelegationExecutionRecordV1,
  detailSha256: string,
) {
  const rows = await sql`
    SELECT id
    FROM omni_events
    WHERE tenant_id = ${record.tenantId}
      AND actor_id = ${record.ownerActorId}
      AND stream_id = ${`delegation-execution:${record.delegationId}`}
      AND type = 'delegation.execution.canceled'
      AND payload ->> 'executionId' = ${record.executionId}
      AND payload ->> 'detailSha256' = ${detailSha256}
      AND (payload ->> 'lifecycleRevision')::bigint = ${record.lifecycleRevision}
    LIMIT 1
  `;
  return rows.length === 1;
}

async function appendDelegationChildRunCancellationEvent(
  sql: DelegationExecutionSql,
  record: DelegationExecutionRecordV1,
  authorityScope: ExecutionScope,
  requestSha256: string,
) {
  const receipt = Object.freeze({
    schemaVersion: 1 as const,
    version: "delegation-child-run-cancellation:1" as const,
    executionId: record.executionId,
    childRunId: record.childRunId,
    delegationId: record.delegationId,
    lifecycleRevision: record.lifecycleRevision,
    requestSha256,
    at: record.updatedAt,
  });
  const receiptSha256 = canonicalJsonSha256(receipt);
  const eventScope = deriveExecutionScope(authorityScope, {
    causationId: `delegation-child-run-cancel:${receiptSha256}`,
    purpose: "delegation.child_run.canceled.v1",
  });
  await appendScopedDomainEvent({
    id: `delegation-child-run-domain-event:${receiptSha256}`,
    streamId: `run:${record.childRunId}`,
    type: "run.canceled",
    payload: {
      schemaVersion: 1,
      type: "canceled",
      messageLength: DELEGATION_CANCELLATION_MESSAGE.length,
      messageSha256: createHash("sha256")
        .update(DELEGATION_CANCELLATION_MESSAGE)
        .digest("hex"),
      source: "delegation_execution_v2",
      ...receipt,
      receiptSha256,
    },
    executionScope: eventScope,
  }, { sql });
  await sql`
    INSERT INTO omni_agent_events (
      id, tenant_id, run_id, type, payload, created_at
    ) VALUES (
      ${`delegation-child-run-event:${receiptSha256}`}, ${record.tenantId},
      ${record.childRunId}, 'canceled',
      ${{ type: "canceled", message: DELEGATION_CANCELLATION_MESSAGE }}::jsonb,
      ${record.updatedAt}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

function cancellationTransitionReason(input: {
  requestSha256: string;
  idempotencyKeySha256: string;
}) {
  return `request:${input.requestSha256}:idempotency:${input.idempotencyKeySha256}`;
}

function assertSha256(value: string, label: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new DelegationExecutionConflictError(
      `Delegation ${label} digest is invalid.`,
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
