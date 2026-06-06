import { runSystemDiagnostics } from "@/lib/diagnostics/health";

export const runtime = "nodejs";

export async function GET() {
  const startedAt = Date.now();
  console.log(JSON.stringify({
    level: "info",
    msg: "start",
    route: "/api/health",
    method: "GET",
  }));
  try {
    const check = await runSystemDiagnostics({ scope: "health" });
    const status = check.status === "healthy" ? 200 : check.status === "degraded" ? 200 : 503;
    console.log(JSON.stringify({
      level: "info",
      msg: "done",
      route: "/api/health",
      method: "GET",
      status: check.status,
      httpStatus: status,
      ms: Date.now() - startedAt,
    }));

    return Response.json({
      status: check.status,
      checkedAt: check.createdAt,
      latencyMs: check.latencyMs,
      incidents: check.incidents.length,
      components: check.components.map((component) => ({
        id: component.id,
        status: component.status,
        summary: component.summary,
      })),
      metrics: {
        queueMaxAgeMs: check.metrics.queueMaxAgeMs,
        workflowCompletionRate: check.metrics.workflowCompletionRate,
        evalPassRate: check.metrics.evalPassRate,
        plannerFallbackRate: check.metrics.plannerFallbackRate,
        toolFailureRate: check.metrics.toolFailureRate,
        triggerFailureRate: check.metrics.triggerFailureRate,
      },
    }, { status });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "failed",
      route: "/api/health",
      method: "GET",
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Health check failed.",
    }));
    return Response.json({ error: "Health check failed." }, { status: 500 });
  }
}
