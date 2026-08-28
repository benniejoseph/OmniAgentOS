import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { ensureMissionTask } from "@/lib/missions/store";
import { toMissionTaskView } from "@/lib/missions/public";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  missionTaskMutationError,
  missionTaskSourceKey,
  PRIVATE_NO_STORE_HEADERS,
} from "./_shared";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const blockerSchema = z.object({
  kind: z.enum(["dependency", "needs_input", "capability", "transient"]),
  reason: z.string().trim().min(1).max(4_000),
}).strict();

const createTaskSchema = z.object({
  sourceKey: z.string().trim().min(1).max(240).optional(),
  title: z.string().trim().min(1).max(280),
  instructions: z.string().trim().max(8_000).optional(),
  definitionOfDone: z.string().trim().max(2_000).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  position: z.number().int().min(0).max(100_000).optional(),
  parentTaskId: z.string().trim().min(1).max(240).optional(),
  dependencyIds: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
  status: z.enum(["triage", "pending"]).optional(),
  assigneeId: z.string().trim().min(1).max(200).optional(),
  assigneeKey: z.string().trim().min(1).max(200).optional(),
  assigneeName: z.string().trim().min(1).max(160).optional(),
  skillIds: z.array(z.string().trim().min(1).max(240)).max(50).optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  blocker: blockerSchema.optional(),
  reviewRequired: z.boolean().optional(),
  reviewerKey: z.string().trim().min(1).max(200).optional(),
  reviewerName: z.string().trim().min(1).max(160).optional(),
}).strict();

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
    const task = await ensureMissionTask(id, {
      sourceKey: missionTaskSourceKey(request, parsed.data.sourceKey, "task", id),
      title: parsed.data.title,
      instructions: parsed.data.instructions,
      definitionOfDone: parsed.data.definitionOfDone,
      priority: parsed.data.priority,
      position: parsed.data.position,
      parentTaskId: parsed.data.parentTaskId,
      dependencyIds: parsed.data.dependencyIds,
      status: parsed.data.status,
      metadata: {
        assigneeKey: parsed.data.assigneeKey || parsed.data.assigneeId,
        assigneeName: parsed.data.assigneeName,
        skillIds: parsed.data.skillIds,
        scheduledAt: parsed.data.scheduledAt,
        blocker: parsed.data.blocker,
        reviewRequired: parsed.data.reviewRequired,
        reviewerKey: parsed.data.reviewerKey,
        reviewerName: parsed.data.reviewerName,
      },
    }, { tenantId: context.tenantId, actorId: context.actorId });
    return Response.json({ task: toMissionTaskView(task) }, {
      status: 201,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  } catch (error) {
    return missionTaskMutationError(error);
  }
}
