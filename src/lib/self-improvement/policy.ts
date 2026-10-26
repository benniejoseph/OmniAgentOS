import type { z } from "zod";
import {
  SELF_IMPROVEMENT_REQUIRED_CHECKS,
  SELF_IMPROVEMENT_TERMINAL_STAGES,
  selfImprovementCandidateSchema,
  selfImprovementCycleSchema,
  selfImprovementPolicyBodySchema,
  selfImprovementPolicySchema,
  selfImprovementSha256,
  selfImprovementValidationSchema,
  type SelfImprovementApproval,
  type SelfImprovementCandidate,
  type SelfImprovementCycle,
  type SelfImprovementPolicy,
  type SelfImprovementStage,
  type SelfImprovementValidation,
} from "@/lib/self-improvement/contracts";

export const DEFAULT_SELF_IMPROVEMENT_POLICY = Object.freeze(createSelfImprovementPolicy({}));

export function createSelfImprovementPolicy(input: Partial<z.input<typeof selfImprovementPolicyBodySchema>>): SelfImprovementPolicy {
  const body = selfImprovementPolicyBodySchema.parse({
    version: 1,
    dailyBudgetUsd: 100,
    maxActiveCycles: 1,
    maxCandidatesPerCycle: 1,
    maxCorrections: 1,
    maxCycleDurationMs: 60 * 60_000,
    maxChangedFiles: 12,
    maxChangedLines: 1_200,
    autoReleaseRoutineChanges: true,
    protectedPathsVersion: 1,
    ...input,
  });
  return selfImprovementPolicySchema.parse({ ...body, policySha256: selfImprovementSha256("policy", body) });
}

/** Schedule and pause revisions are administrative metadata, not new execution authority. */
export function assertCurrentSelfImprovementConfiguration(configuration: {
  id: string; tenantId: string; ownerActorId: string; projectId: string; repositoryId: string;
  repository: SelfImprovementCycle["scope"]["repository"]; policy: SelfImprovementPolicy; paused: boolean;
} | null, admitted: { cycle: SelfImprovementCycle; configurationId: string; projectId: string; repositoryId: string }): void {
  if (!configuration || configuration.paused || configuration.id !== admitted.configurationId ||
      configuration.tenantId !== admitted.cycle.scope.tenantId || configuration.ownerActorId !== admitted.cycle.scope.ownerActorId ||
      configuration.projectId !== admitted.projectId || configuration.repositoryId !== admitted.repositoryId ||
      configuration.policy.policySha256 !== admitted.cycle.policy.policySha256 ||
      selfImprovementSha256("repository_identity", configuration.repository) !== selfImprovementSha256("repository_identity", admitted.cycle.scope.repository)) {
    throw new Error("Self-improvement is paused or its admitted policy, owner, project or repository changed.");
  }
}

const PROTECTED_PATH_RULES = [
  { reason: "self_improvement_control", pattern: /^src\/lib\/self-improvement\// },
  { reason: "authentication_or_authority", pattern: /^src\/lib\/(?:auth|security|db)\// },
  { reason: "runtime_entrypoint", pattern: /^src\/(?:proxy|middleware|instrumentation)(?:\.|\/)|^src\/lib\/config(?:\.|\/)/ },
  { reason: "model_or_connector_authority", pattern: /^src\/lib\/(?:models|mcp)\/|^src\/lib\/connectors\/(?:credential|vault|oauth|native-|mcp-trust)/ },
  { reason: "tool_execution_control", pattern: /^src\/lib\/tools\// },
  { reason: "agent_authority", pattern: /^src\/lib\/agents\/(?:identity|principal|release|learning|adaptation|execution-improvement)(?:[./-]|$)/ },
  { reason: "agent_execution_control", pattern: /^src\/lib\/orchestration\/(?:agent-runner|agent-tool-policy|loop-v2|continuation-authority|resume-queue|action-approval|clarification-approval|prompts)(?:[./-]|$)/ },
  { reason: "execution_control", pattern: /^src\/lib\/(?:delegation|operations|workflows|capabilities)\// },
  { reason: "service_authority", pattern: /^src\/lib\/app-services\/(?:authorization|context|registry|tool-dispatcher|agent-governance|app-builder|self-improvement)(?:[./-]|$)/ },
  { reason: "release_control", pattern: /^src\/lib\/(?:app-builder|release|releases)\// },
  { reason: "protected_api", pattern: /^src\/app\/api\/(?:auth|oauth|release|internal|agent|agents|approvals|tools|security|mobile|capabilities|command|system|operations|mcp|openapi-connectors|connectors|plugins|skills|triggers|workflows|health|self-improvement)(?:\/|$)|^src\/app\/api\/projects\/[^/]+\/builder(?:\/|$)/ },
  { reason: "database_migration", pattern: /(?:^|\/)(?:supabase\/migrations|prisma\/migrations|drizzle|migrations)(?:\/|$)/ },
  { reason: "native_application", pattern: /^(?:apps|native|packages\/native)\// },
  { reason: "release_or_ci_control", pattern: /^(?:scripts\/|\.github\/|\.husky\/|dockerfile|fly\.|vercel\.json|schema-migrations\.json)/ },
  { reason: "dependencies_or_build_control", pattern: /^(?:package(?:-lock)?\.json|(?:pnpm|yarn|bun)\.lockb?|next\.config\.|tsconfig|vitest\.|eslint\.|performance-budgets\.json)/ },
  { reason: "operating_instructions", pattern: /(?:^|\/)(?:agents|claude)\.md$|^docs\/(?:production-rollout|deployment|harness-engineering)\.md$/ },
  { reason: "secret_or_signing_material", pattern: /(?:^|\/)(?:\.env(?:\.|$)|[^/]*\.(?:pem|key|p12|pfx|mobileprovision)$)/ },
] as const;

export type SelfImprovementChangeClassification = Readonly<{
  disposition: "routine" | "review_required";
  reasons: readonly string[];
  protectedFiles: readonly string[];
  candidateSha256: string;
  policySha256: string;
  classificationSha256: string;
}>;

/** A model's 'minor' declaration can never override a protected path or size bound. */
export function classifySelfImprovementChange(input: {
  candidate: SelfImprovementCandidate;
  policy: SelfImprovementPolicy;
}): SelfImprovementChangeClassification {
  const candidate = selfImprovementCandidateSchema.parse(input.candidate);
  const policy = selfImprovementPolicySchema.parse(input.policy);
  const reasons = new Set<string>();
  const protectedFiles = new Set<string>();
  for (const file of candidate.changedFiles) {
    const path = file.path.toLowerCase();
    for (const rule of PROTECTED_PATH_RULES) {
      if (rule.pattern.test(path)) { reasons.add(rule.reason); protectedFiles.add(file.path); }
    }
    // New application modules, UI, assets and regression cases may be routine.
    if (!/^(?:src\/|public\/|docs\/|tests\/|evals\/)/.test(path) && !/^(?:readme|product|design|design_review)\.md$/.test(path)) {
      reasons.add("unclassified_repository_surface"); protectedFiles.add(file.path);
    }
  }
  if (candidate.changedFiles.length > policy.maxChangedFiles) reasons.add("change_file_limit");
  if (candidate.changedLines > policy.maxChangedLines) reasons.add("change_line_limit");
  if (candidate.architectureImpact === "major") reasons.add("major_architecture_change");
  if (!policy.autoReleaseRoutineChanges) reasons.add("automatic_release_disabled");
  const body = {
    disposition: reasons.size ? "review_required" as const : "routine" as const,
    reasons: [...reasons].sort(), protectedFiles: [...protectedFiles].sort(),
    candidateSha256: candidate.candidateSha256, policySha256: policy.policySha256,
  };
  return Object.freeze({ ...body, classificationSha256: selfImprovementSha256("change_classification", body) });
}

const transitions: Readonly<Record<SelfImprovementStage, readonly SelfImprovementStage[]>> = {
  observing: ["no_change", "planned", "failed", "cancelled"],
  planned: ["implementing", "review_required", "failed", "cancelled"],
  implementing: ["validating", "review_required", "failed", "cancelled"],
  validating: ["correcting", "review_required", "ready_for_release", "failed", "cancelled"],
  correcting: ["validating", "review_required", "failed", "cancelled"],
  review_required: ["implementing", "validating", "ready_for_release", "failed", "cancelled"],
  ready_for_release: ["releasing", "review_required", "failed", "cancelled"],
  releasing: ["succeeded", "rolled_back", "failed"],
  no_change: [], succeeded: [], failed: [], rolled_back: [], cancelled: [],
};

export function canTransitionSelfImprovementStage(from: SelfImprovementStage, to: SelfImprovementStage): boolean {
  return transitions[from].includes(to);
}
export function assertSelfImprovementStageTransition(from: SelfImprovementStage, to: SelfImprovementStage): void {
  if (!canTransitionSelfImprovementStage(from, to)) throw new Error(`Self-improvement cannot transition from ${from} to ${to}.`);
}
export function isSelfImprovementTerminalStage(stage: SelfImprovementStage): boolean {
  return SELF_IMPROVEMENT_TERMINAL_STAGES.includes(stage);
}

export function assertPassingSelfImprovementValidation(validationInput: SelfImprovementValidation): void {
  const validation = selfImprovementValidationSchema.parse(validationInput);
  if (validation.checks.some((check) => check.outcome !== "passed")) throw new Error("Every recorded candidate check must pass; incomplete checks cannot be ignored.");
  if (SELF_IMPROVEMENT_REQUIRED_CHECKS.some((kind) => !validation.checks.some((check) => check.kind === kind))) throw new Error("Focused, adjacent, typecheck and independent review evidence are required.");
}

export function hasExactSelfImprovementApproval(input: {
  cycle: SelfImprovementCycle; approval: SelfImprovementApproval | null; now: string;
}): boolean {
  const { cycle, approval } = input;
  return Boolean(approval && cycle.candidate && cycle.validation &&
    approval.tenantId === cycle.scope.tenantId && approval.ownerActorId === cycle.scope.ownerActorId &&
    approval.candidateSha256 === cycle.candidate.candidateSha256 &&
    approval.validationSha256 === cycle.validation.validationSha256 &&
    approval.policySha256 === cycle.policy.policySha256 &&
    Date.parse(approval.approvedAt) <= Date.parse(input.now) && Date.parse(approval.expiresAt) > Date.parse(input.now));
}

/** Validate the whole saved boundary, including callbacks that jump directly to a terminal outcome. */
export function assertSelfImprovementCycleIntegrity(input: SelfImprovementCycle): void {
  const cycle = selfImprovementCycleSchema.parse(input);
  const equal = (left: unknown, right: unknown) => selfImprovementSha256("binding", left) === selfImprovementSha256("binding", right);
  if (Date.parse(cycle.updatedAt) < Date.parse(cycle.createdAt)) throw new Error("Cycle update predates creation.");
  if (cycle.dailyReservationUsd > cycle.policy.dailyBudgetUsd) throw new Error("Cycle reservation exceeds the immutable daily ceiling.");
  if (cycle.signal && !equal(cycle.scope, cycle.signal.scope)) throw new Error("Engineering signal belongs to another owner, repository or base revision.");
  if (!["observing", "no_change", "failed", "cancelled"].includes(cycle.stage) && !cycle.signal) throw new Error("Actionable work requires recorded engineering evidence.");
  if (cycle.stage === "no_change" && (cycle.signal || cycle.candidate || cycle.validation || cycle.release)) throw new Error("A no-change observation cannot claim candidate work.");
  if (cycle.candidate?.revision === cycle.scope.baseRevision) throw new Error("Candidate revision must differ from its base.");
  if (cycle.validation && (!cycle.candidate || !cycle.signal || !equal(cycle.validation.scope, cycle.scope) ||
      cycle.validation.policySha256 !== cycle.policy.policySha256 || cycle.validation.signalSha256 !== cycle.signal.signalSha256 ||
      cycle.validation.candidateSha256 !== cycle.candidate.candidateSha256 || cycle.validation.candidateRevision !== cycle.candidate.revision ||
      cycle.validation.workspaceSha256 !== cycle.candidate.workspaceSha256)) throw new Error("Validation is not bound to this exact scoped candidate.");
  if (cycle.release && (!cycle.candidate || !cycle.validation || !equal(cycle.release.scope, cycle.scope) ||
      cycle.release.candidateSha256 !== cycle.candidate.candidateSha256 || cycle.release.sourceCandidateRevision !== cycle.candidate.revision ||
      cycle.release.validationSha256 !== cycle.validation.validationSha256 || cycle.release.policySha256 !== cycle.policy.policySha256)) throw new Error("Release is not bound to this exact validated candidate.");
  if (["ready_for_release", "releasing", "succeeded", "rolled_back"].includes(cycle.stage) && !cycle.candidate) throw new Error("This stage requires a sealed candidate.");
  if (["ready_for_release", "releasing", "succeeded", "rolled_back"].includes(cycle.stage)) {
    if (!cycle.validation) throw new Error("Release readiness requires validation evidence.");
    assertPassingSelfImprovementValidation(cycle.validation);
    if (cycle.signal?.kind === "code_defect" && cycle.validation.baselineReproduction?.revision !== cycle.scope.baseRevision) throw new Error("Source inspection nominations require a failing baseline reproduction before release.");
    if (cycle.candidate && classifySelfImprovementChange({ candidate: cycle.candidate, policy: cycle.policy }).disposition === "review_required" &&
        !hasExactSelfImprovementApproval({ cycle, approval: cycle.approval, now: ["releasing", "succeeded", "rolled_back"].includes(cycle.stage) ? cycle.approval?.approvedAt || cycle.updatedAt : cycle.updatedAt })) throw new Error("This exact protected candidate needs a current owner approval.");
  }
  if (["releasing", "succeeded", "rolled_back"].includes(cycle.stage) && !cycle.release) throw new Error("Release stages require an exact paired-release binding.");
  if (cycle.releaseReceipt && (!cycle.release || cycle.releaseReceipt.releaseBindingSha256 !== cycle.release.releaseBindingSha256)) throw new Error("Release receipt belongs to another release.");
  if (cycle.stage === "succeeded" && (!cycle.releaseReceipt || cycle.releaseReceipt.outcome !== "deployed" ||
      cycle.releaseReceipt.webRevision !== cycle.release?.candidateRevision || cycle.releaseReceipt.workerRevision !== cycle.release?.candidateRevision)) throw new Error("Success requires matching deployed web and worker revisions with release evidence.");
  if (cycle.stage === "rolled_back" && (!cycle.releaseReceipt || cycle.releaseReceipt.outcome !== "rolled_back" ||
      cycle.releaseReceipt.webRevision !== cycle.scope.baseRevision || cycle.releaseReceipt.workerRevision !== cycle.scope.baseRevision)) throw new Error("Rollback requires matching restored web and worker revisions.");
}

/** Stores must additionally fence this with the current revision and active lease. */
export function assertSelfImprovementCycleTransition(before: SelfImprovementCycle, after: SelfImprovementCycle): void {
  assertSelfImprovementCycleIntegrity(before);
  assertSelfImprovementCycleIntegrity(after);
  assertSelfImprovementStageTransition(before.stage, after.stage);
  if (before.id !== after.id || selfImprovementSha256("scope", before.scope) !== selfImprovementSha256("scope", after.scope) ||
      before.policy.policySha256 !== after.policy.policySha256 || before.createdAt !== after.createdAt ||
      before.dailyReservationUsd !== after.dailyReservationUsd || after.revision !== before.revision + 1 ||
      Date.parse(after.updatedAt) < Date.parse(before.updatedAt)) throw new Error("Cycle identity, policy, reservation and revision must remain pinned.");
  if (before.signal && before.signal.signalSha256 !== after.signal?.signalSha256) throw new Error("A cycle cannot replace its engineering signal.");
  const correctionIncrement = after.stage === "correcting" ? 1 : 0;
  if (after.correctionsUsed !== before.correctionsUsed + correctionIncrement || after.correctionsUsed > before.policy.maxCorrections) throw new Error("Only one bounded correction is available.");
  if (before.candidate && before.candidate.candidateSha256 !== after.candidate?.candidateSha256 && before.stage !== "correcting") throw new Error("A sealed candidate can only change during its one correction.");
  if (before.release && before.release.releaseBindingSha256 !== after.release?.releaseBindingSha256) throw new Error("An in-flight release binding cannot be replaced.");
  // Expiry controls admission of a new release, not reconciliation after an
  // admitted deployment has started. Heartbeats and cost receipts may arrive
  // after expiry and must still be able to settle the same immutable release.
  if (before.stage === "ready_for_release" && after.stage === "releasing" && after.candidate &&
      classifySelfImprovementChange({ candidate: after.candidate, policy: after.policy }).disposition === "review_required" &&
      !hasExactSelfImprovementApproval({ cycle: after, approval: after.approval, now: after.updatedAt })) throw new Error("This exact candidate's owner approval expired before release admission.");
  if (before.stage === "releasing" && after.stage === "failed" && (!after.releaseReceipt || after.releaseReceipt.outcome !== "failed" || after.releaseReceipt.webRevision !== before.scope.baseRevision || after.releaseReceipt.workerRevision !== before.scope.baseRevision)) throw new Error("An uncertain in-flight release must retain its active lock until the paired prior revision is confirmed.");
  if (Date.parse(after.updatedAt) - Date.parse(after.createdAt) > before.policy.maxCycleDurationMs &&
      !["failed", "cancelled", "rolled_back", "succeeded"].includes(after.stage) && before.stage !== "releasing" &&
      !(before.stage === "ready_for_release" && ["releasing", "review_required"].includes(after.stage)) &&
      !(before.stage === "review_required" && after.stage === "ready_for_release")) throw new Error("Self-improvement cycle execution deadline expired.");
}
