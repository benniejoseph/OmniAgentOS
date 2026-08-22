import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  dispatchAlertDeliveries,
  enqueueAlertDeliveriesForActiveIncidents,
  getAlertDeliveryPolicies,
  getAlertDeliveryStats,
  getAlertTargetHealth,
  listAlertDeliveries,
  retryFailedAlertDeliveries,
  type AlertDeliveryStatus,
} from "@/lib/diagnostics/alerts";
import { getIncidentAlertTargets } from "@/lib/diagnostics/incidents";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const alertActionSchema = z.object({
  action: z.enum(["enqueue_active", "dispatch", "enqueue_and_dispatch", "probe_targets", "retry_failed"]),
  limit: z.number().int().min(1).max(50).optional(),
  includeSkipped: z.boolean().optional(),
}).strict();

async function GETHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "alerts");
  const url = new URL(request.url);
  const status = normalizeStatus(url.searchParams.get("status"));
  const incidentId =
    url.searchParams.get("incidentId")?.trim().slice(0, 120) || undefined;
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, {
    max: 200,
  });
  console.log(JSON.stringify({
    level: "info",
    msg: "start",
    route: "/api/alerts",
    method: "GET",
    requestId: request.headers.get("x-vercel-id"),
    status,
    incidentId,
    limit,
  }));

  let context: Awaited<ReturnType<typeof authorizeRequest>>;
  try {
    context = await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "alert_delivery",
      metadata: { status, incidentId, limit },
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "forbidden",
      route: "/api/alerts",
      method: "GET",
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Forbidden",
    }));
    return forbiddenResponse(error);
  }

  try {
    const [deliveries, stats] = await Promise.all([
      listAlertDeliveries({ tenantId: context.tenantId, incidentId, status, limit }),
      getAlertDeliveryStats({ tenantId: context.tenantId }),
    ]);
    console.log(JSON.stringify({
      level: "info",
      msg: "done",
      route: "/api/alerts",
      method: "GET",
      deliveries: deliveries.length,
      ms: Date.now() - startedAt,
    }));
    await recordRuntimeEventSafely({
      category: "alert",
      action: "alerts.list",
      route: "/api/alerts",
      method: "GET",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      resourceType: "alert_delivery",
      message: "Listed alert deliveries and target health.",
      metadata: {
        deliveries: deliveries.length,
        status,
        incidentId,
        limit,
        queued: stats.queued,
        failed: stats.failed,
        blockedExternalTargets: stats.blockedExternalTargets,
      },
    });
    return Response.json({
      deliveries,
      stats,
      policies: getAlertDeliveryPolicies(),
      targets: getIncidentAlertTargets("critical"),
      targetHealth: stats.targetHealth,
    });
  } catch (error) {
    await recordRuntimeEventSafely({
      level: "error",
      category: "alert",
      action: "alerts.list_failed",
      route: "/api/alerts",
      method: "GET",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      resourceType: "alert_delivery",
      message: "Alert delivery list failed.",
      metadata: { error: error instanceof Error ? error.message : "Alert delivery list failed." },
    });
    console.error(JSON.stringify({
      level: "error",
      msg: "failed",
      route: "/api/alerts",
      method: "GET",
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Alert delivery list failed.",
    }));
    return Response.json({ error: "Alert delivery list failed." }, { status: 500 });
  }
}

async function POSTHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "alerts");
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = alertActionSchema.safeParse(body);
  console.log(JSON.stringify({
    level: "info",
    msg: "start",
    route: "/api/alerts",
    method: "POST",
    requestId: request.headers.get("x-vercel-id"),
    action: parsed.success ? parsed.data.action : "invalid",
  }));

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid alert action", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context: Awaited<ReturnType<typeof authorizeRequest>>;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "alert_delivery",
      metadata: {
        action: parsed.data.action,
        limit: parsed.data.limit,
        includeSkipped: parsed.data.includeSkipped,
      },
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "forbidden",
      route: "/api/alerts",
      method: "POST",
      action: parsed.data.action,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Forbidden",
    }));
    return forbiddenResponse(error);
  }

  try {
    const limit = parsed.data.limit || 10;
    const enqueued = parsed.data.action === "enqueue_active" || parsed.data.action === "enqueue_and_dispatch"
      ? await enqueueAlertDeliveriesForActiveIncidents(limit, {
          tenantId: context.tenantId,
        })
      : [];
    const dispatch = parsed.data.action === "dispatch" || parsed.data.action === "enqueue_and_dispatch"
      ? await dispatchAlertDeliveries(limit, { tenantId: context.tenantId })
      : undefined;
    const retried = parsed.data.action === "retry_failed"
      ? await retryFailedAlertDeliveries({
          tenantId: context.tenantId,
          limit,
          includeSkipped: parsed.data.includeSkipped ?? true,
        })
      : [];
    const targetHealth = parsed.data.action === "probe_targets"
      ? getAlertTargetHealth()
      : undefined;
    const stats = await getAlertDeliveryStats({ tenantId: context.tenantId });
    console.log(JSON.stringify({
      level: "info",
      msg: "done",
      route: "/api/alerts",
      method: "POST",
      action: parsed.data.action,
      enqueued: enqueued.length,
      processed: dispatch?.processed.length || 0,
      retried: retried.length,
      probed: targetHealth?.length || 0,
      ms: Date.now() - startedAt,
    }));
    await recordRuntimeEventSafely({
      category: "alert",
      action: `alerts.${parsed.data.action}`,
      route: "/api/alerts",
      method: "POST",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "alert_delivery",
      message: `Alert action ${parsed.data.action} completed.`,
      metadata: {
        enqueued: enqueued.length,
        processed: dispatch?.processed.length || 0,
        delivered: dispatch?.delivered || 0,
        failed: dispatch?.failed || 0,
        retried: retried.length,
        probed: targetHealth?.length || 0,
        queued: stats.queued,
        retryableFailed: stats.retryableFailed,
      },
    });
    return Response.json({
      enqueued,
      dispatch,
      retried,
      targetHealth,
      stats,
    });
  } catch (error) {
    await recordRuntimeEventSafely({
      level: "error",
      category: "alert",
      action: parsed.success ? `alerts.${parsed.data.action}.failed` : "alerts.invalid_failed",
      route: "/api/alerts",
      method: "POST",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      resourceType: "alert_delivery",
      message: "Alert action failed.",
      metadata: { error: error instanceof Error ? error.message : "Alert action failed." },
    });
    console.error(JSON.stringify({
      level: "error",
      msg: "failed",
      route: "/api/alerts",
      method: "POST",
      action: parsed.data.action,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Alert action failed.",
    }));
    return Response.json(
      { error: error instanceof Error ? error.message : "Alert action failed." },
      { status: 500 },
    );
  }
}

function normalizeStatus(value: string | null): AlertDeliveryStatus | "all" {
  if (value === "queued" || value === "running" || value === "delivered" || value === "failed" || value === "skipped") {
    return value;
  }
  return "all";
}
