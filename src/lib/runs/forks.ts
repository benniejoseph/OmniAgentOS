import { createHash } from "node:crypto";
import { z } from "zod";

import type { ChatMessage } from "@/lib/orchestration/types";
import type { RunCheckpointV1 } from "@/lib/runs/checkpoints";
import type { ExecutionScope } from "@/lib/security/execution-scope";

export const RUN_FORK_LINEAGE_SCHEMA_VERSION = 1 as const;
export const RUN_FORK_PURPOSE = "agent.run.checkpoint_fork";
export const MAX_RUN_FORK_CORRECTION_CHARS = 4_000;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().trim().min(1).max(240);
const timestampSchema = z.string().datetime({ offset: true });

export const runForkLineageV1Schema = z.object({
  schemaVersion: z.literal(RUN_FORK_LINEAGE_SCHEMA_VERSION),
  contractKind: z.literal("run_fork_lineage"),
  forkId: idSchema,
  tenantId: idSchema,
  initiatingActorId: idSchema,
  source: z.object({
    runId: idSchema,
    checkpointId: idSchema,
    checkpointSha256: sha256Schema,
    checkpointSequence: z.number().int().min(0).max(1_000_000_000),
    boundaryKind: z.enum(["model", "tool", "approval", "delegation", "verifier"]),
    boundaryPhase: z.enum(["before", "waiting", "after"]),
    recordedAt: timestampSchema,
    eventPrefixCount: z.number().int().min(1).max(2_000),
    eventPrefixLastSeq: z.number().int().min(1),
    eventPrefixSha256: sha256Schema,
  }).strict(),
  target: z.object({
    runId: idSchema,
    executionScopeSha256: sha256Schema,
    contextGrantIdsSha256: sha256Schema,
    capabilityGrantIdsSha256: sha256Schema,
    approvalInheritance: z.literal("none"),
    continuationInheritance: z.literal("none"),
  }).strict(),
  correction: z.object({
    length: z.number().int().min(1).max(MAX_RUN_FORK_CORRECTION_CHARS),
    sha256: sha256Schema,
  }).strict(),
  idempotencyKeySha256: sha256Schema,
  createdAt: timestampSchema,
}).strict().superRefine((value, context) => {
  const expectedForkId = deterministicRunForkId({
    tenantId: value.tenantId,
    sourceRunId: value.source.runId,
    checkpointId: value.source.checkpointId,
    idempotencyKeySha256: value.idempotencyKeySha256,
  });
  if (value.forkId !== expectedForkId) {
    context.addIssue({
      code: "custom",
      path: ["forkId"],
      message: "Fork identity does not match its source and idempotency binding.",
    });
  }
  if (value.target.runId !== deterministicRunForkTargetId(value.forkId)) {
    context.addIssue({
      code: "custom",
      path: ["target", "runId"],
      message: "Fork target identity does not match its lineage.",
    });
  }
});

export type RunForkLineageV1 = z.infer<typeof runForkLineageV1Schema>;

export type BuildRunForkLineageV1Input = Readonly<{
  checkpoint: RunCheckpointV1;
  executionScope: ExecutionScope;
  correction: string;
  idempotencyKey: string;
  eventPrefix: Readonly<{
    count: number;
    lastSeq: number;
    sha256: string;
  }>;
  createdAt: string;
}>;

export function buildRunForkLineageV1(
  input: BuildRunForkLineageV1Input,
): RunForkLineageV1 {
  const correction = normalizedCorrection(input.correction);
  const idempotencyKey = requiredText(input.idempotencyKey, "idempotency key", 240);
  const checkpoint = input.checkpoint;
  const scope = input.executionScope;
  if (
    scope.tenantId !== checkpoint.executionScope.tenantId ||
    !scope.initiatingActorId ||
    scope.causationId !== checkpoint.checkpointId ||
    scope.purpose !== RUN_FORK_PURPOSE
  ) {
    throw new Error("Fork execution scope does not match its checkpoint boundary.");
  }
  if (scope.executingPrincipalType !== "agent" || !scope.executingPrincipalId) {
    throw new Error("A checkpoint fork requires an explicit executing agent.");
  }
  if (
    !Number.isSafeInteger(input.eventPrefix.count) ||
    input.eventPrefix.count < 1 ||
    input.eventPrefix.count > 2_000 ||
    !Number.isSafeInteger(input.eventPrefix.lastSeq) ||
    input.eventPrefix.lastSeq < 1 ||
    !sha256Schema.safeParse(input.eventPrefix.sha256).success
  ) {
    throw new Error("Fork event prefix receipt is invalid.");
  }

  const idempotencyKeySha256 = sha256(idempotencyKey);
  const forkId = deterministicRunForkId({
    tenantId: scope.tenantId,
    sourceRunId: checkpoint.runId,
    checkpointId: checkpoint.checkpointId,
    idempotencyKeySha256,
  });
  return parseRunForkLineageV1({
    schemaVersion: RUN_FORK_LINEAGE_SCHEMA_VERSION,
    contractKind: "run_fork_lineage",
    forkId,
    tenantId: scope.tenantId,
    initiatingActorId: scope.initiatingActorId,
    source: {
      runId: checkpoint.runId,
      checkpointId: checkpoint.checkpointId,
      checkpointSha256: checkpoint.checkpointSha256,
      checkpointSequence: checkpoint.sequence,
      boundaryKind: checkpoint.boundary.kind,
      boundaryPhase: checkpoint.boundary.phase,
      recordedAt: checkpoint.recordedAt,
      eventPrefixCount: input.eventPrefix.count,
      eventPrefixLastSeq: input.eventPrefix.lastSeq,
      eventPrefixSha256: input.eventPrefix.sha256,
    },
    target: {
      runId: deterministicRunForkTargetId(forkId),
      executionScopeSha256: sha256(canonicalExecutionScope(scope)),
      contextGrantIdsSha256: sha256(JSON.stringify(scope.contextGrantIds)),
      capabilityGrantIdsSha256: sha256(JSON.stringify(scope.capabilityGrantIds)),
      approvalInheritance: "none",
      continuationInheritance: "none",
    },
    correction: {
      length: correction.length,
      sha256: sha256(correction),
    },
    idempotencyKeySha256,
    createdAt: canonicalTimestamp(input.createdAt),
  });
}

export function parseRunForkLineageV1(value: unknown): RunForkLineageV1 {
  return deepFreeze(runForkLineageV1Schema.parse(value));
}

export function deterministicRunForkId(input: {
  tenantId: string;
  sourceRunId: string;
  checkpointId: string;
  idempotencyKeySha256: string;
}) {
  return `fork_${sha256([
    "asael.run-fork.v1",
    input.tenantId,
    input.sourceRunId,
    input.checkpointId,
    input.idempotencyKeySha256,
  ].join("\0")).slice(0, 40)}`;
}

export function deterministicRunForkTargetId(forkId: string) {
  return `afr_${sha256(`asael.run-fork-target.v1\0${forkId}`).slice(0, 40)}`;
}

export function buildCheckpointCorrectionMessages(input: {
  sourceMessages: readonly ChatMessage[];
  checkpoint: Pick<RunCheckpointV1, "checkpointId" | "sequence" | "boundary">;
  correction: string;
  maxMessages: number;
}): ChatMessage[] {
  const correction = normalizedCorrection(input.correction);
  const maxMessages = Math.max(2, Math.min(Math.trunc(input.maxMessages), 100));
  const sourceMessages = input.sourceMessages
    .filter((message) =>
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string" &&
      message.content.trim()
    )
    .slice(-(maxMessages - 1))
    .map((message) => ({ role: message.role, content: message.content }));
  return [
    ...sourceMessages,
    {
      role: "user",
      content: [
        `Correction from checkpoint ${input.checkpoint.checkpointId}`,
        `Selected step: ${input.checkpoint.sequence + 1} · ${input.checkpoint.boundary.kind} ${input.checkpoint.boundary.phase}.`,
        correction,
        "Continue as a new trace from this reviewed boundary. Re-evaluate the task with this correction. Prior approvals and continuation authority do not carry into this trace.",
      ].join("\n\n"),
    },
  ];
}

function canonicalExecutionScope(scope: ExecutionScope) {
  return JSON.stringify({
    version: scope.version,
    tenantId: scope.tenantId,
    initiatingActorId: scope.initiatingActorId,
    executingPrincipalType: scope.executingPrincipalType,
    executingPrincipalId: scope.executingPrincipalId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    missionId: scope.missionId,
    delegationId: scope.delegationId,
    correlationId: scope.correlationId,
    causationId: scope.causationId,
    contextGrantIds: scope.contextGrantIds,
    capabilityGrantIds: scope.capabilityGrantIds,
    purpose: scope.purpose,
  });
}

function normalizedCorrection(value: string) {
  const correction = requiredText(
    value,
    "correction",
    MAX_RUN_FORK_CORRECTION_CHARS,
  );
  return correction;
}

function requiredText(value: string, label: string, maxLength: number) {
  const text = String(value).trim();
  if (!text || text.length > maxLength) {
    throw new Error(`Run fork ${label} must be between 1 and ${maxLength} characters.`);
  }
  return text;
}

function canonicalTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Run fork timestamp must be canonical UTC time.");
  }
  return value;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
