import { z } from "zod";
import { acknowledgeIncident, getIncidentDetail, resolveIncident } from "@/lib/diagnostics/incidents";
import { runIncidentPlaybook } from "@/lib/diagnostics/playbooks";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const incidentActionSchema = z.object({
  action: z.enum(["acknowledge", "resolve", "run_playbook"]),
  reason: z.string().max(1000).optional(),
  playbookId: z.string().min(1).max(160).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const { id } = await context.params;
  const parsed = incidentActionSchema.safeParse(await request.json().catch(() => ({})));
  console.log(JSON.stringify({
    level: "info",
    msg: "start",
    route: "/api/incidents/[id]/actions",
    method: "POST",
    requestId: request.headers.get("x-vercel-id"),
    incidentId: id,
    action: parsed.success ? parsed.data.action : "invalid",
  }));

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid incident action", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "incident",
      resourceId: id,
      metadata: parsed.data,
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "forbidden",
      route: "/api/incidents/[id]/actions",
      method: "POST",
      incidentId: id,
      action: parsed.data.action,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Forbidden",
    }));
    return forbiddenResponse(error);
  }

  try {
    const result = parsed.data.action === "acknowledge"
      ? await acknowledgeIncident(id, {
          actorId: securityContext.actorId,
          reason: parsed.data.reason,
        })
      : parsed.data.action === "resolve"
        ? await resolveIncident(id, {
            actorId: securityContext.actorId,
            resolution: parsed.data.reason,
          })
        : await runIncidentPlaybook({
            incidentId: id,
            playbookId: parsed.data.playbookId || "",
            actorId: securityContext.actorId,
          });

    if (!result) {
      return Response.json({ error: "Incident not found." }, { status: 404 });
    }

    const detail = await getIncidentDetail(id);
    console.log(JSON.stringify({
      level: "info",
      msg: "done",
      route: "/api/incidents/[id]/actions",
      method: "POST",
      incidentId: id,
      action: parsed.data.action,
      ms: Date.now() - startedAt,
    }));
    return Response.json({ result, detail });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "failed",
      route: "/api/incidents/[id]/actions",
      method: "POST",
      incidentId: id,
      action: parsed.data.action,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Incident action failed.",
    }));
    return Response.json(
      { error: error instanceof Error ? error.message : "Incident action failed." },
      { status: 400 },
    );
  }
}
