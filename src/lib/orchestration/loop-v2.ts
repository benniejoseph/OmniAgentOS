import { z } from "zod";

import type { TenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  sourceContractIdSchema,
  sourceContractSha256,
  sourceContractSha256Schema,
  sourceTimestampSchema,
} from "@/lib/sources/contracts";

export const LOOP_V2_SCHEMA_VERSION = 1 as const;
export const LOOP_V2_CAPABILITY_ID = "agent_loop_v2" as const;
export const LOOP_V2_ENGINE_VERSION_ID =
  "agent_loop_v2_read_only_canary_1" as const;
export const LOOP_V2_CONTRACT_VERSION_ID =
  "agent_loop_transition_checkpoint_v1" as const;
export const LOOP_V2_CONFIGURATION_SHA256 = sourceContractSha256({
  engineVersionId: LOOP_V2_ENGINE_VERSION_ID,
  contractVersionId: LOOP_V2_CONTRACT_VERSION_ID,
  taskClass: "single_read_only_governed_tool",
  maxRetries: 2,
  maxReplans: 1,
  transitions: [
    "understand",
    "clarify",
    "plan",
    "act",
    "observe",
    "verify",
    "replan",
    "finish",
  ],
});

export const loopV2StateSchema = z.enum([
  "understand",
  "clarify",
  "plan",
  "act",
  "observe",
  "verify",
  "replan",
  "finish",
]);

export const loopV2TriggerSchema = z.enum([
  "started",
  "ambiguity_detected",
  "clarified",
  "plan_bound",
  "action_started",
  "action_succeeded",
  "action_failed",
  "observation_recorded",
  "verification_passed",
  "verification_failed",
  "retry_scheduled",
  "replan_bound",
  "canceled",
  "budget_exhausted",
]);

export const loopV2TerminalDispositionSchema = z.enum([
  "succeeded",
  "failed",
  "canceled",
]);

const loopV2EnginePinSchema = z.object({
  capabilityId: z.literal(LOOP_V2_CAPABILITY_ID),
  engineVersionId: z.literal(LOOP_V2_ENGINE_VERSION_ID),
  contractVersionId: z.literal(LOOP_V2_CONTRACT_VERSION_ID),
  configurationSha256: z.literal(LOOP_V2_CONFIGURATION_SHA256),
  rolloutMode: z.literal("canary"),
  rolloutGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  rolloutLifecycleRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

const loopV2CheckpointBodySchema = z.object({
  schemaVersion: z.literal(LOOP_V2_SCHEMA_VERSION),
  checkpointId: sourceContractIdSchema,
  tenantId: sourceContractIdSchema,
  runId: sourceContractIdSchema,
  ownerActorId: sourceContractIdSchema,
  executionScopeSha256: sourceContractSha256Schema,
  enginePin: loopV2EnginePinSchema,
  sequence: z.number().int().min(1).max(10_000),
  parentCheckpointSha256: sourceContractSha256Schema.nullable(),
  fromState: loopV2StateSchema.nullable(),
  toState: loopV2StateSchema,
  trigger: loopV2TriggerSchema,
  lifecycleState: z.enum(["active", "waiting", "terminal"]),
  terminalDisposition: loopV2TerminalDispositionSchema.nullable(),
  retryCount: z.number().int().min(0).max(2),
  replanCount: z.number().int().min(0).max(1),
  inputReceiptSha256: sourceContractSha256Schema.nullable(),
  outputReceiptSha256: sourceContractSha256Schema.nullable(),
  transitionedAt: sourceTimestampSchema,
}).strict().superRefine((checkpoint, context) => {
  const expectedLifecycle = checkpoint.toState === "finish"
    ? "terminal"
    : checkpoint.toState === "clarify"
      ? "waiting"
      : "active";
  if (checkpoint.lifecycleState !== expectedLifecycle) {
    context.addIssue({
      code: "custom",
      path: ["lifecycleState"],
      message: "Loop lifecycle must match the destination state.",
    });
  }
  if (
    (checkpoint.toState === "finish") !==
      (checkpoint.terminalDisposition !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["terminalDisposition"],
      message: "Only a finished loop has a terminal disposition.",
    });
  }
  if (
    checkpoint.trigger !== "started" &&
    !checkpoint.inputReceiptSha256 &&
    !checkpoint.outputReceiptSha256
  ) {
    context.addIssue({
      code: "custom",
      path: ["outputReceiptSha256"],
      message: "Every non-initial transition must bind an input or output receipt.",
    });
  }
});

export const loopV2CheckpointSchema = loopV2CheckpointBodySchema.extend({
  checkpointSha256: sourceContractSha256Schema,
}).strict();

export type LoopV2State = z.infer<typeof loopV2StateSchema>;
export type LoopV2Trigger = z.infer<typeof loopV2TriggerSchema>;
export type LoopV2TerminalDisposition = z.infer<
  typeof loopV2TerminalDispositionSchema
>;
export type LoopV2EnginePin = Readonly<z.infer<typeof loopV2EnginePinSchema>>;
export type LoopV2Checkpoint = Readonly<
  z.infer<typeof loopV2CheckpointSchema>
>;

export function loopV2ExecutionScopeSha256(executionScope: ExecutionScope) {
  const parsed = parsePersistedExecutionScope(executionScope);
  if (!parsed?.initiatingActorId) {
    throw new Error("Loop v2 requires an actor-bound execution scope.");
  }
  return sourceContractSha256(parsed);
}

export function buildLoopV2EnginePin(
  rollout: TenantCapabilityRollout,
): LoopV2EnginePin {
  if (
    rollout.capabilityId !== LOOP_V2_CAPABILITY_ID ||
    rollout.engineVersion !== LOOP_V2_ENGINE_VERSION_ID ||
    rollout.contractVersionId !== LOOP_V2_CONTRACT_VERSION_ID ||
    rollout.configurationSha256 !== LOOP_V2_CONFIGURATION_SHA256 ||
    rollout.mode !== "canary" ||
    rollout.status !== "active" ||
    rollout.lifecycleRevision < 1
  ) {
    throw new Error("Loop v2 rollout is not an active supported canary.");
  }
  return deepFreeze(loopV2EnginePinSchema.parse({
    capabilityId: rollout.capabilityId,
    engineVersionId: rollout.engineVersion,
    contractVersionId: rollout.contractVersionId,
    configurationSha256: rollout.configurationSha256,
    rolloutMode: rollout.mode,
    rolloutGeneration: rollout.rolloutGeneration,
    rolloutLifecycleRevision: rollout.lifecycleRevision,
  }));
}

export function createInitialLoopV2Checkpoint(input: {
  tenantId: string;
  runId: string;
  ownerActorId: string;
  executionScope: ExecutionScope;
  enginePin: LoopV2EnginePin;
  transitionedAt?: string;
}): LoopV2Checkpoint {
  assertLoopScope(input.executionScope, input.tenantId, input.ownerActorId);
  return buildCheckpoint({
    tenantId: input.tenantId,
    runId: input.runId,
    ownerActorId: input.ownerActorId,
    executionScopeSha256: loopV2ExecutionScopeSha256(input.executionScope),
    enginePin: input.enginePin,
    sequence: 1,
    parentCheckpointSha256: null,
    fromState: null,
    toState: "understand",
    trigger: "started",
    lifecycleState: "active",
    terminalDisposition: null,
    retryCount: 0,
    replanCount: 0,
    inputReceiptSha256: null,
    outputReceiptSha256: null,
    transitionedAt: canonicalTimestamp(input.transitionedAt),
  });
}

export function advanceLoopV2Checkpoint(input: {
  current: LoopV2Checkpoint;
  executionScope: ExecutionScope;
  trigger: Exclude<LoopV2Trigger, "started">;
  inputReceiptSha256?: string | null;
  outputReceiptSha256?: string | null;
  transitionedAt?: string;
}): LoopV2Checkpoint {
  const current = parseLoopV2Checkpoint(input.current);
  assertLoopScope(
    input.executionScope,
    current.tenantId,
    current.ownerActorId,
  );
  if (
    loopV2ExecutionScopeSha256(input.executionScope) !==
      current.executionScopeSha256
  ) {
    throw new Error("Loop v2 transition scope does not match the run binding.");
  }
  if (current.toState === "finish") {
    throw new Error("A finished Loop v2 run cannot transition again.");
  }
  const transition = resolveTransition(current, input.trigger);
  const transitionedAt = canonicalTimestamp(input.transitionedAt);
  if (Date.parse(transitionedAt) < Date.parse(current.transitionedAt)) {
    throw new Error("Loop v2 transition time cannot move backward.");
  }
  return buildCheckpoint({
    tenantId: current.tenantId,
    runId: current.runId,
    ownerActorId: current.ownerActorId,
    executionScopeSha256: current.executionScopeSha256,
    enginePin: current.enginePin,
    sequence: current.sequence + 1,
    parentCheckpointSha256: current.checkpointSha256,
    fromState: current.toState,
    toState: transition.toState,
    trigger: input.trigger,
    lifecycleState: transition.toState === "finish"
      ? "terminal"
      : transition.toState === "clarify"
        ? "waiting"
        : "active",
    terminalDisposition: transition.terminalDisposition,
    retryCount: transition.retryCount,
    replanCount: transition.replanCount,
    inputReceiptSha256: input.inputReceiptSha256 || null,
    outputReceiptSha256: input.outputReceiptSha256 || null,
    transitionedAt,
  });
}

export function parseLoopV2Checkpoint(value: unknown): LoopV2Checkpoint {
  const checkpoint = loopV2CheckpointSchema.parse(value);
  const { checkpointSha256, ...body } = checkpoint;
  if (sourceContractSha256(body) !== checkpointSha256) {
    throw new Error("Loop v2 checkpoint digest is invalid.");
  }
  return deepFreeze(checkpoint);
}

export function replayLoopV2Checkpoints(
  values: readonly unknown[],
): LoopV2Checkpoint {
  if (!values.length || values.length > 10_000) {
    throw new Error("Loop v2 replay requires a bounded non-empty checkpoint chain.");
  }
  const checkpoints = values.map(parseLoopV2Checkpoint);
  const first = checkpoints[0];
  if (
    first.sequence !== 1 ||
    first.parentCheckpointSha256 !== null ||
    first.fromState !== null ||
    first.toState !== "understand" ||
    first.trigger !== "started"
  ) {
    throw new Error("Loop v2 checkpoint chain has an invalid root.");
  }
  for (let index = 1; index < checkpoints.length; index += 1) {
    const parent = checkpoints[index - 1];
    const child = checkpoints[index];
    validateLoopV2CheckpointSuccessor(parent, child);
  }
  return checkpoints.at(-1)!;
}

export function validateLoopV2CheckpointSuccessor(
  parentValue: unknown,
  childValue: unknown,
) {
  const parent = parseLoopV2Checkpoint(parentValue);
  const child = parseLoopV2Checkpoint(childValue);
  if (
    child.sequence !== parent.sequence + 1 ||
    child.parentCheckpointSha256 !== parent.checkpointSha256 ||
    child.fromState !== parent.toState ||
    child.runId !== parent.runId ||
    child.tenantId !== parent.tenantId ||
    child.ownerActorId !== parent.ownerActorId ||
    child.executionScopeSha256 !== parent.executionScopeSha256 ||
    sourceContractSha256(child.enginePin) !==
      sourceContractSha256(parent.enginePin)
  ) {
    throw new Error("Loop v2 checkpoint chain is not contiguous.");
  }
  if (child.trigger === "started") {
    throw new Error("Loop v2 checkpoint chain may only start once.");
  }
  const expected = resolveTransition(parent, child.trigger);
  if (
    child.toState !== expected.toState ||
    child.terminalDisposition !== expected.terminalDisposition ||
    child.retryCount !== expected.retryCount ||
    child.replanCount !== expected.replanCount
  ) {
    throw new Error("Loop v2 checkpoint transition is invalid.");
  }
  return child;
}

function resolveTransition(
  current: LoopV2Checkpoint,
  trigger: Exclude<LoopV2Trigger, "started">,
): {
  toState: LoopV2State;
  terminalDisposition: LoopV2TerminalDisposition | null;
  retryCount: number;
  replanCount: number;
} {
  if (trigger === "canceled") {
    return result("finish", "canceled", current.retryCount, current.replanCount);
  }
  if (
    trigger === "budget_exhausted" &&
    ["act", "verify", "replan"].includes(current.toState)
  ) {
    return result("finish", "failed", current.retryCount, current.replanCount);
  }
  const exact = `${current.toState}:${trigger}`;
  switch (exact) {
    case "understand:ambiguity_detected":
      return result("clarify", null, current.retryCount, current.replanCount);
    case "understand:plan_bound":
    case "clarify:clarified":
    case "replan:replan_bound":
      return result("plan", null, current.retryCount, current.replanCount);
    case "plan:action_started":
      return result("act", null, current.retryCount, current.replanCount);
    case "act:action_succeeded":
      return result("observe", null, current.retryCount, current.replanCount);
    case "act:retry_scheduled":
      if (current.retryCount >= 2) {
        throw new Error("Loop v2 retry budget is exhausted.");
      }
      return result("act", null, current.retryCount + 1, current.replanCount);
    case "act:action_failed":
    case "verify:verification_failed":
      if (current.replanCount >= 1) {
        throw new Error("Loop v2 replan budget is exhausted.");
      }
      return result("replan", null, current.retryCount, current.replanCount + 1);
    case "observe:observation_recorded":
      return result("verify", null, current.retryCount, current.replanCount);
    case "verify:verification_passed":
      return result("finish", "succeeded", current.retryCount, current.replanCount);
    default:
      throw new Error(`Loop v2 transition ${exact} is not allowed.`);
  }
}

function result(
  toState: LoopV2State,
  terminalDisposition: LoopV2TerminalDisposition | null,
  retryCount: number,
  replanCount: number,
) {
  return { toState, terminalDisposition, retryCount, replanCount };
}

function buildCheckpoint(
  input: Omit<
    z.input<typeof loopV2CheckpointBodySchema>,
    "schemaVersion" | "checkpointId"
  >,
): LoopV2Checkpoint {
  const body = loopV2CheckpointBodySchema.parse({
    schemaVersion: LOOP_V2_SCHEMA_VERSION,
    ...input,
    checkpointId: `loop_v2_${sourceContractSha256({
      tenantId: input.tenantId,
      runId: input.runId,
      sequence: input.sequence,
      parentCheckpointSha256: input.parentCheckpointSha256,
      toState: input.toState,
      trigger: input.trigger,
    }).slice(0, 56)}`,
  });
  return deepFreeze(loopV2CheckpointSchema.parse({
    ...body,
    checkpointSha256: sourceContractSha256(body),
  }));
}

function assertLoopScope(
  executionScope: ExecutionScope,
  tenantId: string,
  ownerActorId: string,
) {
  const scope = parsePersistedExecutionScope(executionScope);
  if (
    !scope ||
    scope.tenantId !== tenantId ||
    scope.initiatingActorId !== ownerActorId ||
    scope.purpose !== "agent.loop.v2.read_only_canary" ||
    scope.executingPrincipalType !== "agent" ||
    !scope.executingPrincipalId ||
    scope.workspaceId !== null ||
    scope.projectId !== null ||
    scope.missionId !== null ||
    scope.delegationId !== null
  ) {
    throw new Error("Loop v2 canary requires an exact actor-bound read-only scope.");
  }
}

function canonicalTimestamp(value?: string) {
  const timestamp = value || new Date().toISOString();
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Loop v2 transition timestamp is invalid.");
  }
  return parsed.toISOString();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
