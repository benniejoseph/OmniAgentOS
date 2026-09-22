import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  delegateAgentTaskService,
  listAgentTasksService,
  showAgentTaskService,
} from "@/lib/app-services/agents";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { buildDelegationExecutionRecordV1 } from "@/lib/delegation/execution-record";
import type {
  getDelegationExecution,
  listDelegationExecutions,
} from "@/lib/delegation/execution-store";
import type { delegateAgentTask } from "@/lib/delegation/runtime";
import { buildExecutionContract } from "@/lib/delegation/test-fixtures";
import { createExecutionScope } from "@/lib/security/execution-scope";

const context = {
  tenantId: "tenant-one",
  actorId: "actor-one",
  role: "operator" as const,
  source: "service" as const,
};

const parentExecutionScope = createExecutionScope({
  tenantId: context.tenantId,
  initiatingActorId: context.actorId,
  executingPrincipalType: "agent",
  executingPrincipalId: "principal:atlas:1",
  correlationId: "run-root",
  purpose: "agent.run",
});

function taskRecord() {
  return buildDelegationExecutionRecordV1({
    contract: buildExecutionContract({
      objective: "Research the current state and cite governed evidence.",
    }),
    budgetLedgerRevision: 1,
  });
}

function dependencies(record = taskRecord()) {
  return {
    delegateTask: vi.fn(async () => record) as typeof delegateAgentTask,
    getExecution: vi.fn(async () => record) as typeof getDelegationExecution,
    listExecutions: vi.fn(async () => [record]) as typeof listDelegationExecutions,
  };
}

describe("governed Agent delegation application services", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates through the exact parent scope and returns only the public task projection", async () => {
    const deps = dependencies();
    const caller = createAppServiceCaller({
      context,
      executionScope: parentExecutionScope,
      idempotencyKey: "delegate:research:one",
    });
    const result = await delegateAgentTaskService(caller, {
      objective: "Research the current state and cite governed evidence.",
      taskKind: "research",
      acceptanceCriteria: ["Every conclusion cites governed evidence."],
      mode: "fork",
      preferredAgentId: "scout",
    }, deps);

    expect(deps.delegateTask).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      parentExecutionScope,
      idempotencyKey: "delegate:research:one",
      input: {
        objective: "Research the current state and cite governed evidence.",
        taskKind: "research",
        acceptanceCriteria: ["Every conclusion cites governed evidence."],
        mode: "fork",
        preferredAgentId: "scout",
      },
    });
    expect(result.receipt).toMatchObject({
      operation: "app.agents.delegate",
      action: "run.agent",
      resourceType: "delegation_execution",
      resourceCount: 1,
    });
    expect(result.data.task).toMatchObject({
      executionId: "run-child",
      parentExecutionId: "run-root",
      state: "queued",
      delegateAgentId: "scout",
      objective: "Research the current state and cite governed evidence.",
      runtime: {
        providerId: "configured-provider",
        modelId: "configured-research-model",
      },
    });
    const projectedKeys = allObjectKeys(result.data.task);
    for (const privateKey of [
      "contract",
      "contextCapsule",
      "grants",
      "delegatePrincipalId",
      "identityPinSha256",
      "runtimeAssignment",
    ]) {
      expect(projectedKeys, privateKey).not.toContain(privateKey);
    }
  });

  it("requires governed mutation authority before calling the runtime", async () => {
    const deps = dependencies();
    const caller = createAppServiceCaller({ context });

    await expect(delegateAgentTaskService(caller, {
      objective: "Research the current state.",
      taskKind: "research",
      acceptanceCriteria: ["Return a source-backed summary."],
      mode: "isolated",
    }, deps)).rejects.toThrow("exact execution scope");
    expect(deps.delegateTask).not.toHaveBeenCalled();
  });

  it("lists and shows exact actor-owned tasks through execution-store boundaries", async () => {
    const deps = dependencies();
    const caller = createAppServiceCaller({ context });

    const listed = await listAgentTasksService(caller, {
      parentExecutionId: "run-root",
      limit: 12,
    }, deps);
    const shown = await showAgentTaskService(caller, {
      executionId: "run-child",
    }, deps);

    expect(deps.listExecutions).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      parentExecutionId: "run-root",
      limit: 12,
    });
    expect(deps.getExecution).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      executionId: "run-child",
    });
    expect(listed.data.tasks).toHaveLength(1);
    expect(listed.receipt).toMatchObject({
      operation: "app.agents.tasks.list",
      resourceCount: 1,
    });
    expect(shown.data.task.executionId).toBe("run-child");
    expect(shown.receipt).toMatchObject({
      operation: "app.agents.tasks.show",
      resourceCount: 1,
    });
  });
});

function allObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allObjectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...allObjectKeys(nested)]);
}
