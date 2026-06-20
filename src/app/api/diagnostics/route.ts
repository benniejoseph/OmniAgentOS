import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getHealthStats, getLatestHealthChecks, runSystemDiagnostics } from "@/lib/diagnostics/health";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "diagnostics");
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  console.log(JSON.stringify({
    level: "info",
    msg: "start",
    route: "/api/diagnostics",
    method: "GET",
    requestId: request.headers.get("x-vercel-id"),
    limit,
  }));

  try {
    const context = await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "system_diagnostics",
      metadata: { limit },
    });
    const check = await runSystemDiagnostics({ scope: "diagnostics" });
    const stats = await getHealthStats();
    const history = await getLatestHealthChecks(limit);
    console.log(JSON.stringify({
      level: "info",
      msg: "done",
      route: "/api/diagnostics",
      method: "GET",
      status: check.status,
      ms: Date.now() - startedAt,
    }));
    await recordRuntimeEventSafely({
      category: "diagnostics",
      action: "diagnostics.run",
      route: "/api/diagnostics",
      method: "GET",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "system_diagnostics",
      resourceId: check.id,
      message: "Diagnostics completed.",
      metadata: {
        status: check.status,
        components: check.components.length,
        incidents: check.incidents.length,
        recoveryActions: check.recoveryActions.length,
      },
    });
    return Response.json({
      check,
      stats,
      history,
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "failed",
      route: "/api/diagnostics",
      method: "GET",
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Diagnostics failed.",
    }));
    if (error instanceof Error && error.name === "SecurityPolicyError") {
      return forbiddenResponse(error);
    }
    await recordRuntimeEventSafely({
      level: "error",
      category: "diagnostics",
      action: "diagnostics.run_failed",
      route: "/api/diagnostics",
      method: "GET",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      resourceType: "system_diagnostics",
      message: "Diagnostics failed.",
      metadata: { error: error instanceof Error ? error.message : "Diagnostics failed." },
    });
    return Response.json({ error: "Diagnostics failed." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "diagnostics-repair");
  console.log(JSON.stringify({
    level: "info",
    msg: "start",
    route: "/api/diagnostics",
    method: "POST",
    requestId: request.headers.get("x-vercel-id"),
  }));

  try {
    const context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "system_diagnostics",
      metadata: { repair: true },
    });
    const check = await runSystemDiagnostics({ scope: "repair", repair: true });
    const stats = await getHealthStats();
    const status = check.status === "unhealthy" ? 202 : 200;
    console.log(JSON.stringify({
      level: "info",
      msg: "done",
      route: "/api/diagnostics",
      method: "POST",
      status: check.status,
      ms: Date.now() - startedAt,
    }));
    await recordRuntimeEventSafely({
      category: "diagnostics",
      action: "diagnostics.repair",
      route: "/api/diagnostics",
      method: "POST",
      statusCode: status,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "system_diagnostics",
      resourceId: check.id,
      message: "Diagnostics repair completed.",
      metadata: {
        status: check.status,
        components: check.components.length,
        incidents: check.incidents.length,
        recoveryActions: check.recoveryActions.length,
      },
    });
    return Response.json({
      check,
      stats,
    }, { status });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "failed",
      route: "/api/diagnostics",
      method: "POST",
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Diagnostics repair failed.",
    }));
    if (error instanceof Error && error.name === "SecurityPolicyError") {
      return forbiddenResponse(error);
    }
    await recordRuntimeEventSafely({
      level: "error",
      category: "diagnostics",
      action: "diagnostics.repair_failed",
      route: "/api/diagnostics",
      method: "POST",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      resourceType: "system_diagnostics",
      message: "Diagnostics repair failed.",
      metadata: { error: error instanceof Error ? error.message : "Diagnostics repair failed." },
    });
    return Response.json({ error: "Diagnostics repair failed." }, { status: 500 });
  }
}
