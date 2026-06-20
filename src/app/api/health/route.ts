import { runSystemDiagnostics } from "@/lib/diagnostics/health";
import { getSql, ensureDatabaseSchema } from "@/lib/db/client";

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
  if (request.headers.get("x-health-db-only") === "1") {
    try {
      const t0 = Date.now();
      await ensureDatabaseSchema();
      const t1 = Date.now();
      const rows = await getSql()`SELECT 1 AS ok`;
      const t2 = Date.now();
      return Response.json({ schema_ms: t1 - t0, query_ms: t2 - t1, rows }, { status: 200 });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
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
