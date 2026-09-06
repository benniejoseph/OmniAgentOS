import type { DelegationContractV1 } from "@/lib/delegation/contracts";
import {
  buildDelegationTaskV1,
  initialDelegationTaskEventV1,
  parseDelegationTaskV1,
  transitionDelegationTaskV1,
  type DelegationTaskEventV1,
  type DelegationTaskTransition,
  type DelegationTaskV1,
} from "@/lib/delegation/lifecycle";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  deriveExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

type DelegationSql = ReturnType<typeof getSql>;

export class DelegationTaskConflictError extends Error {
  readonly code = "delegation_task_conflict";

  constructor(message = "The delegation task changed. Refresh and try again.") {
    super(message);
    this.name = "DelegationTaskConflictError";
  }
}

export class DelegationTaskUnavailableError extends Error {
  readonly code = "delegation_task_unavailable";

  constructor(message = "Delegation tasks require the canonical database authority.") {
    super(message);
    this.name = "DelegationTaskUnavailableError";
  }
}

export async function createDelegationTask(input: {
  contract: DelegationContractV1;
  parentExecutionScope: ExecutionScope;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertParentScope(input.contract, input.parentExecutionScope);
  const task = buildDelegationTaskV1(input.contract);
  const event = initialDelegationTaskEventV1(task);
  return getSql().transaction(async (sql: DelegationSql) => {
    const rows = await sql`
      INSERT INTO omni_delegation_tasks (
        tenant_id, task_id, owner_actor_id, parent_execution_id,
        parent_principal_id, parent_delegation_id, delegation_id,
        contract_id, contract_sha256, delegate_principal_id,
        delegate_agent_id, delegate_definition_version,
        verifier_agent_id, verifier_definition_version,
        state, lifecycle_revision, task, task_sha256,
        created_at, accept_by, complete_by, updated_at, terminal_at
      ) VALUES (
        ${task.tenantId}, ${task.taskId}, ${task.ownerActorId},
        ${task.parentExecutionId}, ${task.parentPrincipalId},
        ${task.parentDelegationId}, ${task.delegationId}, ${task.contractId},
        ${task.contractSha256}, ${task.delegatePrincipalId},
        ${task.delegateAgentId}, ${task.delegateDefinitionVersion},
        ${task.verifierAgentId}, ${task.verifierDefinitionVersion},
        ${task.state}, ${task.lifecycleRevision}, ${task}::jsonb,
        ${task.taskSha256}, ${task.createdAt}, ${task.acceptBy},
        ${task.completeBy}, ${task.updatedAt}, ${task.terminalAt}
      )
      ON CONFLICT (tenant_id, task_id) DO NOTHING
      RETURNING task
    `;
    if (rows[0]) {
      await appendDelegationEvent(sql, event, input.parentExecutionScope);
      return parseDelegationTaskV1(rows[0].task);
    }
    const existing = await readDelegationTask(sql, task.taskId, task.tenantId);
    if (existing.contractSha256 !== task.contractSha256) {
      throw new DelegationTaskConflictError(
        "Delegation task ID is already bound to another contract.",
      );
    }
    return existing;
  }) as Promise<DelegationTaskV1>;
}

export async function transitionDelegationTask(input: {
  taskId: string;
  tenantId: string;
  expectedRevision: number;
  transition: DelegationTaskTransition;
  parentExecutionScope: ExecutionScope;
  at?: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: DelegationSql) => {
    const current = await readDelegationTask(
      sql,
      input.taskId,
      input.tenantId,
      true,
    );
    assertTaskScope(current, input.parentExecutionScope);
    if (current.lifecycleRevision !== input.expectedRevision) {
      throw new DelegationTaskConflictError();
    }
    const { task: next, event } = transitionDelegationTaskV1({
      task: current,
      transition: input.transition,
      at: input.at,
    });
    const rows = await sql`
      UPDATE omni_delegation_tasks
      SET state = ${next.state},
          lifecycle_revision = ${next.lifecycleRevision},
          task = ${next}::jsonb,
          task_sha256 = ${next.taskSha256},
          updated_at = ${next.updatedAt},
          terminal_at = ${next.terminalAt}
      WHERE tenant_id = ${next.tenantId}
        AND task_id = ${next.taskId}
        AND state = ${current.state}
        AND lifecycle_revision = ${current.lifecycleRevision}
      RETURNING task
    `;
    if (rows.length !== 1) throw new DelegationTaskConflictError();
    await appendDelegationEvent(sql, event, input.parentExecutionScope);
    return parseDelegationTaskV1(rows[0].task);
  }) as Promise<DelegationTaskV1>;
}

export async function getDelegationTask(input: {
  tenantId: string;
  taskId: string;
  ownerActorId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const task = await readDelegationTask(getSql(), input.taskId, input.tenantId);
  if (task.ownerActorId !== input.ownerActorId) {
    throw new DelegationTaskConflictError("Delegation task is unavailable.");
  }
  return task;
}

export async function listDelegationTasksForExecution(input: {
  tenantId: string;
  ownerActorId: string;
  parentExecutionId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT task
    FROM omni_delegation_tasks
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND parent_execution_id = ${input.parentExecutionId}
    ORDER BY created_at ASC, task_id ASC
    LIMIT 100
  `;
  return rows.map((row) => parseDelegationTaskV1(row.task));
}

export function delegationTaskPersistenceAvailable() {
  return hasDatabaseUrl();
}

async function readDelegationTask(
  sql: DelegationSql,
  taskId: string,
  tenantId: string,
  forUpdate = false,
) {
  const rows = forUpdate
    ? await sql`
        SELECT task FROM omni_delegation_tasks
        WHERE tenant_id = ${tenantId} AND task_id = ${taskId}
        LIMIT 1 FOR UPDATE
      `
    : await sql`
        SELECT task FROM omni_delegation_tasks
        WHERE tenant_id = ${tenantId} AND task_id = ${taskId}
        LIMIT 1
      `;
  if (rows.length !== 1) throw new DelegationTaskConflictError("Delegation task was not found.");
  return parseDelegationTaskV1(rows[0].task);
}

function appendDelegationEvent(
  sql: DelegationSql,
  event: DelegationTaskEventV1,
  parentExecutionScope: ExecutionScope,
) {
  const executionScope = deriveExecutionScope(parentExecutionScope, {
    executingPrincipalType: "agent",
    executingPrincipalId: event.delegatePrincipalId,
    delegationId: event.delegationId,
    causationId: event.eventId,
    purpose: `delegation.task.${event.to}.v1`,
  });
  return appendScopedDomainEvent({
    id: event.eventId,
    streamId: `delegation:${event.delegationId}`,
    type: `delegation.task.${event.to}`,
    payload: {
      schemaVersion: event.schemaVersion,
      version: event.version,
      eventSha256: event.eventSha256,
      taskId: event.taskId,
      parentExecutionId: event.parentExecutionId,
      parentDelegationId: event.parentDelegationId,
      delegationId: event.delegationId,
      delegatePrincipalId: event.delegatePrincipalId,
      delegateAgentId: event.delegateAgentId,
      delegateDefinitionVersion: event.delegateDefinitionVersion,
      from: event.from,
      to: event.to,
      lifecycleRevision: event.lifecycleRevision,
      detailSha256: event.detailSha256,
      toolExecutionIds: event.toolExecutionIds,
      at: event.at,
    },
    executionScope,
  }, { sql });
}

function assertParentScope(
  contract: DelegationContractV1,
  scope: ExecutionScope,
) {
  if (
    scope.tenantId !== contract.scope.tenantId ||
    scope.initiatingActorId !== contract.scope.initiatingActorId ||
    scope.executingPrincipalId !== contract.scope.parentPrincipalId ||
    scope.delegationId !== contract.scope.parentDelegationId ||
    scope.workspaceId !== contract.scope.workspaceId ||
    scope.projectId !== contract.scope.projectId ||
    scope.missionId !== contract.scope.missionId
  ) {
    throw new DelegationTaskConflictError(
      "Delegation task does not match its parent execution scope.",
    );
  }
}

function assertTaskScope(task: DelegationTaskV1, scope: ExecutionScope) {
  if (
    task.tenantId !== scope.tenantId ||
    task.ownerActorId !== scope.initiatingActorId ||
    task.parentPrincipalId !== scope.executingPrincipalId ||
    task.parentDelegationId !== scope.delegationId
  ) {
    throw new DelegationTaskConflictError(
      "Delegation task transition is outside its parent execution scope.",
    );
  }
}

function requireDatabase() {
  if (!hasDatabaseUrl()) throw new DelegationTaskUnavailableError();
}
