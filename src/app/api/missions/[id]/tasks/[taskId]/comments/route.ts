import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { toMissionArtifactView } from "@/lib/missions/public";
import { appendMissionTaskComment, getMissionTask } from "@/lib/missions/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  missionTaskMutationError,
  missionTaskSourceKey,
  PRIVATE_NO_STORE_HEADERS,
} from "../../_shared";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const commentSchema = z.object({
  body: z.string().trim().min(1).max(8_000),
  sourceKey: z.string().trim().min(1).max(240).optional(),
}).strict();

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request, 12_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = commentSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid task comment", details: parsed.error.flatten() }, {
      status: 400,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "mission_task_comment",
      resourceId: taskId,
      metadata: { operation: "create", missionId: id },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const owner = { tenantId: context.tenantId, actorId: context.actorId };
    const task = await getMissionTask(taskId, owner);
    if (!task || task.missionId !== id) {
      return Response.json({ error: "Mission task not found." }, {
        status: 404,
        headers: PRIVATE_NO_STORE_HEADERS,
      });
    }
    const comment = await appendMissionTaskComment(task.id, {
      body: parsed.data.body,
      sourceKey: missionTaskSourceKey(request, parsed.data.sourceKey, "comment", task.id),
    }, owner);
    return Response.json({ comment: toMissionArtifactView(comment) }, {
      status: 201,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  } catch (error) {
    return missionTaskMutationError(error);
  }
}
