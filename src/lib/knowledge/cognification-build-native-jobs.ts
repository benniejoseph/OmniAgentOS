import { claimNativeCognitionBuildEffect, commitNativeCognitionBuildEffect, loadNativeCognitionBuildJob, recheckNativeCognitionBuildEffect } from "@/lib/knowledge/cognification-build-native-store";
import { cognifyKnowledgeBatch } from "@/lib/knowledge/cognification-runtime";
import type { OperationJobRecord } from "@/lib/operations/job-queue";

/** A durable claim precedes the one provider attempt. A lost result stays held. */
export async function executeNativeCognitionBuildJob(job: OperationJobRecord,abortSignal: AbortSignal): Promise<Record<string,unknown>> {
  const accepted = await loadNativeCognitionBuildJob(job); abortSignal.throwIfAborted();
  const claimed = await claimNativeCognitionBuildEffect(accepted,job); abortSignal.throwIfAborted();
  const candidate = await cognifyKnowledgeBatch({ tenantId: accepted.acceptance.scope.tenantId,actorId: accepted.acceptance.scope.ownerActorId,
    document: claimed.document,chunks: claimed.chunks,batchIndex: claimed.batchIndex,generationId: accepted.intent.request.review.generationId,
    executionScope: claimed.executionScope,abortSignal,singleAttempt: true,
    beforeProvider: () => recheckNativeCognitionBuildEffect(accepted,job,claimed.claimId) });
  abortSignal.throwIfAborted();
  return commitNativeCognitionBuildEffect(accepted,job,claimed.claimId,candidate);
}
