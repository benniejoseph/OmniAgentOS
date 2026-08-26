import { createHash } from "node:crypto";
import { after } from "next/server";
import { attachMissionExecutor } from "@/lib/missions/runtime";
import { ensureMissionTask } from "@/lib/missions/store";
import type { AgentMode } from "@/lib/orchestration/types";
import {
  enqueueOperationJob,
  getAgentExecuteJobDedupeKey,
} from "@/lib/operations/job-queue";
import { createQueuedAgentRun } from "@/lib/runs/store";
import {
  durableSpecialistLabel,
  durableSpecialistPrompt,
} from "@/lib/subagents/profiles";
import type {
  DurableSpecialistAgentId,
  DurableSpecialistJobPayload,
  PreparedDurableSpecialist,
} from "@/lib/subagents/types";

type MissionOwner = { tenantId: string; actorId: string };

export async function prepareDurableSpecialistDelegation(input: {
  owner: MissionOwner;
  missionId: string;
  requestId: string;
  objective: string;
  mode: AgentMode;
  primaryAgentId: DurableSpecialistAgentId;
  specialistIds: DurableSpecialistAgentId[];
}) {
  const delegationId = deterministicDelegationId(input);
  const selected = selectDurableSpecialists(
    input.primaryAgentId,
    input.specialistIds,
    input.mode,
  );
  const prepared: PreparedDurableSpecialist[] = [];

  for (const [index, agentId] of selected.entries()) {
    const label = durableSpecialistLabel(agentId);
    const task = await ensureMissionTask(input.missionId, {
      sourceKey: `subagent:${delegationId}:${agentId}`,
      title: `${label.name} · ${label.role}`,
      instructions: durableSpecialistPrompt(agentId, input.objective),
      definitionOfDone:
        "Read-only findings are persisted with evidence, uncertainties, and recommendations for the parent workflow.",
      priority: "high",
      position: index,
      input: {
        kind: "durable_specialist",
        agentId,
        capabilityPolicy: "read_only",
      },
    }, input.owner);
    const runId = deterministicSpecialistRunId(
      input.owner.tenantId,
      task.id,
      agentId,
    );
    const prompt = durableSpecialistPrompt(agentId, input.objective);
    await enqueueDurableSpecialistIntent({
      actorId: input.owner.actorId,
      missionId: input.missionId,
      taskId: task.id,
      runId,
      agentId,
      ready: false,
      preparedAt: task.createdAt,
    }, input.owner);
    const run = await createQueuedAgentRun({
      id: runId,
      tenantId: input.owner.tenantId,
      mode: input.mode,
      prompt,
      messages: [{ role: "user", content: prompt }],
      agentId,
    });
    const attempt = await attachMissionExecutor({
      taskId: task.id,
      executorType: "agent_run",
      executorId: run.id,
      status: "queued",
      payload: { kind: "durable_specialist", agentId },
    }, input.owner);
    const item = {
      agentId,
      runId: run.id,
      missionId: input.missionId,
      taskId: task.id,
      attemptId: attempt.id,
    } satisfies PreparedDurableSpecialist;
    prepared.push(item);
  }

  return prepared;
}

export async function bindDurableSpecialistsToWorkflow(
  specialists: PreparedDurableSpecialist[],
  workflowRunId: string,
  owner: MissionOwner,
) {
  return Promise.all(
    specialists.map((specialist) =>
      enqueueDurableSpecialist(specialist, owner, workflowRunId),
    ),
  );
}

export function scheduleDurableSpecialistDrain(
  tenantId: string,
  limit = 2,
) {
  after(async () => {
    try {
      const [{ processDurableSpecialistQueue }, { processWorkflowQueue }] =
        await Promise.all([
          import("@/lib/subagents/worker"),
          import("@/lib/workflows/queue"),
        ]);
      await processDurableSpecialistQueue({ tenantId, limit });
      await processWorkflowQueue({
        tenantId,
        limit: 1,
        bootstrapQueuedRuns: false,
      });
    } catch (error) {
      console.warn(
        "Durable specialist queue drain failed.",
        error instanceof Error ? error.message : error,
      );
    }
  });
}

export function selectDurableSpecialists(
  primaryAgentId: DurableSpecialistAgentId,
  requested: DurableSpecialistAgentId[],
  mode: AgentMode,
) {
  const selected = [...new Set(requested)].filter(
    (agentId) => agentId !== primaryAgentId,
  );
  if (!selected.length) {
    const fallback: DurableSpecialistAgentId =
      primaryAgentId === "sentinel"
        ? mode === "research"
          ? "scout"
          : "atlas"
        : "sentinel";
    selected.push(fallback);
  }
  return selected.slice(0, 2);
}

async function enqueueDurableSpecialist(
  specialist: PreparedDurableSpecialist,
  owner: MissionOwner,
  workflowRunId?: string,
) {
  const payload = {
    actorId: owner.actorId,
    missionId: specialist.missionId,
    taskId: specialist.taskId,
    runId: specialist.runId,
    agentId: specialist.agentId,
    ready: true,
    preparedAt: new Date().toISOString(),
    workflowRunId,
  } satisfies DurableSpecialistJobPayload;
  return enqueueDurableSpecialistIntent(payload, owner, true);
}

async function enqueueDurableSpecialistIntent(
  payload: DurableSpecialistJobPayload,
  owner: MissionOwner,
  activate = false,
) {
  return enqueueOperationJob({
    tenantId: owner.tenantId,
    type: "agent.execute",
    dedupeKey: getAgentExecuteJobDedupeKey(payload.runId),
    payload,
    priority: 15,
    maxAttempts: 3,
    requeueTerminal: false,
    requeueFailed: activate,
    dedupeMode: activate ? "coalesce" : "idempotent",
  });
}

function deterministicDelegationId(input: {
  owner: MissionOwner;
  missionId: string;
  requestId: string;
}) {
  return createHash("sha256")
    .update(
      `${input.owner.tenantId}\0${input.owner.actorId}\0${input.missionId}\0${input.requestId}`,
    )
    .digest("hex")
    .slice(0, 32);
}

function deterministicSpecialistRunId(
  tenantId: string,
  taskId: string,
  agentId: DurableSpecialistAgentId,
) {
  return `sar_${createHash("sha256")
    .update(`${tenantId}\0${taskId}\0${agentId}`)
    .digest("hex")
    .slice(0, 40)}`;
}
