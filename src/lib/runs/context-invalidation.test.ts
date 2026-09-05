import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";

const eventMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: eventMocks.appendScopedDomainEvent,
}));

import { invalidateRunsForDeletedContext } from "@/lib/runs/context-invalidation";

describe("pending run context invalidation", () => {
  beforeEach(() => {
    eventMocks.appendScopedDomainEvent.mockClear();
  });

  it("cancels agent and workflow continuations and appends scoped typed events", async () => {
    const statements: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      statements.push(text);
      if (text.includes("UPDATE omni_agent_runs")) {
        return [{ id: "agent-run-b" }, { id: "agent-run-a" }];
      }
      if (text.includes("UPDATE omni_workflow_runs")) {
        return [{ id: "workflow-run-a" }];
      }
      return [];
    });
    const executionScope = createExecutionScope({
      tenantId: "tenant-a",
      initiatingActorId: "actor-a",
      executingPrincipalType: "user",
      executingPrincipalId: "actor-a",
      correlationId: "forget-request-a",
      causationId: "memory-a",
      purpose: "memory.forget.test",
    });

    await expect(invalidateRunsForDeletedContext({
      tenantId: "tenant-a",
      retrievalTraceIds: ["trace-b", "trace-a", "trace-a"],
      executionScope,
      sourceKind: "memory",
      sourceReference: "memory-a",
      sql: sql as never,
    })).resolves.toEqual({
      agentRunIds: ["agent-run-a", "agent-run-b"],
      workflowRunIds: ["workflow-run-a"],
    });

    expect(statements).toEqual(expect.arrayContaining([
      expect.stringContaining("status = 'canceled'"),
      expect.stringContaining("continuation = NULL"),
      expect.stringContaining("event.type = 'harness'"),
      expect.stringContaining("plan.context_trace_id"),
      expect.stringContaining("INSERT INTO omni_agent_events"),
      expect.stringContaining("INSERT INTO omni_workflow_events"),
    ]));
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledTimes(3);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run.context_invalidated",
        executionScope,
        payload: expect.objectContaining({
          reasonCode: "retrieved_context_deleted",
          retrievalTraceCount: 2,
          sourceKind: "memory",
        }),
      }),
      { sql },
    );
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workflow.context_invalidated",
        executionScope,
      }),
      { sql },
    );
  });

  it("does no work when deletion has no affected trace", async () => {
    const sql = vi.fn(async () => []);
    const executionScope = createExecutionScope({
      tenantId: "tenant-a",
      initiatingActorId: "actor-a",
      executingPrincipalType: "user",
      executingPrincipalId: "actor-a",
      correlationId: "forget-request-a",
      causationId: "memory-a",
      purpose: "memory.forget.test",
    });

    await expect(invalidateRunsForDeletedContext({
      tenantId: "tenant-a",
      retrievalTraceIds: [],
      executionScope,
      sourceKind: "memory",
      sourceReference: "memory-a",
      sql: sql as never,
    })).resolves.toEqual({ agentRunIds: [], workflowRunIds: [] });
    expect(sql).not.toHaveBeenCalled();
    expect(eventMocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });
});
