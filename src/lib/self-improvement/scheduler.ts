import { resolveBuilderGithubRepository } from "@/lib/app-builder/github";
import { enqueueOperationJob } from "@/lib/operations/job-queue";
import { claimDueSelfImprovementCycles, listDueSelfImprovementConfigurations, releaseSelfImprovementExecutionLease,
  listRunnableSelfImprovementCyclesForTenant, getSelfImprovementCycle,
  type StoredSelfImprovementCycle } from "./store";
import { processDueSelfImprovementNotificationsForTenant } from "./notifications";

export async function enqueueSelfImprovementCycle(stored: StoredSelfImprovementCycle) {
  const cycle = stored.cycle;
  if (stored.leaseToken) await releaseSelfImprovementExecutionLease({ owner: { tenantId: cycle.scope.tenantId, ownerActorId: cycle.scope.ownerActorId },
    cycleId: cycle.id, expectedRevision: cycle.revision, leaseToken: stored.leaseToken });
  return enqueueOperationJob({ tenantId: cycle.scope.tenantId, type: "self_improvement.cycle.tick",
    payload: { actorId: cycle.scope.ownerActorId, cycleId: cycle.id }, dedupeKey: `self-improvement:${cycle.id}`,
    priority: 1, maxAttempts: 1, dedupeMode: "idempotent" });
}

export async function processDueSelfImprovementForTenant(input: { tenantId: string; limit?: number; deadlineAt: number }) {
  // A claim and its job insert are separate transactions. Repair that gap using
  // the same durable dedupe key; never restart a paid phase or reset a job.
  const runnable = await listRunnableSelfImprovementCyclesForTenant(input.tenantId);
  for (const target of runnable) {
    if (Date.now() + 10_000 >= input.deadlineAt) break;
    const stored = await getSelfImprovementCycle({ tenantId: input.tenantId, ownerActorId: target.ownerActorId }, target.cycleId);
    if (stored) await enqueueSelfImprovementCycle(stored);
  }
  if (Date.now() + 10_000 < input.deadlineAt) await processDueSelfImprovementNotificationsForTenant(input);
  const configurations = await listDueSelfImprovementConfigurations({ tenantId: input.tenantId, limit: input.limit || 1 });
  let queued = 0;
  for (const configuration of configurations) {
    if (Date.now() + 10_000 >= input.deadlineAt) break;
    const source = await resolveBuilderGithubRepository(configuration.repositoryId);
    if (!source.baseSha) throw new Error("The repository has no exact baseline revision.");
    if (source.repository.owner !== configuration.repository.owner || source.repository.name !== configuration.repository.name ||
      source.repository.defaultBranch !== configuration.repository.defaultBranch) throw new Error("Scheduled self-improvement repository identity changed.");
    const [claim] = await claimDueSelfImprovementCycles({ tenantId: input.tenantId, targets: [{ configurationId: configuration.id,
      ownerActorId: configuration.ownerActorId, expectedGeneration: configuration.generation, baseRevision: source.baseSha }] });
    if (claim.outcome === "claimed" && claim.cycle) { await enqueueSelfImprovementCycle(claim.cycle); queued++; }
  }
  return { examined: configurations.length, queued };
}
