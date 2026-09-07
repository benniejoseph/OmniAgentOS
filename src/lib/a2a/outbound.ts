import {
  createA2AClientV1,
  discoverExternalA2APeerV1,
  type A2AClientStreamEventV1,
} from "@/lib/a2a/client";
import { issueDelegatedA2ATokenV1 } from "@/lib/a2a/delegated-token";
import {
  getExternalA2ASafety,
  reserveExternalA2ASafety,
  touchExternalA2ASafety,
} from "@/lib/a2a/safety-store";
import type { A2ATaskMappingV1 } from "@/lib/a2a/task-mapping";
import {
  assertA2APeerRolloutActive,
  type A2APeerRolloutV1,
} from "@/lib/a2a/rollout";
import {
  appendA2AExchange,
  createA2ATaskMapping,
} from "@/lib/a2a/task-store";
import {
  a2aMessageV1Schema,
  parseA2ATaskV1,
  type A2AMessageV1,
  type A2ATaskV1,
} from "@/lib/a2a/v1-contracts";
import {
  getA2APeer,
  resolveA2APeerBearerToken,
} from "@/lib/a2a/store";
import {
  parseDelegationContractV1,
  type DelegationContractV1,
} from "@/lib/delegation/contracts";
import type { DelegationTaskV1 } from "@/lib/delegation/lifecycle";
import {
  getDelegationTask,
  transitionDelegationTask,
} from "@/lib/delegation/store";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const OUTBOUND_BOUNDARY_VERSION = "p8.6-a2a-outbound-delegation:1" as const;
const localAgentIds = ["atlas", "scout", "forge", "sentinel", "mnemosyne"] as const;
type LocalAgentId = (typeof localAgentIds)[number];

export class A2AOutboundError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 503 = 400,
  ) {
    super(message);
    this.name = "A2AOutboundError";
  }
}

export async function startExternalA2ATaskV1(input: {
  rollout: A2APeerRolloutV1;
  negotiatedSkillId: string;
  contract: DelegationContractV1;
  internalTask: DelegationTaskV1;
  parentExecutionScope: ExecutionScope;
  callbackBaseUrl?: string;
  abortSignal?: AbortSignal;
}) {
  const contract = parseDelegationContractV1(input.contract);
  const rollout = await verifyOutboundPeer(
    input.rollout,
    input.negotiatedSkillId,
    input.abortSignal,
  );
  assertContractAndTask(contract, input.internalTask, rollout);
  if (!["proposed", "accepted", "working"].includes(input.internalTask.state)) {
    throw new A2AOutboundError(
      "The canonical task cannot start an external delegation.",
      409,
    );
  }
  await reserveExternalA2ASafety({
    contract,
    internalTask: input.internalTask,
    rollout,
    executionScope: input.parentExecutionScope,
  });
  let task = await moveTaskToWorking(input.internalTask, input.parentExecutionScope);
  const issued = issueDelegatedA2ATokenV1({
    contract,
    internalTask: task,
    rollout,
    parentExecutionScope: input.parentExecutionScope,
  });
  const message = buildOutboundDelegationMessage({
    contract,
    rollout,
    negotiatedSkillId: input.negotiatedSkillId,
    token: issued,
    callbackBaseUrl: input.callbackBaseUrl,
  });
  let remoteTask: A2ATaskV1;
  try {
    const client = await outboundClient(rollout);
    remoteTask = await client.sendMessage(message, {
      acceptedOutputModes: ["application/json", "text/plain"],
      blocking: false,
      abortSignal: input.abortSignal,
    });
  } catch (error) {
    task = await waitAfterDispatchFailure(task, input.parentExecutionScope);
    await syncSafetyForTask({
      task,
      executionScope: input.parentExecutionScope,
      reason: "outbound_dispatch_failed",
    }).catch(() => undefined);
    throw new A2AOutboundError(
      error instanceof Error
        ? `The external A2A task could not be dispatched: ${error.message}`
        : "The external A2A task could not be dispatched.",
      503,
    );
  }
  const contextId = remoteTask.contextId || outboundContextId(
    rollout,
    contract,
  );
  const mapping = await createA2ATaskMapping({
    rollout,
    direction: "outbound",
    externalTaskId: remoteTask.id,
    externalContextId: contextId,
    internalTask: task,
    localAgentId: localDelegator(contract),
    localAgentDefinitionVersion: contract.delegator.definitionVersion,
    negotiatedSkillId: input.negotiatedSkillId,
    executionScope: input.parentExecutionScope,
  });
  await appendA2AExchange({
    mapping,
    direction: "outbound",
    payload: {
      type: "message",
      message: redactDelegatedToken({ ...message, contextId }),
    },
    executionScope: input.parentExecutionScope,
  });
  await recordRemoteTask(mapping, remoteTask, input.parentExecutionScope);
  task = await applyRemoteTaskObservation({
    mapping,
    task,
    remoteTask,
    parentExecutionScope: input.parentExecutionScope,
  });
  await syncSafetyForTask({
    task,
    executionScope: input.parentExecutionScope,
    reason: "remote_task_observed",
  });
  return { mapping, internalTask: task, remoteTask } as const;
}

export async function refreshExternalA2ATaskV1(input: {
  mapping: A2ATaskMappingV1;
  parentExecutionScope: ExecutionScope;
  abortSignal?: AbortSignal;
}) {
  const { rollout, task } = await loadOutboundAuthority(
    input.mapping,
    input.parentExecutionScope,
    input.abortSignal,
  );
  const client = await outboundClient(rollout);
  const remoteTask = await client.getTask(input.mapping.externalTaskId, {
    historyLength: 0,
    abortSignal: input.abortSignal,
  });
  assertRemoteCoordinates(input.mapping, remoteTask);
  await recordRemoteTask(input.mapping, remoteTask, input.parentExecutionScope);
  const internalTask = await applyRemoteTaskObservation({
    mapping: input.mapping,
    task,
    remoteTask,
    parentExecutionScope: input.parentExecutionScope,
  });
  await syncSafetyForTask({
    task: internalTask,
    executionScope: input.parentExecutionScope,
    reason: "remote_task_refreshed",
  });
  return { mapping: input.mapping, internalTask, remoteTask } as const;
}

export async function resumeExternalA2ATaskV1(input: {
  mapping: A2ATaskMappingV1;
  contract: DelegationContractV1;
  parentExecutionScope: ExecutionScope;
  parts: A2AMessageV1["parts"];
  callbackBaseUrl?: string;
  abortSignal?: AbortSignal;
}) {
  const contract = parseDelegationContractV1(input.contract);
  const authority = await loadOutboundAuthority(
    input.mapping,
    input.parentExecutionScope,
    input.abortSignal,
  );
  assertContractAndTask(contract, authority.task, authority.rollout);
  let task = authority.task;
  if (["waiting", "challenged"].includes(task.state)) {
    task = await transitionDelegationTask({
      taskId: task.taskId,
      tenantId: task.tenantId,
      expectedRevision: task.lifecycleRevision,
      transition: { to: "working" },
      parentExecutionScope: input.parentExecutionScope,
    });
  }
  if (task.state !== "working") {
    throw new A2AOutboundError("Only a waiting or challenged external task can be resumed.", 409);
  }
  const issued = issueDelegatedA2ATokenV1({
    contract,
    internalTask: task,
    rollout: authority.rollout,
    parentExecutionScope: input.parentExecutionScope,
  });
  const base = buildOutboundDelegationMessage({
    contract,
    rollout: authority.rollout,
    negotiatedSkillId: input.mapping.negotiatedSkillId,
    token: issued,
    callbackBaseUrl: input.callbackBaseUrl,
    messageIdSuffix: `resume:${task.lifecycleRevision}`,
  });
  const message = a2aMessageV1Schema.parse({
    ...base,
    taskId: input.mapping.externalTaskId,
    contextId: input.mapping.externalContextId,
    parts: input.parts,
  });
  const client = await outboundClient(authority.rollout);
  const remoteTask = await client.sendMessage(message, {
    acceptedOutputModes: ["application/json", "text/plain"],
    blocking: false,
    abortSignal: input.abortSignal,
  });
  assertRemoteCoordinates(input.mapping, remoteTask);
  await appendA2AExchange({
    mapping: input.mapping,
    direction: "outbound",
    payload: { type: "message", message: redactDelegatedToken(message) },
    executionScope: input.parentExecutionScope,
  });
  await recordRemoteTask(input.mapping, remoteTask, input.parentExecutionScope);
  task = await applyRemoteTaskObservation({
    mapping: input.mapping,
    task,
    remoteTask,
    parentExecutionScope: input.parentExecutionScope,
  });
  await syncSafetyForTask({
    task,
    executionScope: input.parentExecutionScope,
    reason: "remote_task_resumed",
  });
  return { mapping: input.mapping, internalTask: task, remoteTask } as const;
}

export async function cancelExternalA2ATaskV1(input: {
  mapping: A2ATaskMappingV1;
  parentExecutionScope: ExecutionScope;
  abortSignal?: AbortSignal;
}) {
  const { rollout, task } = await loadOutboundAuthority(
    input.mapping,
    input.parentExecutionScope,
    input.abortSignal,
  );
  if (isTerminalInternalState(task.state)) {
    throw new A2AOutboundError("The external delegation is already terminal.", 409);
  }
  const client = await outboundClient(rollout);
  const remoteTask = await client.cancelTask(
    input.mapping.externalTaskId,
    input.abortSignal,
  );
  assertRemoteCoordinates(input.mapping, remoteTask);
  await recordRemoteTask(input.mapping, remoteTask, input.parentExecutionScope);
  const internalTask = await transitionDelegationTask({
    taskId: task.taskId,
    tenantId: task.tenantId,
    expectedRevision: task.lifecycleRevision,
    transition: {
      to: "canceled",
      initiator: "parent",
      reason: "The parent canceled the external A2A delegation.",
    },
    parentExecutionScope: input.parentExecutionScope,
  });
  await syncSafetyForTask({
    task: internalTask,
    executionScope: input.parentExecutionScope,
    reason: "parent_canceled",
  });
  return { mapping: input.mapping, internalTask, remoteTask } as const;
}

export async function* subscribeExternalA2ATaskV1(input: {
  mapping: A2ATaskMappingV1;
  parentExecutionScope: ExecutionScope;
  abortSignal?: AbortSignal;
}) {
  const { rollout } = await loadOutboundAuthority(
    input.mapping,
    input.parentExecutionScope,
    input.abortSignal,
  );
  const client = await outboundClient(rollout);
  for await (const event of client.subscribeToTask(
    input.mapping.externalTaskId,
    input.abortSignal,
  )) {
    await recordStreamEvent(input.mapping, event, input.parentExecutionScope);
    if (event.type === "task") {
      assertRemoteCoordinates(input.mapping, event.task);
      const task = await getDelegationTask({
        tenantId: input.mapping.tenantId,
        ownerActorId: input.mapping.ownerActorId,
        taskId: input.mapping.internalTaskId,
      });
      const observed = await applyRemoteTaskObservation({
        mapping: input.mapping,
        task,
        remoteTask: event.task,
        parentExecutionScope: input.parentExecutionScope,
      });
      await syncSafetyForTask({
        task: observed,
        executionScope: input.parentExecutionScope,
        reason: "remote_stream_task_observed",
      });
    } else {
      await touchExternalA2ASafety({
        tenantId: input.mapping.tenantId,
        ownerActorId: input.mapping.ownerActorId,
        internalTaskId: input.mapping.internalTaskId,
        executionScope: input.parentExecutionScope,
        reason: "remote_stream_progress",
      });
    }
    yield event;
  }
}

async function verifyOutboundPeer(
  rolloutInput: A2APeerRolloutV1,
  negotiatedSkillId: string,
  abortSignal?: AbortSignal,
) {
  const rollout = assertA2APeerRolloutActive({
    rollout: rolloutInput,
    direction: "outbound",
  });
  if (!rollout.allowedSkillIds.includes(negotiatedSkillId)) {
    throw new A2AOutboundError("The requested A2A skill is outside the peer rollout.", 403);
  }
  const discovered = await discoverExternalA2APeerV1({
    baseUrl: rollout.interfaceUrl,
    abortSignal,
  });
  if (
    discovered.cardSha256 !== rollout.agentCardSha256 ||
    normalizeInterface(discovered.selectedInterface.url) !== rollout.interfaceUrl ||
    !discovered.card.skills.some((skill) => skill.id === negotiatedSkillId)
  ) {
    throw new A2AOutboundError(
      "The live A2A Agent Card no longer matches the reviewed peer rollout.",
      409,
    );
  }
  return rollout;
}

async function outboundClient(rollout: A2APeerRolloutV1) {
  const bearerToken = await resolveA2APeerBearerToken({
    tenantId: rollout.tenantId,
    ownerActorId: rollout.ownerActorId,
    rolloutId: rollout.rolloutId,
  });
  return createA2AClientV1({ rollout, bearerToken });
}

async function loadOutboundAuthority(
  mapping: A2ATaskMappingV1,
  parentExecutionScope: ExecutionScope,
  abortSignal?: AbortSignal,
) {
  assertParentScope(mapping, parentExecutionScope);
  if (mapping.direction !== "outbound") {
    throw new A2AOutboundError("The A2A task mapping is not outbound.", 409);
  }
  const rollout = await verifyOutboundPeer(
    await getA2APeer({
      tenantId: mapping.tenantId,
      ownerActorId: mapping.ownerActorId,
      rolloutId: mapping.rolloutId,
    }),
    mapping.negotiatedSkillId,
    abortSignal,
  );
  if (
    rollout.rolloutSha256 !== mapping.rolloutSha256 ||
    rollout.peerId !== mapping.peerId ||
    !rollout.allowedSkillIds.includes(mapping.negotiatedSkillId)
  ) {
    throw new A2AOutboundError("The A2A task no longer matches its active peer rollout.", 403);
  }
  const task = await getDelegationTask({
    tenantId: mapping.tenantId,
    ownerActorId: mapping.ownerActorId,
    taskId: mapping.internalTaskId,
  });
  if (
    task.delegationId !== mapping.internalDelegationId ||
    task.contractSha256 !== mapping.internalContractSha256
  ) {
    throw new A2AOutboundError("The A2A task mapping no longer matches its canonical task.", 409);
  }
  const safety = await getExternalA2ASafety({
    tenantId: mapping.tenantId,
    ownerActorId: mapping.ownerActorId,
    internalTaskId: mapping.internalTaskId,
  });
  if (
    safety.reservation.peerId !== mapping.peerId ||
    safety.reservation.rolloutId !== mapping.rolloutId ||
    safety.reservation.rolloutSha256 !== mapping.rolloutSha256 ||
    safety.reservation.contractSha256 !== mapping.internalContractSha256
  ) {
    throw new A2AOutboundError(
      "The A2A task no longer matches its external safety authority.",
      403,
    );
  }
  if (!isTerminalInternalState(task.state) && task.state !== "completed_proposed") {
    await touchExternalA2ASafety({
      tenantId: mapping.tenantId,
      ownerActorId: mapping.ownerActorId,
      internalTaskId: mapping.internalTaskId,
      executionScope: parentExecutionScope,
      reason: "outbound_operation_started",
    });
  }
  return { rollout, task, safety } as const;
}

function buildOutboundDelegationMessage(input: {
  contract: DelegationContractV1;
  rollout: A2APeerRolloutV1;
  negotiatedSkillId: string;
  token: ReturnType<typeof issueDelegatedA2ATokenV1>;
  callbackBaseUrl?: string;
  messageIdSuffix?: string;
}) {
  const callbackUrl = new URL(
    "api/a2a/delegated-tools/execute",
    trailingSlash(callbackBaseUrl(input.callbackBaseUrl)),
  );
  if (callbackUrl.protocol !== "https:" || callbackUrl.username || callbackUrl.password) {
    throw new A2AOutboundError("The delegated tool callback must use credential-free HTTPS.", 503);
  }
  return a2aMessageV1Schema.parse({
    messageId: `a2a-message:${canonicalJsonSha256({
      contractSha256: input.contract.contractSha256,
      rolloutSha256: input.rollout.rolloutSha256,
      negotiatedSkillId: input.negotiatedSkillId,
      suffix: input.messageIdSuffix || "start",
    })}`,
    contextId: outboundContextId(input.rollout, input.contract),
    role: "ROLE_USER",
    parts: [
      { text: input.contract.objective, mediaType: "text/plain" },
      {
        data: {
          acceptanceCriteria: input.contract.acceptanceCriteria,
          inputArtifacts: input.contract.inputArtifacts,
          output: {
            schemaId: input.contract.output.schemaId,
            schemaVersion: input.contract.output.schemaVersion,
            schemaSha256: input.contract.output.schemaSha256,
            artifactKinds: input.contract.output.artifactKinds,
            maxArtifacts: input.contract.output.maxArtifacts,
            maxBytes: input.contract.output.maxBytes,
          },
          contentDisposition: "untrusted_external_input",
        },
        mediaType: "application/json",
      },
    ],
    metadata: {
      boundaryVersion: OUTBOUND_BOUNDARY_VERSION,
      negotiatedSkillId: input.negotiatedSkillId,
      internalTaskRef: input.token.envelope.internalTaskId,
      internalDelegationRef: input.contract.delegationId,
      contractSha256: input.contract.contractSha256,
      rolloutId: input.rollout.rolloutId,
      rolloutSha256: input.rollout.rolloutSha256,
      upstreamCredentialMaterialIncluded: false,
      delegatedToolGateway: {
        url: callbackUrl.toString(),
        bearerToken: input.token.token,
        tokenId: input.token.envelope.tokenId,
        tokenSha256: input.token.envelope.tokenSha256,
        expiresAt: input.token.envelope.expiresAt,
        audience: input.token.envelope.audience,
      },
    },
  });
}

function redactDelegatedToken(message: A2AMessageV1) {
  const metadata = structuredClone(message.metadata || {});
  const gateway = metadata.delegatedToolGateway;
  if (gateway && typeof gateway === "object" && !Array.isArray(gateway)) {
    delete (gateway as Record<string, unknown>).bearerToken;
  }
  return a2aMessageV1Schema.parse({ ...message, metadata });
}

async function moveTaskToWorking(
  taskInput: DelegationTaskV1,
  parentExecutionScope: ExecutionScope,
) {
  let task = taskInput;
  if (task.state === "proposed") {
    task = await transitionDelegationTask({
      taskId: task.taskId,
      tenantId: task.tenantId,
      expectedRevision: task.lifecycleRevision,
      transition: { to: "accepted" },
      parentExecutionScope,
    });
  }
  if (task.state === "accepted") {
    task = await transitionDelegationTask({
      taskId: task.taskId,
      tenantId: task.tenantId,
      expectedRevision: task.lifecycleRevision,
      transition: { to: "working" },
      parentExecutionScope,
    });
  }
  if (task.state !== "working") {
    throw new A2AOutboundError("The canonical task cannot start an external delegation.", 409);
  }
  return task;
}

async function waitAfterDispatchFailure(
  task: DelegationTaskV1,
  parentExecutionScope: ExecutionScope,
) {
  if (task.state !== "working") return task;
  try {
    return await transitionDelegationTask({
      taskId: task.taskId,
      tenantId: task.tenantId,
      expectedRevision: task.lifecycleRevision,
      transition: { to: "waiting", reason: "dependency" },
      parentExecutionScope,
    });
  } catch {
    return task;
  }
}

async function recordRemoteTask(
  mapping: A2ATaskMappingV1,
  remoteTaskInput: A2ATaskV1,
  executionScope: ExecutionScope,
) {
  const remoteTask = parseA2ATaskV1(remoteTaskInput);
  assertRemoteCoordinates(mapping, remoteTask);
  await appendA2AExchange({
    mapping,
    direction: "inbound",
    payload: { type: "status", status: remoteTask.status },
    executionScope,
  });
  for (const artifact of remoteTask.artifacts || []) {
    await appendA2AExchange({
      mapping,
      direction: "inbound",
      payload: { type: "artifact", artifact },
      executionScope,
    });
  }
  for (const message of remoteTask.history || []) {
    assertRemoteMessageCoordinates(mapping, message);
    await appendA2AExchange({
      mapping,
      direction: "inbound",
      payload: { type: "message", message },
      executionScope,
    });
  }
}

async function recordStreamEvent(
  mapping: A2ATaskMappingV1,
  event: A2AClientStreamEventV1,
  executionScope: ExecutionScope,
) {
  if (!event) return;
  if (event.type === "task") {
    await recordRemoteTask(mapping, event.task, executionScope);
  } else if (event.type === "message") {
    assertRemoteMessageCoordinates(mapping, event.message);
    await appendA2AExchange({
      mapping,
      direction: "inbound",
      payload: { type: "message", message: event.message },
      executionScope,
    });
  } else if (event.type === "status") {
    assertStreamCoordinates(
      mapping,
      event.statusUpdate.taskId,
      event.statusUpdate.contextId,
    );
    await appendA2AExchange({
      mapping,
      direction: "inbound",
      payload: { type: "status", status: event.statusUpdate.status },
      executionScope,
    });
  } else {
    assertStreamCoordinates(
      mapping,
      event.artifactUpdate.taskId,
      event.artifactUpdate.contextId,
    );
    await appendA2AExchange({
      mapping,
      direction: "inbound",
      payload: { type: "artifact", artifact: event.artifactUpdate.artifact },
      executionScope,
    });
  }
}

async function applyRemoteTaskObservation(input: {
  mapping: A2ATaskMappingV1;
  task: DelegationTaskV1;
  remoteTask: A2ATaskV1;
  parentExecutionScope: ExecutionScope;
}) {
  let task = input.task;
  const state = input.remoteTask.status.state;
  if (isTerminalInternalState(task.state)) return task;
  if (task.state === "completed_proposed" && state === "TASK_STATE_COMPLETED") {
    return task;
  }
  if (["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"].includes(state)) {
    if (task.state === "working") {
      task = await transitionDelegationTask({
        taskId: task.taskId,
        tenantId: task.tenantId,
        expectedRevision: task.lifecycleRevision,
        transition: {
          to: "waiting",
          reason: state === "TASK_STATE_AUTH_REQUIRED"
            ? "dependency"
            : "clarification_required",
        },
        parentExecutionScope: input.parentExecutionScope,
      });
    }
    return task;
  }
  if (state === "TASK_STATE_CANCELED") {
    return transitionDelegationTask({
      taskId: task.taskId,
      tenantId: task.tenantId,
      expectedRevision: task.lifecycleRevision,
      transition: {
        to: "canceled",
        initiator: "system",
        reason: "The external A2A peer reported cancellation.",
      },
      parentExecutionScope: input.parentExecutionScope,
    });
  }
  if (["TASK_STATE_FAILED", "TASK_STATE_REJECTED"].includes(state)) {
    if (task.state === "challenged") return task;
    task = await ensureWorking(task, input.parentExecutionScope);
    return transitionDelegationTask({
      taskId: task.taskId,
      tenantId: task.tenantId,
      expectedRevision: task.lifecycleRevision,
      transition: {
        to: "challenged",
        reason: "The untrusted external A2A peer reported a non-success outcome.",
        challengeSha256: canonicalJsonSha256({
          mappingSha256: input.mapping.mappingSha256,
          remoteTask: input.remoteTask,
        }),
      },
      parentExecutionScope: input.parentExecutionScope,
    });
  }
  if (state === "TASK_STATE_COMPLETED") {
    task = await ensureWorking(task, input.parentExecutionScope);
    const remoteTaskSha256 = canonicalJsonSha256(input.remoteTask);
    return transitionDelegationTask({
      taskId: task.taskId,
      tenantId: task.tenantId,
      expectedRevision: task.lifecycleRevision,
      transition: {
        to: "completed_proposed",
        proposalReceiptSha256: canonicalJsonSha256({
          boundaryVersion: OUTBOUND_BOUNDARY_VERSION,
          mappingSha256: input.mapping.mappingSha256,
          remoteTaskSha256,
          disposition: "observation_until_parent_verification",
        }),
        acceptanceChecksSha256: canonicalJsonSha256({
          remoteTaskSha256,
          schemaParsed: true,
          independentVerificationComplete: false,
          authorityImpact: "none",
        }),
        artifactSha256s: (input.remoteTask.artifacts || []).map(canonicalJsonSha256),
        evidenceIds: [input.mapping.mappingId],
        toolExecutionIds: [],
      },
      parentExecutionScope: input.parentExecutionScope,
    });
  }
  return task;
}

async function ensureWorking(taskInput: DelegationTaskV1, scope: ExecutionScope) {
  if (taskInput.state === "working" || taskInput.state === "challenged") return taskInput;
  if (taskInput.state !== "waiting") {
    throw new A2AOutboundError("The remote observation conflicts with the canonical task state.", 409);
  }
  return transitionDelegationTask({
    taskId: taskInput.taskId,
    tenantId: taskInput.tenantId,
    expectedRevision: taskInput.lifecycleRevision,
    transition: { to: "working" },
    parentExecutionScope: scope,
  });
}

function assertContractAndTask(
  contract: DelegationContractV1,
  task: DelegationTaskV1,
  rollout: A2APeerRolloutV1,
) {
  if (
    task.tenantId !== contract.scope.tenantId ||
    task.ownerActorId !== contract.scope.initiatingActorId ||
    task.contractSha256 !== contract.contractSha256 ||
    task.delegationId !== contract.delegationId ||
    rollout.tenantId !== contract.scope.tenantId ||
    rollout.ownerActorId !== contract.scope.initiatingActorId
  ) {
    throw new A2AOutboundError("The external delegation is outside its canonical scope.", 403);
  }
}

async function syncSafetyForTask(input: {
  task: DelegationTaskV1;
  executionScope: ExecutionScope;
  reason: string;
}) {
  const status = input.task.state === "completed_proposed" ||
      input.task.state === "result_accepted"
    ? "completed"
    : input.task.state === "challenged" || input.task.state === "rejected"
      ? "challenged"
      : input.task.state === "canceled"
        ? "canceled"
        : input.task.state === "expired"
          ? "expired"
          : "active";
  return touchExternalA2ASafety({
    tenantId: input.task.tenantId,
    ownerActorId: input.task.ownerActorId,
    internalTaskId: input.task.taskId,
    executionScope: input.executionScope,
    status,
    reason: input.reason,
  });
}

function assertParentScope(mapping: A2ATaskMappingV1, scope: ExecutionScope) {
  if (
    scope.tenantId !== mapping.tenantId ||
    scope.initiatingActorId !== mapping.ownerActorId
  ) {
    throw new A2AOutboundError("The external A2A operation is outside its parent scope.", 403);
  }
}

function assertRemoteCoordinates(mapping: A2ATaskMappingV1, task: A2ATaskV1) {
  if (
    task.id !== mapping.externalTaskId ||
    (task.contextId && task.contextId !== mapping.externalContextId)
  ) {
    throw new A2AOutboundError("The A2A peer returned different task coordinates.", 409);
  }
}

function assertRemoteMessageCoordinates(
  mapping: A2ATaskMappingV1,
  message: A2AMessageV1,
) {
  if (
    (message.taskId && message.taskId !== mapping.externalTaskId) ||
    (message.contextId && message.contextId !== mapping.externalContextId)
  ) {
    throw new A2AOutboundError("The A2A peer mixed message task coordinates.", 409);
  }
}

function assertStreamCoordinates(
  mapping: A2ATaskMappingV1,
  taskId: string,
  contextId?: string,
) {
  if (
    taskId !== mapping.externalTaskId ||
    (contextId && contextId !== mapping.externalContextId)
  ) {
    throw new A2AOutboundError("The A2A peer mixed stream task coordinates.", 409);
  }
}

function localDelegator(contract: DelegationContractV1): LocalAgentId {
  if (!localAgentIds.includes(contract.delegator.agentId as LocalAgentId)) {
    throw new A2AOutboundError("External delegation requires a canonical local delegator.", 409);
  }
  return contract.delegator.agentId as LocalAgentId;
}

function callbackBaseUrl(explicit?: string) {
  const value = explicit || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!value) throw new A2AOutboundError("NEXT_PUBLIC_APP_URL is required for delegated callbacks.", 503);
  return value;
}

function outboundContextId(
  rollout: A2APeerRolloutV1,
  contract: DelegationContractV1,
) {
  return `a2a-context:${canonicalJsonSha256({
    tenantId: rollout.tenantId,
    peerId: rollout.peerId,
    rolloutId: rollout.rolloutId,
    delegationId: contract.delegationId,
  })}`;
}

function normalizeInterface(value: string) {
  const url = new URL(value);
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function trailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function isTerminalInternalState(value: DelegationTaskV1["state"]) {
  return ["result_accepted", "rejected", "canceled", "expired"].includes(value);
}
