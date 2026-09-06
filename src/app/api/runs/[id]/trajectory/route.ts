import { withDatabaseRequestScope } from "@/lib/db/client";
import { listCorrelatedEvents, listStreamEvents } from "@/lib/events/store";
import { getAgentRun } from "@/lib/runs/store";
import { listRunForkLineage } from "@/lib/runs/fork-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { buildRunTrajectory } from "@/lib/trajectories/builder";
import { evaluateTrajectoryLearning } from "@/lib/trajectories/evaluate";
import {
  buildRunTraceHierarchy,
  resolveRunCorrelationId,
} from "@/lib/trajectories/hierarchy";
import { verifyRunTrajectory } from "@/lib/trajectories/verify";

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
      resourceType: "run_trajectory",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const run = await getAgentRun(id, { tenantId: auth.tenantId });
  if (!run) return Response.json({ error: "Run not found." }, { status: 404 });
  if (run.ownerActorId !== auth.actorId) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  const runEvents = await listStreamEvents(`run:${id}`, {
    tenantId: auth.tenantId,
    actorId: run.ownerActorId,
    limit: 2_000,
  });
  const correlationId = resolveRunCorrelationId(run, runEvents);
  const correlatedEvents = await listCorrelatedEvents(correlationId, {
    tenantId: auth.tenantId,
    actorId: run.ownerActorId,
    limit: 2_000,
  });
  const traceEvents = [
    ...new Map(
      [...runEvents, ...correlatedEvents].map((event) => [event.id, event]),
    ).values(),
  ];
  const trajectory = buildRunTrajectory(run, runEvents);
  const verification = verifyRunTrajectory(trajectory, run);
  const traceHierarchy = buildRunTraceHierarchy(
    run,
    traceEvents,
    correlationId,
  );
  const lineage = await listRunForkLineage(id, {
    tenantId: auth.tenantId,
  });
  return Response.json(
    {
      trajectory,
      verification,
      traceHierarchy,
      lineage,
      learningEvaluation: evaluateTrajectoryLearning(trajectory, verification),
    },
    {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="asael-trajectory-${id}.json"`,
      },
    },
  );
}
