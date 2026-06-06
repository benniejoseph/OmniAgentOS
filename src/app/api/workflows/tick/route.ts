import { z } from "zod";
import {
  ALERT_SCHEDULER_DISPATCH_LIMIT,
  ALERT_SCHEDULER_QUEUE_LIMIT,
} from "@/lib/config";
import { getAlertDeliveryStats, runScheduledAlertDispatch } from "@/lib/diagnostics/alerts";
import { runObservabilitySloMonitor } from "@/lib/observability/slo-monitor";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { recordSecurityAudit } from "@/lib/security/audit-store";
import { SecurityPolicyError } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import type { SecurityContext } from "@/lib/security/types";
import { getOperationJobStats } from "@/lib/operations/job-queue";
import { processWorkflowQueue } from "@/lib/workflows/queue";

export const runtime = "nodejs";

const tickSchema = z.object({
  limit: z.number().int().min(1).max(10).optional(),
  slo: z.boolean().optional(),
  alerts: z.boolean().optional(),
  alertQueueLimit: z.number().int().min(1).max(50).optional(),
  alertDispatchLimit: z.number().int().min(1).max(50).optional(),
});

const cronTickLimit = 5;

export async function GET(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "cron-tick");
  const cronSecret = process.env.CRON_SECRET?.trim();
  const context = getCronSecurityContext();

  if (!cronSecret) {
    await recordSecurityAudit({
      context,
      action: "manage.workflow",
      resourceType: "workflow_queue",
      decision: "deny",
      reason: "CRON_SECRET is not configured.",
      metadata: { trigger: "vercel_cron" },
    });

    return Response.json(
      { error: "Cron is not configured.", message: "CRON_SECRET is required for scheduled workflow and alert ticks." },
      { status: 503 },
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    await recordSecurityAudit({
      context,
      action: "manage.workflow",
      resourceType: "workflow_queue",
      decision: "deny",
      reason: "Invalid cron authorization.",
      metadata: { trigger: "vercel_cron" },
    });

    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [queue, slo] = await Promise.all([
      processWorkflowQueue({ limit: cronTickLimit }),
      runObservabilitySloMonitor({
        trigger: "vercel_cron",
        actorId: context.actorId,
        correlationId: telemetry.correlationId,
        queueAlerts: false,
      }),
    ]);
    const alerts = await runScheduledAlertDispatch({
      trigger: "vercel_cron",
      queueLimit: ALERT_SCHEDULER_QUEUE_LIMIT,
      dispatchLimit: ALERT_SCHEDULER_DISPATCH_LIMIT,
    });
    await recordSecurityAudit({
      context,
      action: "manage.workflow",
      resourceType: "workflow_queue",
      decision: "allow",
      reason: "Vercel Cron workflow and alert tick.",
      metadata: {
        trigger: "vercel_cron",
        workflowLimit: cronTickLimit,
        workflowLeased: queue.leased,
        sloHealthy: slo.healthy,
        sloBreaches: slo.breaches.length,
        sloIncidentActions: slo.incidentActions.length,
        alertQueueLimit: alerts.scheduler.queueLimit,
        alertDispatchLimit: alerts.scheduler.dispatchLimit,
        alertEnqueued: alerts.enqueued.length,
        alertProcessed: alerts.dispatch.processed.length,
        alertDelivered: alerts.dispatch.delivered,
        alertFailed: alerts.dispatch.failed,
      },
    });
    await recordRuntimeEventSafely({
      category: "workflow",
      action: "workflow_tick.cron",
      route: "/api/workflows/tick",
      method: "GET",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "workflow_queue",
      message: "Vercel Cron workflow and alert tick completed.",
      metadata: {
        workflowLeased: queue.leased,
        workflowCompleted: queue.completed,
        sloHealthy: slo.healthy,
        sloBreaches: slo.breaches.length,
        sloIncidentActions: slo.incidentActions.length,
        alertEnqueued: alerts.enqueued.length,
        alertProcessed: alerts.dispatch.processed.length,
        alertDelivered: alerts.dispatch.delivered,
        alertFailed: alerts.dispatch.failed,
      },
    });

    return Response.json({
      queue,
      slo,
      alerts,
      stats: {
        operationJobs: await getOperationJobStats(),
        alerts: alerts.stats,
      },
      count: queue.leased,
      trigger: "vercel_cron",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled tick failed.";
    console.error(JSON.stringify({
      level: "error",
      msg: "failed",
      route: "/api/workflows/tick",
      trigger: "vercel_cron",
      error: message,
    }));
    await recordSecurityAudit({
      context,
      action: "manage.workflow",
      resourceType: "workflow_queue",
      decision: "allow",
      reason: "Vercel Cron tick failed after authorization.",
      metadata: { trigger: "vercel_cron", error: message },
    }).catch(() => undefined);
    await recordRuntimeEventSafely({
      level: "error",
      category: "workflow",
      action: "workflow_tick.cron_failed",
      route: "/api/workflows/tick",
      method: "GET",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "workflow_queue",
      message: "Vercel Cron workflow and alert tick failed.",
      metadata: { error: message },
    });

    return Response.json({ error: message, trigger: "vercel_cron" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "workflow-tick");
  const body = await request.json().catch(() => ({}));
  const parsed = tickSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow tick request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow_queue",
      metadata: parsed.data,
    });
    const queue = await processWorkflowQueue({ limit: parsed.data.limit || 5 });
    const slo = parsed.data.slo
      ? await runObservabilitySloMonitor({
          trigger: "operator.workflow_tick",
          actorId: context.actorId,
          correlationId: telemetry.correlationId,
          queueAlerts: !parsed.data.alerts,
        })
      : undefined;
    const alerts = parsed.data.alerts
      ? await runScheduledAlertDispatch({
          trigger: "operator.workflow_tick",
          queueLimit: parsed.data.alertQueueLimit || ALERT_SCHEDULER_QUEUE_LIMIT,
          dispatchLimit: parsed.data.alertDispatchLimit || ALERT_SCHEDULER_DISPATCH_LIMIT,
        })
      : undefined;
    const stats = {
      operationJobs: await getOperationJobStats(),
      alerts: alerts?.stats || await getAlertDeliveryStats(),
    };
    await recordRuntimeEventSafely({
      category: "workflow",
      action: "workflow_tick.operator",
      route: "/api/workflows/tick",
      method: "POST",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "workflow_queue",
      message: "Operator workflow queue tick completed.",
      metadata: {
        workflowLeased: queue.leased,
        workflowCompleted: queue.completed,
        sloEnabled: Boolean(parsed.data.slo),
        sloHealthy: slo?.healthy,
        sloBreaches: slo?.breaches.length || 0,
        sloIncidentActions: slo?.incidentActions.length || 0,
        alertsEnabled: Boolean(parsed.data.alerts),
        alertEnqueued: alerts?.enqueued.length || 0,
        alertProcessed: alerts?.dispatch.processed.length || 0,
      },
    });
    return Response.json({
      queue,
      slo,
      alerts,
      stats,
      count: queue.leased,
    });
  } catch (error) {
    if (error instanceof SecurityPolicyError) {
      return forbiddenResponse(error);
    }
    await recordRuntimeEventSafely({
      level: "error",
      category: "workflow",
      action: "workflow_tick.operator_failed",
      route: "/api/workflows/tick",
      method: "POST",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      resourceType: "workflow_queue",
      message: "Operator workflow queue tick failed.",
      metadata: { error: error instanceof Error ? error.message : "Workflow tick failed." },
    });
    return Response.json(
      { error: error instanceof Error ? error.message : "Workflow tick failed." },
      { status: 500 },
    );
  }
}

function getCronSecurityContext(): SecurityContext {
  return {
    tenantId: process.env.OMNIAGENT_DEFAULT_TENANT || "default",
    actorId: "vercel-cron",
    role: "system",
    source: "default",
  };
}
