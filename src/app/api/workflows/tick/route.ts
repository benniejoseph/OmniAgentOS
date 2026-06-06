import { z } from "zod";
import {
  ALERT_SCHEDULER_DISPATCH_LIMIT,
  ALERT_SCHEDULER_QUEUE_LIMIT,
} from "@/lib/config";
import { getAlertDeliveryStats, runScheduledAlertDispatch } from "@/lib/diagnostics/alerts";
import { recordSecurityAudit } from "@/lib/security/audit-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import type { SecurityContext } from "@/lib/security/types";
import { getOperationJobStats } from "@/lib/operations/job-queue";
import { processWorkflowQueue } from "@/lib/workflows/queue";

export const runtime = "nodejs";

const tickSchema = z.object({
  limit: z.number().int().min(1).max(10).optional(),
  alerts: z.boolean().optional(),
  alertQueueLimit: z.number().int().min(1).max(50).optional(),
  alertDispatchLimit: z.number().int().min(1).max(50).optional(),
});

const cronTickLimit = 5;

export async function GET(request: Request) {
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
    const [queue, alerts] = await Promise.all([
      processWorkflowQueue({ limit: cronTickLimit }),
      runScheduledAlertDispatch({
        trigger: "vercel_cron",
        queueLimit: ALERT_SCHEDULER_QUEUE_LIMIT,
        dispatchLimit: ALERT_SCHEDULER_DISPATCH_LIMIT,
      }),
    ]);
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
        alertQueueLimit: alerts.scheduler.queueLimit,
        alertDispatchLimit: alerts.scheduler.dispatchLimit,
        alertEnqueued: alerts.enqueued.length,
        alertProcessed: alerts.dispatch.processed.length,
        alertDelivered: alerts.dispatch.delivered,
        alertFailed: alerts.dispatch.failed,
      },
    });

    return Response.json({
      queue,
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

    return Response.json({ error: message, trigger: "vercel_cron" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = tickSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow tick request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow_queue",
      metadata: parsed.data,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const queue = await processWorkflowQueue({ limit: parsed.data.limit || 5 });
  const alerts = parsed.data.alerts
    ? await runScheduledAlertDispatch({
        trigger: "operator.workflow_tick",
        queueLimit: parsed.data.alertQueueLimit || ALERT_SCHEDULER_QUEUE_LIMIT,
        dispatchLimit: parsed.data.alertDispatchLimit || ALERT_SCHEDULER_DISPATCH_LIMIT,
      })
    : undefined;
  return Response.json({
    queue,
    alerts,
    stats: {
      operationJobs: await getOperationJobStats(),
      alerts: alerts?.stats || await getAlertDeliveryStats(),
    },
    count: queue.leased,
  });
}

function getCronSecurityContext(): SecurityContext {
  return {
    tenantId: process.env.OMNIAGENT_DEFAULT_TENANT || "default",
    actorId: "vercel-cron",
    role: "system",
    source: "default",
  };
}
