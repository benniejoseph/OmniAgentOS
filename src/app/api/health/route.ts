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
