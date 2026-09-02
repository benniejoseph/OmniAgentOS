import { createHash } from "node:crypto";
import { after } from "next/server";
import { attachMissionExecutor } from "@/lib/missions/runtime";
import { ensureMissionTask } from "@/lib/missions/store";
import type { AgentMode } from "@/lib/orchestration/types";
import {
  enqueueOperationJob,
  getAgentExecuteJobDedupeKey,
} from "@/lib/operations/job-queue";
import {
  bindAgentRunExecutionScope,
  createQueuedAgentRun,
} from "@/lib/runs/store";
import {
  assertExecutionScopeTenant,
  deriveExecutionScope,
  executionScopesEqual,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  durableSpecialistLabel,
  durableSpecialistPrompt,
} from "@/lib/subagents/profiles";
import { DURABLE_SPECIALIST_SCOPE_PURPOSE } from "@/lib/subagents/types";
import type {
  DurableSpecialistAgentId,
  DurableSpecialistJobPayload,
  PreparedDurableSpecialist,
} from "@/lib/subagents/types";

type MissionOwner = { tenantId: string; actorId: string };

export async function prepareDurableSpecialistDelegation(input: {
  owner: MissionOwner;
  parentExecutionScope: ExecutionScope;
  missionId: string;
  requestId: string;
  objective: string;
  mode: AgentMode;
  primaryAgentId: DurableSpecialistAgentId;
  specialistIds: DurableSpecialistAgentId[];
}) {
  const parentExecutionScope = input.parentExecutionScope;
  assertExecutionScopeTenant(parentExecutionScope, input.owner.tenantId);
  if (
    parentExecutionScope.initiatingActorId !== input.owner.actorId ||
    parentExecutionScope.executingPrincipalType !== "agent" ||
    parentExecutionScope.missionId !== input.missionId ||
    parentExecutionScope.correlationId !== input.requestId
  ) {
    throw new Error("Durable delegation scope does not match its request.");
  }
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
    const executionScope = deriveExecutionScope(parentExecutionScope, {
      executingPrincipalType: "agent",
      executingPrincipalId: agentId,
      missionId: input.missionId,
      delegationId,
      causationId: task.id,
      capabilityGrantIds: [],
      purpose: DURABLE_SPECIALIST_SCOPE_PURPOSE,
    });
    const runId = deterministicSpecialistRunId(
      input.owner.tenantId,
      task.id,
      agentId,
    );
    const prompt = durableSpecialistPrompt(agentId, input.objective);
    const intentPayload = {
      actorId: input.owner.actorId,
      missionId: input.missionId,
      taskId: task.id,
      runId,
      agentId,
      requestId: input.requestId,
      delegationId,
      executionScope,
      ready: false,
      preparedAt: task.createdAt,
    } satisfies DurableSpecialistJobPayload;
    const intent = await enqueueDurableSpecialistIntent(
      intentPayload,
      input.owner,
    );
    assertSpecialistJobScope(intent.payload, intentPayload, true);
    const run = await createQueuedAgentRun({
      id: runId,
      tenantId: input.owner.tenantId,
      mode: input.mode,
      prompt,
      messages: [{ role: "user", content: prompt }],
      agentId,
    });
    await bindAgentRunExecutionScope(run.id, executionScope, {
      tenantId: input.owner.tenantId,
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
      requestId: input.requestId,
      delegationId,
      runId: run.id,
      missionId: input.missionId,
      taskId: task.id,
      attemptId: attempt.id,
      executionScope,
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
    requestId: specialist.requestId,
    delegationId: specialist.delegationId,
    executionScope: specialist.executionScope,
    ready: true,
    preparedAt: new Date().toISOString(),
    workflowRunId,
  } satisfies DurableSpecialistJobPayload;
  const job = await enqueueDurableSpecialistIntent(payload, owner, true);
  assertSpecialistJobScope(
    job.payload,
    payload,
    job.status === "completed" || job.status === "canceled",
  );
  return job;
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

function assertSpecialistJobScope(
  payload: Record<string, unknown>,
  expectedPayload: DurableSpecialistJobPayload,
  allowLegacy = false,
) {
  const expected = expectedPayload.executionScope;
  if (!expected) {
    throw new Error("Durable specialist queue scope is required.");
  }
  const identityMatches =
    payload.actorId === expectedPayload.actorId &&
    payload.agentId === expectedPayload.agentId &&
    payload.missionId === expectedPayload.missionId &&
    payload.taskId === expectedPayload.taskId &&
    payload.runId === expectedPayload.runId;
  const isLegacy =
    payload.executionScope === undefined &&
    payload.requestId === undefined &&
    payload.delegationId === undefined;
  if (allowLegacy && isLegacy && identityMatches) {
    return;
  }
  const stored = parsePersistedExecutionScope(payload.executionScope);
  if (
    !stored ||
    !identityMatches ||
    !executionScopesEqual(stored, expected) ||
    payload.actorId !== expected.initiatingActorId ||
    payload.agentId !== expected.executingPrincipalId ||
    payload.missionId !== expected.missionId ||
    payload.taskId !== expected.causationId ||
    payload.requestId !== expected.correlationId ||
    payload.delegationId !== expected.delegationId
  ) {
    throw new Error("Durable specialist queue scope does not match its request.");
  }
}
