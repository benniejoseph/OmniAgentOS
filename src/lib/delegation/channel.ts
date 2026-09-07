import { z } from "zod";

import type { DelegationTaskV1 } from "@/lib/delegation/lifecycle";
import { redactSensitive } from "@/lib/security/context";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const DELEGATION_MESSAGE_VERSION = "p8.4-delegation-message:1" as const;
export const DELEGATION_SHARED_ARTIFACT_VERSION =
  "p8.4-shared-mission-artifact:1" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const idListSchema = z.array(idSchema).max(32).refine(
  (values) => new Set(values).size === values.length,
  "IDs must be unique.",
);
const recipientsSchema = z.object({
  parent: z.boolean(),
  delegationTaskIds: z.array(idSchema).max(8).refine(
    (values) => new Set(values).size === values.length,
    "Recipient tasks must be unique.",
  ),
}).strict().refine(
  (value) => value.parent || value.delegationTaskIds.length > 0,
  "A delegation channel record requires a recipient.",
);
const senderSchema = z.object({
  taskId: idSchema,
  delegationId: idSchema,
  principalId: idSchema,
  agentId: idSchema,
  definitionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const boundarySchema = z.object({
  contentIsUntrusted: z.literal(true),
  mutatesStateDirectly: z.literal(false),
  authorityImpact: z.literal("none"),
  privateMemoryIncluded: z.literal(false),
  credentialMaterialIncluded: z.literal(false),
}).strict();

const artifactReferenceSchema = z.object({
  artifactId: idSchema,
  artifactSha256: sha256Schema,
}).strict();

export const delegationMessageV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(DELEGATION_MESSAGE_VERSION),
  messageId: idSchema,
  messageSha256: sha256Schema,
  missionId: idSchema,
  parentExecutionId: idSchema,
  parentDelegationId: idSchema.nullable(),
  sender: senderSchema,
  recipients: recipientsSchema,
  kind: z.enum(["progress", "question", "challenge", "handoff"]),
  body: z.string().trim().min(1).max(2_000),
  bodySha256: sha256Schema,
  artifactReferences: z.array(artifactReferenceSchema).max(16).refine(
    (values) => new Set(values.map((value) => value.artifactId)).size === values.length,
    "Artifact references must be unique.",
  ),
  inReplyToMessageId: idSchema.nullable(),
  createdAt: timestampSchema,
  boundary: boundarySchema,
}).strict().superRefine((value, context) => {
  const { messageId, messageSha256, ...body } = value;
  if (
    messageId !== `delegation-message:${messageSha256}` ||
    canonicalJsonSha256(body) !== messageSha256 ||
    canonicalJsonSha256({ body: value.body }) !== value.bodySha256
  ) {
    context.addIssue({ code: "custom", path: ["messageSha256"], message: "Delegation message integrity is invalid." });
  }
  if (redactSensitive(value.body) !== value.body) {
    context.addIssue({ code: "custom", path: ["body"], message: "Delegation messages cannot contain credential material." });
  }
});

export type DelegationMessageV1 = Readonly<
  z.infer<typeof delegationMessageV1Schema>
>;

export const sharedMissionArtifactV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(DELEGATION_SHARED_ARTIFACT_VERSION),
  artifactId: idSchema,
  artifactSha256: sha256Schema,
  missionId: idSchema,
  parentExecutionId: idSchema,
  parentDelegationId: idSchema.nullable(),
  sender: senderSchema,
  recipients: recipientsSchema,
  kind: z.enum(["analysis", "result", "evidence", "plan", "report"]),
  title: z.string().trim().min(1).max(160),
  mediaType: z.enum(["text/plain", "text/markdown", "application/json"]),
  content: z.string().min(1).max(32_000),
  contentSha256: sha256Schema,
  byteCount: z.number().int().min(1).max(64_000),
  evidenceIds: idListSchema,
  toolExecutionIds: idListSchema,
  createdAt: timestampSchema,
  boundary: boundarySchema,
}).strict().superRefine((value, context) => {
  const { artifactId, artifactSha256, ...body } = value;
  if (
    artifactId !== `delegation-artifact:${artifactSha256}` ||
    canonicalJsonSha256(body) !== artifactSha256 ||
    canonicalJsonSha256({ content: value.content }) !== value.contentSha256 ||
    Buffer.byteLength(value.content, "utf8") !== value.byteCount
  ) {
    context.addIssue({ code: "custom", path: ["artifactSha256"], message: "Shared mission artifact integrity is invalid." });
  }
  if (redactSensitive(value.content) !== value.content) {
    context.addIssue({ code: "custom", path: ["content"], message: "Shared mission artifacts cannot contain credential material." });
  }
});

export type SharedMissionArtifactV1 = Readonly<
  z.infer<typeof sharedMissionArtifactV1Schema>
>;

export function buildDelegationMessageV1(input: {
  task: DelegationTaskV1;
  missionId: string;
  recipients: DelegationMessageV1["recipients"];
  kind: DelegationMessageV1["kind"];
  body: string;
  artifactReferences?: DelegationMessageV1["artifactReferences"];
  inReplyToMessageId?: string | null;
  createdAt?: string;
}) {
  assertChannelSender(input.task);
  const bodyText = input.body.trim();
  const createdAt = channelTimestamp(input.task, input.createdAt);
  const body = {
    schemaVersion: 1 as const,
    version: DELEGATION_MESSAGE_VERSION,
    missionId: input.missionId,
    parentExecutionId: input.task.parentExecutionId,
    parentDelegationId: input.task.parentDelegationId,
    sender: taskSender(input.task),
    recipients: input.recipients,
    kind: input.kind,
    body: bodyText,
    bodySha256: canonicalJsonSha256({ body: bodyText }),
    artifactReferences: [...(input.artifactReferences || [])],
    inReplyToMessageId: input.inReplyToMessageId || null,
    createdAt,
    boundary: channelBoundary(),
  };
  const messageSha256 = canonicalJsonSha256(body);
  return deepFreeze(delegationMessageV1Schema.parse({
    ...body,
    messageId: `delegation-message:${messageSha256}`,
    messageSha256,
  }));
}

export function buildSharedMissionArtifactV1(input: {
  task: DelegationTaskV1;
  missionId: string;
  recipients: SharedMissionArtifactV1["recipients"];
  kind: SharedMissionArtifactV1["kind"];
  title: string;
  mediaType: SharedMissionArtifactV1["mediaType"];
  content: string;
  evidenceIds?: readonly string[];
  toolExecutionIds?: readonly string[];
  createdAt?: string;
}) {
  assertChannelSender(input.task);
  const createdAt = channelTimestamp(input.task, input.createdAt);
  const body = {
    schemaVersion: 1 as const,
    version: DELEGATION_SHARED_ARTIFACT_VERSION,
    missionId: input.missionId,
    parentExecutionId: input.task.parentExecutionId,
    parentDelegationId: input.task.parentDelegationId,
    sender: taskSender(input.task),
    recipients: input.recipients,
    kind: input.kind,
    title: input.title.trim(),
    mediaType: input.mediaType,
    content: input.content,
    contentSha256: canonicalJsonSha256({ content: input.content }),
    byteCount: Buffer.byteLength(input.content, "utf8"),
    evidenceIds: [...(input.evidenceIds || [])],
    toolExecutionIds: [...(input.toolExecutionIds || [])],
    createdAt,
    boundary: channelBoundary(),
  };
  const artifactSha256 = canonicalJsonSha256(body);
  return deepFreeze(sharedMissionArtifactV1Schema.parse({
    ...body,
    artifactId: `delegation-artifact:${artifactSha256}`,
    artifactSha256,
  }));
}

export function parseDelegationMessageV1(value: unknown) {
  return deepFreeze(delegationMessageV1Schema.parse(value));
}

export function parseSharedMissionArtifactV1(value: unknown) {
  return deepFreeze(sharedMissionArtifactV1Schema.parse(value));
}

function assertChannelSender(task: DelegationTaskV1) {
  if (!["working", "waiting", "challenged", "completed_proposed", "result_accepted"].includes(task.state)) {
    throw new Error("Delegation task cannot publish to its Mission channel in this state.");
  }
}

function channelTimestamp(task: DelegationTaskV1, value?: string) {
  const timestamp = timestampSchema.parse(value || new Date().toISOString());
  if (
    Date.parse(timestamp) < Date.parse(task.createdAt) ||
    Date.parse(timestamp) >= Date.parse(task.completeBy)
  ) throw new Error("Delegation channel timestamp is outside the task deadline.");
  return timestamp;
}

function taskSender(task: DelegationTaskV1) {
  return {
    taskId: task.taskId,
    delegationId: task.delegationId,
    principalId: task.delegatePrincipalId,
    agentId: task.delegateAgentId,
    definitionVersion: task.delegateDefinitionVersion,
  };
}

function channelBoundary() {
  return {
    contentIsUntrusted: true as const,
    mutatesStateDirectly: false as const,
    authorityImpact: "none" as const,
    privateMemoryIncluded: false as const,
    credentialMaterialIncluded: false as const,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
