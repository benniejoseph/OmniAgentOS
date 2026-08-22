import { withDatabaseRequestScope } from "@/lib/db/client";
import { getIncidentDetail } from "@/lib/diagnostics/incidents";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const { id } = await context.params;
  console.log(JSON.stringify({
    level: "info",
    msg: "start",
    route: "/api/incidents/[id]",
    method: "GET",
    requestId: request.headers.get("x-vercel-id"),
    incidentId: id,
  }));

  let securityContext: Awaited<ReturnType<typeof authorizeRequest>>;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "incident",
      resourceId: id,
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "forbidden",
      route: "/api/incidents/[id]",
      method: "GET",
      incidentId: id,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Forbidden",
    }));
    return forbiddenResponse(error);
  }

  const detail = await getIncidentDetail(id, { tenantId: securityContext.tenantId });
  console.log(JSON.stringify({
    level: "info",
    msg: detail ? "done" : "not_found",
    route: "/api/incidents/[id]",
    method: "GET",
    incidentId: id,
    ms: Date.now() - startedAt,
  }));

  if (!detail) {
    return Response.json({ error: "Incident not found." }, { status: 404 });
  }

  return Response.json(detail);
}
