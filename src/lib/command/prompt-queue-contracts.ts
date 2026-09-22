import { z } from "zod";

export const PROMPT_QUEUE_SCHEMA_VERSION = 1 as const;
export const PROMPT_QUEUE_MAX_ITEMS = 40;
export const PROMPT_QUEUE_MAX_PROMPT_CHARS = 20_000;
export const PROMPT_QUEUE_DISPATCH_ID_HEADER = "x-asael-prompt-queue-item";
export const PROMPT_QUEUE_DISPATCH_TOKEN_HEADER = "x-asael-prompt-queue-token";

const idSchema = z.string().trim().min(1).max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const governedAgentIdSchema = z.string().trim().min(1).max(120)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const governedProjectIdSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const promptQueueTargetV1Schema = z.object({
  threadId: z.string().uuid().nullable(),
  missionId: z.string().uuid().nullable(),
  projectId: governedProjectIdSchema.nullable(),
  executionTarget: z.enum(["asael", "local_macos"]),
}).strict();

export const promptQueueAgentPinV1Schema = z.object({
  logicalAgentId: idSchema,
  definitionId: idSchema,
  definitionVersion: positiveIntegerSchema,
  definitionVersionId: idSchema,
  definitionSha256: sha256Schema,
  principalId: idSchema,
  principalGeneration: positiveIntegerSchema,
  principalVersionId: idSchema,
  principalSha256: sha256Schema,
}).strict();

export const promptQueueModelPinV1Schema = z.object({
  providerId: z.enum(["openai", "google", "anthropic", "aws_bedrock"]),
  modelId: idSchema,
  tier: z.enum(["fast", "reasoning"]),
  assignmentId: idSchema.nullable(),
  assignmentRevision: positiveIntegerSchema.nullable(),
  assignmentConfigurationSha256: sha256Schema.nullable(),
  routingPolicySha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const assignmentFields = [
    value.assignmentId,
    value.assignmentRevision,
    value.assignmentConfigurationSha256,
  ];
  if (assignmentFields.some((field) => field !== null) &&
      !assignmentFields.every((field) => field !== null)) {
    context.addIssue({
      code: "custom",
      path: ["assignmentId"],
      message: "A model assignment pin must be complete or absent.",
    });
  }
});

export const promptQueueItemV1Schema = z.object({
  schemaVersion: z.literal(PROMPT_QUEUE_SCHEMA_VERSION),
  id: z.string().uuid(),
  clientCorrelationId: idSchema,
  originSessionId: idSchema,
  lastModifiedSessionId: idSchema,
  prompt: z.string().min(1).max(PROMPT_QUEUE_MAX_PROMPT_CHARS),
  promptSha256: sha256Schema,
  mode: z.enum(["orchestrate", "research", "execute", "learn"]),
  strategy: z.enum(["direct", "auto"]),
  target: promptQueueTargetV1Schema,
  targetSha256: sha256Schema,
  agent: promptQueueAgentPinV1Schema,
  model: promptQueueModelPinV1Schema,
  state: z.enum([
    "queued",
    "paused",
    "dispatching",
    "completed",
    "failed",
  ]),
  position: positiveIntegerSchema,
  lifecycleRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  runId: idSchema.nullable(),
  resultThreadId: idSchema.nullable(),
  progressLabel: z.string().trim().min(1).max(160).nullable(),
  failureCode: idSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  dispatchedAt: timestampSchema.nullable(),
  terminalAt: timestampSchema.nullable(),
  queueGrantsAuthority: z.literal(false),
}).strict();

export const promptQueueListV1Schema = z.object({
  schemaVersion: z.literal(PROMPT_QUEUE_SCHEMA_VERSION),
  items: z.array(promptQueueItemV1Schema).max(PROMPT_QUEUE_MAX_ITEMS),
  serverTime: timestampSchema,
}).strict();

export const promptQueueCreateRequestSchema = z.object({
  clientCorrelationId: idSchema,
  prompt: z.string().trim().min(1).max(PROMPT_QUEUE_MAX_PROMPT_CHARS),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).default("orchestrate"),
  strategy: z.enum(["direct", "auto"]).default("direct"),
  agentId: governedAgentIdSchema.default("atlas"),
  target: promptQueueTargetV1Schema,
}).strict();

export const promptQueueUpdateRequestSchema = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  prompt: z.string().trim().min(1).max(PROMPT_QUEUE_MAX_PROMPT_CHARS).optional(),
  state: z.enum(["queued", "paused"]).optional(),
}).strict().refine(
  (value) => value.prompt !== undefined || value.state !== undefined,
  { message: "A prompt or lifecycle change is required." },
);

export const promptQueueDeleteRequestSchema = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const promptQueueReorderRequestSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).strict()).min(1).max(PROMPT_QUEUE_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  if (new Set(value.items.map((item) => item.id)).size !== value.items.length) {
    context.addIssue({ code: "custom", message: "Queue reorder ids must be unique." });
  }
});

export const promptQueueDispatchRequestSchema = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  force: z.boolean().default(false),
}).strict();

export type PromptQueueTargetV1 = Readonly<z.infer<typeof promptQueueTargetV1Schema>>;
export type PromptQueueAgentPinV1 = Readonly<z.infer<typeof promptQueueAgentPinV1Schema>>;
export type PromptQueueModelPinV1 = Readonly<z.infer<typeof promptQueueModelPinV1Schema>>;
export type PromptQueueItemV1 = Readonly<z.infer<typeof promptQueueItemV1Schema>>;
export type PromptQueueCreateRequest = Readonly<z.infer<typeof promptQueueCreateRequestSchema>>;
