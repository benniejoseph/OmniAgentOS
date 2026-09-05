import { createHash } from "node:crypto";
import { z } from "zod";
import {
  runContractIdSchema as baseRunContractIdSchema,
  runContractSha256Schema,
} from "@/lib/runs/contracts";
import {
  EXECUTION_SCOPE_VERSION,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

/**
 * Dormant, metadata-only checkpoint contract. Persistence and resume execution
 * deliberately remain outside this module until the P1.6 runtime slice.
 */
export const RUN_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const MAX_RUN_CHECKPOINT_BYTES = 64_000;
export const MAX_RUN_CHECKPOINT_STATE_REFERENCES = 64;
export const MAX_RUN_CHECKPOINT_SCOPE_GRANTS = 256;
export const MAX_RUN_CHECKPOINT_SUPPORTED_PINS = 32;

const MAX_CHECKPOINT_INPUT_BYTES = 64_000;
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_NODES = 4_096;
const MAX_CANONICAL_ARRAY_ITEMS = 256;
const MAX_CANONICAL_OBJECT_KEYS = 64;
const MAX_CANONICAL_STRING_LENGTH = 512;
const MAX_COUNTER_VALUE = 1_000_000_000_000;
const MAX_SEQUENCE_VALUE = 1_000_000_000;
const CHECKPOINT_DIGEST_DOMAIN = "asael.run-checkpoint.v1";
const CHECKPOINT_PREFLIGHT_MESSAGE =
  "Run checkpoint failed bounded plain-data preflight.";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

const runContractIdSchema = z
  .string()
  .min(1)
  .max(240)
  .superRefine((value, context) => {
    const parsed = baseRunContractIdSchema.safeParse(value);
    if (!parsed.success || parsed.data !== value) {
      context.addIssue({
        code: "custom",
        message: "Expected a canonical opaque ID, not free-form text.",
      });
    }
  });

const nullableIdSchema = runContractIdSchema.nullable();
const boundedCounterSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_COUNTER_VALUE);
const boundedSequenceSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_SEQUENCE_VALUE);
const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => {
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
    },
    "Expected a canonical UTC timestamp with millisecond precision.",
  );

const executionPrincipalTypeSchema = z.enum(["user", "agent", "system"]);

const executionScopeBindingBaseSchema = z.object({
  executionScopeVersion: z.literal(EXECUTION_SCOPE_VERSION),
  tenantId: runContractIdSchema,
  initiatingActorId: runContractIdSchema,
  executingPrincipalType: executionPrincipalTypeSchema,
  executingPrincipalId: runContractIdSchema,
  workspaceId: nullableIdSchema,
  projectId: nullableIdSchema,
  missionId: nullableIdSchema,
  delegationId: nullableIdSchema,
  correlationId: runContractIdSchema,
  causationId: nullableIdSchema,
  contextGrantIds: z
    .array(runContractIdSchema)
    .max(MAX_RUN_CHECKPOINT_SCOPE_GRANTS),
  capabilityGrantIds: z
    .array(runContractIdSchema)
    .max(MAX_RUN_CHECKPOINT_SCOPE_GRANTS),
  purposeSha256: runContractSha256Schema,
  executionScopeSha256: runContractSha256Schema,
}).strict();

const executionScopeBindingSchema = executionScopeBindingBaseSchema
  .superRefine((value, context) => {
    validateCanonicalIds(value.contextGrantIds, context, ["contextGrantIds"]);
    validateCanonicalIds(
      value.capabilityGrantIds,
      context,
      ["capabilityGrantIds"],
    );
    if (
      value.executingPrincipalType === "user" &&
      value.executingPrincipalId !== value.initiatingActorId
    ) {
      addIssue(
        context,
        ["executingPrincipalId"],
        "A user checkpoint must execute as its initiating actor.",
      );
    }

    const { executionScopeSha256, ...scopeBody } = value;
    if (
      executionScopeSha256 !==
      checkpointDomainDigest("execution_scope_binding", scopeBody)
    ) {
      addIssue(
        context,
        ["executionScopeSha256"],
        "Execution-scope digest does not match its binding.",
      );
    }
  });

const checkpointBoundarySchema = z.object({
  kind: z.enum(["model", "tool", "approval", "delegation", "verifier"]),
  phase: z.enum(["before", "waiting", "after"]),
  boundaryId: runContractIdSchema,
  attempt: z.number().int().min(1).max(MAX_SEQUENCE_VALUE),
}).strict();

const checkpointParentSchema = z.object({
  checkpointId: runContractIdSchema,
  checkpointSha256: runContractSha256Schema,
  sequence: boundedSequenceSchema,
}).strict();

const checkpointEnginePinSchema = z.object({
  rolloutCapabilityId: runContractIdSchema,
  engineVersionId: runContractIdSchema,
  contractVersionId: runContractIdSchema,
  configurationSha256: runContractSha256Schema,
  runContractEnvelopeId: runContractIdSchema,
  runContractEnvelopeSha256: runContractSha256Schema,
  harnessManifestId: runContractIdSchema,
  harnessManifestSha256: runContractSha256Schema,
  rolloutMode: z.enum(["shadow", "canary", "enabled"]),
  rolloutLifecycleStatus: z.enum([
    "registered",
    "active",
    "paused",
    "superseded",
  ]),
  rolloutGeneration: z.number().int().min(1).max(MAX_SEQUENCE_VALUE),
  rolloutLifecycleRevision: boundedSequenceSchema,
}).strict().superRefine((value, context) => {
  if (
    (value.rolloutLifecycleStatus === "registered" &&
      value.rolloutLifecycleRevision !== 0) ||
    (value.rolloutLifecycleStatus !== "registered" &&
      value.rolloutLifecycleRevision < 1)
  ) {
    addIssue(
      context,
      ["rolloutLifecycleRevision"],
      "Rollout lifecycle revision must match its lifecycle status.",
    );
  }
});

const checkpointStateReferenceKindSchema = z.enum([
  "run_record",
  "workflow_run",
  "conversation",
  "context_manifest",
  "harness_manifest",
  "model_turn",
  "model_continuation",
  "tool_execution",
  "approval_request",
  "approval_decision",
  "delegation",
  "delegation_signal",
  "verifier_request",
  "verifier_receipt",
  "effect_intent",
  "effect_receipt",
  "artifact",
]);

const checkpointStateReferenceSchema = z.object({
  kind: checkpointStateReferenceKindSchema,
  referenceId: runContractIdSchema,
  referenceSha256: runContractSha256Schema,
  versionId: nullableIdSchema,
}).strict();

const checkpointEffectReferenceSchema = z.object({
  referenceId: runContractIdSchema,
  referenceSha256: runContractSha256Schema,
}).strict();

const checkpointToolBindingSchema = z.object({
  operationClass: z.enum(["read_only", "mutation"]),
  toolExecutionId: runContractIdSchema,
  toolExecutionSha256: runContractSha256Schema,
  toolId: runContractIdSchema,
  toolContractSha256: runContractSha256Schema,
  inputSha256: runContractSha256Schema,
  idempotencyKeySha256: runContractSha256Schema.nullable(),
  effectState: z.enum([
    "not_applicable",
    "intent_recorded",
    "no_effect",
    "effect_recorded",
  ]),
  effectIntent: checkpointEffectReferenceSchema.nullable(),
  effectReceipt: checkpointEffectReferenceSchema.nullable(),
}).strict();

const checkpointResourceUsageBaseSchema = z.object({
  measurementKind: z.literal("cumulative"),
  modelCallCount: boundedCounterSchema,
  modelInputTokenCount: boundedCounterSchema,
  modelOutputTokenCount: boundedCounterSchema,
  cachedInputTokenCount: boundedCounterSchema,
  totalTokenCount: boundedCounterSchema,
  toolCallCount: boundedCounterSchema,
  toolResultByteCount: boundedCounterSchema,
  externalEffectCount: boundedCounterSchema,
  boundaryExternalEffectCount: z.union([z.literal(0), z.literal(1)]),
  elapsedMs: boundedCounterSchema,
}).strict();

const checkpointResourceUsageSchema = checkpointResourceUsageBaseSchema
  .superRefine((value, context) => {
    validateCommonResourceUsage(value, context);
    if (
      value.totalTokenCount !==
      value.modelInputTokenCount + value.modelOutputTokenCount
    ) {
      addIssue(
        context,
        ["totalTokenCount"],
        "Total tokens must equal input plus output tokens.",
      );
    }
  });

const checkpointLifecycleStateSchema = z.enum(["active", "waiting", "terminal"]);
const checkpointResumeDispositionSchema = z.enum([
  "resumable",
  "awaiting_signal",
  "not_resumable",
]);

const runCheckpointBodyShape = {
  schemaVersion: z.literal(RUN_CHECKPOINT_SCHEMA_VERSION),
  contractKind: z.literal("run_checkpoint"),
  checkpointId: runContractIdSchema,
  runId: runContractIdSchema,
  executionScope: executionScopeBindingSchema,
  boundary: checkpointBoundarySchema,
  sequence: boundedSequenceSchema,
  parent: checkpointParentSchema.nullable(),
  enginePin: checkpointEnginePinSchema,
  stateReferences: z
    .array(checkpointStateReferenceSchema)
    .min(1)
    .max(MAX_RUN_CHECKPOINT_STATE_REFERENCES),
  toolBinding: checkpointToolBindingSchema.nullable(),
  resourceUsage: checkpointResourceUsageSchema,
  lifecycleState: checkpointLifecycleStateSchema,
  resumeDisposition: checkpointResumeDispositionSchema,
  recordedAt: canonicalTimestampSchema,
};

const runCheckpointBaseSchema = z.object({
  ...runCheckpointBodyShape,
  checkpointSha256: runContractSha256Schema,
}).strict();

const runCheckpointValidatedSchema = runCheckpointBaseSchema
  .superRefine((value, context) => {
    validateRunCheckpoint(value, context);
  });

/** Public untrusted-data parser. Bounded plain-data checks precede Zod traversal. */
export const runCheckpointV1Schema = z.preprocess((value, context) => {
  try {
    return JSON.parse(
      canonicalizeBoundedPlainData(value, MAX_RUN_CHECKPOINT_BYTES),
    ) as unknown;
  } catch {
    context.addIssue({
      code: "custom",
      message: CHECKPOINT_PREFLIGHT_MESSAGE,
    });
    return z.NEVER;
  }
}, runCheckpointValidatedSchema).transform((value) => deepFreeze(value));

export type RunCheckpointV1 = z.infer<typeof runCheckpointV1Schema>;
export type RunCheckpointBoundaryV1 = z.infer<typeof checkpointBoundarySchema>;
export type RunCheckpointParentV1 = z.infer<typeof checkpointParentSchema>;
export type RunCheckpointEnginePinV1 = z.infer<typeof checkpointEnginePinSchema>;
export type RunCheckpointStateReferenceV1 = z.infer<
  typeof checkpointStateReferenceSchema
>;
export type RunCheckpointToolBindingV1 = z.infer<
  typeof checkpointToolBindingSchema
>;
export type RunCheckpointLifecycleStateV1 = z.infer<
  typeof checkpointLifecycleStateSchema
>;
export type RunCheckpointResumeDispositionV1 = z.infer<
  typeof checkpointResumeDispositionSchema
>;

const executionScopeInputSchema = z.object({
  version: z.literal(EXECUTION_SCOPE_VERSION),
  tenantId: runContractIdSchema,
  initiatingActorId: nullableIdSchema,
  executingPrincipalType: executionPrincipalTypeSchema,
  executingPrincipalId: nullableIdSchema,
  workspaceId: nullableIdSchema,
  projectId: nullableIdSchema,
  missionId: nullableIdSchema,
  delegationId: nullableIdSchema,
  correlationId: runContractIdSchema,
  causationId: nullableIdSchema,
  contextGrantIds: z
    .array(runContractIdSchema)
    .max(MAX_RUN_CHECKPOINT_SCOPE_GRANTS),
  capabilityGrantIds: z
    .array(runContractIdSchema)
    .max(MAX_RUN_CHECKPOINT_SCOPE_GRANTS),
  purpose: z.string().trim().min(1).max(500),
}).strict().superRefine((value, context) => {
  validateUniqueIds(value.contextGrantIds, context, ["contextGrantIds"]);
  validateUniqueIds(
    value.capabilityGrantIds,
    context,
    ["capabilityGrantIds"],
  );
  if (value.initiatingActorId === null) {
    addIssue(
      context,
      ["initiatingActorId"],
      "A checkpoint requires an initiating actor.",
    );
  }
  if (value.executingPrincipalId === null) {
    addIssue(
      context,
      ["executingPrincipalId"],
      "A checkpoint requires an executing principal.",
    );
  }
  if (
    value.executingPrincipalType === "user" &&
    value.executingPrincipalId !== value.initiatingActorId
  ) {
    addIssue(
      context,
      ["executingPrincipalId"],
      "A user checkpoint must execute as its initiating actor.",
    );
  }
});

const checkpointResourceUsageInputSchema = checkpointResourceUsageBaseSchema
  .omit({
    measurementKind: true,
    totalTokenCount: true,
  })
  .superRefine((value, context) => {
    validateCommonResourceUsage(value, context);
  });

const buildRunCheckpointInputSchema = z.object({
  runId: runContractIdSchema,
  executionScope: executionScopeInputSchema,
  boundary: checkpointBoundarySchema,
  sequence: boundedSequenceSchema,
  parent: checkpointParentSchema.nullable(),
  enginePin: checkpointEnginePinSchema,
  stateReferences: z
    .array(checkpointStateReferenceSchema)
    .min(1)
    .max(MAX_RUN_CHECKPOINT_STATE_REFERENCES),
  toolBinding: checkpointToolBindingSchema.nullable(),
  resourceUsage: checkpointResourceUsageInputSchema,
  lifecycleState: checkpointLifecycleStateSchema,
  resumeDisposition: checkpointResumeDispositionSchema,
  recordedAt: canonicalTimestampSchema,
}).strict();

type RunCheckpointResourceUsageInputV1 = z.infer<
  typeof checkpointResourceUsageInputSchema
>;

export type BuildRunCheckpointV1Input = Readonly<{
  runId: string;
  executionScope: ExecutionScope;
  boundary: RunCheckpointBoundaryV1;
  sequence: number;
  parent: RunCheckpointParentV1 | null;
  enginePin: RunCheckpointEnginePinV1;
  stateReferences: readonly RunCheckpointStateReferenceV1[];
  toolBinding: RunCheckpointToolBindingV1 | null;
  resourceUsage: RunCheckpointResourceUsageInputV1;
  lifecycleState: RunCheckpointLifecycleStateV1;
  resumeDisposition: RunCheckpointResumeDispositionV1;
  recordedAt: string;
}>;

/** Builds one deterministic checkpoint. It performs no persistence or resume. */
export function buildRunCheckpointV1(
  input: BuildRunCheckpointV1Input,
): RunCheckpointV1 {
  let safeInput: unknown;
  try {
    safeInput = JSON.parse(
      canonicalizeBoundedPlainData(input, MAX_CHECKPOINT_INPUT_BYTES),
    ) as unknown;
  } catch {
    throw new Error(CHECKPOINT_PREFLIGHT_MESSAGE);
  }

  const parsedInput = buildRunCheckpointInputSchema.parse(safeInput);
  const contextGrantIds = canonicalIds(
    parsedInput.executionScope.contextGrantIds,
  );
  const capabilityGrantIds = canonicalIds(
    parsedInput.executionScope.capabilityGrantIds,
  );
  const purposeSha256 = checkpointDomainDigest(
    "execution_scope_purpose",
    parsedInput.executionScope.purpose,
  );
  const scopeBody = {
    executionScopeVersion: EXECUTION_SCOPE_VERSION,
    tenantId: parsedInput.executionScope.tenantId,
    initiatingActorId: requiredScopedId(
      parsedInput.executionScope.initiatingActorId,
      "initiating actor",
    ),
    executingPrincipalType: parsedInput.executionScope.executingPrincipalType,
    executingPrincipalId: requiredScopedId(
      parsedInput.executionScope.executingPrincipalId,
      "executing principal",
    ),
    workspaceId: parsedInput.executionScope.workspaceId,
    projectId: parsedInput.executionScope.projectId,
    missionId: parsedInput.executionScope.missionId,
    delegationId: parsedInput.executionScope.delegationId,
    correlationId: parsedInput.executionScope.correlationId,
    causationId: parsedInput.executionScope.causationId,
    contextGrantIds,
    capabilityGrantIds,
    purposeSha256,
  };
  const executionScope = {
    ...scopeBody,
    executionScopeSha256: checkpointDomainDigest(
      "execution_scope_binding",
      scopeBody,
    ),
  };
  const resourceUsage = {
    ...parsedInput.resourceUsage,
    measurementKind: "cumulative" as const,
    totalTokenCount:
      parsedInput.resourceUsage.modelInputTokenCount +
      parsedInput.resourceUsage.modelOutputTokenCount,
  };
  const checkpointIdentity = {
    schemaVersion: RUN_CHECKPOINT_SCHEMA_VERSION,
    contractKind: "run_checkpoint" as const,
    runId: parsedInput.runId,
    executionScope,
    boundary: parsedInput.boundary,
    sequence: parsedInput.sequence,
    parent: parsedInput.parent,
    enginePin: parsedInput.enginePin,
    stateReferences: canonicalStateReferences(parsedInput.stateReferences),
    toolBinding: parsedInput.toolBinding,
    resourceUsage,
    lifecycleState: parsedInput.lifecycleState,
    resumeDisposition: parsedInput.resumeDisposition,
    recordedAt: parsedInput.recordedAt,
  };
  const checkpointId = derivedCheckpointId(checkpointIdentity);
  const checkpointBody = {
    ...checkpointIdentity,
    checkpointId,
  };

  return runCheckpointV1Schema.parse({
    ...checkpointBody,
    checkpointSha256: checkpointDomainDigest(
      "checkpoint_record",
      checkpointBody,
    ),
  });
}

/** Parses a persisted checkpoint without tolerating legacy or partial shapes. */
export function parseRunCheckpointV1(value: unknown): RunCheckpointV1 {
  return runCheckpointV1Schema.parse(value);
}

/**
 * Parses and validates one immutable parent/successor pair. This is deliberately
 * pure; a store must still enforce compare-and-swap when installing a child.
 */
export function validateRunCheckpointSuccessorV1(
  parentValue: unknown,
  successorValue: unknown,
): RunCheckpointV1 {
  const parent = parseRunCheckpointV1(parentValue);
  const successor = parseRunCheckpointV1(successorValue);

  if (successor.sequence !== parent.sequence + 1) {
    throw new Error("Checkpoint successor sequence is not contiguous.");
  }
  if (
    successor.parent === null ||
    successor.parent.checkpointId !== parent.checkpointId ||
    successor.parent.checkpointSha256 !== parent.checkpointSha256 ||
    successor.parent.sequence !== parent.sequence
  ) {
    throw new Error("Checkpoint successor does not exactly bind its parent.");
  }
  if (
    parent.lifecycleState === "terminal" ||
    parent.resumeDisposition === "not_resumable"
  ) {
    throw new Error("A terminal checkpoint cannot have a successor.");
  }
  if (successor.runId !== parent.runId) {
    throw new Error("Checkpoint successor is bound to a different run.");
  }
  if (
    successor.executionScope.executionScopeSha256 !==
    parent.executionScope.executionScopeSha256
  ) {
    throw new Error(
      "Checkpoint successor is bound to a different execution scope.",
    );
  }
  if (!enginePinsEqual(parent.enginePin, successor.enginePin)) {
    throw new Error("Checkpoint successor changed its engine or rollout pin.");
  }
  if (successor.recordedAt < parent.recordedAt) {
    throw new Error("Checkpoint successor predates its parent.");
  }

  const expectedCallDeltas = validateCheckpointBoundaryTransition(
    parent,
    successor,
  );

  const cumulativeCounters = [
    "modelCallCount",
    "modelInputTokenCount",
    "modelOutputTokenCount",
    "cachedInputTokenCount",
    "totalTokenCount",
    "toolCallCount",
    "toolResultByteCount",
    "externalEffectCount",
    "elapsedMs",
  ] as const;
  for (const counter of cumulativeCounters) {
    if (successor.resourceUsage[counter] < parent.resourceUsage[counter]) {
      throw new Error(
        `Checkpoint successor decreased cumulative ${counter}.`,
      );
    }
  }
  if (
    successor.resourceUsage.modelCallCount -
      parent.resourceUsage.modelCallCount !==
    expectedCallDeltas.modelCallCount
  ) {
    throw new Error(
      "Checkpoint successor model-call delta does not match its boundary transition.",
    );
  }
  if (
    successor.resourceUsage.toolCallCount -
      parent.resourceUsage.toolCallCount !==
    expectedCallDeltas.toolCallCount
  ) {
    throw new Error(
      "Checkpoint successor tool-call delta does not match its boundary transition.",
    );
  }
  if (
    successor.resourceUsage.externalEffectCount -
      parent.resourceUsage.externalEffectCount !==
    successor.resourceUsage.boundaryExternalEffectCount
  ) {
    throw new Error(
      "Checkpoint successor effect delta does not match its boundary receipt.",
    );
  }

  return successor;
}

function validateCheckpointBoundaryTransition(
  parent: RunCheckpointV1,
  successor: RunCheckpointV1,
): { modelCallCount: 0 | 1; toolCallCount: 0 | 1 } {
  const sameBoundary =
    successor.boundary.kind === parent.boundary.kind &&
    successor.boundary.boundaryId === parent.boundary.boundaryId &&
    successor.boundary.attempt === parent.boundary.attempt;
  const modelPair =
    sameBoundary &&
    parent.boundary.kind === "model" &&
    parent.boundary.phase === "before" &&
    successor.boundary.kind === "model" &&
    successor.boundary.phase === "after";
  const toolPair =
    sameBoundary &&
    parent.boundary.kind === "tool" &&
    parent.boundary.phase === "before" &&
    successor.boundary.kind === "tool" &&
    successor.boundary.phase === "after";

  if (
    toolPair &&
    !toolIntentBindingsEqual(parent.toolBinding, successor.toolBinding)
  ) {
    throw new Error(
      "A paired tool boundary changed its immutable tool intent binding.",
    );
  }

  if (
    successor.boundary.phase === "after" &&
    (successor.boundary.kind === "model" ||
      successor.boundary.kind === "tool") &&
    !modelPair &&
    !toolPair
  ) {
    throw new Error(
      "A model or tool after-boundary checkpoint lacks its paired predecessor.",
    );
  }
  if (
    parent.boundary.phase === "before" &&
    (parent.boundary.kind === "model" || parent.boundary.kind === "tool") &&
    !modelPair &&
    !toolPair
  ) {
    throw new Error(
      "A model or tool before-boundary checkpoint must advance to its paired after-boundary.",
    );
  }

  if (
    parent.boundary.phase === "waiting" &&
    (parent.boundary.kind === "approval" ||
      parent.boundary.kind === "delegation")
  ) {
    if (!sameBoundary || successor.boundary.phase !== "after") {
      throw new Error(
        "A waiting boundary must advance the same kind, ID, and attempt to after.",
      );
    }
    const resolutionKind = parent.boundary.kind === "approval"
      ? "approval_decision"
      : "delegation_signal";
    if (
      !hasStateReference(
        successor.stateReferences,
        resolutionKind,
        parent.boundary.boundaryId,
      )
    ) {
      throw new Error(
        "A waiting boundary successor lacks its decision or signal reference.",
      );
    }
    if (!toolIntentBindingsEqual(parent.toolBinding, successor.toolBinding)) {
      throw new Error(
        "A waiting boundary successor changed its tool intent binding.",
      );
    }
  }

  return {
    modelCallCount: modelPair ? 1 : 0,
    toolCallCount: toolPair ? 1 : 0,
  };
}

function toolIntentBindingsEqual(
  left: RunCheckpointV1["toolBinding"],
  right: RunCheckpointV1["toolBinding"],
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.operationClass === right.operationClass &&
    left.toolExecutionId === right.toolExecutionId &&
    left.toolId === right.toolId &&
    left.toolContractSha256 === right.toolContractSha256 &&
    left.inputSha256 === right.inputSha256 &&
    left.idempotencyKeySha256 === right.idempotencyKeySha256 &&
    effectReferencesEqual(left.effectIntent, right.effectIntent)
  );
}

function effectReferencesEqual(
  left: Readonly<{ referenceId: string; referenceSha256: string }> | null,
  right: Readonly<{ referenceId: string; referenceSha256: string }> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.referenceId === right.referenceId &&
    left.referenceSha256 === right.referenceSha256;
}

const _compatibilityPauseReasonSchema = z.enum([
  "invalid_checkpoint",
  "unsupported_checkpoint_schema",
  "unsupported_contract_version",
  "unsupported_engine_version",
  "pin_mismatch",
  "rollout_not_resumable",
  "checkpoint_awaiting_signal",
  "checkpoint_not_resumable",
]);

export type RunCheckpointCompatibilityDecisionV1 =
  | DeepReadonly<{
      disposition: "resume";
      reason: "compatible";
      checkpoint: RunCheckpointV1;
    }>
  | DeepReadonly<{
      disposition: "pause";
      reason: z.infer<typeof _compatibilityPauseReasonSchema>;
      checkpoint: null;
    }>;

export type DecideRunCheckpointCompatibilityV1Input = Readonly<{
  checkpoint: unknown;
  supportedPins: readonly RunCheckpointEnginePinV1[];
}>;

/**
 * Selects whether a checkpoint is safe to interpret. Unsupported headers are
 * paused before the full checkpoint schema or digest is evaluated.
 */
export function decideRunCheckpointCompatibilityV1(
  input: DecideRunCheckpointCompatibilityV1Input,
): RunCheckpointCompatibilityDecisionV1 {
  if (!isPlainRecord(input)) {
    return pauseCompatibility("invalid_checkpoint");
  }

  const supportedPinsProperty = ownEnumerableDataProperty(
    input,
    "supportedPins",
  );
  if (!supportedPinsProperty.valid) {
    throw new Error("Supported checkpoint pins are invalid.");
  }
  const checkpointProperty = ownEnumerableDataProperty(input, "checkpoint");
  if (!checkpointProperty.valid) {
    return pauseCompatibility("invalid_checkpoint");
  }

  let supportedPins: RunCheckpointEnginePinV1[];
  try {
    const safeSupportedPins = JSON.parse(canonicalizeBoundedPlainData(
      supportedPinsProperty.value,
      MAX_CHECKPOINT_INPUT_BYTES,
    )) as unknown;
    supportedPins = z
      .array(checkpointEnginePinSchema)
      .max(MAX_RUN_CHECKPOINT_SUPPORTED_PINS)
      .parse(safeSupportedPins);
  } catch {
    throw new Error("Supported checkpoint pins are invalid.");
  }

  let checkpointValue: unknown;
  try {
    checkpointValue = JSON.parse(canonicalizeBoundedPlainData(
      checkpointProperty.value,
      MAX_RUN_CHECKPOINT_BYTES,
    )) as unknown;
  } catch {
    return pauseCompatibility("invalid_checkpoint");
  }
  if (!isPlainRecord(checkpointValue)) {
    return pauseCompatibility("invalid_checkpoint");
  }
  const checkpoint = checkpointValue;
  if (
    checkpoint.schemaVersion !== RUN_CHECKPOINT_SCHEMA_VERSION ||
    checkpoint.contractKind !== "run_checkpoint"
  ) {
    return pauseCompatibility("unsupported_checkpoint_schema");
  }

  const pin = checkpoint.enginePin;
  if (!isPlainRecord(pin)) {
    return pauseCompatibility("invalid_checkpoint");
  }
  const contractPins = supportedPins.filter(
    (supported) => supported.contractVersionId === pin.contractVersionId,
  );
  if (contractPins.length === 0) {
    return pauseCompatibility("unsupported_contract_version");
  }
  const enginePins = contractPins.filter(
    (supported) => supported.engineVersionId === pin.engineVersionId,
  );
  if (enginePins.length === 0) {
    return pauseCompatibility("unsupported_engine_version");
  }
  if (!enginePins.some((supported) => enginePinsEqual(supported, pin))) {
    return pauseCompatibility("pin_mismatch");
  }
  if (
    pin.rolloutLifecycleStatus !== "active" ||
    pin.rolloutMode === "shadow"
  ) {
    return pauseCompatibility("rollout_not_resumable");
  }

  const parsed = runCheckpointV1Schema.safeParse(checkpoint);
  if (!parsed.success) {
    return pauseCompatibility("invalid_checkpoint");
  }
  if (
    parsed.data.enginePin.rolloutLifecycleStatus !== "active" ||
    parsed.data.enginePin.rolloutMode === "shadow"
  ) {
    return pauseCompatibility("rollout_not_resumable");
  }
  if (
    parsed.data.lifecycleState === "waiting" ||
    parsed.data.resumeDisposition === "awaiting_signal"
  ) {
    return pauseCompatibility("checkpoint_awaiting_signal");
  }
  if (
    parsed.data.lifecycleState === "terminal" ||
    parsed.data.resumeDisposition === "not_resumable"
  ) {
    return pauseCompatibility("checkpoint_not_resumable");
  }
  return deepFreeze({
    disposition: "resume" as const,
    reason: "compatible" as const,
    checkpoint: parsed.data,
  });
}

function validateRunCheckpoint(
  value: z.infer<typeof runCheckpointBaseSchema>,
  context: z.RefinementCtx,
): void {
  const { checkpointSha256, ...checkpointBody } = value;
  const { checkpointId, ...checkpointIdentity } = checkpointBody;
  const expectedId = derivedCheckpointId(checkpointIdentity);

  if (checkpointId !== expectedId) {
    addIssue(
      context,
      ["checkpointId"],
      "Checkpoint ID does not match its canonical identity.",
    );
  }
  if (
    checkpointSha256 !==
    checkpointDomainDigest("checkpoint_record", checkpointBody)
  ) {
    addIssue(
      context,
      ["checkpointSha256"],
      "Checkpoint digest does not match its body.",
    );
  }

  if (value.sequence === 0 && value.parent !== null) {
    addIssue(context, ["parent"], "A genesis checkpoint cannot have a parent.");
  }
  if (value.sequence > 0 && value.parent === null) {
    addIssue(context, ["parent"], "A non-genesis checkpoint requires a parent.");
  }
  if (
    value.sequence === 0 &&
    value.boundary.phase === "after" &&
    (value.boundary.kind === "model" || value.boundary.kind === "tool")
  ) {
    addIssue(
      context,
      ["boundary", "phase"],
      "A model or tool after-boundary checkpoint requires its paired predecessor.",
    );
  }
  if (
    value.sequence === 0 &&
    value.resourceUsage.externalEffectCount !==
      value.resourceUsage.boundaryExternalEffectCount
  ) {
    addIssue(
      context,
      ["resourceUsage", "externalEffectCount"],
      "Genesis cumulative effects must exactly match its receipt-bound boundary.",
    );
  }
  if (
    value.parent !== null &&
    value.parent.sequence !== value.sequence - 1
  ) {
    addIssue(
      context,
      ["parent", "sequence"],
      "Parent sequence must immediately precede checkpoint sequence.",
    );
  }
  if (value.parent?.checkpointId === value.checkpointId) {
    addIssue(
      context,
      ["parent", "checkpointId"],
      "A checkpoint cannot parent itself.",
    );
  }

  validateBoundaryPhase(value.boundary, context);
  validateCanonicalStateReferences(value.stateReferences, context);
  validateStateReferenceBindings(value, context);
  validateToolBinding(value, context);
  validateLifecycle(value, context);
}

function validateBoundaryPhase(
  boundary: RunCheckpointBoundaryV1,
  context: z.RefinementCtx,
): void {
  const allowed: Record<
    RunCheckpointBoundaryV1["kind"],
    readonly RunCheckpointBoundaryV1["phase"][]
  > = {
    model: ["before", "after"],
    tool: ["before", "after"],
    approval: ["waiting", "after"],
    delegation: ["before", "waiting", "after"],
    verifier: ["before", "after"],
  };
  if (!allowed[boundary.kind].includes(boundary.phase)) {
    addIssue(
      context,
      ["boundary", "phase"],
      `Phase ${boundary.phase} is invalid for a ${boundary.kind} boundary.`,
    );
  }
}

function validateCanonicalStateReferences(
  references: readonly RunCheckpointStateReferenceV1[],
  context: z.RefinementCtx,
): void {
  let priorKey: string | null = null;
  references.forEach((reference, index) => {
    const key = stateReferenceKey(reference);
    if (priorKey !== null && key <= priorKey) {
      addIssue(
        context,
        ["stateReferences", index],
        key === priorKey
          ? "State references must be unique."
          : "State references must use canonical order.",
      );
    }
    priorKey = key;
  });
}

function validateStateReferenceBindings(
  value: z.infer<typeof runCheckpointBaseSchema>,
  context: z.RefinementCtx,
): void {
  const runReferences = value.stateReferences.filter(
    (reference) => reference.kind === "run_record",
  );
  if (
    runReferences.length !== 1 ||
    runReferences[0]?.referenceId !== value.runId
  ) {
    addIssue(
      context,
      ["stateReferences"],
      "A checkpoint requires exactly one run-record reference bound to runId.",
    );
  }

  const boundaryKind = boundaryReferenceKind(value.boundary);
  if (
    !hasStateReference(
      value.stateReferences,
      boundaryKind,
      value.boundary.boundaryId,
    )
  ) {
    addIssue(
      context,
      ["stateReferences"],
      `The ${boundaryKind} boundary reference is missing.`,
    );
  }
}

function validateToolBinding(
  value: z.infer<typeof runCheckpointBaseSchema>,
  context: z.RefinementCtx,
): void {
  const binding = value.toolBinding;
  if (
    value.boundary.kind === "approval" &&
    value.resourceUsage.boundaryExternalEffectCount !== 0
  ) {
    addIssue(
      context,
      ["resourceUsage", "boundaryExternalEffectCount"],
      "An approval boundary cannot claim an external effect.",
    );
  }
  if (
    value.boundary.kind === "approval" &&
    binding?.effectState === "effect_recorded"
  ) {
    addIssue(
      context,
      ["toolBinding", "effectState"],
      "An approval boundary cannot record a mutation effect.",
    );
  }
  if (value.boundary.kind === "tool" && binding === null) {
    addIssue(
      context,
      ["toolBinding"],
      "A tool boundary requires an exact tool binding.",
    );
    return;
  }
  if (
    binding !== null &&
    value.boundary.kind !== "tool" &&
    value.boundary.kind !== "approval"
  ) {
    addIssue(
      context,
      ["toolBinding"],
      "Only tool and approval boundaries may include a tool binding.",
    );
  }
  if (binding === null) {
    if (value.resourceUsage.boundaryExternalEffectCount !== 0) {
      addIssue(
        context,
        ["resourceUsage", "boundaryExternalEffectCount"],
        "A boundary effect requires a tool binding and receipt.",
      );
    }
    return;
  }

  if (
    value.boundary.kind === "tool" &&
    binding.toolExecutionId !== value.boundary.boundaryId
  ) {
    addIssue(
      context,
      ["toolBinding", "toolExecutionId"],
      "Tool binding must match the tool boundary ID.",
    );
  }
  if (!hasExactStateReference(value.stateReferences, "tool_execution", {
    referenceId: binding.toolExecutionId,
    referenceSha256: binding.toolExecutionSha256,
  })) {
    addIssue(
      context,
      ["stateReferences"],
      "The exact bound tool-execution reference is missing.",
    );
  }

  if (binding.operationClass === "read_only") {
    if (
      binding.idempotencyKeySha256 !== null ||
      binding.effectState !== "not_applicable" ||
      binding.effectIntent !== null ||
      binding.effectReceipt !== null
    ) {
      addIssue(
        context,
        ["toolBinding"],
        "A read-only tool cannot carry mutation or effect bindings.",
      );
    }
  } else {
    validateMutationBinding(value, binding, context);
  }

  const expectedBoundaryEffectCount =
    binding.effectState === "effect_recorded" ? 1 : 0;
  if (
    value.resourceUsage.boundaryExternalEffectCount !==
    expectedBoundaryEffectCount
  ) {
    addIssue(
      context,
      ["resourceUsage", "boundaryExternalEffectCount"],
      "Boundary effect count must exactly match its receipt state.",
    );
  }
}

function validateMutationBinding(
  value: z.infer<typeof runCheckpointBaseSchema>,
  binding: NonNullable<z.infer<typeof checkpointToolBindingSchema>>,
  context: z.RefinementCtx,
): void {
  if (binding.idempotencyKeySha256 === null) {
    addIssue(
      context,
      ["toolBinding", "idempotencyKeySha256"],
      "A mutation requires an idempotency-key digest.",
    );
  }
  if (binding.effectIntent === null) {
    addIssue(
      context,
      ["toolBinding", "effectIntent"],
      "A mutation requires a recorded effect intent.",
    );
  } else if (
    !hasExactStateReference(
      value.stateReferences,
      "effect_intent",
      binding.effectIntent,
    )
  ) {
    addIssue(
      context,
      ["toolBinding", "effectIntent"],
      "Effect intent must exactly match a checkpoint state reference.",
    );
  }
  if (binding.effectState === "not_applicable") {
    addIssue(
      context,
      ["toolBinding", "effectState"],
      "A mutation cannot declare effects not applicable.",
    );
  }
  if (
    value.boundary.kind === "tool" &&
    value.boundary.phase === "before" &&
    binding.effectState !== "intent_recorded"
  ) {
    addIssue(
      context,
      ["toolBinding", "effectState"],
      "A pre-tool mutation checkpoint must stop at recorded intent.",
    );
  }
  if (
    value.boundary.kind === "tool" &&
    value.boundary.phase === "after" &&
    binding.effectState !== "no_effect" &&
    binding.effectState !== "effect_recorded"
  ) {
    addIssue(
      context,
      ["toolBinding", "effectState"],
      "A post-tool mutation checkpoint must record no effect or an effect receipt.",
    );
  }
  if (
    value.boundary.kind === "approval" &&
    binding.effectState !== "intent_recorded"
  ) {
    addIssue(
      context,
      ["toolBinding", "effectState"],
      "An approval mutation must remain at recorded intent.",
    );
  }

  if (binding.effectState === "effect_recorded") {
    if (binding.effectReceipt === null) {
      addIssue(
        context,
        ["toolBinding", "effectReceipt"],
        "A recorded effect requires an exact receipt binding.",
      );
    } else if (
      !hasExactStateReference(
        value.stateReferences,
        "effect_receipt",
        binding.effectReceipt,
      )
    ) {
      addIssue(
        context,
        ["toolBinding", "effectReceipt"],
        "Effect receipt must exactly match a checkpoint state reference.",
      );
    }
  } else if (binding.effectReceipt !== null) {
    addIssue(
      context,
      ["toolBinding", "effectReceipt"],
      "Only a recorded effect may include an effect receipt.",
    );
  }
}

function validateLifecycle(
  value: z.infer<typeof runCheckpointBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (
    value.boundary.phase === "waiting" &&
    (value.lifecycleState !== "waiting" ||
      value.resumeDisposition !== "awaiting_signal")
  ) {
    addIssue(
      context,
      ["resumeDisposition"],
      "A waiting boundary must await an external signal.",
    );
  }
  if (
    value.boundary.phase !== "waiting" &&
    value.lifecycleState === "waiting"
  ) {
    addIssue(
      context,
      ["lifecycleState"],
      "Only a waiting boundary may use waiting lifecycle state.",
    );
  }
  if (
    value.lifecycleState === "active" &&
    value.resumeDisposition !== "resumable"
  ) {
    addIssue(
      context,
      ["resumeDisposition"],
      "An active checkpoint must be resumable.",
    );
  }
  if (
    value.lifecycleState === "waiting" &&
    value.resumeDisposition !== "awaiting_signal"
  ) {
    addIssue(
      context,
      ["resumeDisposition"],
      "A waiting checkpoint must await a signal.",
    );
  }
  if (
    value.lifecycleState === "terminal" &&
    (value.resumeDisposition !== "not_resumable" ||
      value.boundary.phase !== "after")
  ) {
    addIssue(
      context,
      ["resumeDisposition"],
      "A terminal checkpoint must be a non-resumable after-boundary record.",
    );
  }
}

function boundaryReferenceKind(
  boundary: RunCheckpointBoundaryV1,
): z.infer<typeof checkpointStateReferenceKindSchema> {
  switch (boundary.kind) {
    case "model":
      return "model_turn";
    case "tool":
      return "tool_execution";
    case "approval":
      return boundary.phase === "waiting"
        ? "approval_request"
        : "approval_decision";
    case "delegation":
      return boundary.phase === "after"
        ? "delegation_signal"
        : "delegation";
    case "verifier":
      return boundary.phase === "before"
        ? "verifier_request"
        : "verifier_receipt";
  }
}

function hasStateReference(
  references: readonly RunCheckpointStateReferenceV1[],
  kind: z.infer<typeof checkpointStateReferenceKindSchema>,
  referenceId: string,
): boolean {
  return references.some(
    (reference) =>
      reference.kind === kind && reference.referenceId === referenceId,
  );
}

function hasExactStateReference(
  references: readonly RunCheckpointStateReferenceV1[],
  kind: "tool_execution" | "effect_intent" | "effect_receipt",
  expected: z.infer<typeof checkpointEffectReferenceSchema>,
): boolean {
  return references.some(
    (reference) =>
      reference.kind === kind &&
      reference.referenceId === expected.referenceId &&
      reference.referenceSha256 === expected.referenceSha256,
  );
}

function canonicalStateReferences(
  references: readonly RunCheckpointStateReferenceV1[],
): RunCheckpointStateReferenceV1[] {
  return [...references].sort((left, right) =>
    compareStrings(stateReferenceKey(left), stateReferenceKey(right)),
  );
}

function stateReferenceKey(reference: RunCheckpointStateReferenceV1): string {
  return `${reference.kind}\u0000${reference.referenceId}`;
}

function canonicalIds(ids: readonly string[]): string[] {
  return [...ids].sort(compareStrings);
}

function validateUniqueIds(
  ids: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      addIssue(context, [...path, index], "Grant IDs must be unique.");
    }
    seen.add(id);
  });
}

function validateCommonResourceUsage(
  value: {
    modelInputTokenCount: number;
    cachedInputTokenCount: number;
    externalEffectCount: number;
    boundaryExternalEffectCount: number;
  },
  context: z.RefinementCtx,
): void {
  if (value.cachedInputTokenCount > value.modelInputTokenCount) {
    addIssue(
      context,
      ["cachedInputTokenCount"],
      "Cached input tokens cannot exceed model input tokens.",
    );
  }
  if (value.boundaryExternalEffectCount > value.externalEffectCount) {
    addIssue(
      context,
      ["boundaryExternalEffectCount"],
      "Boundary effects cannot exceed cumulative effects.",
    );
  }
}

function validateCanonicalIds(
  ids: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  let prior: string | null = null;
  ids.forEach((id, index) => {
    if (prior !== null && id <= prior) {
      addIssue(
        context,
        [...path, index],
        id === prior
          ? "Grant IDs must be unique."
          : "Grant IDs must use canonical order.",
      );
    }
    prior = id;
  });
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function requiredScopedId(value: string | null, label: string): string {
  if (value === null) {
    throw new Error(`Checkpoint requires ${label} attribution.`);
  }
  return value;
}

function derivedCheckpointId(value: unknown): string {
  return `run_checkpoint_${checkpointDomainDigest(
    "checkpoint_identity",
    value,
  ).slice(0, 56)}`;
}

function checkpointDomainDigest(domain: string, value: unknown): string {
  const canonical = canonicalizeBoundedPlainData(
    value,
    MAX_RUN_CHECKPOINT_BYTES,
  );
  return createHash("sha256")
    .update(`${CHECKPOINT_DIGEST_DOMAIN}\u0000${domain}\u0000${canonical}`)
    .digest("hex");
}

function enginePinsEqual(
  supported: RunCheckpointEnginePinV1,
  candidate: Record<string, unknown>,
): boolean {
  return (
    candidate.rolloutCapabilityId === supported.rolloutCapabilityId &&
    candidate.engineVersionId === supported.engineVersionId &&
    candidate.contractVersionId === supported.contractVersionId &&
    candidate.configurationSha256 === supported.configurationSha256 &&
    candidate.runContractEnvelopeId === supported.runContractEnvelopeId &&
    candidate.runContractEnvelopeSha256 ===
      supported.runContractEnvelopeSha256 &&
    candidate.harnessManifestId === supported.harnessManifestId &&
    candidate.harnessManifestSha256 === supported.harnessManifestSha256 &&
    candidate.rolloutMode === supported.rolloutMode &&
    candidate.rolloutLifecycleStatus ===
      supported.rolloutLifecycleStatus &&
    candidate.rolloutGeneration === supported.rolloutGeneration &&
    candidate.rolloutLifecycleRevision === supported.rolloutLifecycleRevision &&
    Object.keys(candidate).length === 12
  );
}

function pauseCompatibility(
  reason: z.infer<typeof _compatibilityPauseReasonSchema>,
): RunCheckpointCompatibilityDecisionV1 {
  return deepFreeze({
    disposition: "pause" as const,
    reason,
    checkpoint: null,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownEnumerableDataProperty(
  value: Record<string, unknown>,
  key: string,
): { valid: true; value: unknown } | { valid: false } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor)
  ) {
    return { valid: false };
  }
  return { valid: true, value: descriptor.value };
}

function addIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/**
 * Produces canonical JSON with bounded ordinary plain-data traversal.
 * Accessors, exotic prototypes, sparse/extended arrays, cycles, undefined
 * values, and unsafe numbers are rejected. Symbol and non-enumerable fields
 * are JSON-invisible and are not traversed; Zod reconstructs the clean output.
 * JavaScript cannot inspect a hostile Proxy without invoking its reflection
 * traps, so this is a data-contract guard rather than a Proxy sandbox.
 */
function canonicalizeBoundedPlainData(value: unknown, maxBytes: number): string {
  const chunks: string[] = [];
  const active = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;

  const emit = (chunk: string): void => {
    bytes += new TextEncoder().encode(chunk).byteLength;
    if (bytes > maxBytes) {
      throw new Error("Canonical value exceeds its byte limit.");
    }
    chunks.push(chunk);
  };

  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
      throw new Error("Canonical value exceeds its traversal limit.");
    }
    if (current === null) {
      emit("null");
      return;
    }
    if (typeof current === "string") {
      if (current.length > MAX_CANONICAL_STRING_LENGTH) {
        throw new Error("Canonical string exceeds its length limit.");
      }
      emit(JSON.stringify(current));
      return;
    }
    if (typeof current === "boolean") {
      emit(current ? "true" : "false");
      return;
    }
    if (typeof current === "number") {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) {
        throw new Error("Canonical numbers must be safe integers.");
      }
      emit(String(current));
      return;
    }
    if (typeof current !== "object") {
      throw new Error("Canonical values must contain JSON data only.");
    }
    if (active.has(current)) {
      throw new Error("Canonical values cannot contain cycles.");
    }
    active.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          throw new Error("Canonical arrays must use the plain array prototype.");
        }
        if (current.length > MAX_CANONICAL_ARRAY_ITEMS) {
          throw new Error("Canonical array exceeds its item limit.");
        }
        const keys = collectBoundedEnumerableOwnKeys(
          current,
          MAX_CANONICAL_ARRAY_ITEMS,
        );
        if (keys.length !== current.length) {
          throw new Error("Canonical arrays must be dense and unextended.");
        }
        for (const key of keys) {
          const index = Number(key);
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= current.length ||
            String(index) !== key
          ) {
            throw new Error("Canonical arrays must be dense and unextended.");
          }
        }
        emit("[");
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            current,
            String(index),
          );
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            throw new Error("Canonical arrays cannot contain holes or accessors.");
          }
          if (index > 0) emit(",");
          visit(descriptor.value, depth + 1);
        }
        emit("]");
        return;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Canonical objects must use a plain prototype.");
      }
      const keys = collectBoundedEnumerableOwnKeys(
        current,
        MAX_CANONICAL_OBJECT_KEYS,
      );
      keys.sort(compareStrings);
      emit("{");
      keys.forEach((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new Error("Canonical objects require enumerable data fields.");
        }
        if (index > 0) emit(",");
        emit(JSON.stringify(key));
        emit(":");
        visit(descriptor.value, depth + 1);
      });
      emit("}");
    } finally {
      active.delete(current);
    }
  };

  visit(value, 0);
  return chunks.join("");
}

function collectBoundedEnumerableOwnKeys(
  value: object,
  maximum: number,
): string[] {
  const keys: string[] = [];
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error("Canonical values cannot inherit enumerable fields.");
    }
    if (key.length > MAX_CANONICAL_STRING_LENGTH) {
      throw new Error("Canonical key exceeds its length limit.");
    }
    keys.push(key);
    if (keys.length > maximum) {
      throw new Error("Canonical value exceeds its enumerable-key limit.");
    }
  }
  return keys;
}
