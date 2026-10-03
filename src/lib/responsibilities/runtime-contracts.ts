import { z } from "zod";
import { runBudgetCountersV1Schema } from "@/lib/runs/budgets";
import { digestSchema, exactIdSchema, instantSchema, responsibilityCadenceSchema, responsibilityIdSchema, responsibilityPinsSchema } from "./contracts";

export const RESPONSIBILITY_RUNTIME_CONTRACT = "asael-responsibility-runtime:1" as const;
export const RESPONSIBILITY_PILOT = "native_meeting_metadata_v1" as const;
export const RESPONSIBILITY_DUE_GRACE_MS = 15 * 60_000;
export const RESPONSIBILITY_PILOT_DISCLOSURE = Object.freeze({
  pilot: RESPONSIBILITY_PILOT,
  source: "One owner-private native Meeting with granted participant consent and a current source revision.",
  comparison: "Deterministic meeting time, state, participant and structured metadata changes. Changed prose is insufficient evidence.",
  cadence: "Daily or weekly in the reviewed timezone, with a 15-minute due grace. Older instants are skipped. Hourly cadence is unavailable in this pilot.",
  stops: "Expires at the reviewed end, or stops when the meeting starts or is canceled. Free-text success and stop conditions are descriptive, not executable predicates.",
  execution: "Only the exact saved app.meetings.show binding. No model, provider mutation, approval, PolicyLease, notification or delivery authority.",
});
export const runtimeRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const expectedRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 2);
export const wakeIdSchema = z.string().regex(/^responsibility-wake:[a-f0-9]{64}$/);
export const runtimeStateSchema = z.enum(["active", "pausing", "paused", "ending", "ended", "blocked"]);
export const runtimeReasonSchema = z.enum(["owner_activated", "owner_paused", "owner_resumed", "owner_ended", "expired", "meeting_started", "meeting_canceled", "budget_exhausted", "source_unavailable", "authority_changed", "uncertain_started_work", "check_settled", "missed_skipped"]);
export const pilotConfigurationSchema = z.object({
  schemaVersion: z.literal(1), pilot: z.literal(RESPONSIBILITY_PILOT),
  responsibilityRevision: runtimeRevisionSchema, reviewSha256: digestSchema, draftSha256: digestSchema,
  pins: responsibilityPinsSchema,
  source: z.object({ kind: z.literal("meeting"), id: exactIdSchema, workspaceId: exactIdSchema }).strict(),
  tool: z.object({ id: z.literal("app.meetings.show"), input: z.object({ workspaceId: exactIdSchema, meetingId: exactIdSchema }).strict(), contractSha256: digestSchema }).strict(),
  cadence: responsibilityCadenceSchema.refine((value) => value.frequency !== "hourly", "This pilot supports daily or weekly cadence."),
  maximumChecks: z.number().int().min(1).max(10_000), cumulativeLimits: runBudgetCountersV1Schema,
  checkReservation: runBudgetCountersV1Schema, comparisonPolicySha256: digestSchema,
  stops: z.tuple([z.literal("expiry"), z.literal("meeting_started"), z.literal("meeting_canceled")]),
  notificationAuthority: z.literal("none"), approvalAuthority: z.literal("none"), mutationAuthority: z.literal("none"),
  configurationSha256: digestSchema,
}).strict();
export const cumulativeBudgetSchema = z.object({
  limits: runBudgetCountersV1Schema, used: runBudgetCountersV1Schema, reserved: runBudgetCountersV1Schema,
  maximumChecks: z.number().int().min(1).max(10_000), usedChecks: z.number().int().min(0).max(10_000), reservedChecks: z.number().int().min(0).max(10_000),
}).strict();
export const responsibilityLifecycleSchema = z.object({
  schemaVersion: z.literal(1), contract: z.literal(RESPONSIBILITY_RUNTIME_CONTRACT),
  tenantId: exactIdSchema, actorId: z.string().min(1).max(320), responsibilityId: responsibilityIdSchema,
  revision: runtimeRevisionSchema, generation: runtimeRevisionSchema,
  state: runtimeStateSchema, reason: runtimeReasonSchema, configuration: pilotConfigurationSchema,
  nextDueAt: instantSchema.nullable(), budget: cumulativeBudgetSchema,
  activatedAt: instantSchema, updatedAt: instantSchema,
}).strict();
export const responsibilityLifecycleRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("activate"), expectedRevision: z.literal(0), expectedGeneration: z.literal(0),
    configurationSha256: digestSchema, acknowledgePilot: z.literal(RESPONSIBILITY_PILOT) }).strict(),
  z.object({ action: z.literal("resume"), expectedRevision: expectedRevisionSchema, expectedGeneration: expectedRevisionSchema,
    configurationSha256: digestSchema, acknowledgePilot: z.literal(RESPONSIBILITY_PILOT) }).strict(),
  z.object({ action: z.enum(["pause", "end"]), expectedRevision: expectedRevisionSchema, expectedGeneration: expectedRevisionSchema }).strict(),
]);
export const responsibilityWakeSchema = z.object({
  schemaVersion: z.literal(1), id: wakeIdSchema, tenantId: exactIdSchema, actorId: z.string().min(1).max(320), responsibilityId: responsibilityIdSchema,
  generation: runtimeRevisionSchema, configurationSha256: digestSchema, scheduledFor: instantSchema,
  revision: runtimeRevisionSchema, state: z.enum(["reserved", "enqueued", "running", "completed", "failed", "canceled", "uncertain"]),
  reservation: runBudgetCountersV1Schema, charged: runBudgetCountersV1Schema.nullable(),
  // The existing workflow store uses wf_<40 hex> for idempotent creates and
  // UUIDs for ordinary creates. Preserve both canonical identities verbatim.
  workflowRunId: z.union([z.string().uuid(), z.string().regex(/^wf_[a-f0-9]{40}$/)]).nullable(), operationJobId: exactIdSchema.nullable(),
  leaseGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), leaseTokenSha256: digestSchema.nullable(), leaseExpiresAt: instantSchema.nullable(),
  startedAt: instantSchema.nullable(), settledAt: instantSchema.nullable(), observationId: z.string().regex(/^responsibility-observation:[a-f0-9]{64}$/).nullable(),
  observationReceiptSha256: digestSchema.nullable(), createdAt: instantSchema, updatedAt: instantSchema,
}).strict();
export type PilotConfiguration = z.infer<typeof pilotConfigurationSchema>;
export type CumulativeBudget = z.infer<typeof cumulativeBudgetSchema>;
export type ResponsibilityLifecycle = z.infer<typeof responsibilityLifecycleSchema>;
export type ResponsibilityLifecycleRequest = z.infer<typeof responsibilityLifecycleRequestSchema>;
export type ResponsibilityWake = z.infer<typeof responsibilityWakeSchema>;
export type ResponsibilityRuntimeReason = z.infer<typeof runtimeReasonSchema>;

export const runtimeReceiptSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^responsibility-runtime-receipt:[a-f0-9]{64}$/),
  idempotencySha256: digestSchema, requestSha256: digestSchema,
  action: z.enum(["activate", "pause", "resume", "end", "reserve", "enqueue", "start", "settle", "block", "reconcile"]),
  previousRevision: expectedRevisionSchema, snapshot: responsibilityLifecycleSchema,
  wake: responsibilityWakeSchema.nullable(), savedAt: instantSchema, receiptSha256: digestSchema,
}).strict();
export type ResponsibilityRuntimeReceipt = z.infer<typeof runtimeReceiptSchema>;
export const responsibilityWorkflowBindingSchema = z.object({
  schemaVersion: z.literal(1), contract: z.literal(RESPONSIBILITY_RUNTIME_CONTRACT),
  responsibilityId: responsibilityIdSchema, wakeId: wakeIdSchema, generation: runtimeRevisionSchema,
  configurationSha256: digestSchema, ownerActorId: z.string().min(1).max(320),
}).strict();
export type ResponsibilityWorkflowBinding = z.infer<typeof responsibilityWorkflowBindingSchema>;
