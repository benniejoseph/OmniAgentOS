import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  hasDatabaseUrl: vi.fn(() => true),
  getSql: vi.fn(),
  runWithDatabaseActorScope: vi.fn(
    async (_tenantId: string, _actorIds: readonly string[], operation: () => unknown) => operation(),
  ),
  appendScopedDomainEvent: vi.fn(async () => ({ id: "event" })),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  hasDatabaseUrl: mocks.hasDatabaseUrl,
  getSql: mocks.getSql,
  runWithDatabaseActorScope: mocks.runWithDatabaseActorScope,
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));

import {
  buildDelegationExecutionRecordV1,
  transitionDelegationExecutionRecordV1,
  type DelegationExecutionRecordV1,
} from "@/lib/delegation/execution-record";
import {
  createDelegationExecution,
  DelegationExecutionUnavailableError,
  transitionDelegationExecution,
} from "@/lib/delegation/execution-store";
import {
  buildExecutionContract,
  executionParentBudgets,
} from "@/lib/delegation/test-fixtures";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("delegation execution store", () => {
  beforeEach(() => {
    mocks.ensureDatabaseSchema.mockClear();
    mocks.appendScopedDomainEvent.mockClear();
    mocks.runWithDatabaseActorScope.mockClear();
    mocks.hasDatabaseUrl.mockReturnValue(true);
  });

  it("atomically reserves root budget and creates one immutable child execution", async () => {
    const contract = buildExecutionContract();
    const expected = buildDelegationExecutionRecordV1({
      contract,
      budgetLedgerRevision: 1,
    });
    const statements: string[] = [];
    const sql = Object.assign(async (parts: TemplateStringsArray) => {
      const statement = parts.join("?");
      statements.push(statement);
      if (/SELECT \* FROM omni_delegation_executions/.test(statement)) return [];
      if (/SELECT limits, limits_sha256/.test(statement)) {
        return [{
          limits: executionParentBudgets,
          limits_sha256: canonicalJsonSha256(executionParentBudgets),
          reserved: zeroBudget(),
          lifecycle_revision: 0,
          updated_at: contract.deadline.createdAt,
        }];
      }
      if (/UPDATE omni_delegation_budget_ledgers/.test(statement)) {
        return [{ lifecycle_revision: 1 }];
      }
      if (/INSERT INTO omni_delegation_executions/.test(statement)) {
        return [recordRow(expected)];
      }
      return [];
    }, {
      transaction: async (callback: (sql: unknown) => unknown) => callback(sql),
    });
    mocks.getSql.mockReturnValue(sql);

    const created = await createDelegationExecution({
      contract,
      parentExecutionScope: parentScope(contract),
      rootBudgetLimits: executionParentBudgets,
    });

    expect(created).toEqual(expected);
    expect(statements.some((statement) =>
      /UPDATE omni_delegation_budget_ledgers/.test(statement)
    )).toBe(true);
    expect(statements.some((statement) =>
      /INSERT INTO omni_delegation_executions/.test(statement)
    )).toBe(true);
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `delegation-execution:${contract.delegationId}`,
        type: "delegation.execution.queued",
        payload: expect.objectContaining({
          executionId: contract.delegateIdentity.runId,
          contractSha256: contract.contractSha256,
          lifecycleRevision: 0,
        }),
      }),
      { sql },
    );
  });

  it("lets only the delegated principal advance child work", async () => {
    const contract = buildExecutionContract();
    const current = buildDelegationExecutionRecordV1({
      contract,
      budgetLedgerRevision: 1,
    });
    const next = transitionDelegationExecutionRecordV1({
      record: current,
      transition: { to: "running" },
      at: "2026-09-22T12:00:30.000Z",
    }).record;
    const sql = Object.assign(async (parts: TemplateStringsArray) => {
      const statement = parts.join("?");
      if (/SELECT \* FROM omni_delegation_executions/.test(statement)) {
        return [recordRow(current)];
      }
      if (/UPDATE omni_delegation_executions/.test(statement)) {
        return [recordRow(next)];
      }
      return [];
    }, {
      transaction: async (callback: (sql: unknown) => unknown) => callback(sql),
    });
    mocks.getSql.mockReturnValue(sql);

    const persisted = await transitionDelegationExecution({
      tenantId: current.tenantId,
      executionId: current.executionId,
      expectedRevision: 0,
      transition: { to: "running" },
      executionScope: childScope(contract),
      at: "2026-09-22T12:00:30.000Z",
    });
    expect(persisted.state).toBe("running");
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delegation.execution.running",
        payload: expect.objectContaining({ lifecycleRevision: 1 }),
      }),
      { sql },
    );

    await expect(transitionDelegationExecution({
      tenantId: current.tenantId,
      executionId: current.executionId,
      expectedRevision: 0,
      transition: { to: "running" },
      executionScope: parentScope(contract),
      at: "2026-09-22T12:00:30.000Z",
    })).rejects.toThrow(/exact delegated principal/i);
  });

  it("fails closed without canonical persistence", async () => {
    mocks.hasDatabaseUrl.mockReturnValue(false);
    const contract = buildExecutionContract();
    await expect(createDelegationExecution({
      contract,
      parentExecutionScope: parentScope(contract),
      rootBudgetLimits: executionParentBudgets,
    })).rejects.toBeInstanceOf(DelegationExecutionUnavailableError);
  });
});

function parentScope(contract: ReturnType<typeof buildExecutionContract>) {
  return createExecutionScope({
    tenantId: contract.lineage.tenantId,
    initiatingActorId: contract.lineage.initiatingActorId,
    executingPrincipalType: "agent",
    executingPrincipalId: contract.lineage.parentPrincipalId,
    workspaceId: contract.lineage.workspaceId,
    projectId: contract.lineage.projectId,
    delegationId: null,
    correlationId: contract.lineage.parentExecutionId,
    contextGrantIds: contract.grants.contextGrantIds,
    capabilityGrantIds: contract.grants.capabilityGrantIds,
    purpose: "agent.run",
  });
}

function childScope(contract: ReturnType<typeof buildExecutionContract>) {
  return createExecutionScope({
    tenantId: contract.lineage.tenantId,
    initiatingActorId: contract.lineage.initiatingActorId,
    executingPrincipalType: "agent",
    executingPrincipalId: contract.delegateIdentity.principalId,
    workspaceId: contract.lineage.workspaceId,
    projectId: contract.lineage.projectId,
    delegationId: contract.delegationId,
    correlationId: contract.lineage.rootExecutionId,
    contextGrantIds: contract.grants.contextGrantIds,
    capabilityGrantIds: contract.grants.capabilityGrantIds,
    purpose: "delegation.work.execute",
  });
}

function recordRow(record: DelegationExecutionRecordV1) {
  return {
    schema_version: record.schemaVersion,
    tenant_id: record.tenantId,
    execution_id: record.executionId,
    owner_actor_id: record.ownerActorId,
    root_execution_id: record.rootExecutionId,
    parent_execution_id: record.parentExecutionId,
    child_run_id: record.childRunId,
    delegation_id: record.delegationId,
    compatibility_task_id: record.compatibilityTaskId,
    contract_id: record.contractId,
    contract_sha256: record.contractSha256,
    context_capsule_id: record.contextCapsuleId,
    context_capsule_sha256: record.contextCapsuleSha256,
    delegate_agent_id: record.delegateAgentId,
    delegate_principal_id: record.delegatePrincipalId,
    runtime_assignment_id: record.runtimeAssignmentId,
    runtime_assignment_sha256: record.runtimeAssignmentSha256,
    mode: record.mode,
    budget_limits: record.budgetLimits,
    budget_limits_sha256: record.budgetLimitsSha256,
    budget_ledger_revision: record.budgetLedgerRevision,
    state: record.state,
    lifecycle_revision: record.lifecycleRevision,
    contract: record.contract,
    context_capsule: record.contract.contextCapsule,
    runtime_assignment: record.contract.runtimeAssignment,
    result: record.result,
    result_sha256: record.resultSha256,
    verification: record.verification,
    verification_sha256: record.verificationSha256,
    failure_code: record.failureCode,
    created_at: record.createdAt,
    accept_by: record.acceptBy,
    complete_by: record.completeBy,
    updated_at: record.updatedAt,
    terminal_at: record.terminalAt,
  };
}

function zeroBudget() {
  return {
    modelTurns: 0,
    tokens: 0,
    costMicrousd: 0,
    wallTimeMs: 0,
    toolCalls: 0,
    browserActions: 0,
    agents: 0,
    fanOut: 0,
    retries: 0,
    replans: 0,
  };
}
