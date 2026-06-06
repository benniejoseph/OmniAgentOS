import { z } from "zod";
import { dispatchAlertDeliveries } from "@/lib/diagnostics/alerts";
import {
  getDefaultObservabilitySloPolicies,
  getObservabilitySloSnapshot,
  runObservabilitySloMonitor,
} from "@/lib/observability/slo-monitor";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const sloActionSchema = z.object({
  action: z.enum(["run_monitor"]),
  queueAlerts: z.boolean().optional(),
  resolveRecovered: z.boolean().optional(),
  dispatchAlerts: z.boolean().optional(),
  dispatchLimit: z.number().int().min(1).max(50).optional(),
});

export async function GET(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "observability-slo");

  try {
    await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "observability_slo",
      metadata: { policies: getDefaultObservabilitySloPolicies().map((policy) => policy.id) },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const snapshot = await getObservabilitySloSnapshot();
    await recordRuntimeEventSafely({
      category: "api",
      action: "observability.slo_snapshot",
      route: "/api/observability/slo",
      method: "GET",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      resourceType: "observability_slo",
      message: "Read observability SLO snapshot.",
      metadata: {
        healthy: snapshot.healthy,
        breaches: snapshot.breaches.length,
        policies: snapshot.policies.length,
      },
    });
    return Response.json(snapshot);
  } catch (error) {
    await recordRuntimeEventSafely({
      level: "error",
      category: "api",
      action: "observability.slo_snapshot_failed",
      route: "/api/observability/slo",
      method: "GET",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      resourceType: "observability_slo",
      message: "Observability SLO snapshot failed.",
      metadata: { error: error instanceof Error ? error.message : "SLO snapshot failed." },
    });
    return Response.json({ error: "Observability SLO snapshot failed." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "observability-slo");
  const parsed = sloActionSchema.safeParse(await request.json().catch(() => ({})));

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid observability SLO action", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context: Awaited<ReturnType<typeof authorizeRequest>>;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "observability_slo",
      metadata: parsed.data,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const result = await runObservabilitySloMonitor({
      trigger: "operator.api",
      actorId: context.actorId,
      correlationId: telemetry.correlationId,
      queueAlerts: parsed.data.queueAlerts ?? true,
      resolveRecovered: parsed.data.resolveRecovered ?? true,
    });
    const dispatch = parsed.data.dispatchAlerts
      ? await dispatchAlertDeliveries(parsed.data.dispatchLimit || 10)
      : undefined;

    await recordRuntimeEventSafely({
      category: "api",
      action: "observability.slo_monitor_api",
      route: "/api/observability/slo",
      method: "POST",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "observability_slo",
      message: "Operator observability SLO monitor completed.",
      metadata: {
        healthy: result.healthy,
        breaches: result.breaches.length,
        queuedAlerts: result.queuedAlerts,
        dispatched: dispatch?.processed.length || 0,
      },
    });

    return Response.json({ result, dispatch });
  } catch (error) {
    await recordRuntimeEventSafely({
      level: "error",
      category: "api",
      action: "observability.slo_monitor_api_failed",
      route: "/api/observability/slo",
      method: "POST",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "observability_slo",
      message: "Operator observability SLO monitor failed.",
      metadata: { error: error instanceof Error ? error.message : "SLO monitor failed." },
    });
    return Response.json(
      { error: error instanceof Error ? error.message : "Observability SLO monitor failed." },
      { status: 500 },
    );
  }
}
