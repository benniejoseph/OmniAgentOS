import {
  buildDelegationMessageV1,
  buildSharedMissionArtifactV1,
  parseDelegationMessageV1,
  parseSharedMissionArtifactV1,
  type DelegationMessageV1,
  type SharedMissionArtifactV1,
} from "@/lib/delegation/channel";
import type { DelegationTaskV1 } from "@/lib/delegation/lifecycle";
import {
  delegationTaskPersistenceAvailable,
  listDelegationTasksForExecution,
} from "@/lib/delegation/store";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  listMissionArtifacts,
  recordMissionArtifact,
} from "@/lib/missions/store";
import type { MissionArtifact } from "@/lib/missions/types";
import {
  deriveExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

export type DelegationChannelRecord =
  | Readonly<{ type: "message"; value: DelegationMessageV1 }>
  | Readonly<{ type: "artifact"; value: SharedMissionArtifactV1 }>;

export async function shareDelegationMissionArtifact(input: {
  task: DelegationTaskV1;
  parentExecutionScope: ExecutionScope;
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
  assertChannelScope(input.task, input.parentExecutionScope, input.missionId);
  await validateRecipientTasks(
    input.task,
    input.recipients.delegationTaskIds,
  );
  const artifact = buildSharedMissionArtifactV1({
    task: input.task,
    missionId: input.missionId,
    recipients: input.recipients,
    kind: input.kind,
    title: input.title,
    mediaType: input.mediaType,
    content: input.content,
    evidenceIds: input.evidenceIds,
    toolExecutionIds: input.toolExecutionIds,
    createdAt: input.createdAt,
  });
  const executionScope = channelExecutionScope(
    input.task,
    input.parentExecutionScope,
    artifact.artifactId,
    "delegation.channel.artifact.share",
  );
  const saved = await recordMissionArtifact({
    tenantId: input.task.tenantId,
    actorId: input.task.ownerActorId,
    executionScope,
    idempotencyKey: artifact.artifactSha256,
    missionId: input.missionId,
    sourceKey: artifact.artifactId,
    kind: "delegation_shared_artifact",
    title: artifact.title,
    mimeType: artifact.mediaType,
    data: { protocol: artifact },
  });
  const persisted = parseSharedMissionArtifactV1(saved.data.protocol);
  if (persisted.artifactSha256 !== artifact.artifactSha256) {
    throw new Error("Shared mission artifact idempotency key is already bound.");
  }
  await appendChannelEvent({
    id: `delegation-artifact-shared:${artifact.artifactSha256}`,
    type: "delegation.artifact.shared",
    missionId: input.missionId,
    task: input.task,
    executionScope,
    digest: artifact.artifactSha256,
    recipientParent: artifact.recipients.parent,
    recipientTaskIds: artifact.recipients.delegationTaskIds,
    toolExecutionIds: artifact.toolExecutionIds,
  });
  return persisted;
}

export async function sendDelegationMessage(input: {
  task: DelegationTaskV1;
  parentExecutionScope: ExecutionScope;
  missionId: string;
  recipients: DelegationMessageV1["recipients"];
  kind: DelegationMessageV1["kind"];
  body: string;
  artifactReferences?: DelegationMessageV1["artifactReferences"];
  inReplyToMessageId?: string | null;
  createdAt?: string;
}) {
  assertChannelScope(input.task, input.parentExecutionScope, input.missionId);
  await validateRecipientTasks(
    input.task,
    input.recipients.delegationTaskIds,
  );
  await validateArtifactReferences(input);
  const message = buildDelegationMessageV1({
    task: input.task,
    missionId: input.missionId,
    recipients: input.recipients,
    kind: input.kind,
    body: input.body,
    artifactReferences: input.artifactReferences,
    inReplyToMessageId: input.inReplyToMessageId,
    createdAt: input.createdAt,
  });
  const executionScope = channelExecutionScope(
    input.task,
    input.parentExecutionScope,
    message.messageId,
    "delegation.channel.message.send",
  );
  const saved = await recordMissionArtifact({
    tenantId: input.task.tenantId,
    actorId: input.task.ownerActorId,
    executionScope,
    idempotencyKey: message.messageSha256,
    missionId: input.missionId,
    sourceKey: message.messageId,
    kind: "delegation_message",
    title: `${input.task.delegateAgentId} · ${message.kind}`,
    mimeType: "text/plain",
    data: { protocol: message },
  });
  const persisted = parseDelegationMessageV1(saved.data.protocol);
  if (persisted.messageSha256 !== message.messageSha256) {
    throw new Error("Delegation message idempotency key is already bound.");
  }
  await appendChannelEvent({
    id: `delegation-message-sent:${message.messageSha256}`,
    type: "delegation.message.sent",
    missionId: input.missionId,
    task: input.task,
    executionScope,
    digest: message.messageSha256,
    recipientParent: message.recipients.parent,
    recipientTaskIds: message.recipients.delegationTaskIds,
    artifactIds: message.artifactReferences.map((reference) =>
      reference.artifactId
    ),
  });
  return persisted;
}

export async function listDelegationChannelForTask(input: {
  task: DelegationTaskV1;
  parentExecutionScope: ExecutionScope;
  missionId: string;
}) {
  assertChannelScope(input.task, input.parentExecutionScope, input.missionId);
  const records = await readMissionChannel(
    input.missionId,
    input.task.tenantId,
    input.task.ownerActorId,
  );
  return records.filter((record) => {
    const value = record.value;
    return value.sender.taskId === input.task.taskId ||
      value.recipients.delegationTaskIds.includes(input.task.taskId);
  });
}

export async function listDelegationChannelForParent(input: {
  tenantId: string;
  ownerActorId: string;
  parentExecutionId: string;
  missionId: string;
}) {
  const records = await readMissionChannel(
    input.missionId,
    input.tenantId,
    input.ownerActorId,
  );
  return records.filter((record) =>
    record.value.parentExecutionId === input.parentExecutionId &&
    record.value.recipients.parent
  );
}

async function readMissionChannel(
  missionId: string,
  tenantId: string,
  ownerActorId: string,
) {
  const artifacts = await listMissionArtifacts(
    missionId,
    { tenantId, actorId: ownerActorId },
    500,
  );
  return artifacts.flatMap(parseMissionChannelArtifact)
    .sort((left, right) =>
      left.value.createdAt.localeCompare(right.value.createdAt)
    );
}

function parseMissionChannelArtifact(
  artifact: MissionArtifact,
): DelegationChannelRecord[] {
  try {
    if (artifact.kind === "delegation_message") {
      return [{ type: "message", value: parseDelegationMessageV1(artifact.data.protocol) }];
    }
    if (artifact.kind === "delegation_shared_artifact") {
      return [{ type: "artifact", value: parseSharedMissionArtifactV1(artifact.data.protocol) }];
    }
  } catch {
    // Mission artifacts are untrusted input. A malformed channel record cannot
    // make the rest of the scoped channel unreadable.
  }
  return [];
}

async function validateRecipientTasks(
  sender: DelegationTaskV1,
  recipientTaskIds: readonly string[],
) {
  if (!recipientTaskIds.length) return;
  if (!delegationTaskPersistenceAvailable()) {
    throw new Error("Sibling delegation recipients require the canonical task ledger.");
  }
  const tasks = await listDelegationTasksForExecution({
    tenantId: sender.tenantId,
    ownerActorId: sender.ownerActorId,
    parentExecutionId: sender.parentExecutionId,
  });
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  for (const taskId of recipientTaskIds) {
    const recipient = byId.get(taskId);
    if (
      !recipient ||
      recipient.taskId === sender.taskId ||
      recipient.parentPrincipalId !== sender.parentPrincipalId ||
      recipient.parentDelegationId !== sender.parentDelegationId ||
      ["rejected", "canceled", "expired"].includes(recipient.state)
    ) {
      throw new Error("Delegation channel recipient is not an active sibling task.");
    }
  }
}

async function validateArtifactReferences(input: {
  task: DelegationTaskV1;
  missionId: string;
  artifactReferences?: DelegationMessageV1["artifactReferences"];
}) {
  if (!input.artifactReferences?.length) return;
  const records = await readMissionChannel(
    input.missionId,
    input.task.tenantId,
    input.task.ownerActorId,
  );
  const readable = new Map(records.flatMap((record) => {
    if (record.type !== "artifact") return [];
    const value = record.value;
    const allowed = value.sender.taskId === input.task.taskId ||
      value.recipients.delegationTaskIds.includes(input.task.taskId);
    return allowed ? [[value.artifactId, value.artifactSha256] as const] : [];
  }));
  for (const reference of input.artifactReferences) {
    if (readable.get(reference.artifactId) !== reference.artifactSha256) {
      throw new Error("Delegation message references an unavailable shared artifact.");
    }
  }
}

function assertChannelScope(
  task: DelegationTaskV1,
  scope: ExecutionScope,
  missionId: string,
) {
  if (
    scope.tenantId !== task.tenantId ||
    scope.initiatingActorId !== task.ownerActorId ||
    scope.executingPrincipalId !== task.parentPrincipalId ||
    scope.delegationId !== task.parentDelegationId ||
    scope.missionId !== missionId ||
    task.parentExecutionId.trim().length === 0
  ) {
    throw new Error("Delegation Mission channel does not match its parent scope.");
  }
}

function channelExecutionScope(
  task: DelegationTaskV1,
  parent: ExecutionScope,
  causationId: string,
  purpose: string,
) {
  return deriveExecutionScope(parent, {
    executingPrincipalType: "agent",
    executingPrincipalId: task.delegatePrincipalId,
    delegationId: task.delegationId,
    causationId,
    purpose,
  });
}

function appendChannelEvent(input: {
  id: string;
  type: "delegation.message.sent" | "delegation.artifact.shared";
  missionId: string;
  task: DelegationTaskV1;
  executionScope: ExecutionScope;
  digest: string;
  recipientParent: boolean;
  recipientTaskIds: readonly string[];
  artifactIds?: readonly string[];
  toolExecutionIds?: readonly string[];
}) {
  return appendScopedDomainEvent({
    id: input.id,
    streamId: `delegation:${input.task.delegationId}`,
    type: input.type,
    payload: {
      schemaVersion: 1,
      missionId: input.missionId,
      parentExecutionId: input.task.parentExecutionId,
      parentDelegationId: input.task.parentDelegationId,
      taskId: input.task.taskId,
      delegationId: input.task.delegationId,
      delegatePrincipalId: input.task.delegatePrincipalId,
      delegateAgentId: input.task.delegateAgentId,
      delegateDefinitionVersion: input.task.delegateDefinitionVersion,
      recordSha256: input.digest,
      recipientParent: input.recipientParent,
      recipientTaskIds: input.recipientTaskIds,
      artifactIds: input.artifactIds || [],
      toolExecutionIds: input.toolExecutionIds || [],
    },
    executionScope: input.executionScope,
  });
}
