import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const startedAt = Date.now();
  const requestId = request.headers.get("x-vercel-id") || crypto.randomUUID();
  const checkedAt = new Date().toISOString();

  if (!hasDatabaseUrl()) {
    return Response.json({ status: "degraded", checkedAt, requestId }, { status: 200 });
  }

  try {
    await ensureDatabaseSchema();
    await getSql()`SELECT 1 AS ok`;
    const ms = Date.now() - startedAt;
    console.log(JSON.stringify({ level: "info", msg: "health ok", ms, route: "/api/health" }));
    return Response.json({ status: "healthy", checkedAt, requestId }, { status: 200 });
  } catch (error) {
    const ms = Date.now() - startedAt;
    console.error(JSON.stringify({
      level: "error",
      msg: "health failed",
      ms,
      route: "/api/health",
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json({ status: "unhealthy", checkedAt, requestId }, { status: 503 });
  }
}
