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

import { buildContract } from "@/lib/delegation/test-fixtures";
import {
  createDelegationTask,
  DelegationTaskUnavailableError,
  transitionDelegationTask,
} from "@/lib/delegation/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

function parentScope() {
  return createExecutionScope({
    tenantId: "tenant-one",
    initiatingActorId: "actor-one",
    executingPrincipalType: "agent",
    executingPrincipalId: "principal:atlas:1",
    correlationId: "run-one",
    contextGrantIds: ["grant:context:one"],
    capabilityGrantIds: ["grant:capability:one"],
    purpose: "agent.run",
  });
}

describe("delegation task store", () => {
  beforeEach(() => {
    mocks.ensureDatabaseSchema.mockClear();
    mocks.appendScopedDomainEvent.mockClear();
    mocks.runWithDatabaseActorScope.mockClear();
    mocks.hasDatabaseUrl.mockReturnValue(true);
  });

  it("persists the proposed task and its causation-complete event atomically", async () => {
    const contract = buildContract();
    const statements: string[] = [];
    const sql = Object.assign(async (parts: TemplateStringsArray) => {
      const statement = parts.join("?");
      statements.push(statement);
      if (/INSERT INTO omni_delegation_tasks/.test(statement)) {
        const { buildDelegationTaskV1 } = await import("@/lib/delegation/lifecycle");
        return [{ task: buildDelegationTaskV1(contract) }];
      }
      return [];
    }, {
      transaction: async (callback: (sql: unknown) => unknown) => callback(sql),
    });
    mocks.getSql.mockReturnValue(sql);
    const task = await createDelegationTask({ contract, parentExecutionScope: parentScope() });
    expect(task.state).toBe("proposed");
    expect(statements.some((statement) => /INSERT INTO omni_delegation_tasks/.test(statement))).toBe(true);
    expect(mocks.runWithDatabaseActorScope).toHaveBeenCalledWith(
      "tenant-one",
      ["actor-one"],
      expect.any(Function),
    );
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `delegation:${contract.delegationId}`,
        type: "delegation.task.proposed",
        payload: expect.objectContaining({
          parentExecutionId: "run-one",
          delegationId: contract.delegationId,
          delegateAgentId: "sentinel",
          toolExecutionIds: [],
          authority: expect.objectContaining({
            version: "p11.5-delegation-authority:1",
            grants: expect.objectContaining({
              contextGrantIds: ["grant:context:one"],
              capabilityGrantIds: ["grant:capability:one"],
              governedToolIds: ["knowledge.search"],
            }),
          }),
        }),
        executionScope: expect.objectContaining({
          contextGrantIds: ["grant:context:one"],
          capabilityGrantIds: ["grant:capability:one"],
        }),
      }),
      { sql },
    );
  });

  it("CAS-transitions a task and emits the exact lifecycle revision", async () => {
    const contract = buildContract();
    const { buildDelegationTaskV1, transitionDelegationTaskV1 } = await import("@/lib/delegation/lifecycle");
    const current = buildDelegationTaskV1(contract);
    const next = transitionDelegationTaskV1({
      task: current,
      transition: { to: "accepted" },
      at: "2026-09-07T06:00:10.000Z",
    }).task;
    const sql = Object.assign(async (parts: TemplateStringsArray) => {
      const statement = parts.join("?");
      if (/SELECT task FROM omni_delegation_tasks/.test(statement)) return [{ task: current }];
      if (/UPDATE omni_delegation_tasks/.test(statement)) return [{ task: next }];
      return [];
    }, { transaction: async (callback: (sql: unknown) => unknown) => callback(sql) });
    mocks.getSql.mockReturnValue(sql);
    const persisted = await transitionDelegationTask({
      taskId: current.taskId,
      tenantId: current.tenantId,
      expectedRevision: 0,
      transition: { to: "accepted" },
      parentExecutionScope: parentScope(),
      at: "2026-09-07T06:00:10.000Z",
    });
    expect(persisted.state).toBe("accepted");
    expect(mocks.runWithDatabaseActorScope).toHaveBeenCalledWith(
      "tenant-one",
      ["actor-one"],
      expect.any(Function),
    );
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delegation.task.accepted",
        payload: expect.objectContaining({ lifecycleRevision: 1 }),
      }),
      { sql },
    );
  });

  it("does not silently fall back when canonical persistence is unavailable", async () => {
    mocks.hasDatabaseUrl.mockReturnValue(false);
    await expect(createDelegationTask({
      contract: buildContract(),
      parentExecutionScope: parentScope(),
    })).rejects.toBeInstanceOf(DelegationTaskUnavailableError);
  });
});
