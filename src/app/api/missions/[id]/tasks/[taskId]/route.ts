import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { toMissionTaskView } from "@/lib/missions/public";
import {
  getMissionTask,
  MissionConflictError,
  MissionTransitionError,
  transitionMissionTask,
  updateMissionTask,
} from "@/lib/missions/store";
import { reconcileMissionState } from "@/lib/missions/runtime";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  missionTaskMutationError,
  PRIVATE_NO_STORE_HEADERS,
  sameTimestamp,
} from "../_shared";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const blockerSchema = z.object({
  kind: z.enum(["dependency", "needs_input", "capability", "transient"]),
  reason: z.string().trim().min(1).max(4_000),
}).strict();

const metadataPatchSchema = z.object({
  assigneeKey: z.string().trim().min(1).max(200).nullable().optional(),
  assigneeName: z.string().trim().min(1).max(160).nullable().optional(),
  skillIds: z.array(z.string().trim().min(1).max(240)).max(50).nullable().optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  blocker: blockerSchema.nullable().optional(),
  reviewRequired: z.boolean().nullable().optional(),
  reviewerKey: z.string().trim().min(1).max(200).nullable().optional(),
  reviewerName: z.string().trim().min(1).max(160).nullable().optional(),
  reviewRequestedAt: z.string().datetime({ offset: true }).nullable().optional(),
  reviewSummary: z.string().trim().max(4_000).nullable().optional(),
  changesRequestedReason: z.string().trim().max(4_000).nullable().optional(),
}).strict();

const updateTaskSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
  title: z.string().trim().min(1).max(280).optional(),
  instructions: z.string().trim().max(8_000).optional(),
  definitionOfDone: z.string().trim().max(2_000).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  position: z.number().int().min(0).max(100_000).optional(),
  dependencyIds: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
  status: z.enum(["triage", "pending", "running", "blocked", "review", "succeeded", "failed", "canceled"]).optional(),
  metadata: metadataPatchSchema.optional(),
  assigneeId: z.string().trim().min(1).max(200).nullable().optional(),
  assigneeKey: z.string().trim().min(1).max(200).nullable().optional(),
  assigneeName: z.string().trim().min(1).max(160).nullable().optional(),
  skillIds: z.array(z.string().trim().min(1).max(240)).max(50).nullable().optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  blocker: blockerSchema.nullable().optional(),
  reviewRequired: z.boolean().nullable().optional(),
  reviewerKey: z.string().trim().min(1).max(200).nullable().optional(),
  reviewerName: z.string().trim().min(1).max(160).nullable().optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"),
  { message: "A task change is required." },
);

async function PATCHHandler(
  request: Request,
  route: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request, 40_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = updateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid mission task update", details: parsed.error.flatten() }, {
      status: 400,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "mission_task",
      resourceId: taskId,
      metadata: { operation: "update", missionId: id },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const owner = { tenantId: context.tenantId, actorId: context.actorId };
    let task = await getMissionTask(taskId, owner);
    if (!task || task.missionId !== id) {
      return Response.json({ error: "Mission task not found." }, {
        status: 404,
        headers: PRIVATE_NO_STORE_HEADERS,
      });
    }
    if (
      parsed.data.expectedUpdatedAt &&
      !sameTimestamp(task.updatedAt, parsed.data.expectedUpdatedAt)
    ) {
      throw new MissionConflictError("Mission task changed after it was loaded.");
    }
    const reviewRequiredByPatch = parsed.data.reviewRequired === true ||
      parsed.data.metadata?.reviewRequired === true;
    if (
      parsed.data.status === "succeeded" &&
      task.status !== "review" &&
      (task.metadata.reviewRequired === true || reviewRequiredByPatch)
    ) {
      throw new MissionTransitionError(
        "A review-required task must enter review before it can succeed.",
      );
    }

    const nestedMetadata = parsed.data.metadata || {};
    const metadata = {
      ...nestedMetadata,
      ...(parsed.data.assigneeId !== undefined
        ? { assigneeKey: parsed.data.assigneeId }
        : {}),
      ...(parsed.data.assigneeKey !== undefined
        ? { assigneeKey: parsed.data.assigneeKey }
        : {}),
      ...(parsed.data.assigneeName !== undefined
        ? { assigneeName: parsed.data.assigneeName }
        : {}),
      ...(parsed.data.skillIds !== undefined ? { skillIds: parsed.data.skillIds } : {}),
      ...(parsed.data.scheduledAt !== undefined ? { scheduledAt: parsed.data.scheduledAt } : {}),
      ...(parsed.data.blocker !== undefined ? { blocker: parsed.data.blocker } : {}),
      ...(parsed.data.reviewRequired !== undefined
        ? { reviewRequired: parsed.data.reviewRequired }
        : {}),
      ...(parsed.data.reviewerKey !== undefined ? { reviewerKey: parsed.data.reviewerKey } : {}),
      ...(parsed.data.reviewerName !== undefined ? { reviewerName: parsed.data.reviewerName } : {}),
    };
    if (parsed.data.status && parsed.data.status !== "blocked" && !("blocker" in metadata)) {
      metadata.blocker = null;
    }

    const hasEditableFields = [
      "title",
      "instructions",
      "definitionOfDone",
      "priority",
      "position",
      "dependencyIds",
    ].some((key) => parsed.data[key as keyof typeof parsed.data] !== undefined) ||
      Object.keys(metadata).length > 0;

    if (hasEditableFields) {
      task = await updateMissionTask(task.id, {
        expectedUpdatedAt: parsed.data.expectedUpdatedAt,
        title: parsed.data.title,
        instructions: parsed.data.instructions,
        definitionOfDone: parsed.data.definitionOfDone,
        priority: parsed.data.priority,
        position: parsed.data.position,
        dependencyIds: parsed.data.dependencyIds,
        metadata,
      }, owner);
    }
    if (parsed.data.status && parsed.data.status !== task.status) {
      task = await transitionMissionTask(task.id, parsed.data.status, owner);
      await reconcileMissionState(task.missionId, owner);
    }
    return Response.json({ task: toMissionTaskView(task) }, {
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  } catch (error) {
    return missionTaskMutationError(error);
  }
}
