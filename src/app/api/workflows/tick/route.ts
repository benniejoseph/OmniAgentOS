import { z } from "zod";
import {
  runWithDatabaseTenantScope,
  withDatabaseRequestScope,
} from "@/lib/db/client";
import {
  ALERT_SCHEDULER_DISPATCH_LIMIT,
  ALERT_SCHEDULER_QUEUE_LIMIT,
} from "@/lib/config";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { getAlertDeliveryStats, runScheduledAlertDispatch } from "@/lib/diagnostics/alerts";
import { runObservabilitySloMonitor } from "@/lib/observability/slo-monitor";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import {
  processAgentResumeQueue,
  processAllTenantAgentResumeQueues,
} from "@/lib/orchestration/resume-queue";
import { repairStuckAgentRuns } from "@/lib/runs/store";
import { recordSecurityAudit } from "@/lib/security/audit-store";
import { SecurityPolicyError } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { processPendingMemoryGraphRebuilds } from "@/lib/security/retention";
import type { SecurityContext } from "@/lib/security/types";
import {
  getOperationJobStats,
  listMaintenanceTenantIds,
} from "@/lib/operations/job-queue";
import { recordWorkerHeartbeat } from "@/lib/operations/worker-heartbeat";
import {
  checkWorkerRevision,
  workerRevisionErrorResponse,
} from "@/lib/operations/worker-request";
import { recoverStaleToolExecutionClaims } from "@/lib/tools/audit-store";
import {
  processAllTenantWorkflowQueues,
  processWorkflowQueue,
} from "@/lib/workflows/queue";

export const runtime = "nodejs";
// Workflow steps run gpt-5 planning/execution that can exceed 60s; 300s is the
// Vercel Pro ceiling (silently capped to 60s on Hobby).
export const maxDuration = 300;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const tickSchema = z.object({
  limit: z.number().int().min(1).max(10).optional(),
  slo: z.boolean().optional(),
  alerts: z.boolean().optional(),
  alertQueueLimit: z.number().int().min(1).max(50).optional(),
  alertDispatchLimit: z.number().int().min(1).max(50).optional(),
  scope: z.enum(["tenant", "all_tenants"]).optional(),
  tenantCursor: z.string().min(1).max(120).optional(),
  maintenanceTenantLimit: z.number().int().min(1).max(100).optional(),
}).strict();

const cronTickLimit = 5;

function GETHandler(request: Request) {
  const context = getCronSecurityContext();
  return runWithDatabaseTenantScope(context.tenantId, () =>
    runCronTick(request, context),
  );
}

async function runCronTick(request: Request, context: SecurityContext) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "cron-tick");
  const cronSecret = process.env.CRON_SECRET?.trim();
  const authenticationProbe =
    new URL(request.url).searchParams.get("probe") === "auth";

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

  if (authenticationProbe) {
    return Response.json({
      status: "ok",
      trigger: "vercel_cron",
      probe: "auth",
    });
  }

  try {
    const scheduled = await runAllTenantScheduledWork({
      trigger: "vercel_cron",
      actorId: context.actorId,
      correlationId: telemetry.correlationId,
      queueLimit: cronTickLimit,
      enableSlo: true,
      enableAlerts: true,
      alertQueueLimit: ALERT_SCHEDULER_QUEUE_LIMIT,
      alertDispatchLimit: ALERT_SCHEDULER_DISPATCH_LIMIT,
      maintenanceTenantLimit: cronTickLimit,
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
        workflowLeased: scheduled.queue.leased,
        sloHealthy: scheduled.slo?.healthy,
        sloBreaches: scheduled.slo?.breaches.length || 0,
        sloIncidentActions: scheduled.slo?.incidentActions.length || 0,
        alertQueueLimit: ALERT_SCHEDULER_QUEUE_LIMIT,
        alertDispatchLimit: ALERT_SCHEDULER_DISPATCH_LIMIT,
        alertEnqueued: scheduled.alerts?.enqueued.length || 0,
        alertProcessed: scheduled.alerts?.dispatch.processed.length || 0,
        alertDelivered: scheduled.alerts?.dispatch.delivered || 0,
        alertFailed: scheduled.alerts?.dispatch.failed || 0,
        maintenanceTenants: scheduled.maintenanceTenantIds.length,
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
        workflowLeased: scheduled.queue.leased,
        workflowCompleted: scheduled.queue.completed,
        sloHealthy: scheduled.slo?.healthy,
        sloBreaches: scheduled.slo?.breaches.length || 0,
        sloIncidentActions: scheduled.slo?.incidentActions.length || 0,
        alertEnqueued: scheduled.alerts?.enqueued.length || 0,
        alertProcessed: scheduled.alerts?.dispatch.processed.length || 0,
        alertDelivered: scheduled.alerts?.dispatch.delivered || 0,
        alertFailed: scheduled.alerts?.dispatch.failed || 0,
        maintenanceTenants: scheduled.maintenanceTenantIds.length,
      },
    });

    return Response.json({
      ...scheduled,
      count: scheduled.queue.leased,
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

async function POSTHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "workflow-tick");
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
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
      metadata: {
        scope: parsed.data.scope,
        limit: parsed.data.limit,
        slo: Boolean(parsed.data.slo),
        alerts: Boolean(parsed.data.alerts),
        hasTenantCursor: Boolean(parsed.data.tenantCursor),
      },
    });
    if (parsed.data.scope === "all_tenants") {
      if (context.role !== "system") {
        return Response.json(
          { error: "All-tenant workflow ticks require system authentication." },
          { status: 403 },
        );
      }
      const revisionCheck = checkWorkerRevision(request);
      if (!revisionCheck.accepted) {
        return workerRevisionErrorResponse(revisionCheck);
      }
      const workerHeartbeat = await recordWorkerHeartbeat({
        instanceId:
          request.headers.get("x-omni-worker-instance") ||
          context.actorId,
        revision:
          request.headers.get("x-omni-worker-revision") || undefined,
      });
      const scheduled = await runAllTenantScheduledWork({
        trigger: "dedicated_worker",
        actorId: context.actorId,
        correlationId: telemetry.correlationId,
        queueLimit: parsed.data.limit || 5,
        enableSlo: Boolean(parsed.data.slo),
        enableAlerts: Boolean(parsed.data.alerts),
        alertQueueLimit: parsed.data.alertQueueLimit || ALERT_SCHEDULER_QUEUE_LIMIT,
        alertDispatchLimit: parsed.data.alertDispatchLimit || ALERT_SCHEDULER_DISPATCH_LIMIT,
        tenantCursor: parsed.data.tenantCursor,
        maintenanceTenantLimit: parsed.data.maintenanceTenantLimit || 25,
      });
      await recordRuntimeEventSafely({
        category: "workflow",
        action: "workflow_tick.system",
        route: "/api/workflows/tick",
        method: "POST",
        statusCode: 200,
        durationMs: Date.now() - startedAt,
        requestId: telemetry.requestId,
        correlationId: telemetry.correlationId,
        tenantId: context.tenantId,
        actorId: context.actorId,
        resourceType: "workflow_queue",
        message: "System workflow queue and tenant maintenance tick completed.",
        metadata: {
          workflowLeased: scheduled.queue.leased,
          workflowCompleted: scheduled.queue.completed,
          maintenanceTenants: scheduled.maintenanceTenantIds.length,
          hasMoreTenants: Boolean(scheduled.nextTenantCursor),
        },
      });
      return Response.json({
        ...scheduled,
        workerHeartbeat,
        count: scheduled.queue.leased,
      });
    }
    const [queue, agentResumes, recoveredToolClaims] = await Promise.all([
      processWorkflowQueue({
        limit: parsed.data.limit || 5,
        tenantId: context.tenantId,
      }),
      processAgentResumeQueue({
        limit: parsed.data.limit || 5,
        tenantId: context.tenantId,
      }),
      recoverStaleToolExecutionClaims({
        tenantId: context.tenantId,
        limit: parsed.data.limit || 5,
      }),
    ]);
    const slo = parsed.data.slo
      ? await runObservabilitySloMonitor({
          trigger: "operator.workflow_tick",
          tenantId: context.tenantId,
          actorId: context.actorId,
          correlationId: telemetry.correlationId,
          queueAlerts: !parsed.data.alerts,
        })
      : undefined;
    const alerts = parsed.data.alerts
      ? await runScheduledAlertDispatch({
          trigger: "operator.workflow_tick",
          tenantId: context.tenantId,
          queueLimit: parsed.data.alertQueueLimit || ALERT_SCHEDULER_QUEUE_LIMIT,
          dispatchLimit: parsed.data.alertDispatchLimit || ALERT_SCHEDULER_DISPATCH_LIMIT,
        })
      : undefined;
    const stats =
      parsed.data.slo || parsed.data.alerts
        ? {
            operationJobs: await getOperationJobStats({ tenantId: context.tenantId }),
            alerts: alerts?.stats ?? (
              parsed.data.alerts
                ? await getAlertDeliveryStats({ tenantId: context.tenantId })
                : undefined
            ),
          }
        : undefined;
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
      agentResumes,
      recoveredToolClaims,
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

async function runAllTenantScheduledWork({
  trigger,
  actorId,
  correlationId,
  queueLimit,
  enableSlo,
  enableAlerts,
  alertQueueLimit,
  alertDispatchLimit,
  tenantCursor,
  maintenanceTenantLimit,
}: {
  trigger: string;
  actorId: string;
  correlationId: string;
  queueLimit: number;
  enableSlo: boolean;
  enableAlerts: boolean;
  alertQueueLimit: number;
  alertDispatchLimit: number;
  tenantCursor?: string;
  maintenanceTenantLimit: number;
}) {
  const [queue, agentResumes, memoryGraphRebuilds] = await Promise.all([
    processAllTenantWorkflowQueues({ limit: queueLimit }),
    processAllTenantAgentResumeQueues({ limit: queueLimit }),
    processPendingMemoryGraphRebuilds({ limit: 1 }),
  ]);
  const page = await listMaintenanceTenantIds({
    after: tenantCursor,
    limit: Math.min(maintenanceTenantLimit + 1, 101),
  });
  const maintenanceTenantIds = page.slice(0, maintenanceTenantLimit);
  const nextTenantCursor =
    page.length > maintenanceTenantLimit
      ? maintenanceTenantIds.at(-1)
      : undefined;
  const maintenance: Array<{
    tenantId: string;
    agentRunsRepaired: number;
    toolClaimsRecovered: number;
    slo?: Awaited<ReturnType<typeof runObservabilitySloMonitor>>;
    alerts?: Awaited<ReturnType<typeof runScheduledAlertDispatch>>;
  }> = [];

  for (const tenantId of maintenanceTenantIds) {
    maintenance.push(
      await runWithDatabaseTenantScope(tenantId, async () => ({
        tenantId,
        agentRunsRepaired: await repairStuckAgentRuns({ tenantId }),
        toolClaimsRecovered: (
          await recoverStaleToolExecutionClaims({ tenantId })
        ).length,
        slo: enableSlo
          ? await runObservabilitySloMonitor({
              trigger,
              tenantId,
              actorId,
              correlationId,
              queueAlerts: !enableAlerts,
            })
          : undefined,
        alerts: enableAlerts
          ? await runScheduledAlertDispatch({
              trigger,
              tenantId,
              queueLimit: alertQueueLimit,
              dispatchLimit: alertDispatchLimit,
            })
          : undefined,
      })),
    );
  }

  return {
    scope: "all_tenants" as const,
    queue,
    agentResumes,
    memoryGraphRebuilds,
    maintenanceTenantIds,
    nextTenantCursor,
    maintenance,
    slo: enableSlo
      ? {
          healthy: maintenance.every((item) => item.slo?.healthy !== false),
          breaches: maintenance.flatMap((item) => item.slo?.breaches || []),
          incidentActions: maintenance.flatMap(
            (item) => item.slo?.incidentActions || [],
          ),
        }
      : undefined,
    alerts: enableAlerts
      ? {
          enqueued: maintenance.flatMap((item) => item.alerts?.enqueued || []),
          dispatch: {
            processed: maintenance.flatMap(
              (item) => item.alerts?.dispatch.processed || [],
            ),
            delivered: maintenance.reduce(
              (total, item) => total + (item.alerts?.dispatch.delivered || 0),
              0,
            ),
            skipped: maintenance.reduce(
              (total, item) => total + (item.alerts?.dispatch.skipped || 0),
              0,
            ),
            failed: maintenance.reduce(
              (total, item) => total + (item.alerts?.dispatch.failed || 0),
              0,
            ),
          },
        }
      : undefined,
  };
}

function getCronSecurityContext(): SecurityContext {
  return {
    tenantId: process.env.OMNIAGENT_DEFAULT_TENANT || "default",
    actorId: "vercel-cron",
    role: "system",
    source: "default",
  };
}
