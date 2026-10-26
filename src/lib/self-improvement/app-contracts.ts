import { z } from "zod";
import { appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { selfImprovementCycleSchema, selfImprovementDigestSchema, selfImprovementPolicySchema, selfImprovementRepositorySchema } from "./contracts";
import { improvementPhaseSchema, selfImprovementRuntimeSchema } from "./runtime";

// Pure wire contracts shared by the application services and native publication.
// Authentication, owner scope, fingerprints and transition admission remain server-owned.
const target = z.string().trim().min(1).max(240);
const time = z.string().datetime({ offset: true });
const revision = z.number().int().positive();
export const improvementConfigureInput = z.object({ projectId: target, repositoryId: z.string().regex(/^\d{1,24}$/),
  dailyBudgetUsd: z.number().finite().positive().max(100), maxCycleBudgetUsd: z.number().finite().positive().max(100).optional(), autoReleaseRoutineChanges: z.boolean(), notifyOutcomes: z.boolean().default(true),
  timeZone: z.string().min(1).max(80).default("Asia/Kolkata"), dailyHour: z.number().int().min(0).max(23).default(3),
  expectedGeneration: revision.optional() }).strict().refine(
  (value) => value.maxCycleBudgetUsd === undefined || value.maxCycleBudgetUsd <= value.dailyBudgetUsd,
  { path: ["maxCycleBudgetUsd"], message: "The cycle limit cannot exceed the daily limit." });
export const improvementRunInput = z.object({ configurationId: target, expectedGeneration: revision }).strict();
export const improvementAdvanceInput = z.object({ cycleId: target, expectedRevision: revision }).strict();
export const improvementRetryInput = improvementRunInput.extend({ failedCycleId: target, expectedRevision: revision }).strict();
export const improvementStopNativeCheckInput = z.object({ cycleId: target, expectedRevision: revision, requestId: z.string().regex(/^self_native_[a-f0-9]{64}$/), requestSha256: selfImprovementDigestSchema }).strict();
export const improvementPauseInput = improvementRunInput.extend({ paused: z.boolean() }).strict();
export const improvementReviewInput = z.object({ cycleId: target, expectedRevision: revision,
  candidateSha256: selfImprovementDigestSchema, validationSha256: selfImprovementDigestSchema, decision: z.enum(["approve", "reject"]) }).strict();

export const improvementReadQuerySchema = z.union([
  z.object({}).strict(),
  z.object({ view: z.literal("repositories") }).strict(),
  z.object({ cycleId: z.string().regex(/^self_cycle_[a-f0-9]{64}$/) }).strict(),
]);
export const improvementNativeMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), input: improvementConfigureInput }).strict(),
  z.object({ action: z.literal("run"), input: improvementRunInput }).strict(),
  z.object({ action: z.literal("pause"), input: improvementPauseInput }).strict(),
  z.object({ action: z.literal("review"), input: improvementReviewInput }).strict(),
  z.object({ action: z.literal("retry"), input: improvementRetryInput }).strict(),
  z.object({ action: z.literal("stop_native_check"), input: improvementStopNativeCheckInput }).strict(),
]);

export const improvementConfigurationSchema = z.object({
  id: target, tenantId: target, ownerActorId: target, projectId: target,
  repositoryId: z.string().regex(/^\d{1,24}$/), repository: selfImprovementRepositorySchema,
  policy: selfImprovementPolicySchema, generation: revision, nextDueAt: time, paused: z.boolean(),
  timeZone: z.string().min(1).max(80), dailyHour: z.number().int().min(0).max(23), createdAt: time, updatedAt: time,
}).strict();
const classificationSchema = z.object({
  disposition: z.enum(["routine", "review_required"]), reasons: z.array(target).max(100), protectedFiles: z.array(z.string().min(1).max(500)).max(500),
  candidateSha256: selfImprovementDigestSchema, policySha256: selfImprovementDigestSchema, classificationSha256: selfImprovementDigestSchema,
}).strict();
export const improvementPublicCycleSchema = selfImprovementCycleSchema.omit({ leaseToken: true }).extend({
  configurationId: target, projectId: target, executionLeaseExpiresAt: time,
  nativeCheck: z.object({ requestId: z.string().regex(/^self_native_[a-f0-9]{64}$/), requestSha256: selfImprovementDigestSchema, purpose: z.enum(["baseline", "candidate"]), status: z.enum(["queued", "claimed", "completed", "held"]), holdCategory: target.nullable(), canStop: z.boolean() }).strict().optional(),
  spendUsd: z.number().finite().min(0), usageState: z.enum(["known", "unknown"]),
  controllerHold: z.object({ category: target, occurredAt: time }).strict().nullable(),
  phase: z.union([improvementPhaseSchema, z.literal("unknown")]), summary: z.string().max(2_000),
  agentRuns: selfImprovementRuntimeSchema.shape.agentRuns,
  classification: classificationSchema.nullable(), approvalExpired: z.boolean(), approvalRenewalAvailable: z.boolean(), discardAvailable: z.boolean(),
  releaseEligibility: z.enum(["manual_release", "owner_review", "automatic"]), setupRetryAvailable: z.boolean().optional(),
}).strict();
const githubStatusSchema = z.object({ configured: z.boolean(), missing: z.array(z.string().min(1).max(120)).max(4),
  appSlug: z.string().min(1).max(200).optional(), installUrl: z.string().url().optional() }).strict();
const githubRepositorySchema = z.object({ repositoryId: z.string().regex(/^\d{1,24}$/),
  owner: z.string().min(1).max(100), name: z.string().min(1).max(100), fullName: z.string().min(1).max(201),
  private: z.boolean(), defaultBranch: z.string().min(1).max(200), htmlUrl: z.string().url() }).strict();
const controllerStatusSchema = z.union([
  z.object({ status: z.literal("not_connected") }).strict(),
  z.object({ status: z.enum(["online", "offline"]), lastSeenAt: time, activity: z.literal("held").optional(), category: target.optional() }).strict(),
]);
const receipt = { serviceReceipt: appServiceReceiptSchema };
export const improvementStatusResponseSchema = z.object({ ...receipt,
  configurations: z.array(improvementConfigurationSchema).max(100), cycles: z.array(improvementPublicCycleSchema).max(30),
  github: githubStatusSchema, controller: controllerStatusSchema,
}).strict();
export const improvementRepositoriesResponseSchema = z.object({ ...receipt, repositories: z.array(githubRepositorySchema).max(300) }).strict();
export const improvementCycleResponseSchema = z.object({ ...receipt, cycle: improvementPublicCycleSchema }).strict();
export const improvementReadResponseSchema = z.union([improvementStatusResponseSchema, improvementRepositoriesResponseSchema, improvementCycleResponseSchema]);

const operationJobSchema = z.object({ id: target, type: z.literal("self_improvement.cycle.tick"),
  status: z.enum(["queued", "running", "completed", "failed", "canceled", "quarantined"]) }).strict();
const runResponse = { ...receipt, outcome: z.enum(["claimed", "duplicate", "busy", "budget_exhausted", "paused", "not_due"]),
  cycle: improvementPublicCycleSchema.nullable(), operationJob: operationJobSchema.nullable() };
export const improvementConfigurationResponseSchema = z.object({ ...receipt, configuration: improvementConfigurationSchema }).strict();
export const improvementRunResponseSchema = z.object(runResponse).strict();
export const improvementRetryResponseSchema = z.object({ ...runResponse,
  retryOf: z.object({ cycleId: target, revision, cycleSha256: selfImprovementDigestSchema, toolExecutionId: target, toolReceiptSha256: selfImprovementDigestSchema }).strict().nullable(),
}).strict();
export const improvementReviewResponseSchema = z.object({ ...receipt, cycle: improvementPublicCycleSchema, manualReleaseRequired: z.boolean() }).strict();
export const improvementStopNativeCheckResponseSchema = z.object({ ...receipt, cycle: improvementPublicCycleSchema }).strict();
export const improvementMutationResponseSchema = z.union([
  improvementConfigurationResponseSchema, improvementRunResponseSchema, improvementRetryResponseSchema, improvementReviewResponseSchema, improvementStopNativeCheckResponseSchema,
]);
export const improvementErrorResponseSchema = z.object({ error: z.string().min(1), message: z.string().min(1).optional() }).strict();

export const nativeSelfImprovementSchemas = Object.freeze({
  NativeSelfImprovementMutationRequest: improvementNativeMutationSchema,
  NativeSelfImprovementReadResponse: improvementReadResponseSchema,
  NativeSelfImprovementMutationResponse: improvementMutationResponseSchema,
  NativeSelfImprovementStatusResponse: improvementStatusResponseSchema,
  NativeSelfImprovementRepositoriesResponse: improvementRepositoriesResponseSchema,
  NativeSelfImprovementCycleResponse: improvementCycleResponseSchema,
  NativeSelfImprovementErrorResponse: improvementErrorResponseSchema,
});
