import { runSystemDiagnostics } from "@/lib/diagnostics/health";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const startedAt = Date.now();
  const requestId = request.headers.get("x-vercel-id") || crypto.randomUUID();
  console.log(JSON.stringify({
    level: "info",
    msg: "start",
    route: "/api/health",
    method: "GET",
  }));
  if (request.headers.get("x-health-quick") === "1") {
    return Response.json({ status: "ok", ms: Date.now() - startedAt }, { status: 200 });
  }
  try {
    console.log(JSON.stringify({ level: "info", msg: "diag_start", ms: Date.now() - startedAt }));
    const check = await runSystemDiagnostics({ scope: "health" });
    console.log(JSON.stringify({ level: "info", msg: "diag_done", ms: Date.now() - startedAt }));
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

    return Response.json({ status: check.status, checkedAt: check.createdAt, requestId }, { status });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "failed",
      route: "/api/health",
      method: "GET",
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Health check failed.",
    }));
    return Response.json(
      { status: "unhealthy", checkedAt: new Date().toISOString(), requestId },
      { status: 503 },
    );
  }
}
