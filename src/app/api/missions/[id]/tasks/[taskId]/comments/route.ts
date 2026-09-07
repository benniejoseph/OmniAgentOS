import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  commentOnMissionTaskService,
  missionTaskCommentServiceInputSchema,
} from "@/lib/app-services/missions";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { missionMutationFromRequest } from "@/lib/missions/request-mutation";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  missionTaskMutationError,
  PRIVATE_NO_STORE_HEADERS,
} from "../../_shared";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const commentSchema = missionTaskCommentServiceInputSchema.omit({
  missionId: true,
  taskId: true,
});

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
    const mutation = missionMutationFromRequest(request, context, {
        purpose: "mission.task.comment.create",
        missionId: id,
        causationId: taskId,
      });
    const result = await commentOnMissionTaskService(
      createAppServiceCaller({
        context,
        executionScope: mutation.executionScope,
        idempotencyKey: mutation.idempotencyKey,
      }),
      { ...parsed.data, missionId: id, taskId },
    );
    if (!result.data.comment) {
      return Response.json({ error: "Mission task not found." }, {
        status: 404,
        headers: PRIVATE_NO_STORE_HEADERS,
      });
    }
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, {
      status: 201,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  } catch (error) {
    return missionTaskMutationError(error);
  }
}
