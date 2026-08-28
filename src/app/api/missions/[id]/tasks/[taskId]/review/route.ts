import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { toMissionArtifactView, toMissionTaskView } from "@/lib/missions/public";
import { reconcileMissionState } from "@/lib/missions/runtime";
import {
  approveMissionTaskReview,
  getMissionTask,
  requestMissionTaskChanges,
  requestMissionTaskReview,
} from "@/lib/missions/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  missionTaskMutationError,
  missionTaskSourceKey,
  PRIVATE_NO_STORE_HEADERS,
} from "../../_shared";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const reviewSchema = z.object({
  action: z.enum(["request", "request_review", "approve", "request_changes"]),
  summary: z.string().trim().max(4_000).optional(),
  reason: z.string().trim().max(4_000).optional(),
  comment: z.string().trim().max(4_000).optional(),
  reviewerKey: z.string().trim().min(1).max(200).optional(),
  reviewerName: z.string().trim().min(1).max(160).optional(),
  sourceKey: z.string().trim().min(1).max(240).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "request_changes" && !(value.reason || value.comment)) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "A reason is required when requesting changes.",
    });
  }
});

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request, 16_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid task review", details: parsed.error.flatten() }, {
      status: 400,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "mission_task_review",
      resourceId: taskId,
      metadata: { operation: parsed.data.action, missionId: id },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const owner = { tenantId: context.tenantId, actorId: context.actorId };
    const current = await getMissionTask(taskId, owner);
    if (!current || current.missionId !== id) {
      return Response.json({ error: "Mission task not found." }, {
        status: 404,
        headers: PRIVATE_NO_STORE_HEADERS,
      });
    }
    const sourceKey = missionTaskSourceKey(request, parsed.data.sourceKey, "review", current.id);
    const result = parsed.data.action === "approve"
      ? await approveMissionTaskReview(current.id, {
          summary: parsed.data.summary || parsed.data.comment,
          sourceKey,
        }, owner)
      : parsed.data.action === "request_changes"
        ? await requestMissionTaskChanges(current.id, {
            reason: parsed.data.reason || parsed.data.comment || "",
            sourceKey,
          }, owner)
        : await requestMissionTaskReview(current.id, {
            summary: parsed.data.summary || parsed.data.comment,
            reviewerKey: parsed.data.reviewerKey,
            reviewerName: parsed.data.reviewerName,
            sourceKey,
          }, owner);
    await reconcileMissionState(result.task.missionId, owner);
    return Response.json({
      task: toMissionTaskView(result.task),
      review: toMissionArtifactView(result.review),
    }, { headers: PRIVATE_NO_STORE_HEADERS });
  } catch (error) {
    return missionTaskMutationError(error);
  }
}
