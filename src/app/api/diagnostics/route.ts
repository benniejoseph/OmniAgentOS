import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getHealthStats, getLatestHealthChecks, runSystemDiagnostics } from "@/lib/diagnostics/health";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const startedAt = Date.now();
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
    await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "system_diagnostics",
      metadata: { limit },
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "forbidden",
      route: "/api/diagnostics",
      method: "GET",
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Forbidden",
    }));
    return forbiddenResponse(error);
  }

  try {
    const check = await runSystemDiagnostics({ scope: "diagnostics" });
    console.log(JSON.stringify({
      level: "info",
      msg: "done",
      route: "/api/diagnostics",
      method: "GET",
      status: check.status,
      ms: Date.now() - startedAt,
    }));
    return Response.json({
      check,
      stats: await getHealthStats(),
      history: await getLatestHealthChecks(limit),
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
    return Response.json({ error: "Diagnostics failed." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  console.log(JSON.stringify({
    level: "info",
    msg: "start",
    route: "/api/diagnostics",
    method: "POST",
    requestId: request.headers.get("x-vercel-id"),
  }));

  try {
    await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "system_diagnostics",
      metadata: { repair: true },
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "forbidden",
      route: "/api/diagnostics",
      method: "POST",
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Forbidden",
    }));
    return forbiddenResponse(error);
  }

  try {
    const check = await runSystemDiagnostics({ scope: "repair", repair: true });
    console.log(JSON.stringify({
      level: "info",
      msg: "done",
      route: "/api/diagnostics",
      method: "POST",
      status: check.status,
      ms: Date.now() - startedAt,
    }));
    return Response.json({
      check,
      stats: await getHealthStats(),
    }, { status: check.status === "unhealthy" ? 202 : 200 });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "failed",
      route: "/api/diagnostics",
      method: "POST",
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Diagnostics repair failed.",
    }));
    return Response.json({ error: "Diagnostics repair failed." }, { status: 500 });
  }
}
