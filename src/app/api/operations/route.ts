import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { getOperationsOverview } from "@/lib/operations/queue";
import { reconcileOperationsRecovery } from "@/lib/operations/recovery";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const operationsActionSchema = z.object({
  action: z.enum(["inspect_recovery", "repair_recovery", "drain_recovery"]),
  limit: z.number().int().min(1).max(50).optional(),
  drainLimit: z.number().int().min(1).max(10).optional(),
  staleWorkflowMs: z.number().int().min(0).max(86_400_000).optional(),
  failAfterMs: z.number().int().min(60_000).max(604_800_000).optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "operations",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  return Response.json(await getOperationsOverview({ tenantId: context.tenantId }));
}

async function POSTHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "operations-recovery");
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = operationsActionSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid operations action", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context: Awaited<ReturnType<typeof authorizeRequest>>;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "operations_recovery",
      metadata: {
        action: parsed.data.action,
        limit: parsed.data.limit,
        drainLimit: parsed.data.drainLimit,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const mode = parsed.data.action === "drain_recovery"
      ? "drain"
      : parsed.data.action === "repair_recovery"
        ? "repair"
        : "inspect";
    const recovery = await reconcileOperationsRecovery({
      mode,
      limit: parsed.data.limit,
      drainLimit: parsed.data.drainLimit,
      staleWorkflowMs: parsed.data.staleWorkflowMs,
      failAfterMs: parsed.data.failAfterMs,
      actorId: context.actorId,
      tenantId: context.tenantId,
    });
    const overview = await getOperationsOverview({ tenantId: context.tenantId });
    await recordRuntimeEventSafely({
      category: "workflow",
      action: `operations.${parsed.data.action}`,
      route: "/api/operations",
      method: "POST",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "operations_recovery",
      message: "Operations recovery action completed.",
      metadata: {
        action: parsed.data.action,
        mode: recovery.mode,
        staleWorkflows: recovery.staleWorkflows.length,
        requeuedWorkflows: recovery.requeuedWorkflows,
        failedWorkflows: recovery.failedWorkflows,
        expiredLeasesRepaired: recovery.expiredLeasesRepaired,
        drainLeased: recovery.drain?.leased || 0,
      },
    });
    return Response.json({ recovery, overview });
  } catch (error) {
    await recordRuntimeEventSafely({
      level: "error",
      category: "workflow",
      action: `operations.${parsed.data.action}.failed`,
      route: "/api/operations",
      method: "POST",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "operations_recovery",
      message: "Operations recovery action failed.",
      metadata: { error: error instanceof Error ? error.message : "Operations recovery failed." },
    });
    return Response.json(
      { error: error instanceof Error ? error.message : "Operations recovery failed." },
      { status: 500 },
    );
  }
}
