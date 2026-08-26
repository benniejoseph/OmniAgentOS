import { withDatabaseRequestScope } from "@/lib/db/client";
import { listStreamEvents } from "@/lib/events/store";
import { getAgentRun } from "@/lib/runs/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { buildRunTrajectory } from "@/lib/trajectories/builder";
import { evaluateTrajectoryLearning } from "@/lib/trajectories/evaluate";
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

  const events = await listStreamEvents(`run:${id}`, {
    tenantId: auth.tenantId,
    limit: 2_000,
  });
  const trajectory = buildRunTrajectory(run, events);
  const verification = verifyRunTrajectory(trajectory, run);
  return Response.json(
    {
      trajectory,
      verification,
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
