import {
  getIncidentAlertTargets,
  getIncidentPlaybooks,
  getIncidentStats,
  listIncidents,
  type IncidentStatus,
} from "@/lib/diagnostics/incidents";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const status = normalizeStatus(url.searchParams.get("status"));
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 25), 1), 100);
  console.log(JSON.stringify({
    level: "info",
    msg: "start",
    route: "/api/incidents",
    method: "GET",
    requestId: request.headers.get("x-vercel-id"),
    status,
    limit,
  }));

  try {
    await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "incident",
      metadata: { status, limit },
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "forbidden",
      route: "/api/incidents",
      method: "GET",
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Forbidden",
    }));
    return forbiddenResponse(error);
  }

  try {
    const [incidents, stats] = await Promise.all([
      listIncidents({ status, limit }),
      getIncidentStats(),
    ]);
    console.log(JSON.stringify({
      level: "info",
      msg: "done",
      route: "/api/incidents",
      method: "GET",
      incidents: incidents.length,
      ms: Date.now() - startedAt,
    }));
    return Response.json({
      incidents,
      stats,
      playbooks: getIncidentPlaybooks(),
      alertTargets: getIncidentAlertTargets("critical"),
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "failed",
      route: "/api/incidents",
      method: "GET",
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Incident list failed.",
    }));
    return Response.json({ error: "Incident list failed." }, { status: 500 });
  }
}

function normalizeStatus(value: string | null): IncidentStatus | "active" | "all" {
  if (value === "open" || value === "acknowledged" || value === "resolved" || value === "all") {
    return value;
  }
  return "active";
}
