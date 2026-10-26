import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const SELF_IMPROVEMENT_VERSION = 1 as const;
export const SELF_IMPROVEMENT_MAX_DAILY_BUDGET_USD = 100;
export const selfImprovementDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const selfImprovementRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().trim().min(1).max(240);
const time = z.string().datetime({ offset: true });
const usd = z.number().finite().min(0).max(SELF_IMPROVEMENT_MAX_DAILY_BUDGET_USD);

/** These hashes bind observable artifacts; they do not make their producer trusted. */
export function selfImprovementSha256(kind: string, value: unknown): string {
  return canonicalJsonSha256({ contract: "asael-self-improvement", version: SELF_IMPROVEMENT_VERSION, kind, value });
}

export const selfImprovementRepositorySchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  defaultBranch: z.string().min(1).max(200).refine((value) => !/[\s~^:?*\[\\]/.test(value) && !value.includes("..") && !value.includes("@{"), "Invalid repository branch."),
}).strict();
export const selfImprovementScopeSchema = z.object({
  tenantId: id,
  ownerActorId: id,
  repository: selfImprovementRepositorySchema,
  baseRevision: selfImprovementRevisionSchema,
}).strict();
export type SelfImprovementScope = z.infer<typeof selfImprovementScopeSchema>;

export const selfImprovementPolicyBodySchema = z.object({
  version: z.literal(SELF_IMPROVEMENT_VERSION),
  dailyBudgetUsd: usd.refine((value) => value > 0, "A positive daily ceiling is required."),
  // Absence is an immutable legacy policy, whose cycle allowance equals its daily ceiling.
  maxCycleBudgetUsd: usd.refine((value) => value > 0, "A positive cycle ceiling is required.").optional(),
  maxActiveCycles: z.literal(1),
  maxCandidatesPerCycle: z.literal(1),
  maxCorrections: z.literal(1),
  maxCycleDurationMs: z.number().int().min(60_000).max(86_400_000),
  maxChangedFiles: z.number().int().min(1).max(100),
  maxChangedLines: z.number().int().min(1).max(10_000),
  autoReleaseRoutineChanges: z.boolean(),
  notifyOutcomes: z.boolean(),
  protectedPathsVersion: z.literal(1),
}).strict();
export const selfImprovementPolicySchema = selfImprovementPolicyBodySchema.extend({ policySha256: selfImprovementDigestSchema }).superRefine((value, context) => {
  const { policySha256, ...body } = value;
  if (value.maxCycleBudgetUsd !== undefined && value.maxCycleBudgetUsd > value.dailyBudgetUsd) context.addIssue({ code: "custom", path: ["maxCycleBudgetUsd"], message: "The cycle ceiling cannot exceed the daily ceiling." });
  if (policySha256 !== selfImprovementSha256("policy", body)) context.addIssue({ code: "custom", path: ["policySha256"], message: "Self-improvement policy fingerprint does not match." });
});
export type SelfImprovementPolicy = z.infer<typeof selfImprovementPolicySchema>;

export const engineeringObservationSchema = z.object({
  sourceKind: z.enum(["run", "tool_execution", "owner_feedback", "test_result", "metric", "owner_request", "source_file"]),
  sourceId: id,
  sourceSha256: selfImprovementDigestSchema,
  observedAt: time,
  outcome: z.enum(["failed", "needs_work", "regressed", "requested"]),
  path: z.string().min(1).max(500).optional(),
  sourceRevision: selfImprovementRevisionSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.sourceKind === "source_file" && (!value.path || !value.sourceRevision || value.path.startsWith("/") || value.path.includes("\\") || value.path.split("/").some((part) => !part || part === "." || part === ".."))) context.addIssue({ code: "custom", message: "Source inspection requires an exact repository-relative path and source revision." });
});
export const engineeringSignalBodySchema = z.object({
  version: z.literal(SELF_IMPROVEMENT_VERSION),
  scope: selfImprovementScopeSchema,
  kind: z.enum(["recurrent_tool_failure", "failed_run", "owner_correction", "regression", "performance_regression", "requested_enhancement", "code_defect"]),
  // A normalized deterministic symptom hash, never a model's unsupported diagnosis.
  symptomSha256: selfImprovementDigestSchema,
  summary: z.string().trim().min(1).max(1_000),
  observations: z.array(engineeringObservationSchema).min(1).max(100),
}).strict();
export const engineeringSignalSchema = engineeringSignalBodySchema.extend({
  id: z.string().regex(/^self_signal_[a-f0-9]{64}$/),
  signalSha256: selfImprovementDigestSchema,
}).superRefine((value, context) => {
  const { id: signalId, signalSha256, ...body } = value;
  const expected = selfImprovementSha256("engineering_signal", body);
  if (signalSha256 !== expected || signalId !== `self_signal_${expected}`) context.addIssue({ code: "custom", message: "Engineering signal fingerprint does not match." });
  const references = value.observations.map((item) => `${item.sourceKind}:${item.sourceId}`);
  if (new Set(references).size !== references.length) context.addIssue({ code: "custom", message: "Engineering evidence references must be unique." });
  const expectedKind = { recurrent_tool_failure: "tool_execution", failed_run: "run", owner_correction: "owner_feedback", regression: "test_result", performance_regression: "metric", requested_enhancement: "owner_request", code_defect: "source_file" } as const;
  const expectedOutcome = { recurrent_tool_failure: "failed", failed_run: "failed", owner_correction: "needs_work", regression: "regressed", performance_regression: "regressed", requested_enhancement: "requested", code_defect: "needs_work" } as const;
  if (value.observations.some((item) => item.sourceKind !== expectedKind[value.kind] || item.outcome !== expectedOutcome[value.kind])) context.addIssue({ code: "custom", message: "Signal kind must match its recorded source observations." });
  if (value.observations.some((item) => item.sourceKind === "source_file" && item.sourceRevision !== value.scope.baseRevision)) context.addIssue({ code: "custom", message: "Source inspection must bind the exact observed base revision." });
});
export type EngineeringObservation = z.infer<typeof engineeringObservationSchema>;
export type EngineeringSignal = z.infer<typeof engineeringSignalSchema>;

export const selfImprovementPathSchema = z.string().min(1).max(500).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !/[\u0000-\u001f\u007f]/.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Expected a normalized repository-relative source path.");
export const selfImprovementChangedFileSchema = z.object({
  path: selfImprovementPathSchema,
  beforeSha256: selfImprovementDigestSchema.nullable(),
  afterSha256: selfImprovementDigestSchema.nullable(),
}).strict().refine((value) => value.beforeSha256 !== value.afterSha256, "A change must alter, create or remove a file.");
export const selfImprovementCandidateBodySchema = z.object({
  revision: selfImprovementRevisionSchema,
  workspaceSha256: selfImprovementDigestSchema,
  diffSha256: selfImprovementDigestSchema,
  changedFiles: z.array(selfImprovementChangedFileSchema).min(1).max(500),
  changedLines: z.number().int().min(1).max(100_000),
  architectureImpact: z.enum(["none", "minor", "major"]),
}).strict();
export const selfImprovementCandidateSchema = selfImprovementCandidateBodySchema.extend({ candidateSha256: selfImprovementDigestSchema }).superRefine((value, context) => {
  const { candidateSha256, ...body } = value;
  if (candidateSha256 !== selfImprovementSha256("candidate", body)) context.addIssue({ code: "custom", message: "Candidate fingerprint does not match." });
  const paths = value.changedFiles.map((item) => item.path);
  if (new Set(paths).size !== paths.length || paths.join("\n") !== [...paths].sort().join("\n")) context.addIssue({ code: "custom", message: "Changed files must be unique and in lexical order." });
});
export type SelfImprovementCandidate = z.infer<typeof selfImprovementCandidateSchema>;

export const SELF_IMPROVEMENT_REQUIRED_CHECKS = ["focused_regression", "adjacent_regression", "typecheck", "independent_review"] as const;
export const selfImprovementValidationCheckSchema = z.object({
  id,
  kind: z.enum([...SELF_IMPROVEMENT_REQUIRED_CHECKS, "behavior_comparison", "build", "lint"]),
  outcome: z.enum(["passed", "failed", "incomplete", "not_run"]),
  producerKind: z.enum(["command", "agent_review", "behavior_comparison"]),
  producerId: id,
  candidateRevision: selfImprovementRevisionSchema,
  workspaceSha256: selfImprovementDigestSchema,
  evidenceSha256: selfImprovementDigestSchema,
  declaredCases: z.number().int().min(1).max(100_000),
  executedCases: z.number().int().min(0).max(100_000),
  failedCases: z.number().int().min(0).max(100_000),
  completedAt: time,
}).strict().superRefine((value, context) => {
  if (value.executedCases > value.declaredCases || value.failedCases > value.executedCases ||
      (value.outcome === "passed" && (value.executedCases !== value.declaredCases || value.failedCases !== 0)) ||
      (value.outcome === "failed" && value.failedCases === 0) || (value.outcome === "not_run" && value.executedCases !== 0)) context.addIssue({ code: "custom", message: "Validation outcome must match actual case counts." });
  const expectedProducer = value.kind === "independent_review" ? "agent_review" : value.kind === "behavior_comparison" ? "behavior_comparison" : "command";
  if (value.producerKind !== expectedProducer) context.addIssue({ code: "custom", message: "Validation needs the correct evidence producer." });
});
export const selfImprovementValidationBodySchema = z.object({
  scope: selfImprovementScopeSchema,
  policySha256: selfImprovementDigestSchema,
  signalSha256: selfImprovementDigestSchema,
  candidateSha256: selfImprovementDigestSchema,
  candidateRevision: selfImprovementRevisionSchema,
  workspaceSha256: selfImprovementDigestSchema,
  checks: z.array(selfImprovementValidationCheckSchema).min(1).max(30),
  baselineReproduction: z.object({
    revision: selfImprovementRevisionSchema, producerId: id, evidenceSha256: selfImprovementDigestSchema,
    executedCases: z.number().int().min(1), failedCases: z.number().int().min(1), completedAt: time,
  }).strict().refine((value) => value.failedCases <= value.executedCases, "Baseline failing cases must have actually executed.").nullable().optional(),
}).strict();
export const selfImprovementValidationSchema = selfImprovementValidationBodySchema.extend({ validationSha256: selfImprovementDigestSchema }).superRefine((value, context) => {
  const { validationSha256, ...body } = value;
  if (validationSha256 !== selfImprovementSha256("validation", body)) context.addIssue({ code: "custom", message: "Validation fingerprint does not match." });
  if (new Set(value.checks.map((check) => check.id)).size !== value.checks.length) context.addIssue({ code: "custom", message: "Validation check IDs must be unique." });
  if (value.checks.some((check) => check.candidateRevision !== value.candidateRevision || check.workspaceSha256 !== value.workspaceSha256)) context.addIssue({ code: "custom", message: "Validation checks must bind the exact candidate and workspace." });
});
export type SelfImprovementValidation = z.infer<typeof selfImprovementValidationSchema>;

export const selfImprovementApprovalSchema = z.object({
  approvalId: id,
  tenantId: id,
  ownerActorId: id,
  candidateSha256: selfImprovementDigestSchema,
  policySha256: selfImprovementDigestSchema,
  validationSha256: selfImprovementDigestSchema,
  decision: z.literal("approved"),
  approvedAt: time,
  expiresAt: time,
  receiptSha256: selfImprovementDigestSchema,
}).strict().superRefine((value, context) => {
  const { receiptSha256, ...body } = value;
  if (receiptSha256 !== selfImprovementSha256("approval", body)) context.addIssue({ code: "custom", message: "Exact approval receipt fingerprint does not match." });
  if (Date.parse(value.expiresAt) <= Date.parse(value.approvedAt)) context.addIssue({ code: "custom", message: "Approval expiry must follow approval time." });
});
export type SelfImprovementApproval = z.infer<typeof selfImprovementApprovalSchema>;
export function sealSelfImprovementApproval(body: Omit<SelfImprovementApproval, "receiptSha256">): SelfImprovementApproval {
  return selfImprovementApprovalSchema.parse({ ...body, receiptSha256: selfImprovementSha256("approval", body) });
}

export const selfImprovementReleaseBindingBodySchema = z.object({
  releaseId: id,
  scope: selfImprovementScopeSchema,
  previousRevision: selfImprovementRevisionSchema,
  sourceCandidateRevision: selfImprovementRevisionSchema,
  candidateRevision: selfImprovementRevisionSchema,
  sourceTree: selfImprovementRevisionSchema,
  mergedTree: selfImprovementRevisionSchema,
  pullRequestUrl: z.string().url(),
  mergeEvidenceSha256: selfImprovementDigestSchema,
  candidateSha256: selfImprovementDigestSchema,
  policySha256: selfImprovementDigestSchema,
  validationSha256: selfImprovementDigestSchema,
  runner: z.literal("asael_paired_production"),
}).strict();
export const selfImprovementReleaseBindingSchema = selfImprovementReleaseBindingBodySchema.extend({ releaseBindingSha256: selfImprovementDigestSchema }).superRefine((value, context) => {
  const { releaseBindingSha256, ...body } = value;
  if (releaseBindingSha256 !== selfImprovementSha256("release_binding", body)) context.addIssue({ code: "custom", message: "Release fingerprint does not match." });
  if (value.previousRevision !== value.scope.baseRevision || value.previousRevision === value.candidateRevision) context.addIssue({ code: "custom", message: "Release must bind a distinct candidate and the exact observed base." });
  if (value.sourceTree !== value.mergedTree || value.mergeEvidenceSha256 !== selfImprovementMergeEvidenceSha256(value)) context.addIssue({ code: "custom", message: "Merged release must preserve the verified source tree with exact merge evidence." });
});
export type SelfImprovementReleaseBinding = z.infer<typeof selfImprovementReleaseBindingSchema>;
export function selfImprovementMergeEvidenceSha256(value: Pick<SelfImprovementReleaseBinding, "sourceCandidateRevision" | "previousRevision" | "candidateRevision" | "sourceTree" | "mergedTree" | "pullRequestUrl">): string {
  return selfImprovementSha256("merge_evidence", { sourceCandidateRevision: value.sourceCandidateRevision, previousRevision: value.previousRevision, mergedRevision: value.candidateRevision, sourceTree: value.sourceTree, mergedTree: value.mergedTree, pullRequestUrl: value.pullRequestUrl });
}
export const selfImprovementReleaseReceiptSchema = z.object({
  releaseBindingSha256: selfImprovementDigestSchema,
  outcome: z.enum(["deployed", "failed", "rolled_back"]),
  webRevision: selfImprovementRevisionSchema,
  workerRevision: selfImprovementRevisionSchema,
  manifestSha256: selfImprovementDigestSchema,
  healthEvidenceSha256: selfImprovementDigestSchema,
  serverHealthEvidenceSha256: selfImprovementDigestSchema.optional(),
  behaviorEvidenceSha256: selfImprovementDigestSchema,
  evidenceSha256: selfImprovementDigestSchema,
  recordedAt: time,
}).strict();

export const selfImprovementStageSchema = z.enum(["observing", "no_change", "planned", "implementing", "validating", "correcting", "review_required", "ready_for_release", "releasing", "succeeded", "failed", "rolled_back", "cancelled"]);
export type SelfImprovementStage = z.infer<typeof selfImprovementStageSchema>;
export const SELF_IMPROVEMENT_TERMINAL_STAGES: readonly SelfImprovementStage[] = ["no_change", "succeeded", "failed", "rolled_back", "cancelled"];
export const selfImprovementCycleSchema = z.object({
  id,
  scope: selfImprovementScopeSchema,
  policy: selfImprovementPolicySchema,
  stage: selfImprovementStageSchema,
  revision: z.number().int().min(1),
  signal: engineeringSignalSchema.nullable(),
  candidate: selfImprovementCandidateSchema.nullable(),
  validation: selfImprovementValidationSchema.nullable(),
  approval: selfImprovementApprovalSchema.nullable(),
  release: selfImprovementReleaseBindingSchema.nullable(),
  releaseReceipt: selfImprovementReleaseReceiptSchema.nullable(),
  correctionsUsed: z.number().int().min(0).max(1),
  dailyReservationUsd: usd,
  runId: id.nullable().optional(),
  builderSessionId: id.nullable().optional(),
  checkpointId: id.nullable().optional(),
  verificationId: id.nullable().optional(),
  deliveryId: id.nullable().optional(),
  pullRequestUrl: z.string().url().nullable().optional(),
  leaseToken: id.nullable().optional(),
  createdAt: time,
  updatedAt: time,
}).strict();
export type SelfImprovementCycle = z.infer<typeof selfImprovementCycleSchema>;

export function sealSelfImprovementCandidate(input: z.input<typeof selfImprovementCandidateBodySchema>): SelfImprovementCandidate {
  const body = selfImprovementCandidateBodySchema.parse(input);
  // Use code-point order consistently with schema and Git manifest producers.
  body.changedFiles.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return selfImprovementCandidateSchema.parse({ ...body, candidateSha256: selfImprovementSha256("candidate", body) });
}
export function sealSelfImprovementValidation(input: z.input<typeof selfImprovementValidationBodySchema>): SelfImprovementValidation {
  const body = selfImprovementValidationBodySchema.parse(input);
  return selfImprovementValidationSchema.parse({ ...body, validationSha256: selfImprovementSha256("validation", body) });
}
export function sealSelfImprovementReleaseBinding(input: Omit<z.input<typeof selfImprovementReleaseBindingBodySchema>, "mergeEvidenceSha256"> & { mergeEvidenceSha256?: string }): SelfImprovementReleaseBinding {
  const body = selfImprovementReleaseBindingBodySchema.parse({ ...input, mergeEvidenceSha256: input.mergeEvidenceSha256 || selfImprovementMergeEvidenceSha256(input) });
  return selfImprovementReleaseBindingSchema.parse({ ...body, releaseBindingSha256: selfImprovementSha256("release_binding", body) });
}
