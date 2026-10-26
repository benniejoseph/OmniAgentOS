import { z } from "zod";

const id = z.string().min(1).max(240);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const time = z.string().datetime({ offset: true });
const repository = z.object({ owner: z.string().regex(/^[A-Za-z0-9-]+$/), name: z.string().regex(/^[A-Za-z0-9_.-]+$/), defaultBranch: id });
const policy = z.object({ dailyBudgetUsd: z.number().positive().max(100), maxCycleBudgetUsd: z.number().positive().max(100).optional(), autoReleaseRoutineChanges: z.boolean(), notifyOutcomes: z.boolean().default(true), policySha256: digest })
  .refine((value) => value.maxCycleBudgetUsd === undefined || value.maxCycleBudgetUsd <= value.dailyBudgetUsd, "The cycle limit exceeds the daily limit.");
export const improvementConfigurationView = z.object({
  id, tenantId: id, ownerActorId: id, projectId: id, repositoryId: z.string().regex(/^\d{1,24}$/), repository,
  policy, generation: z.number().int().positive(), nextDueAt: time, paused: z.boolean(), timeZone: id,
  dailyHour: z.number().int().min(0).max(23), updatedAt: time,
});
const check = z.object({
  id, kind: z.enum(["focused_regression", "adjacent_regression", "typecheck", "independent_review", "behavior_comparison", "build", "lint"]),
  outcome: z.enum(["passed", "failed", "incomplete", "not_run"]), candidateRevision: revision, workspaceSha256: digest,
  executedCases: z.number().int().nonnegative(), failedCases: z.number().int().nonnegative(), declaredCases: z.number().int().positive(),
}).refine((value) => value.executedCases <= value.declaredCases && value.failedCases <= value.executedCases &&
  (value.outcome !== "passed" || (value.executedCases === value.declaredCases && value.failedCases === 0)), "Validation counts are inconsistent.");
export const improvementCycleView = z.object({
  id, configurationId: id, projectId: id, revision: z.number().int().positive(),
  scope: z.object({ tenantId: id, ownerActorId: id, repository, baseRevision: revision }), policy,
  stage: z.enum(["observing", "no_change", "planned", "implementing", "validating", "correcting", "review_required", "ready_for_release", "releasing", "succeeded", "failed", "rolled_back", "cancelled"]),
  phase: z.string().max(80), summary: z.string().max(2000), spendUsd: z.number().nonnegative().finite(), usageState: z.enum(["known", "unknown"]),
  candidate: z.object({ revision, candidateSha256: digest, workspaceSha256: digest, changedFiles: z.array(z.object({ path: z.string().min(1).max(500) })).min(1).max(500), changedLines: z.number().int().positive() }).nullable(),
  validation: z.object({ validationSha256: digest, candidateSha256: digest, candidateRevision: revision, workspaceSha256: digest,
    checks: z.array(check).max(30), baselineReproduction: z.object({ executedCases: z.number().int().positive(), failedCases: z.number().int().positive() }).nullable().optional() }).nullable(),
  classification: z.object({ disposition: z.enum(["routine", "review_required"]), reasons: z.array(z.string().max(120)).max(30) }).nullable(),
  releaseEligibility: z.enum(["automatic", "owner_review", "manual_release"]).nullable().optional(),
  approvalExpired: z.boolean().default(false),
  approvalRenewalAvailable: z.boolean().default(false),
  discardAvailable: z.boolean().default(false),
  setupRetryAvailable: z.boolean().default(false),
  agentRuns: z.array(z.object({ agentId: z.enum(["atlas", "forge", "sentinel"]), runId: z.string().uuid(), completed: z.boolean(), phase: z.string().max(80) })).max(6),
  pullRequestUrl: z.string().url().nullable().optional(), createdAt: time, updatedAt: time,
  controllerHold: z.object({ category: z.string().regex(/^[a-z0-9_]{1,120}$/), occurredAt: time }).nullable().optional(),
  releaseReceipt: z.object({ outcome: z.enum(["deployed", "failed", "rolled_back"]), webRevision: revision, workerRevision: revision }).nullable(),
});
export type ImprovementConfigurationView = z.infer<typeof improvementConfigurationView>;
export type ImprovementCycleView = z.infer<typeof improvementCycleView>;
export const improvementProjectsView = z.object({ projects: z.array(z.object({ id, title: z.string().min(1).max(180) })).max(100) });
export const improvementRepositoriesView = z.object({ repositories: z.array(z.object({ repositoryId: z.string().regex(/^\d{1,24}$/), fullName: z.string().min(1).max(250) })).max(300) });

const snapshot = z.object({
  configurations: z.array(improvementConfigurationView).max(100), cycles: z.array(improvementCycleView).max(30),
  github: z.object({ configured: z.boolean(), missing: z.array(z.string().max(200)).max(20) }),
  controller: z.discriminatedUnion("status", [z.object({ status: z.literal("not_connected") }), z.object({ status: z.enum(["online", "offline"]), lastSeenAt: time, activity: z.literal("held").optional(), category: z.string().max(120).optional() })]).nullable().optional(),
});
export function parseImprovementSnapshot(value: unknown, tenantId?: string) {
  const parsed = snapshot.parse(value);
  const configurationIds = new Set(parsed.configurations.map((item) => item.id));
  if (configurationIds.size !== parsed.configurations.length || new Set(parsed.cycles.map((item) => item.id)).size !== parsed.cycles.length) throw new Error("Improvement records contain duplicate identities.");
  for (const configuration of parsed.configurations) {
    if (tenantId && configuration.tenantId !== tenantId) throw new Error("Improvement settings belong to another workspace.");
  }
  for (const cycle of parsed.cycles) {
    const configuration = parsed.configurations.find((item) => item.id === cycle.configurationId);
    if (!configuration || cycle.scope.tenantId !== configuration.tenantId || cycle.scope.ownerActorId !== configuration.ownerActorId || cycle.projectId !== configuration.projectId || cycle.scope.repository.owner !== configuration.repository.owner || cycle.scope.repository.name !== configuration.repository.name) throw new Error("Improvement history does not match its workspace settings.");
    if (cycle.validation && (!cycle.candidate || cycle.validation.candidateSha256 !== cycle.candidate.candidateSha256 || cycle.validation.candidateRevision !== cycle.candidate.revision || cycle.validation.workspaceSha256 !== cycle.candidate.workspaceSha256 || cycle.validation.checks.some((item) => item.candidateRevision !== cycle.candidate!.revision || item.workspaceSha256 !== cycle.candidate!.workspaceSha256))) throw new Error("Validation belongs to a different candidate. Refresh this review.");
    if (cycle.stage === "succeeded" && (cycle.releaseReceipt?.outcome !== "deployed" || cycle.releaseReceipt.webRevision !== cycle.releaseReceipt.workerRevision)) throw new Error("Released status requires matching production receipts.");
  }
  return parsed;
}
export type ImprovementSnapshot = ReturnType<typeof parseImprovementSnapshot>;
export const improvementStageLabels: Record<ImprovementCycleView["stage"], string> = {
  observing: "Investigating", planned: "Repair planned", implementing: "Making a repair", validating: "Checking the repair", correcting: "Refining the repair",
  review_required: "Needs your review", ready_for_release: "Ready for release", releasing: "Releasing", succeeded: "Released", no_change: "No change needed",
  failed: "Stopped with an issue", rolled_back: "Rolled back", cancelled: "Cancelled",
};
export function isImprovementActive(cycle: Pick<ImprovementCycleView, "stage">) {
  return !["succeeded", "no_change", "failed", "rolled_back", "cancelled"].includes(cycle.stage);
}
export function improvementDiffHref(cycle: ImprovementCycleView): string | undefined {
  if (!cycle.candidate) return undefined;
  const { owner, name } = cycle.scope.repository;
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${cycle.scope.baseRevision}...${cycle.candidate.revision}`;
}
export function improvementHoldMessage(category: string): string {
  const messages: Record<string, string> = {
    manual_operator_release_required: "This repair changes protected code and needs a trusted manual release.",
    release_usage_unconfirmed: "Release costs have not been reconciled.",
    release_outcome_requires_reconciliation: "The release result needs to be reconciled before another attempt.",
    source_candidate_changed: "The source candidate changed after verification.",
    source_revision_changed: "The source revision changed after verification.",
    base_revision_changed: "The production base changed after this repair was checked.",
    controller_unavailable: "The release controller could not complete its work.",
    private_file_unavailable: "A required local release file is unavailable.",
  };
  return messages[category] || `The release was stopped because of ${category.replaceAll("_", " ")}.`;
}
export function improvementRequiresManualRelease(cycle: ImprovementCycleView) {
  return cycle.releaseEligibility === "manual_release" || cycle.controllerHold?.category === "manual_operator_release_required";
}
export function improvementCanDiscard(cycle: ImprovementCycleView) {
  return cycle.discardAvailable && cycle.stage === "ready_for_release" && Boolean(cycle.controllerHold) && cycle.usageState === "known" && !cycle.releaseReceipt;
}
export function improvementReviewInput(cycle: ImprovementCycleView, decision: "approve" | "reject") {
  const renewable = cycle.stage === "ready_for_release" && cycle.approvalExpired && cycle.approvalRenewalAvailable;
  const discard = decision === "reject" && improvementCanDiscard(cycle);
  if ((cycle.stage !== "review_required" && !renewable && !discard) || !cycle.candidate || !cycle.validation || cycle.validation.candidateSha256 !== cycle.candidate.candidateSha256 || cycle.validation.candidateRevision !== cycle.candidate.revision || cycle.validation.workspaceSha256 !== cycle.candidate.workspaceSha256) throw new Error("This exact review is no longer available. Refresh the cycle.");
  if (decision === "approve" && (["focused_regression", "adjacent_regression", "typecheck", "independent_review"].some((kind) => !cycle.validation!.checks.some((item) => item.kind === kind && item.outcome === "passed")) || cycle.validation.checks.some((item) => item.outcome !== "passed"))) throw new Error("Approval requires complete passing validation for this candidate.");
  return { cycleId: cycle.id, expectedRevision: cycle.revision, candidateSha256: cycle.candidate.candidateSha256, validationSha256: cycle.validation.validationSha256, decision };
}

export function improvementRetryInput(cycle: ImprovementCycleView, configuration: ImprovementConfigurationView) {
  if (!cycle.setupRetryAvailable || cycle.stage !== "failed" || cycle.spendUsd !== 0 || cycle.usageState !== "known" || cycle.agentRuns.length || cycle.candidate || cycle.releaseReceipt ||
      configuration.paused || configuration.id !== cycle.configurationId || configuration.policy.policySha256 !== cycle.policy.policySha256) throw new Error("This setup retry is no longer available. Refresh the cycle and settings.");
  return { configurationId: configuration.id, expectedGeneration: configuration.generation, failedCycleId: cycle.id, expectedRevision: cycle.revision };
}
export function improvementActionReceipt(action: "configure" | "pause" | "run" | "review" | "retry", input: Record<string, unknown>, payload: Record<string, unknown>): string {
  if (action === "configure" || action === "pause") {
    const configuration = improvementConfigurationView.parse(payload.configuration);
    if (configuration.generation !== Number(input.expectedGeneration ?? 0) + 1 || (action === "pause" ? configuration.id !== input.configurationId || configuration.paused !== input.paused : configuration.projectId !== input.projectId || configuration.repositoryId !== input.repositoryId || configuration.policy.dailyBudgetUsd !== input.dailyBudgetUsd || (configuration.policy.maxCycleBudgetUsd ?? configuration.policy.dailyBudgetUsd) !== (input.maxCycleBudgetUsd ?? Math.min(10, Number(input.dailyBudgetUsd))) || configuration.dailyHour !== input.dailyHour || configuration.timeZone !== input.timeZone || configuration.policy.autoReleaseRoutineChanges !== input.autoReleaseRoutineChanges || configuration.policy.notifyOutcomes !== input.notifyOutcomes)) throw new Error("The settings response does not confirm this exact change. Refresh before continuing.");
    return action === "configure" ? "Daily improvement settings saved." : input.paused ? "Daily improvement paused. An already claimed release can still finish." : "Daily improvement resumed.";
  }
  if (action === "review") {
    const cycle = improvementCycleView.parse(payload.cycle);
    if (cycle.id !== input.cycleId || cycle.revision <= Number(input.expectedRevision) || cycle.candidate?.candidateSha256 !== input.candidateSha256 || cycle.validation?.validationSha256 !== input.validationSha256 || cycle.stage !== (input.decision === "approve" ? "ready_for_release" : "cancelled")) throw new Error("The review response does not confirm this exact candidate. Refresh before continuing.");
    return input.decision === "approve" ? improvementRequiresManualRelease(cycle) ? "This repair is approved and needs a trusted manual release." : "This repair is approved for release." : "This repair was declined.";
  }
  const outcome = z.enum(["claimed", "duplicate", "busy", "budget_exhausted", "paused", "not_due"]).parse(payload.outcome);
  if (outcome === "claimed" || outcome === "duplicate") {
    const cycle = improvementCycleView.parse(payload.cycle);
    if (cycle.configurationId !== input.configurationId) throw new Error("The run response belongs to different settings.");
    if (action === "retry") {
      const lineage = z.object({ cycleId: id, revision: z.number().int().positive(), cycleSha256: digest, toolExecutionId: id, toolReceiptSha256: digest }).parse(payload.retryOf);
      if (cycle.id === input.failedCycleId || lineage.cycleId !== input.failedCycleId || lineage.revision !== input.expectedRevision) throw new Error("The retry response does not preserve the exact failed cycle. Refresh before continuing.");
      return outcome === "claimed" ? "One setup retry is queued. The original failure and budget history are preserved." : "This setup retry already has a cycle.";
    }
  }
  return { claimed: "An improvement cycle has been queued.", duplicate: "This request already has a cycle.", busy: "An improvement cycle is already in progress.", budget_exhausted: "The daily budget is already reserved. No new cycle started.", paused: "Resume daily improvement before starting a cycle.", not_due: "The next scheduled check is not due yet." }[outcome];
}
