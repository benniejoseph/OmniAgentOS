import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  createMissionTaskService,
  missionTaskCreateServiceInputSchema,
} from "@/lib/app-services/missions";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { missionMutationFromRequest } from "@/lib/missions/request-mutation";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  missionTaskMutationError,
  PRIVATE_NO_STORE_HEADERS,
} from "./_shared";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const createTaskSchema = missionTaskCreateServiceInputSchema.omit({
  missionId: true,
});

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request, 32_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = createTaskSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid mission task", details: parsed.error.flatten() }, {
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
      resourceId: id,
      metadata: { operation: "create" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const mutation = missionMutationFromRequest(request, context, {
        purpose: "mission.task.create",
        missionId: id,
      });
    const result = await createMissionTaskService(
      createAppServiceCaller({
        context,
        executionScope: mutation.executionScope,
        idempotencyKey: mutation.idempotencyKey,
      }),
      { ...parsed.data, missionId: id },
    );
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
