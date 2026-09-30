import { withDatabaseRequestScope } from "@/lib/db/client";
import { serverErrorResponse } from "@/lib/http/errors";
import {
  listWorkerReleaseActivations,
  summarizeWorkerLaneActivity,
  workerHeartbeatMaxAgeMs,
  type WorkerReleaseActivation,
} from "@/lib/operations/worker-heartbeat";
import { AsyncTtlCache } from "@/lib/performance/async-ttl-cache";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);

const activationCache = new AsyncTtlCache<WorkerReleaseActivation[]>(15_000, 4);

/**
 * Whether a dedicated worker is doing this release's work, lane by lane.
 * `/api/health` cannot say so: the worker and the release runner read it
 * before any work starts.
 */
async function GETHandler(request: Request) {
  const checkedAt = new Date().toISOString();
  const revision =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.OMNIAGENT_RELEASE_SHA?.trim() ||
    undefined;
  const maxAgeMs = workerHeartbeatMaxAgeMs();
  try {
    const activations = await activationCache.get(revision ?? "", () =>
      listWorkerReleaseActivations({ revision }),
    );
    const lanes = summarizeWorkerLaneActivity(activations, { maxAgeMs });
    const healthy = lanes.every((lane) => lane.status === "fresh");
    return Response.json(
      {
        status: healthy ? "healthy" : "unhealthy",
        checkedAt,
        revision,
        maxAgeMs,
        lanes,
      },
      { status: healthy ? 200 : 503 },
    );
  } catch (error) {
    return serverErrorResponse(error, {
      message: "Worker health could not be read",
      status: 503,
      request,
      body: { status: "unknown", checkedAt, revision },
    });
  }
}
