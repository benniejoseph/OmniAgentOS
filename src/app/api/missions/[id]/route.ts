import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  getMissionDetail,
  MissionConflictError,
  MissionNotFoundError,
  MissionTransitionError,
  transitionMission,
  transitionMissionTask,
} from "@/lib/missions/store";
import { toMissionDetailView, toMissionSummaryView } from "@/lib/missions/public";
import type { MissionDetail } from "@/lib/missions/types";
import { syncMissionExecutor } from "@/lib/missions/runtime";
import {
  cancelOperationJobByDedupeKey,
  getAgentExecuteJobDedupeKey,
  getAgentResumeJobDedupeKey,
} from "@/lib/operations/job-queue";
import {
  appendRunEvent,
  cancelAgentRun,
  getAgentRun,
} from "@/lib/runs/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { cancelWorkflowRunTick } from "@/lib/workflows/queue";
import {
  signalWorkflowRun,
  WorkflowSignalConflictError,
} from "@/lib/workflows/runner";
import { getWorkflowRunDetail } from "@/lib/workflows/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const transitionSchema = z.object({
  status: z.enum(["canceled", "archived"]),
}).strict();

async function GETHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "mission",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const detail = await getMissionDetail(id, {
    tenantId: context.tenantId,
    actorId: context.actorId,
  }, { tasks: 30, attempts: 100, artifacts: 50 });
  return detail
    ? Response.json(toMissionDetailView(detail), { headers: { "cache-control": "private, no-store" } })
    : Response.json({ error: "Mission not found." }, { status: 404 });
}

async function PATCHHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid mission transition",
      details: parsed.error.flatten(),
    }, { status: 400 });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "mission",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const owner = {
      tenantId: context.tenantId,
      actorId: context.actorId,
    };
    const detail = await getMissionDetail(id, owner);
    if (!detail) {
      return Response.json({ error: "Mission not found." }, { status: 404 });
    }

    if (parsed.data.status === "archived") {
      if (!["succeeded", "failed", "canceled", "archived"].includes(detail.mission.status)) {
        return Response.json({
          error: "Only a terminal mission can be archived.",
          message: "Cancel the mission or let it finish before archiving it.",
        }, { status: 409 });
      }
      const mission = await transitionMission(id, "archived", owner);
      return Response.json({ mission: toMissionSummaryView(mission), canceledExecutors: [] });
    }

    if (detail.mission.status === "canceled") {
      return Response.json({ mission: toMissionSummaryView(detail.mission), canceledExecutors: [] });
    }
    if (["succeeded", "failed", "archived"].includes(detail.mission.status)) {
      return Response.json({
        error: `Mission cannot be canceled after it is ${detail.mission.status}.`,
      }, { status: 409 });
    }

    const cancellationPlan = await buildCancellationPlan(detail, context.tenantId);
    const canceledExecutors = await cancelLinkedExecutors(cancellationPlan, owner);
    for (const task of detail.tasks) {
      if (!["succeeded", "failed", "canceled"].includes(task.status)) {
        await transitionMissionTask(task.id, "canceled", owner);
      }
    }
    const mission = await transitionMission(id, "canceled", owner);
    return Response.json({ mission: toMissionSummaryView(mission), canceledExecutors });
  } catch (error) {
    if (error instanceof MissionNotFoundError) {
      return Response.json({ error: "Mission not found." }, { status: 404 });
    }
    if (error instanceof MissionTransitionError || error instanceof MissionConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof MissionCancellationBlockedError) {
      return Response.json({
        error: "Mission cancellation was not acknowledged.",
        message: error.message,
        executor: error.executor,
      }, { status: 409 });
    }
    throw error;
  }
}

type CancellationOwner = { tenantId: string; actorId: string };

type CancellationTarget =
  | {
      kind: "agent_run";
      id: string;
      status: "queued" | "running" | "waiting_approval" | "resuming" | "canceled";
      executionId?: string;
    }
  | {
      kind: "workflow_run";
      id: string;
      status: "queued" | "running" | "paused" | "waiting_approval" | "canceled";
    };

class MissionCancellationBlockedError extends Error {
  constructor(message: string, readonly executor?: { type: string; id: string }) {
    super(message);
  }
}

async function buildCancellationPlan(
  detail: MissionDetail,
  tenantId: string,
): Promise<CancellationTarget[]> {
  const activeAttempts = detail.attempts.filter((attempt) =>
    ["queued", "running", "waiting"].includes(attempt.status)
  );
  return Promise.all(activeAttempts.map(async (attempt): Promise<CancellationTarget> => {
    const executor = { type: attempt.executorType, id: attempt.executorId };
    if (attempt.executorType === "agent_run") {
      const run = await getAgentRun(attempt.executorId, { tenantId });
      if (!run) {
        throw new MissionCancellationBlockedError("The linked agent run could not be found, so cancellation stopped fail-closed.", executor);
      }
      if (!["queued", "running", "waiting_approval", "resuming", "canceled"].includes(run.status)) {
        throw new MissionCancellationBlockedError(`The linked agent run is already ${run.status}; reconcile the mission before canceling it.`, executor);
      }
      return {
        kind: "agent_run",
        id: run.id,
        status: run.status as "queued" | "running" | "waiting_approval" | "resuming" | "canceled",
        executionId: run.continuation?.pendingToolCall.executionId,
      };
    }
    if (attempt.executorType === "workflow_run") {
      const workflow = await getWorkflowRunDetail(attempt.executorId, { tenantId });
      if (!workflow) {
        throw new MissionCancellationBlockedError("The linked workflow could not be found, so cancellation stopped fail-closed.", executor);
      }
      if (!["queued", "running", "paused", "waiting_approval", "canceled"].includes(workflow.run.status)) {
        throw new MissionCancellationBlockedError(`The linked workflow is already ${workflow.run.status}; reconcile the mission before canceling it.`, executor);
      }
      return {
        kind: "workflow_run",
        id: workflow.run.id,
        status: workflow.run.status as "queued" | "running" | "paused" | "waiting_approval" | "canceled",
      };
    }
    throw new MissionCancellationBlockedError("This mission is linked to an executor type that cannot yet acknowledge cancellation.", executor);
  }));
}

async function cancelLinkedExecutors(
  targets: CancellationTarget[],
  owner: CancellationOwner,
) {
  const canceled: Array<{ type: CancellationTarget["kind"]; id: string }> = [];
  for (const target of targets) {
    if (target.kind === "agent_run") {
      const reason = "Canceled with the parent mission.";
      if (target.status !== "canceled") {
        await cancelAgentRun(target.id, reason);
        const current = await getAgentRun(target.id, { tenantId: owner.tenantId });
        if (current?.status !== "canceled") {
          throw new MissionCancellationBlockedError("The linked agent run did not acknowledge cancellation.", { type: target.kind, id: target.id });
        }
        await appendRunEvent(target.id, { type: "canceled", message: reason }, { tenantId: owner.tenantId });
      }
      if (target.executionId) {
        await cancelOperationJobByDedupeKey(
          getAgentResumeJobDedupeKey(target.executionId),
          reason,
          { tenantId: owner.tenantId },
        );
      }
      await cancelOperationJobByDedupeKey(
        getAgentExecuteJobDedupeKey(target.id),
        reason,
        { tenantId: owner.tenantId },
      );
      const synced = await syncMissionExecutor({
        executorType: "agent_run",
        executorId: target.id,
        status: "canceled",
      }, owner);
      if (!synced) {
        throw new MissionCancellationBlockedError("The linked agent attempt could not acknowledge cancellation.", { type: target.kind, id: target.id });
      }
    } else {
      if (target.status !== "canceled") {
        try {
          await signalWorkflowRun(target.id, "cancel", {
            tenantId: owner.tenantId,
            actorId: owner.actorId,
            reason: "Canceled with the parent mission.",
          });
        } catch (error) {
          if (!(error instanceof WorkflowSignalConflictError)) throw error;
        }
      }
      await cancelWorkflowRunTick(target.id, "Canceled with the parent mission.", owner.tenantId);
      const current = await getWorkflowRunDetail(target.id, { tenantId: owner.tenantId });
      if (current?.run.status !== "canceled") {
        throw new MissionCancellationBlockedError("The linked workflow did not acknowledge cancellation.", { type: target.kind, id: target.id });
      }
      const synced = await syncMissionExecutor({
        executorType: "workflow_run",
        executorId: target.id,
        status: "canceled",
      }, owner);
      if (!synced) {
        throw new MissionCancellationBlockedError("The linked workflow attempt could not acknowledge cancellation.", { type: target.kind, id: target.id });
      }
    }
    canceled.push({ type: target.kind, id: target.id });
  }
  return canceled;
}
