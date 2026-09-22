import { z } from "zod";

import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  getWorkflowTrigger,
  listWorkflowScheduleOccurrenceReceipts,
  listWorkflowScheduleOccurrences,
  previewWorkflowSchedule,
  runWorkflowScheduleOnce,
  setWorkflowSchedulePaused,
  WorkflowScheduleControlError,
} from "@/lib/workflows/triggers";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("pause"),
    reason: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
  z.object({
    action: z.literal("run_once"),
    scheduledFor: z.string().datetime({ offset: true }).optional(),
  }).strict(),
]);

type RouteContext = { params: Promise<{ id: string }> };

async function GETHandler(request: Request, routeContext: RouteContext) {
  const { id } = await routeContext.params;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "workflow_trigger",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const [trigger, preview, occurrences, receipts] = await Promise.all([
      getWorkflowTrigger(id, {
        tenantId: context.tenantId,
        actorId: context.actorId,
      }),
      previewWorkflowSchedule({
        tenantId: context.tenantId,
        actorId: context.actorId,
        triggerId: id,
        count: 6,
      }),
      listWorkflowScheduleOccurrences({
        tenantId: context.tenantId,
        actorId: context.actorId,
        triggerId: id,
        limit: 30,
      }),
      listWorkflowScheduleOccurrenceReceipts({
        tenantId: context.tenantId,
        actorId: context.actorId,
        triggerId: id,
        limit: 60,
      }),
    ]);
    return Response.json({ trigger, preview, occurrences, receipts });
  } catch (error) {
    return scheduleErrorResponse(error);
  }
}

async function POSTHandler(request: Request, routeContext: RouteContext) {
  const { id } = await routeContext.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid schedule control", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow_trigger",
      resourceId: id,
      metadata: { action: parsed.data.action },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const requestId = request.headers.get("idempotency-key")?.trim();
  if (!requestId) {
    return Response.json({
      error: "Idempotency-Key is required for schedule controls.",
      code: "idempotency_key_required",
    }, { status: 428 });
  }
  if (requestId.length > 240) {
    return Response.json({
      error: "Idempotency-Key exceeds 240 characters.",
      code: "idempotency_key_invalid",
    }, { status: 400 });
  }
  const executionScope = executionScopeFromSecurityContext(context, {
    correlationId: `workflow-schedule-control:${requestId}`,
    purpose: `workflow.schedule.${parsed.data.action}`,
  });
  try {
    if (parsed.data.action === "run_once") {
      const occurrence = await runWorkflowScheduleOnce({
        tenantId: context.tenantId,
        actorId: context.actorId,
        triggerId: id,
        scheduledFor: parsed.data.scheduledFor || new Date().toISOString(),
        executionScope,
      });
      return Response.json({ occurrence }, { status: 202 });
    }
    const trigger = await setWorkflowSchedulePaused({
      tenantId: context.tenantId,
      actorId: context.actorId,
      triggerId: id,
      paused: parsed.data.action === "pause",
      reason: parsed.data.action === "pause" ? parsed.data.reason : undefined,
      executionScope,
    });
    return Response.json({ trigger });
  } catch (error) {
    return scheduleErrorResponse(error);
  }
}

function scheduleErrorResponse(error: unknown) {
  if (error instanceof WorkflowScheduleControlError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.code === "not_found" ? 404 : 409 },
    );
  }
  return Response.json(
    {
      error: "Schedule control failed",
      message: error instanceof Error ? error.message : "Unknown error.",
    },
    { status: 400 },
  );
}
