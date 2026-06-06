import { z } from "zod";
import {
  dispatchAlertDeliveries,
  enqueueAlertDeliveriesForActiveIncidents,
  getAlertDeliveryPolicies,
  getAlertDeliveryStats,
  listAlertDeliveries,
  type AlertDeliveryStatus,
} from "@/lib/diagnostics/alerts";
import { getIncidentAlertTargets } from "@/lib/diagnostics/incidents";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const alertActionSchema = z.object({
  action: z.enum(["enqueue_active", "dispatch", "enqueue_and_dispatch"]),
  limit: z.number().int().min(1).max(50).optional(),
});

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const status = normalizeStatus(url.searchParams.get("status"));
  const incidentId = url.searchParams.get("incidentId") || undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 200);
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

  try {
    await authorizeRequest({
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
      listAlertDeliveries({ incidentId, status, limit }),
      getAlertDeliveryStats(),
    ]);
    console.log(JSON.stringify({
      level: "info",
      msg: "done",
      route: "/api/alerts",
      method: "GET",
      deliveries: deliveries.length,
      ms: Date.now() - startedAt,
    }));
    return Response.json({
      deliveries,
      stats,
      policies: getAlertDeliveryPolicies(),
      targets: getIncidentAlertTargets("critical"),
    });
  } catch (error) {
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

export async function POST(request: Request) {
  const startedAt = Date.now();
  const parsed = alertActionSchema.safeParse(await request.json().catch(() => ({})));
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

  try {
    await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "alert_delivery",
      metadata: parsed.data,
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
      ? await enqueueAlertDeliveriesForActiveIncidents(limit)
      : [];
    const dispatch = parsed.data.action === "dispatch" || parsed.data.action === "enqueue_and_dispatch"
      ? await dispatchAlertDeliveries(limit)
      : undefined;
    console.log(JSON.stringify({
      level: "info",
      msg: "done",
      route: "/api/alerts",
      method: "POST",
      action: parsed.data.action,
      enqueued: enqueued.length,
      processed: dispatch?.processed.length || 0,
      ms: Date.now() - startedAt,
    }));
    return Response.json({
      enqueued,
      dispatch,
      stats: await getAlertDeliveryStats(),
    });
  } catch (error) {
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
