import { z } from "zod";

import { sourceContractSha256 } from "@/lib/sources/contracts";

export const AGENT_LEARNING_OBSERVATION_VERSION =
  "agent-learning-observation:1" as const;
export const AGENT_LEARNING_CYCLE_VERSION =
  "agent-learning-daily-cycle:1" as const;
export const AGENT_DAILY_LEARNING_STATUS_VERSION =
  "agent-daily-learning-status:1" as const;

const idSchema = z.string().trim().min(1).max(320).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const positiveVersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const boundedCountSchema = z.number().int().min(0).max(10_000);

export const agentLearningObservationV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(AGENT_LEARNING_OBSERVATION_VERSION),
  observationId: idSchema,
  ownerBindingSha256: sha256Schema,
  agentId: idSchema,
  definitionVersion: positiveVersionSchema,
  definitionSha256: sha256Schema,
  sourceKind: z.literal("agent_run"),
  sourceId: idSchema,
  sourceSha256: sha256Schema,
  outcome: z.enum([
    "useful",
    "needs_work",
    "completed_unreviewed",
    "failed",
    "canceled",
  ]),
  groundingStatus: z.enum(["verified", "not_verified", "not_required"]),
  hasCorrection: z.boolean(),
  actionable: z.boolean(),
  observedAt: timestampSchema,
  recordedAt: timestampSchema,
  contentIncluded: z.literal(false),
  modelInvoked: z.literal(false),
  authorityImpact: z.literal("none"),
}).strict().superRefine((value, context) => {
  const expectedId = `agent-learning-observation:${sourceContractSha256({
    ownerBindingSha256: value.ownerBindingSha256,
    agentId: value.agentId,
    definitionVersion: value.definitionVersion,
    definitionSha256: value.definitionSha256,
    sourceKind: value.sourceKind,
    sourceId: value.sourceId,
    sourceSha256: value.sourceSha256,
  })}`;
  if (value.observationId !== expectedId) {
    context.addIssue({
      code: "custom",
      path: ["observationId"],
      message: "Agent learning observation integrity is invalid.",
    });
  }
  if (value.actionable !== (value.outcome === "needs_work" && value.hasCorrection)) {
    context.addIssue({
      code: "custom",
      path: ["actionable"],
      message: "Only explicit corrective feedback is actionable learning evidence.",
    });
  }
  if (Date.parse(value.recordedAt) < Date.parse(value.observedAt)) {
    context.addIssue({
      code: "custom",
      path: ["recordedAt"],
      message: "Agent learning evidence cannot be recorded before it was observed.",
    });
  }
});

const learningHighWaterSchema = z.object({
  observedAt: timestampSchema,
  observationId: idSchema,
}).strict();

export const agentLearningCycleV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(AGENT_LEARNING_CYCLE_VERSION),
  cycleId: idSchema,
  ownerBindingSha256: sha256Schema,
  agentId: idSchema,
  definitionVersion: positiveVersionSchema,
  definitionSha256: sha256Schema,
  timezone: z.string().trim().min(1).max(120),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  previousHighWater: learningHighWaterSchema.nullable(),
  highWater: learningHighWaterSchema.nullable(),
  observationCount: boundedCountSchema,
  usefulEvidenceCount: boundedCountSchema,
  needsWorkEvidenceCount: boundedCountSchema,
  unreviewedEvidenceCount: boundedCountSchema,
  failedEvidenceCount: boundedCountSchema,
  canceledEvidenceCount: boundedCountSchema,
  actionableEvidenceCount: boundedCountSchema,
  evidenceManifestSha256: sha256Schema,
  outcome: z.enum(["actionable_evidence_recorded", "no_actionable_evidence"]),
  completedAt: timestampSchema,
  contentIncluded: z.literal(false),
  modelInvoked: z.literal(false),
  behaviorChanged: z.literal(false),
  authorityImpact: z.literal("none"),
  toolAuthorityChanged: z.literal(false),
  contextAuthorityChanged: z.literal(false),
  budgetAuthorityChanged: z.literal(false),
  adaptationActivated: z.literal(false),
  receiptSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const expectedCycleId = `agent-learning-cycle:${sourceContractSha256({
    ownerBindingSha256: value.ownerBindingSha256,
    agentId: value.agentId,
    definitionVersion: value.definitionVersion,
    definitionSha256: value.definitionSha256,
    timezone: value.timezone,
    localDate: value.localDate,
  })}`;
  if (value.cycleId !== expectedCycleId) {
    context.addIssue({
      code: "custom",
      path: ["cycleId"],
      message: "Agent learning cycle identity is invalid.",
    });
  }
  const classifiedCount = value.usefulEvidenceCount +
    value.needsWorkEvidenceCount + value.unreviewedEvidenceCount +
    value.failedEvidenceCount + value.canceledEvidenceCount;
  if (
    classifiedCount !== value.observationCount ||
    value.actionableEvidenceCount > value.needsWorkEvidenceCount
  ) {
    context.addIssue({
      code: "custom",
      path: ["observationCount"],
      message: "Agent learning cycle evidence counts are inconsistent.",
    });
  }
  if (
    value.outcome !== (value.actionableEvidenceCount > 0
      ? "actionable_evidence_recorded"
      : "no_actionable_evidence")
  ) {
    context.addIssue({
      code: "custom",
      path: ["outcome"],
      message: "Agent learning cycle outcome is inconsistent.",
    });
  }
  if (value.observationCount > 0 && !value.highWater) {
    context.addIssue({
      code: "custom",
      path: ["highWater"],
      message: "Agent learning evidence requires a high-water coordinate.",
    });
  }
  if (
    value.previousHighWater && value.highWater &&
    (
      value.highWater.observedAt < value.previousHighWater.observedAt ||
      (
        value.highWater.observedAt === value.previousHighWater.observedAt &&
        value.highWater.observationId < value.previousHighWater.observationId
      )
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["highWater"],
      message: "Agent learning high-water coordinates cannot move backward.",
    });
  }
  if (
    value.highWater &&
    Date.parse(value.completedAt) < Date.parse(value.highWater.observedAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["completedAt"],
      message: "Agent learning cannot complete before its high-water evidence.",
    });
  }
  const { receiptSha256: _receiptSha256, ...receiptBody } = value;
  if (sourceContractSha256(receiptBody) !== value.receiptSha256) {
    context.addIssue({
      code: "custom",
      path: ["receiptSha256"],
      message: "Agent learning cycle receipt integrity is invalid.",
    });
  }
});

const latestCompletedLearningDaySchema = z.object({
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().trim().min(1).max(120),
  completedAt: timestampSchema,
  observationsReviewed: boundedCountSchema,
  explicitCorrectionCount: boundedCountSchema,
  actionableEvidenceCount: boundedCountSchema,
  outcome: z.enum(["actionable_evidence_recorded", "no_actionable_evidence"]),
}).strict();

/**
 * Content-free projection used by the Agent workspace. It deliberately exposes
 * counts and lifecycle state only, never prompts, responses, corrections, or
 * private model reasoning.
 */
export const agentDailyLearningStatusV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(AGENT_DAILY_LEARNING_STATUS_VERSION),
  agentId: idSchema,
  definitionVersion: positiveVersionSchema,
  projectedAt: timestampSchema,
  availability: z.enum(["ready", "canonical_store_unavailable"]),
  latestCompletedDay: latestCompletedLearningDaySchema.nullable(),
  pendingReviewedAdaptationCount: boundedCountSchema,
  contentIncluded: z.literal(false),
  privateReasoningIncluded: z.literal(false),
  authorityImpact: z.literal("none"),
}).strict().superRefine((value, context) => {
  if (
    value.availability === "canonical_store_unavailable" &&
    (value.latestCompletedDay !== null || value.pendingReviewedAdaptationCount !== 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["availability"],
      message: "Unavailable Agent learning cannot imply canonical evidence.",
    });
  }
});

export type AgentLearningObservationV1 = Readonly<
  z.infer<typeof agentLearningObservationV1Schema>
>;
export type AgentLearningHighWaterV1 = Readonly<
  z.infer<typeof learningHighWaterSchema>
>;
export type AgentLearningCycleV1 = Readonly<
  z.infer<typeof agentLearningCycleV1Schema>
>;
export type AgentDailyLearningStatusV1 = Readonly<
  z.infer<typeof agentDailyLearningStatusV1Schema>
>;

export function buildAgentLearningObservationV1(input: {
  tenantId: string;
  ownerActorId: string;
  agentId: string;
  definitionVersion: number;
  definitionSha256: string;
  sourceId: string;
  sourceSha256: string;
  outcome: AgentLearningObservationV1["outcome"];
  groundingStatus: AgentLearningObservationV1["groundingStatus"];
  hasCorrection: boolean;
  observedAt: string;
  recordedAt?: string;
}) {
  const ownerBindingSha256 = sourceContractSha256({
    tenantId: requiredText(input.tenantId),
    ownerActorId: requiredText(input.ownerActorId),
    agentId: requiredText(input.agentId),
  });
  const sourceKind = "agent_run" as const;
  const observationId = `agent-learning-observation:${sourceContractSha256({
    ownerBindingSha256,
    agentId: input.agentId,
    definitionVersion: input.definitionVersion,
    definitionSha256: input.definitionSha256,
    sourceKind,
    sourceId: input.sourceId,
    sourceSha256: input.sourceSha256,
  })}`;
  return parseAgentLearningObservationV1({
    schemaVersion: 1,
    version: AGENT_LEARNING_OBSERVATION_VERSION,
    observationId,
    ownerBindingSha256,
    agentId: input.agentId,
    definitionVersion: input.definitionVersion,
    definitionSha256: input.definitionSha256,
    sourceKind,
    sourceId: input.sourceId,
    sourceSha256: input.sourceSha256,
    outcome: input.outcome,
    groundingStatus: input.groundingStatus,
    hasCorrection: input.hasCorrection,
    actionable: input.outcome === "needs_work" && input.hasCorrection,
    observedAt: canonicalTimestamp(input.observedAt),
    recordedAt: canonicalTimestamp(input.recordedAt || Date.now()),
    contentIncluded: false,
    modelInvoked: false,
    authorityImpact: "none",
  });
}

export function buildAgentLearningCycleV1(input: {
  tenantId: string;
  ownerActorId: string;
  agentId: string;
  definitionVersion: number;
  definitionSha256: string;
  timezone: string;
  localDate: string;
  previousHighWater: AgentLearningHighWaterV1 | null;
  observations: readonly AgentLearningObservationV1[];
  completedAt?: string;
}) {
  const ownerBindingSha256 = sourceContractSha256({
    tenantId: requiredText(input.tenantId),
    ownerActorId: requiredText(input.ownerActorId),
    agentId: requiredText(input.agentId),
  });
  const observations = [...input.observations]
    .map(parseAgentLearningObservationV1)
    .sort(compareLearningObservations);
  for (const observation of observations) {
    if (
      observation.ownerBindingSha256 !== ownerBindingSha256 ||
      observation.agentId !== input.agentId ||
      observation.definitionVersion !== input.definitionVersion ||
      observation.definitionSha256 !== input.definitionSha256
    ) {
      throw new Error("Agent learning evidence does not match its cycle scope.");
    }
  }
  const timezone = normalizeTimezone(input.timezone);
  const localDate = normalizeLocalDate(input.localDate);
  const highWater = observations.at(-1)
    ? Object.freeze({
        observedAt: observations.at(-1)!.observedAt,
        observationId: observations.at(-1)!.observationId,
      })
    : input.previousHighWater;
  const evidenceManifestSha256 = sourceContractSha256(
    observations.map((observation) => ({
      observationId: observation.observationId,
      sourceSha256: observation.sourceSha256,
      outcome: observation.outcome,
      actionable: observation.actionable,
    })),
  );
  const actionableEvidenceCount = observations.filter((item) => item.actionable).length;
  const cycleId = `agent-learning-cycle:${sourceContractSha256({
    ownerBindingSha256,
    agentId: input.agentId,
    definitionVersion: input.definitionVersion,
    definitionSha256: input.definitionSha256,
    timezone,
    localDate,
  })}`;
  const receiptBody = {
    schemaVersion: 1 as const,
    version: AGENT_LEARNING_CYCLE_VERSION,
    cycleId,
    ownerBindingSha256,
    agentId: input.agentId,
    definitionVersion: input.definitionVersion,
    definitionSha256: input.definitionSha256,
    timezone,
    localDate,
    previousHighWater: input.previousHighWater,
    highWater,
    observationCount: observations.length,
    usefulEvidenceCount: countOutcome(observations, "useful"),
    needsWorkEvidenceCount: countOutcome(observations, "needs_work"),
    unreviewedEvidenceCount: countOutcome(observations, "completed_unreviewed"),
    failedEvidenceCount: countOutcome(observations, "failed"),
    canceledEvidenceCount: countOutcome(observations, "canceled"),
    actionableEvidenceCount,
    evidenceManifestSha256,
    outcome: actionableEvidenceCount > 0
      ? "actionable_evidence_recorded" as const
      : "no_actionable_evidence" as const,
    completedAt: canonicalTimestamp(input.completedAt || Date.now()),
    contentIncluded: false as const,
    modelInvoked: false as const,
    behaviorChanged: false as const,
    authorityImpact: "none" as const,
    toolAuthorityChanged: false as const,
    contextAuthorityChanged: false as const,
    budgetAuthorityChanged: false as const,
    adaptationActivated: false as const,
  };
  return parseAgentLearningCycleV1({
    ...receiptBody,
    receiptSha256: sourceContractSha256(receiptBody),
  });
}

export function parseAgentLearningObservationV1(value: unknown) {
  return deepFreeze(agentLearningObservationV1Schema.parse(value));
}

export function parseAgentLearningCycleV1(value: unknown) {
  return deepFreeze(agentLearningCycleV1Schema.parse(value));
}

function countOutcome(
  observations: readonly AgentLearningObservationV1[],
  outcome: AgentLearningObservationV1["outcome"],
) {
  return observations.filter((item) => item.outcome === outcome).length;
}

function compareLearningObservations(
  left: AgentLearningObservationV1,
  right: AgentLearningObservationV1,
) {
  return left.observedAt.localeCompare(right.observedAt) ||
    left.observationId.localeCompare(right.observationId);
}

function normalizeTimezone(value: string) {
  const timezone = value.trim();
  if (!timezone || timezone.length > 120) {
    throw new Error("Agent learning timezone is invalid.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    throw new Error("Agent learning timezone is invalid.");
  }
}

function normalizeLocalDate(value: string) {
  const localDate = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error("Agent learning local date is invalid.");
  }
  const date = new Date(`${localDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== localDate) {
    throw new Error("Agent learning local date is invalid.");
  }
  return localDate;
}

function canonicalTimestamp(value: string | number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Agent learning timestamp is invalid.");
  }
  return date.toISOString();
}

function requiredText(value: string) {
  const text = value.trim();
  if (!text || text.length > 320 || text.includes("\0")) {
    throw new Error("Agent learning scope identifier is invalid.");
  }
  return text;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
