import { z } from "zod";
import { appServiceActorBinding, authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "./contracts";
import { getAppServiceOperationContract } from "./registry";
import { getBuilderGithubStatus, listBuilderGithubRepositories, resolveBuilderGithubRepository } from "@/lib/app-builder/github";
import { assertCurrentSelfImprovementConfiguration, canDiscardHeldSelfImprovementCandidate, createSelfImprovementPolicy, classifySelfImprovementChange } from "@/lib/self-improvement/policy";
import { selfImprovementSha256 } from "@/lib/self-improvement/contracts";
import { getSelfImprovementConfiguration, listSelfImprovementConfigurations, listSelfImprovementCycles, getSelfImprovementCycle,
  configureSelfImprovement, pauseSelfImprovement, claimManualSelfImprovementCycle, renewSelfImprovementCycleLease,
  transitionSelfImprovementCycle, releaseSelfImprovementExecutionLease, holdSelfImprovementRelease, reviewExpiredSelfImprovementApproval, discardHeldSelfImprovementCandidate, assertConfiguredSelfImprovementOwner, type StoredSelfImprovementCycle } from "@/lib/self-improvement/store";
import { enqueueSelfImprovementCycle } from "@/lib/self-improvement/scheduler";
import { selfImprovementRuntimeSchema } from "@/lib/self-improvement/runtime";
import { getSelfImprovementControllerStatus } from "@/lib/self-improvement/release-service";

const target = z.string().trim().min(1).max(240);
export const improvementConfigureInput = z.object({ projectId: target, repositoryId: z.string().regex(/^\d{1,24}$/),
  dailyBudgetUsd: z.number().finite().positive().max(100), autoReleaseRoutineChanges: z.boolean(), notifyOutcomes: z.boolean().default(true),
  timeZone: z.string().min(1).max(80).default("Asia/Kolkata"), dailyHour: z.number().int().min(0).max(23).default(3),
  expectedGeneration: z.number().int().positive().optional() }).strict();
export const improvementRunInput = z.object({ configurationId: target, expectedGeneration: z.number().int().positive() }).strict();
export const improvementAdvanceInput = z.object({ cycleId: target, expectedRevision: z.number().int().positive() }).strict();
export const improvementPauseInput = improvementRunInput.extend({ paused: z.boolean() }).strict();
export const improvementReviewInput = z.object({ cycleId: target, expectedRevision: z.number().int().positive(),
  candidateSha256: z.string().regex(/^[a-f0-9]{64}$/), validationSha256: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["approve", "reject"]) }).strict();

export function selfImprovementServiceOwner(caller: AppServiceCaller) {
  const binding = appServiceActorBinding(caller);
  if (!binding) throw new Error("Self-improvement requires an authenticated owner identity.");
  return { tenantId: caller.context.tenantId, ownerActorId: binding.canonicalActorId };
}
export function publicSelfImprovementCycle(stored: StoredSelfImprovementCycle) {
  const runtime = selfImprovementRuntimeSchema.safeParse(stored.runtime);
  const { leaseToken: _lease, ...cycle } = stored.cycle;
  const classification = cycle.candidate ? classifySelfImprovementChange({ candidate: cycle.candidate, policy: cycle.policy }) : null;
  const approvalExpired = cycle.stage === "ready_for_release" && Boolean(cycle.approval && Date.parse(cycle.approval.expiresAt) <= Date.now());
  const approvalRenewalAvailable = approvalExpired && stored.usageState === "known" && !stored.controllerId && !stored.controllerHold && Date.parse(stored.leaseExpiresAt) <= Date.now();
  return { ...cycle, configurationId: stored.configurationId, projectId: stored.projectId,
    executionLeaseExpiresAt: stored.leaseExpiresAt,
    spendUsd: stored.spendUsd, usageState: stored.usageState,
    controllerHold: stored.controllerHold,
    phase: runtime.success ? runtime.data.phase : "unknown", summary: runtime.success ? runtime.data.summary : "",
    agentRuns: runtime.success ? runtime.data.agentRuns : [],
    classification, approvalExpired, approvalRenewalAvailable, discardAvailable: canDiscardHeldSelfImprovementCandidate(stored),
    releaseEligibility: classification?.protectedFiles.length ? "manual_release" as const : classification?.disposition === "review_required" && (!cycle.approval || approvalRenewalAvailable) ? "owner_review" as const : "automatic" as const };
}

export async function showSelfImprovementService(caller: AppServiceCaller) {
  const call = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.self_improvement.show"));
  const owner = selfImprovementServiceOwner(caller);
  const [configurations, cycles, controller] = await Promise.all([listSelfImprovementConfigurations(owner), listSelfImprovementCycles(owner, { limit: 30 }), getSelfImprovementControllerStatus(owner)]);
  return completeAppServiceCall(call, { configurations, cycles: cycles.map(publicSelfImprovementCycle), github: getBuilderGithubStatus(), controller });
}
export async function listSelfImprovementRepositoriesService(caller: AppServiceCaller) {
  const call = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.self_improvement.show"));
  assertConfiguredSelfImprovementOwner(selfImprovementServiceOwner(caller));
  return completeAppServiceCall(call, { repositories: await listBuilderGithubRepositories() });
}
export async function configureSelfImprovementService(caller: AppServiceCaller, input: unknown) {
  const call = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.self_improvement.configure"));
  const value = improvementConfigureInput.parse(input), owner = selfImprovementServiceOwner(caller);
  if (caller.context.role !== "admin") throw new Error("Only the application owner may enroll its source repository.");
  const source = await resolveBuilderGithubRepository(value.repositoryId);
  if (source.repository.fullName.toLowerCase() !== "benniejoseph/omniagentos") throw new Error("This policy is for Asael's own source repository.");
  const configuration = await configureSelfImprovement({ ...owner, ...value,
    repository: { owner: source.repository.owner, name: source.repository.name, defaultBranch: source.repository.defaultBranch },
    policy: createSelfImprovementPolicy({ dailyBudgetUsd: value.dailyBudgetUsd, autoReleaseRoutineChanges: value.autoReleaseRoutineChanges, notifyOutcomes: value.notifyOutcomes }) });
  return completeAppServiceCall(call, { configuration });
}
export async function runSelfImprovementService(caller: AppServiceCaller, input: unknown) {
  const call = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.self_improvement.run"));
  const value = improvementRunInput.parse(input), owner = selfImprovementServiceOwner(caller);
  const configuration = await getSelfImprovementConfiguration(owner, value.configurationId);
  if (!configuration || configuration.generation !== value.expectedGeneration) throw new Error("Read the current improvement configuration before starting.");
  const source = await resolveBuilderGithubRepository(configuration.repositoryId);
  if (!source.baseSha) throw new Error("The repository has no exact baseline revision.");
  const claim = await claimManualSelfImprovementCycle({ owner, ...value, baseRevision: source.baseSha, idempotencyKey: caller.idempotencyKey! });
  const job = claim.cycle && ["observing", "planned", "implementing", "validating", "correcting"].includes(claim.cycle.cycle.stage)
    ? await enqueueSelfImprovementCycle(claim.cycle) : null;
  if (job && (job.type !== "self_improvement.cycle.tick" || job.tenantId !== owner.tenantId ||
    job.payload.actorId !== owner.ownerActorId || job.payload.cycleId !== claim.cycle?.cycle.id)) {
    throw new Error("The queued improvement job does not match its admitted owner and cycle.");
  }
  return completeAppServiceCall(call, { outcome: claim.outcome, cycle: claim.cycle ? publicSelfImprovementCycle(claim.cycle) : null,
    operationJob: job ? { id: job.id, type: job.type, status: job.status } : null });
}
/** Advance one existing cycle phase on this authenticated deployment, without a scheduler tick or another admission. */
export async function advanceSelfImprovementService(caller: AppServiceCaller, input: unknown, options: { abortSignal?: AbortSignal } = {}) {
  const call = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.self_improvement.advance"));
  if (caller.context.role !== "admin" || !["session", "mobile"].includes(caller.context.source)) throw new Error("Advancing an improvement phase requires the authenticated application owner.");
  const value = improvementAdvanceInput.parse(input), owner = selfImprovementServiceOwner(caller);
  assertConfiguredSelfImprovementOwner(owner);
  const abortSignal = options.abortSignal ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(240_000)]) : AbortSignal.timeout(240_000);
  abortSignal.throwIfAborted();
  const stored = await getSelfImprovementCycle(owner, value.cycleId);
  if (!stored || stored.cycle.revision !== value.expectedRevision) throw new Error("The improvement phase revision changed; read its current state before advancing.");
  if (!["observing", "planned", "implementing", "validating", "correcting"].includes(stored.cycle.stage)) throw new Error("This cycle has no coding phase to advance.");
  if (Date.parse(stored.leaseExpiresAt) > Date.now()) throw new Error("Another executor still owns this improvement phase.");
  const configuration = await getSelfImprovementConfiguration(owner, stored.configurationId);
  assertCurrentSelfImprovementConfiguration(configuration, stored);
  if (stored.usageState !== "known") throw new Error("The admitted improvement authority is awaiting usage reconciliation.");
  const { executeSelfImprovementJob } = await import("@/lib/self-improvement/worker");
  const phaseResult = await executeSelfImprovementJob({ tenantId: owner.tenantId, payload: { actorId: owner.ownerActorId, cycleId: value.cycleId } }, abortSignal, value.expectedRevision);
  const updated = await getSelfImprovementCycle(owner, value.cycleId);
  if (!updated) throw new Error("The advanced improvement cycle could not be read back.");
  return completeAppServiceCall(call, { phaseResult, cycle: publicSelfImprovementCycle(updated) });
}
export async function pauseSelfImprovementService(caller: AppServiceCaller, input: unknown) {
  const call = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.self_improvement.pause"));
  const value = improvementPauseInput.parse(input);
  const configuration = await pauseSelfImprovement({ owner: selfImprovementServiceOwner(caller), ...value });
  return completeAppServiceCall(call, { configuration });
}
export async function reviewSelfImprovementService(caller: AppServiceCaller, input: unknown) {
  const call = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.self_improvement.review"));
  const value = improvementReviewInput.parse(input), owner = selfImprovementServiceOwner(caller);
  const stored = await getSelfImprovementCycle(owner, value.cycleId);
  if (!stored || stored.cycle.revision !== value.expectedRevision ||
      stored.cycle.candidate?.candidateSha256 !== value.candidateSha256 || stored.cycle.validation?.validationSha256 !== value.validationSha256) throw new Error("The exact candidate review is no longer current.");
  if (value.decision === "reject" && canDiscardHeldSelfImprovementCandidate(stored)) {
    if (caller.context.role !== "admin" || !["session", "mobile"].includes(caller.context.source)) throw new Error("Discarding a held candidate requires the authenticated application owner.");
    const discarded = await discardHeldSelfImprovementCandidate({ owner, ...value });
    return completeAppServiceCall(call, { cycle: publicSelfImprovementCycle(discarded), manualReleaseRequired: false });
  }
  const renewingExpiredApproval = stored.cycle.stage === "ready_for_release" && Boolean(stored.cycle.approval && Date.parse(stored.cycle.approval.expiresAt) <= Date.now()) && !stored.controllerId && !stored.controllerHold;
  if (stored.cycle.stage !== "review_required" && !renewingExpiredApproval) throw new Error("The exact candidate review is no longer current.");
  const now = new Date().toISOString();
  const approvalBody = { approvalId: `self_approval_${selfImprovementSha256("approval_id", { ...owner, key: caller.idempotencyKey })}`,
    ...owner, candidateSha256: value.candidateSha256, policySha256: stored.cycle.policy.policySha256,
    validationSha256: value.validationSha256, decision: "approved" as const, approvedAt: now, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
  const approval = { ...approvalBody, receiptSha256: selfImprovementSha256("approval", approvalBody) };
  const manualReleaseRequired = value.decision === "approve" && classifySelfImprovementChange({ candidate: stored.cycle.candidate, policy: stored.cycle.policy }).protectedFiles.length > 0;
  if (renewingExpiredApproval) {
    let renewed = await reviewExpiredSelfImprovementApproval({ owner, ...value, ...(value.decision === "approve" ? { approval } : {}) });
    if (manualReleaseRequired) renewed = await holdSelfImprovementRelease({ owner, cycleId: value.cycleId,
      candidateRevision: stored.cycle.candidate.revision, controllerId: "trusted-manual-release", category: "manual_operator_release_required" });
    return completeAppServiceCall(call, { cycle: publicSelfImprovementCycle(renewed), manualReleaseRequired });
  }
  const claimed = await renewSelfImprovementCycleLease({ owner, cycleId: value.cycleId, expectedRevision: value.expectedRevision });
  let changed = await transitionSelfImprovementCycle({ owner, cycleId: value.cycleId, expectedRevision: claimed.cycle.revision,
    leaseToken: claimed.leaseToken!, nextStage: value.decision === "approve" ? "ready_for_release" : "cancelled",
    ...(value.decision === "approve" ? { patch: { approval } } : {}) });
  if (manualReleaseRequired) changed = await holdSelfImprovementRelease({ owner, cycleId: value.cycleId,
    candidateRevision: stored.cycle.candidate.revision, controllerId: "trusted-manual-release", category: "manual_operator_release_required" });
  if (value.decision === "approve") changed = await releaseSelfImprovementExecutionLease({ owner, cycleId: value.cycleId, expectedRevision: changed.cycle.revision, leaseToken: claimed.leaseToken! });
  return completeAppServiceCall(call, { cycle: publicSelfImprovementCycle(changed), manualReleaseRequired });
}
