import { createHash } from "node:crypto";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import {
  reconcileMissionState,
  syncMissionExecutor,
} from "@/lib/missions/runtime";
import {
  listEndedMissionsToReconcile,
  listMissionAttemptsToReconcile,
  type MissionOwner,
} from "@/lib/missions/store";
import type { MissionAttempt } from "@/lib/missions/types";
import { getAgentRun } from "@/lib/runs/store";
import { redactSensitive } from "@/lib/security/context";
import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  durableSpecialistReceipt,
  recordDurableSpecialistFindings,
} from "@/lib/subagents/findings";
import {
  isDurableSpecialistAgentId,
  type DurableSpecialistAgentId,
} from "@/lib/subagents/types";
import { getWorkflowRun, workflowResultReceipt } from "@/lib/workflows/store";

/** How long the update that ends a run has to land before a repair. */
const MISSION_UPDATE_SETTLE_MS = 2 * 60 * 1000;
/** Candidates listed per repair, since the file ledger cannot see runs. */
const CANDIDATES_PER_REPAIR = 5;

type AttemptEnd = {
  status: "succeeded" | "failed" | "canceled";
  output?: Record<string, unknown>;
  error?: string;
  /** A specialist's findings, which its parent reads once its task succeeds. */
  findings?: { agentId: DurableSpecialistAgentId; response?: string };
};

/**
 * Replays mission updates that the end of a run never delivered: an attempt
 * whose run ended, a task its ended attempt never reached, and a mission
 * whose tasks all ended. Each end is left two minutes for its own update to
 * land. A replay takes the path the run's own update takes, as the
 * mission's owner, so a repeat changes nothing.
 */
export async function reconcileMissionProjections({
  tenantId,
  limit = 10,
}: {
  tenantId: string;
  limit?: number;
}) {
  const settledBefore = new Date(Date.now() - MISSION_UPDATE_SETTLE_MS);
  let repaired = 0;
  let failed = 0;
  const attempts = await listMissionAttemptsToReconcile({
    tenantId,
    settledBefore: settledBefore.toISOString(),
    limit: limit * CANDIDATES_PER_REPAIR,
  });
  for (const attempt of attempts) {
    if (repaired + failed >= limit) break;
    try {
      const replayed = await runWithDatabaseActorScope(
        attempt.tenantId,
        [attempt.actorId],
        () => replayAttemptEnd(attempt, settledBefore.getTime()),
      );
      if (replayed) repaired += 1;
    } catch (error) {
      failed += 1;
      logRepairFailure(tenantId, { attemptId: attempt.id }, error);
    }
  }
  const missions = await listEndedMissionsToReconcile({
    tenantId,
    settledBefore: settledBefore.toISOString(),
    limit,
  });
  for (const mission of missions) {
    try {
      const reconciled = await runWithDatabaseActorScope(
        mission.tenantId,
        [mission.actorId],
        () => reconcileMissionState(
          mission.id,
          maintenanceOwner(mission.tenantId, mission.actorId, mission.id),
        ),
      );
      if (reconciled && reconciled.status !== mission.status) repaired += 1;
    } catch (error) {
      failed += 1;
      logRepairFailure(tenantId, { missionId: mission.id }, error);
    }
  }
  return { repaired, failed };
}

async function replayAttemptEnd(attempt: MissionAttempt, settledBefore: number) {
  const end = ["succeeded", "failed", "canceled"].includes(attempt.status)
    ? await endedAttemptEnd(attempt)
    : await settledRunEnd(attempt, settledBefore);
  if (!end) return false;
  const owner = maintenanceOwner(attempt.tenantId, attempt.actorId, attempt.id);
  if (end.findings) {
    await recordDurableSpecialistFindings({
      missionId: attempt.missionId,
      taskId: attempt.taskId,
      runId: attempt.executorId,
      ...end.findings,
    }, owner);
  }
  await syncMissionExecutor({
    executorType: attempt.executorType === "workflow_run"
      ? "workflow_run"
      : "agent_run",
    executorId: attempt.executorId,
    status: end.status,
    output: end.output,
    error: end.error,
  }, owner);
  return true;
}

/** An ended attempt replays its own status, with a specialist's findings. */
async function endedAttemptEnd(attempt: MissionAttempt): Promise<AttemptEnd> {
  const status = attempt.status as AttemptEnd["status"];
  const agentId = durableSpecialistAgentId(attempt);
  if (status !== "succeeded" || !agentId) return { status };
  const run = await getAgentRun(attempt.executorId, {
    tenantId: attempt.tenantId,
  });
  return run?.status === "completed"
    ? { status, findings: { agentId, response: run.response } }
    : { status };
}

/** How an open attempt's run ended, or nothing while it runs or just ended. */
async function settledRunEnd(
  attempt: MissionAttempt,
  settledBefore: number,
): Promise<AttemptEnd | undefined> {
  if (attempt.executorType === "workflow_run") {
    const run = await getWorkflowRun(attempt.executorId, {
      tenantId: attempt.tenantId,
    });
    const status = run ? attemptStatusForRun(run.status) : undefined;
    if (
      !run ||
      !status ||
      Date.parse(run.completedAt || run.updatedAt) > settledBefore
    ) {
      return undefined;
    }
    return status === "succeeded"
      ? { status, output: workflowResultReceipt(run.result) }
      : { status, error: status === "failed" ? run.error : undefined };
  }
  const run = await getAgentRun(attempt.executorId, {
    tenantId: attempt.tenantId,
  });
  const status = run ? attemptStatusForRun(run.status) : undefined;
  if (
    !run ||
    !status ||
    Date.parse(run.completedAt || run.startedAt) > settledBefore
  ) {
    return undefined;
  }
  if (status !== "succeeded") {
    return { status, error: status === "failed" ? run.error : undefined };
  }
  const agentId = durableSpecialistAgentId(attempt);
  return agentId
    ? {
        status,
        output: durableSpecialistReceipt(agentId, run.response),
        findings: { agentId, response: run.response },
      }
    : { status, output: agentRunReceipt(run.response) };
}

function attemptStatusForRun(status: string): AttemptEnd["status"] | undefined {
  if (status === "completed") return "succeeded";
  return status === "failed" || status === "canceled" ? status : undefined;
}

function durableSpecialistAgentId(attempt: MissionAttempt) {
  return attempt.executorType === "agent_run" &&
    attempt.input.kind === "durable_specialist" &&
    isDurableSpecialistAgentId(attempt.input.agentId)
    ? attempt.input.agentId
    : undefined;
}

function agentRunReceipt(response = "") {
  return {
    responseLength: response.length,
    responseSha256: createHash("sha256").update(response).digest("hex"),
  };
}

function maintenanceOwner(
  tenantId: string,
  actorId: string,
  correlationId: string,
): MissionOwner {
  return {
    tenantId,
    actorId,
    executionScope: createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "omniagent-maintenance",
      correlationId,
      purpose: "mission.reconcile",
    }),
  };
}

function logRepairFailure(
  tenantId: string,
  item: { attemptId: string } | { missionId: string },
  error: unknown,
) {
  console.error(JSON.stringify({
    level: "error",
    msg: "mission_projection_repair_failed",
    tenantId,
    ...item,
    error: String(
      redactSensitive(error instanceof Error ? error.message : error),
    ).slice(0, 500),
  }));
}
