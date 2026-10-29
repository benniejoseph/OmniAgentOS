import { z } from "zod";
import { selfImprovementDigestSchema as digest, selfImprovementPathSchema as path, selfImprovementSha256, type SelfImprovementCycle } from "./contracts";

const handle = z.string().min(1).max(240);
const line = z.number().int().min(1).max(1_000_000);
export const MAX_REVIEW_RATIONALE_CHARACTERS = 500;
export const reviewEvidenceReferenceSchema = z.object({
  path, startLine: line, endLine: line, checkId: z.string().regex(/^(?:baseline|candidate:[0-3])$/).optional(),
}).strict().refine(value => value.endLine >= value.startLine, "Review evidence range is reversed.");
export const reviewAssessmentSchema = z.object({
  status: z.enum(["satisfied", "unmet", "unverified"]), rationale: z.string().min(1).max(MAX_REVIEW_RATIONALE_CHARACTERS),
  evidence: z.array(reviewEvidenceReferenceSchema).max(4),
}).strict();
export const reviewSubmissionSchema = z.object({
  architectureImpact: z.enum(["none", "minor", "major"]), summary: z.string().min(1).max(500),
  baselineControl: reviewAssessmentSchema,
  criteria: z.array(reviewAssessmentSchema.extend({ criterionId: z.string().regex(/^c(?:[1-9]|1[0-2])$/) }).strict()).min(1).max(12),
}).strict();
export type ReviewSubmission = z.infer<typeof reviewSubmissionSchema>;
export const reviewReadSchema = z.object({
  executionId: handle, path, sha256: digest, startLine: line, endLine: line,
  inputSha256: digest, scopeSha256: digest,
}).strict().refine(value => value.endLine >= value.startLine, "Review read range is reversed.");
export type ReviewRead = z.infer<typeof reviewReadSchema>;
/** A citation can cross real pages, but cannot cross an unread line or file revision. */
export function reviewReferenceReads(reference: z.infer<typeof reviewEvidenceReferenceSchema>, reads: readonly ReviewRead[]): ReviewRead[] | undefined {
  const revisions = new Map<string, ReviewRead[]>();
  for (const read of reads) if (read.path === reference.path) {
    const group = revisions.get(read.sha256) || [];
    group.push(read); revisions.set(read.sha256, group);
  }
  for (const group of revisions.values()) {
    const covered: ReviewRead[] = [];
    let next = reference.startLine;
    for (const read of group.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)) {
      if (read.endLine < next) continue;
      if (read.startLine > next) break;
      covered.push(read); next = read.endLine + 1;
      if (next > reference.endLine) return covered;
    }
  }
  return undefined;
}
export const reviewCheckSchema = z.object({
  id: z.string().regex(/^(?:baseline|candidate:[0-3])$/), executionId: handle, command: z.string().min(1).max(40),
  paths: z.array(path).max(30), outputSha256: digest, workspaceSha256: digest,
  exitCode: z.number().int(), totalTests: z.number().int().nonnegative(), passedTests: z.number().int().nonnegative(), failedTests: z.number().int().nonnegative(),
}).strict();
export type ReviewCheck = z.infer<typeof reviewCheckSchema>;
/** Test coverage comes from its report; static checks retain their declared command targets. */
export function reviewCheckEvidencePaths(check: { command: string; paths: string[]; executedPaths?: string[] }) {
  return check.command === "test_focused" || check.command === "macos_test_focused" ? check.executedPaths ?? [] : check.paths;
}
export const reviewManifestSchema = z.object({
  tenantId: handle, ownerActorId: handle, projectId: handle, cycleId: handle, policySha256: digest,
  sessionId: z.string().regex(/^app_build_[a-f0-9]{48}$/), checkpointId: handle, verificationId: handle, workspaceSha256: digest,
  planSha256: digest, preparationSha256: digest, checksSha256: digest, supervisionSha256: digest.optional(),
  criteria: z.array(z.string().min(1).max(500)).min(1).max(12),
  sourcePaths: z.array(path).min(1).max(20), focusedTestPaths: z.array(path).min(1).max(6),
  fileHashes: z.record(path, digest), checks: z.array(reviewCheckSchema).length(5),
}).strict().superRefine((value, context) => {
  if (Object.keys(value.fileHashes).length > 32 || new Set(value.checks.map(item => item.id)).size !== 5 ||
      !value.checks.some(item => item.id === "baseline") || value.checks.some(item => item.id !== "baseline" && (item.exitCode !== 0 || item.workspaceSha256 !== value.workspaceSha256)) ||
      [...value.sourcePaths, ...value.focusedTestPaths].some(item => !value.fileHashes[item])) context.addIssue({ code: "custom", message: "Review manifest lacks exact candidate evidence." });
});
export type ReviewManifest = z.infer<typeof reviewManifestSchema>;
/** Ephemeral server evidence from the exact checkpoint's safe workspace index; never model/API input. */
export type ReviewWorkspaceIndex = Readonly<{ workspaceSha256: string; fileHashes: Readonly<Record<string, string>> }>;
const reviewEvidenceFailureSchema = z.object({
  code: z.enum(["authority_unavailable", "workspace_changed", "workspace_index_mismatch", "read_receipt_unavailable", "read_hash_mismatch", "reference_range_unavailable", "check_reference_mismatch", "required_check_missing", "required_file_unread", "receipt_too_large"]),
  criterionId: z.string().regex(/^(?:baselineControl|c(?:[1-9]|1[0-2]))$/).optional(),
  referenceIndex: z.number().int().min(0).max(3).optional(),
}).strict();
export type ReviewEvidenceFailure = z.infer<typeof reviewEvidenceFailureSchema>;
export const reviewCompletionReceiptSchema = z.object({
  version: z.literal(1), runId: z.string().uuid(), sessionId: z.string().regex(/^app_build_[a-f0-9]{48}$/),
  tenantId: handle, ownerActorId: handle, projectId: handle, cycleId: handle, policySha256: digest,
  checkpointId: handle, verificationId: handle, workspaceSha256: digest, planSha256: digest, preparationSha256: digest, checksSha256: digest, manifestSha256: digest, supervisionSha256: digest.optional(),
  outcome: z.enum(["passed", "blocked", "rejected"]), reason: z.enum(["complete", "criteria_not_satisfied", "invalid_result", "incomplete_run", "evidence_unavailable"]),
  criterionCount: z.number().int().min(1).max(12),
  result: reviewSubmissionSchema.optional(), reads: z.array(reviewReadSchema).max(48), resultSha256: digest.optional(),
  evidenceFailure: reviewEvidenceFailureSchema.optional(),
  receiptSha256: digest,
}).strict().superRefine((value, context) => {
  const { receiptSha256, ...body } = value;
  const ids = value.result?.criteria.map(item => item.criterionId);
  const unsupported = value.result && [value.result.baselineControl, ...value.result.criteria].some(item => item.evidence.some(reference =>
    !reviewReferenceReads(reference, value.reads)));
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 48 * 1024 || selfImprovementSha256("review_completion", body) !== receiptSha256 ||
      unsupported || (value.evidenceFailure && (value.outcome !== "rejected" || value.reason !== "evidence_unavailable")) ||
      (value.outcome !== "rejected") !== Boolean(value.result && value.resultSha256) ||
      (value.result && (selfImprovementSha256("review_result", value.result) !== value.resultSha256 || ids?.length !== value.criterionCount || new Set(ids).size !== value.criterionCount || ids.some(id => !Array.from({ length: value.criterionCount }, (_, i) => `c${i + 1}`).includes(id)))) ||
      (value.outcome === "passed" && (value.reason !== "complete" || value.result?.baselineControl.status !== "satisfied" ||
        !value.result.baselineControl.evidence.some(item => item.checkId === "baseline") ||
        value.result.criteria.some(item => item.status !== "satisfied" || !item.evidence.some(reference => reference.checkId?.startsWith("candidate:")))))) {
    context.addIssue({ code: "custom", message: "Review completion evidence changed." });
  }
});
export type ReviewCompletionReceipt = z.infer<typeof reviewCompletionReceiptSchema>;

/** Historical runtime rows remain readable; only this exact new proof grants delivery authority. */
export function assertReviewCompletionBinding(receipt: ReviewCompletionReceipt | undefined, expected: {
  tenantId: string; ownerActorId: string; projectId: string; cycleId: string; policySha256: string;
  sessionId: string; checkpointId: string; verificationId: string; workspaceSha256: string; plan: unknown; runId: string;
  preparation: unknown; baseline: unknown; checks: unknown; supervisionSha256?: string;
}) {
  const parsed = reviewCompletionReceiptSchema.safeParse(receipt);
  if (!parsed.success || parsed.data.outcome !== "passed" || parsed.data.planSha256 !== selfImprovementSha256("review_plan", expected.plan) ||
      parsed.data.preparationSha256 !== selfImprovementSha256("review_preparation", expected.preparation) ||
      parsed.data.checksSha256 !== selfImprovementSha256("review_checks", { baseline: expected.baseline, checks: expected.checks }) ||
      Object.entries(expected).some(([key, value]) => !["plan", "preparation", "baseline", "checks"].includes(key) && parsed.data[key as keyof ReviewCompletionReceipt] !== value)) {
    throw new Error("The candidate has no exact, complete per-criterion Sentinel review.");
  }
  return parsed.data;
}

export function assertPublishableCriterionReview(stored: { cycle: SelfImprovementCycle; projectId: string; runtime: Record<string, unknown> }) {
  const { cycle, runtime } = stored;
  const parsed = reviewCompletionReceiptSchema.safeParse(runtime.reviewReceipt);
  const preparations = Array.isArray(runtime.preparations) ? runtime.preparations : [];
  if (!parsed.success || !cycle.candidate || !cycle.validation || !cycle.builderSessionId || !cycle.checkpointId || !cycle.verificationId || typeof runtime.reviewRunId !== "string") {
    throw new Error("Publication requires the exact per-criterion review receipt; legacy prose reviews remain unproven.");
  }
  if (!parsed.data.supervisionSha256) {
    throw new Error("Publication requires fresh review evidence bound to the preparation chronology and candidate changes.");
  }
  const receipt = assertReviewCompletionBinding(parsed.data, { tenantId: cycle.scope.tenantId, ownerActorId: cycle.scope.ownerActorId,
    projectId: stored.projectId, cycleId: cycle.id, policySha256: cycle.policy.policySha256, sessionId: cycle.builderSessionId,
    checkpointId: cycle.checkpointId, verificationId: cycle.verificationId, workspaceSha256: cycle.candidate.workspaceSha256,
    plan: runtime.plan, runId: runtime.reviewRunId, preparation: preparations.at(-1), baseline: runtime.baseline, checks: runtime.checks });
  const reviews = cycle.validation.checks.filter(item => item.kind === "independent_review");
  if (reviews.length !== 1 || reviews[0].producerId !== receipt.runId || reviews[0].evidenceSha256 !== receipt.receiptSha256 ||
      reviews[0].declaredCases !== receipt.criterionCount || reviews[0].executedCases !== receipt.criterionCount || reviews[0].outcome !== "passed" || reviews[0].failedCases !== 0) {
    throw new Error("Publication validation does not contain the exact satisfied criterion set.");
  }
  return receipt;
}
