import { withDatabaseRequestScope } from "@/lib/db/client";
import { listCorrelatedEvents, listStreamEvents } from "@/lib/events/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { buildWorkflowTraceHierarchy } from "@/lib/trajectories/hierarchy";
import {
  getWorkflowRunDetail,
  getWorkflowRunExecutionAuthority,
} from "@/lib/workflows/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "read",
      resourceType: "workflow_trajectory",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const detail = await getWorkflowRunDetail(id, { tenantId: auth.tenantId });
  if (!detail) {
    return Response.json({ error: "Workflow run not found." }, { status: 404 });
  }
  const authority = await getWorkflowRunExecutionAuthority(id, {
    tenantId: auth.tenantId,
  });
  const ownerActorId = authority?.executionScope.initiatingActorId;
  if (!ownerActorId || ownerActorId !== auth.actorId) {
    return Response.json({ error: "Workflow run not found." }, { status: 404 });
  }

  const rootEvents = await listStreamEvents(`workflow:${id}`, {
    tenantId: auth.tenantId,
    actorId: ownerActorId,
    limit: 2_000,
  });
  const correlationId = authority.executionScope.correlationId;
  const correlatedEvents = await listCorrelatedEvents(correlationId, {
    tenantId: auth.tenantId,
    actorId: ownerActorId,
    limit: 2_000,
  });
  const events = [
    ...new Map(
      [...rootEvents, ...correlatedEvents].map((event) => [event.id, event]),
    ).values(),
  ];
  const traceHierarchy = buildWorkflowTraceHierarchy(
    detail.run,
    ownerActorId,
    events,
    correlationId,
  );

  return Response.json(
    { traceHierarchy },
    {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="asael-workflow-trace-${id}.json"`,
      },
    },
  );
}
