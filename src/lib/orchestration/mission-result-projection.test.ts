import { describe, expect, it } from "vitest";
import { toMissionDetailView } from "@/lib/missions/public";
import { MISSION_RESULT_CHARACTERS, projectMissionToolResult } from "./mission-result-projection";
import { projectToolResult, serializeProjectedToolResult } from "./tool-result-projection";

const at = "2026-10-26T19:55:55.275Z";
const missionId = "11111111-1111-4111-8111-111111111111";
const workflowId = "wf_2e26bc66ffe0b5191ffb2e9745b23abd828719da";
const id = (index: number) => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
function surface(workItemId: string, milestone = false) {
  return {
    version: "p11.4-work-item-surface:1",
    projection: { authority: "canonical_work_item_v1", sha256: "a".repeat(64), sourceRevisionSha256: "b".repeat(64) },
    status: { schemaVersion: 1, authority: "canonical_work_item_v1", persistence: "postgres", workspaceId: id(9997),
      projectId: `mission_project:${missionId}`, workItemId, kind: milestone ? "milestone" : "task",
      sourceAuthority: milestone ? "legacy_mission" : "legacy_mission_task", sourceId: workItemId,
      status: "waiting", sourceStatus: "waiting", statusRevision: 1, updatedAt: at },
    assignment: { authority: "canonical_work_item_v1", agents: [{ agentId: "atlas", principalId: null, principalGeneration: null }] },
    artifacts: { authority: "canonical_work_item_v1", count: 0, items: [] },
    execution: { authority: "governed_workflow_v1", availability: milestone ? "unavailable" : "current",
      workflowRunId: milestone ? null : workflowId, sourceStatus: milestone ? null : "paused", currentStep: milestone ? null : "execute",
      completedSteps: 3, totalSteps: 6, progressPercent: 50, updatedAt: at },
    cost: { authority: "ai_usage_ledger_v1", state: "known", usageReceiptCount: 8,
      unknownCostReceiptCount: 0, totalTokens: 10_000, knownEstimatedCostMicrousd: 100_000 },
  };
}
function fixture(count = 200) {
  const detail = toMissionDetailView({
    mission: { id: missionId, tenantId: "tenant-a", actorId: "actor-a", title: "Public research", objective: "Research objective ".repeat(200),
      status: "waiting", priority: "high", source: "talk", createdAt: at, updatedAt: at },
    tasks: Array.from({ length: count }, (_, index) => ({ id: id(index), missionId, title: "Research task",
      instructions: "Detailed research instructions ".repeat(100), definitionOfDone: "Report acceptance criteria ".repeat(100),
      status: "blocked", priority: "high", position: index, dependencyIds: [],
      metadata: { assigneeKey: "atlas", assigneeName: "Atlas", reviewRequired: true, reviewerKey: "sentinel", reviewerName: "Sentinel",
        reviewRequestedAt: at, reviewSummary: "Recorded review note ".repeat(100), changesRequestedReason: "Relevant review feedback ".repeat(100),
        blocker: { kind: "transient", reason: "Current report writer is paused" } }, createdAt: at, updatedAt: at })),
    attempts: Array.from({ length: count }, (_, index) => ({ id: id(1000 + index), missionId, taskId: id(index),
      executorType: "workflow_run", workflowRunId: index === 0 ? workflowId : `wf_${String(index).padStart(40, "0")}`,
      status: "waiting", error: "Report writer stopped after 180 seconds", startedAt: at, createdAt: at, updatedAt: at })),
    artifacts: Array.from({ length: count }, (_, index) => ({ id: id(2000 + index), missionId, taskId: id(index), attemptId: id(1000 + index),
      kind: "task_handoff", title: "Task handoff", data: { summary: "Saved source summary ".repeat(300), verification: "Verification note ".repeat(200),
        recovery: "Recovery note ".repeat(200), residualRisk: "Retained work note ".repeat(200), artifactIds: Array(50).fill(id(9999)) },
      createdAt: at, updatedAt: at })),
  } as never);
  const root = surface(`mission_root:${missionId}`, true);
  return {
    executionInspection: { schemaVersion: 1, rootExecution: "aggregate_milestone",
      interpretation: "The mission root has no direct execution status. Inspect its linked task executions before diagnosing stalled work; a waiting attempt alone does not distinguish a paused workflow from an approval wait.",
      coverage: { attemptsRead: count, attemptReadLimit: 200, linkedExecutionsOmitted: Math.max(0, count - 20), historyMayBeIncomplete: count >= 200 },
      linkedExecutions: detail.attempts.slice(0, 20).map(attempt => ({ taskId: attempt.taskId, attemptId: attempt.id,
        executorType: attempt.executorType, attemptStatus: attempt.status, updatedAt: attempt.updatedAt,
        read: { toolId: "app.workflows.show", input: { workflowId: attempt.workflowRunId } } })),
    },
    ...detail,
    mission: { ...detail.mission, workItemStatus: root.status, workItem: root },
    tasks: detail.tasks.map(task => { const workItem = surface(task.id); return { ...task, workItemStatus: workItem.status, workItem }; }),
    serviceReceipt: { schemaVersion: 1, receiptKind: "app_service_receipt", boundaryVersion: "app-service:v1",
      operation: "missions.show", action: "read", resourceType: "mission", accessMode: "read", eventContract: null,
      authoritySha256: "c".repeat(64), idempotencyKeySha256: null, outcomeSha256: "d".repeat(64), resourceCount: 1,
      occurredAt: at, receiptSha256: "e".repeat(64) },
  };
}
const envelope = (result: unknown) => ({ executionId: id(9998), status: "executed", dryRun: false, approvalRequired: false, result });

describe("mission execution result projection", () => {
  it("recovers usable executor references when a full public mission detail exceeds the model envelope", () => {
    const source = fixture();
    const withoutProjection = JSON.parse(serializeProjectedToolResult(envelope(source)));
    expect(withoutProjection.data.result).toEqual({ omitted: true });
    const projected = projectToolResult("mission.show", source);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(MISSION_RESULT_CHARACTERS);
    const serialized = serializeProjectedToolResult(envelope(projected));
    const observed = JSON.parse(serialized);
    expect(observed.coverage).toBeUndefined();
    const result = observed.data.result;
    expect(result.executionInspection.linkedExecutions[0].read.input.workflowId).toBe(workflowId);
    expect(result.executionInspection.linkedExecutions).toEqual(source.executionInspection.linkedExecutions.slice(0,
      result.executionInspection.linkedExecutions.length));
    expect(result.executionInspection.coverage.linkedExecutionsOmitted + result.executionInspection.linkedExecutions.length).toBe(200);
    expect(result.projection).toMatchObject({ kind: "mission_execution_summary", fullResultInExecutionReceipt: true,
      fullMissionDetailIncluded: false, serviceReceiptSha256: "e".repeat(64) });
    expect(serialized).not.toMatch(/Detailed research instructions|Saved source summary|Relevant review feedback/);
    expect(source.executionInspection.linkedExecutions).toHaveLength(20);
  });

  it("preserves complete long identifiers by dropping whole references in source order", () => {
    const source = fixture(20);
    source.executionInspection.linkedExecutions.forEach((reference, index) => {
      reference.taskId = `task-${index}`.padEnd(240, "x");
      reference.attemptId = `attempt-${index}`.padEnd(240, "x");
      reference.read.input.workflowId = `workflow-${index}`.padEnd(240, "x");
    });
    source.executionInspection.linkedExecutions[0].updatedAt = "2026-10-25T00:00:00.000Z";
    const result = JSON.parse(serializeProjectedToolResult(envelope(projectMissionToolResult("mission.show", source)))).data.result;
    expect(result.executionInspection.linkedExecutions.length).toBeGreaterThan(0);
    expect(result.executionInspection.linkedExecutions.length).toBeLessThan(20);
    expect(result.executionInspection.linkedExecutions).toEqual(source.executionInspection.linkedExecutions.slice(0,
      result.executionInspection.linkedExecutions.length));
    expect(result.executionInspection.coverage.linkedExecutionsOmitted + result.executionInspection.linkedExecutions.length).toBe(20);
  });

  it("leaves ordinary public responses, unrelated tools and mismatched executor metadata unchanged", () => {
    const source = fixture(1);
    const { executionInspection: _inspection, ...ordinary } = source;
    expect(projectMissionToolResult("mission.show", ordinary)).toBe(ordinary);
    expect(projectMissionToolResult("app.workflows.show", source)).toBe(source);
    source.executionInspection.linkedExecutions[0].executorType = "agent_run";
    expect(projectMissionToolResult("mission.show", source)).toBe(source);
    const foreign = fixture(1); foreign.serviceReceipt.operation = "app.workflows.show";
    expect(projectMissionToolResult("mission.show", foreign)).toBe(foreign);
  });

  it("preserves full task detail when the original mission result fits the model budget", () => {
    const source = fixture(1);
    const small = {
      mission: { id: missionId, title: "Research", status: "waiting", updatedAt: at },
      executionInspection: source.executionInspection,
      tasks: [{ id: id(0), title: "Compare sources", instructions: "Keep the cancellation deadlines." }],
    };
    expect(JSON.stringify(small).length).toBeLessThan(MISSION_RESULT_CHARACTERS);
    expect(projectToolResult("mission.show", small)).toBe(small);
    expect(JSON.parse(serializeProjectedToolResult(envelope(small))).data.result.tasks).toEqual(small.tasks);
  });
});
