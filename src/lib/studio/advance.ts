import { randomUUID } from "node:crypto";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import {
  completeOperationJob,
  deferOperationJob,
  failOperationJob,
  leaseOperationJobByDedupeKey,
} from "@/lib/operations/job-queue";
import type { SecurityContext } from "@/lib/security/types";
import { studioOwner } from "./authority";
import { executeStudioRunJob } from "./runner";
import { getStudioRun } from "./service";
import { StudioError, studioJobKey } from "./server-types";

/** Advance only this caller's already accepted run, through its due queue lease. */
export async function advanceStudioRun(
  context: SecurityContext,
  runId: string,
  signal: AbortSignal,
) {
  await getStudioRun(context, runId);
  const owner = studioOwner(context);
  return runWithDatabaseActorScope(
    owner.tenantId,
    [owner.actorId, ...(owner.legacyActorId ? [owner.legacyActorId] : [])],
    async () => {
      const lease = await leaseOperationJobByDedupeKey(studioJobKey(runId), {
        tenantId: owner.tenantId,
        type: "studio.run.tick",
        queuedOnly: true,
        owner: `studio-advance:${randomUUID()}`,
        leaseSeconds: 90,
      });
      if (lease.outcome !== "leased")
        return (await getStudioRun(context, runId)).run;
      if (
        lease.job.payload.runId !== runId ||
        lease.job.payload.actorId !== owner.actorId
      )
        throw new StudioError(
          "The queued run does not match this owner.",
          403,
          "studio_queue_owner_mismatch",
        );
      try {
        const result = await executeStudioRunJob(lease.job, signal);
        if ("__deferOperation" in result)
          await deferOperationJob(lease.job.id, lease.job.leaseOwner!, {
            tenantId: owner.tenantId,
            delaySeconds: result.delaySeconds,
            reason: result.reason,
          });
        else
          await completeOperationJob(
            lease.job.id,
            lease.job.leaseOwner,
            owner.tenantId,
          );
      } catch (error) {
        await failOperationJob(
          lease.job.id,
          "Studio step interrupted. Its durable receipt will be reconciled before continuing.",
          lease.job.leaseOwner,
          owner.tenantId,
        );
        throw error;
      }
      return (await getStudioRun(context, runId)).run;
    },
  );
}
