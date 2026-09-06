import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@/lib/events/store";
import type { AgentRunRecord } from "@/lib/runs/types";
import {
  buildRunTraceHierarchy,
  resolveRunCorrelationId,
  traceStageIds,
} from "@/lib/trajectories/hierarchy";

const run: AgentRunRecord = {
  id: "run-trace",
  tenantId: "tenant-trace",
  ownerActorId: "actor-trace",
  mode: "execute",
  status: "completed",
  prompt: "private request",
  messages: [{ role: "user", content: "private request" }],
  memoryContextCount: 1,
  response: "private response",
  grounding: {
    status: "verified",
    citedIds: ["source:one"],
    invalidIds: [],
    sources: [],
  },
  startedAt: "2026-09-06T00:00:00.000Z",
  completedAt: "2026-09-06T00:00:09.000Z",
};

function traceEvent(
  seq: number,
  streamId: string,
  type: string,
  payload: Record<string, unknown> = {},
  options: Partial<DomainEvent> = {},
): DomainEvent {
  return {
    id: `event-${seq}`,
    seq,
    streamId,
    type,
    tenantId: "tenant-trace",
    actorId: "actor-trace",
    payload,
    correlationId: "correlation-private",
    at: `2026-09-06T00:00:0${seq}.000Z`,
    ...options,
  };
}

describe("run trace hierarchy", () => {
  it("projects a complete cross-stream journey without plaintext or raw identifiers", () => {
    const events = [
      traceEvent(1, "intent:request-private", "intent.semantic_resolved", {
        intent: "execute",
        privatePrompt: "private request",
      }),
      traceEvent(2, "run:run-trace", "run.harness", { mode: "execute" }),
      traceEvent(3, "run:run-trace", "run.scope_bound", {}, {
        executionScope: {
          version: 1,
          tenantId: "tenant-trace",
          initiatingActorId: "actor-trace",
          executingPrincipalType: "user",
          executingPrincipalId: "actor-trace",
          workspaceId: null,
          projectId: null,
          missionId: null,
          delegationId: null,
          correlationId: "correlation-private",
          causationId: null,
          contextGrantIds: [],
          capabilityGrantIds: [],
          purpose: "private purpose",
        },
      }),
      traceEvent(4, "run:run-trace", "run.model", {
        provider: "openai",
        model: "gpt-test",
        privateOutput: "private response",
      }),
      traceEvent(5, "run:run-trace", "run.tool", {
        toolId: "calendar.create",
        toolName: "calendar.create",
        status: "executed",
        dryRun: false,
        privateResult: "secret tool output",
      }),
      traceEvent(6, "run:run-trace", "run.memory", { count: 1 }),
      traceEvent(7, "tool:execution-private", "tool.effect_receipt.recorded", {}, {
        causationId: "event-5",
      }),
      traceEvent(8, "run:run-trace", "run.done", {
        grounding: { status: "verified" },
        response: "private response",
      }),
      traceEvent(9, "memory:private", "memory.formed", {
        content: "private memory",
      }),
      traceEvent(10, "workflow:other-actor", "workflow.private", {}, {
        actorId: "actor-other",
      }),
    ];

    expect(resolveRunCorrelationId(run, events)).toBe("correlation-private");
    const hierarchy = buildRunTraceHierarchy(
      run,
      events,
      "correlation-private",
    );

    expect(hierarchy.stages.map((stage) => stage.id)).toEqual(traceStageIds);
    expect(hierarchy.stages.every((stage) => stage.status === "observed")).toBe(true);
    expect(hierarchy.summary).toMatchObject({
      eventCount: 9,
      observedStageCount: 9,
      missingStageCount: 0,
    });
    expect(hierarchy.correlationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(hierarchy.traceId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(hierarchy)).not.toContain("correlation-private");
    expect(JSON.stringify(hierarchy)).not.toContain("request-private");
    expect(JSON.stringify(hierarchy)).not.toContain("execution-private");
    expect(JSON.stringify(hierarchy)).not.toContain("private request");
    expect(JSON.stringify(hierarchy)).not.toContain("private response");
    expect(JSON.stringify(hierarchy)).not.toContain("secret tool output");
    expect(JSON.stringify(hierarchy)).not.toContain("private memory");
    expect(hierarchy.stages.find((stage) => stage.id === "effect")?.events[0])
      .toMatchObject({
        parentEventRef: hierarchy.stages.find((stage) => stage.id === "tool")?.events[0].eventRef,
        streamKind: "tool",
      });
  });

  it("distinguishes terminal gaps from optional stages that were not used", () => {
    const hierarchy = buildRunTraceHierarchy(run, [], run.id);

    expect(hierarchy.stages.find((stage) => stage.id === "intent")?.status).toBe("missing");
    expect(hierarchy.stages.find((stage) => stage.id === "verification")?.status).toBe("missing");
    expect(hierarchy.stages.find((stage) => stage.id === "tool")?.status).toBe("not_applicable");
    expect(hierarchy.stages.find((stage) => stage.id === "memory")?.status).toBe("not_applicable");
  });

  it("marks required gaps as pending while a run is active", () => {
    const hierarchy = buildRunTraceHierarchy(
      { ...run, status: "running", completedAt: undefined },
      [],
      run.id,
    );

    expect(hierarchy.stages.find((stage) => stage.id === "model")?.status).toBe("pending");
    expect(hierarchy.outcome).toBe("running");
  });
});
