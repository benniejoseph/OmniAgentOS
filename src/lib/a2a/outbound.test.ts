import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createA2AClientV1: vi.fn(),
  discoverExternalA2APeerV1: vi.fn(),
  issueDelegatedA2ATokenV1: vi.fn(),
  appendA2AExchange: vi.fn(),
  createA2ATaskMapping: vi.fn(),
  getA2APeer: vi.fn(),
  resolveA2APeerBearerToken: vi.fn(),
  getDelegationTask: vi.fn(),
  transitionDelegationTask: vi.fn(),
}));

vi.mock("@/lib/a2a/client", () => ({
  createA2AClientV1: mocks.createA2AClientV1,
  discoverExternalA2APeerV1: mocks.discoverExternalA2APeerV1,
}));
vi.mock("@/lib/a2a/delegated-token", () => ({
  issueDelegatedA2ATokenV1: mocks.issueDelegatedA2ATokenV1,
}));
vi.mock("@/lib/a2a/task-store", () => ({
  appendA2AExchange: mocks.appendA2AExchange,
  createA2ATaskMapping: mocks.createA2ATaskMapping,
}));
vi.mock("@/lib/a2a/store", () => ({
  getA2APeer: mocks.getA2APeer,
  resolveA2APeerBearerToken: mocks.resolveA2APeerBearerToken,
}));
vi.mock("@/lib/delegation/store", () => ({
  getDelegationTask: mocks.getDelegationTask,
  transitionDelegationTask: mocks.transitionDelegationTask,
}));

import {
  cancelExternalA2ATaskV1,
  resumeExternalA2ATaskV1,
  startExternalA2ATaskV1,
  subscribeExternalA2ATaskV1,
} from "@/lib/a2a/outbound";
import {
  buildA2APeerRolloutV1,
  transitionA2APeerRolloutV1,
} from "@/lib/a2a/rollout";
import { buildA2ATaskMappingV1 } from "@/lib/a2a/task-mapping";
import {
  buildDelegationTaskV1,
  transitionDelegationTaskV1,
  type DelegationTaskV1,
} from "@/lib/delegation/lifecycle";
import { buildContract } from "@/lib/delegation/test-fixtures";
import { createExecutionScope } from "@/lib/security/execution-scope";

describe("outbound A2A adapter", () => {
  let canonicalTask: DelegationTaskV1;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T06:00:30.000Z"));
    for (const mock of Object.values(mocks)) mock.mockReset();
    canonicalTask = buildDelegationTaskV1(buildContract());
    mocks.discoverExternalA2APeerV1.mockResolvedValue(discovery());
    mocks.resolveA2APeerBearerToken.mockResolvedValue("peer-bearer");
    mocks.issueDelegatedA2ATokenV1.mockReturnValue(delegatedToken());
    mocks.appendA2AExchange.mockImplementation(async (input) => input);
    mocks.transitionDelegationTask.mockImplementation(async (input) => {
      expect(input.expectedRevision).toBe(canonicalTask.lifecycleRevision);
      canonicalTask = transitionDelegationTaskV1({
        task: canonicalTask,
        transition: input.transition,
      }).task;
      return canonicalTask;
    });
    mocks.createA2ATaskMapping.mockImplementation(async (input) => {
      return buildA2ATaskMappingV1({
        tenantId: input.rollout.tenantId,
        ownerActorId: input.rollout.ownerActorId,
        peerId: input.rollout.peerId,
        rolloutId: input.rollout.rolloutId,
        rolloutSha256: input.rollout.rolloutSha256,
        direction: input.direction,
        externalTaskId: input.externalTaskId,
        externalContextId: input.externalContextId,
        internalTaskId: input.internalTask.taskId,
        internalDelegationId: input.internalTask.delegationId,
        internalContractSha256: input.internalTask.contractSha256,
        localAgentId: input.localAgentId,
        localAgentDefinitionVersion: input.localAgentDefinitionVersion,
        negotiatedSkillId: input.negotiatedSkillId,
        createdAt: "2026-09-07T06:00:31.000Z",
      });
    });
    mocks.getA2APeer.mockResolvedValue(activeRollout());
    mocks.getDelegationTask.mockImplementation(async () => canonicalTask);
  });

  afterEach(() => vi.useRealTimers());

  it("dispatches a scoped token and records remote completion only as a proposal", async () => {
    const sent: unknown[] = [];
    mocks.createA2AClientV1.mockReturnValue(client({ sent }));
    const result = await startExternalA2ATaskV1({
      rollout: activeRollout(),
      negotiatedSkillId: "peer.verify",
      contract: buildContract(),
      internalTask: canonicalTask,
      parentExecutionScope,
      callbackBaseUrl: "https://asael.example/",
    });

    expect(mocks.discoverExternalA2APeerV1).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain("opaque-delegated-token");
    const persistedMessage = mocks.appendA2AExchange.mock.calls.find(
      ([value]) => value.direction === "outbound" && value.payload.type === "message",
    )?.[0];
    expect(JSON.stringify(persistedMessage)).not.toContain("opaque-delegated-token");
    expect(result.internalTask.state).toBe("completed_proposed");
    expect(
      mocks.transitionDelegationTask.mock.calls.map(([value]) => value.transition.to),
    ).toEqual(["accepted", "working", "completed_proposed"]);
    expect(result.internalTask.proposal).toMatchObject({
      toolExecutionIds: [],
      evidenceIds: [result.mapping.mappingId],
    });
  });

  it("blocks dispatch when live discovery differs from the reviewed card", async () => {
    mocks.discoverExternalA2APeerV1.mockResolvedValue({
      ...discovery(),
      cardSha256: "f".repeat(64),
    });
    mocks.createA2AClientV1.mockReturnValue(client({ sent: [] }));
    await expect(startExternalA2ATaskV1({
      rollout: activeRollout(),
      negotiatedSkillId: "peer.verify",
      contract: buildContract(),
      internalTask: canonicalTask,
      parentExecutionScope,
      callbackBaseUrl: "https://asael.example/",
    })).rejects.toThrow(/no longer matches the reviewed/i);
    expect(mocks.resolveA2APeerBearerToken).not.toHaveBeenCalled();
    expect(mocks.transitionDelegationTask).not.toHaveBeenCalled();
  });

  it("resumes, streams, and cancels only through the pinned outbound mapping", async () => {
    canonicalTask = taskAt("waiting");
    const mapping = outboundMapping(canonicalTask);
    const streamedStatus = {
      type: "status" as const,
      statusUpdate: {
        taskId: mapping.externalTaskId,
        contextId: mapping.externalContextId,
        status: {
          state: "TASK_STATE_WORKING" as const,
          timestamp: "2026-09-07T06:00:40.000Z",
        },
      },
    };
    mocks.createA2AClientV1.mockReturnValue(client({
      sent: [],
      sendState: "TASK_STATE_WORKING",
      streamEvents: [streamedStatus],
    }));

    const resumed = await resumeExternalA2ATaskV1({
      mapping,
      contract: buildContract(),
      parentExecutionScope,
      parts: [{ text: "Continue with the bounded clarification.", mediaType: "text/plain" }],
      callbackBaseUrl: "https://asael.example/",
    });
    expect(resumed.internalTask.state).toBe("working");

    const streamed = [];
    for await (const event of subscribeExternalA2ATaskV1({
      mapping,
      parentExecutionScope,
    })) streamed.push(event);
    expect(streamed).toEqual([streamedStatus]);

    const canceled = await cancelExternalA2ATaskV1({
      mapping,
      parentExecutionScope,
    });
    expect(canceled.internalTask.state).toBe("canceled");
  });
});

function client(input: {
  sent: unknown[];
  sendState?: "TASK_STATE_COMPLETED" | "TASK_STATE_WORKING";
  streamEvents?: unknown[];
}) {
  return {
    sendMessage: vi.fn(async (message) => {
      input.sent.push(message);
      return remoteTask(message.contextId, input.sendState || "TASK_STATE_COMPLETED");
    }),
    getTask: vi.fn(async () => remoteTask(outboundMapping(canonicalWorking()).externalContextId, "TASK_STATE_WORKING")),
    cancelTask: vi.fn(async () => remoteTask(outboundMapping(canonicalWorking()).externalContextId, "TASK_STATE_CANCELED")),
    subscribeToTask: vi.fn(async function* () {
      for (const event of input.streamEvents || []) yield event;
    }),
  };
}

function remoteTask(contextId: string, state: "TASK_STATE_COMPLETED" | "TASK_STATE_WORKING" | "TASK_STATE_CANCELED") {
  return {
    id: "remote-task:one",
    contextId,
    status: { state, timestamp: "2026-09-07T06:00:35.000Z" },
    artifacts: state === "TASK_STATE_COMPLETED" ? [{
      artifactId: "remote-artifact:one",
      parts: [{ data: { status: "done" }, mediaType: "application/json" }],
    }] : undefined,
  };
}

function activeRollout() {
  return transitionA2APeerRolloutV1({
    rollout: buildA2APeerRolloutV1({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      peerId: "peer:one",
      generation: 1,
      direction: "outbound",
      mode: "enabled",
      interfaceUrl: "https://peer.example/a2a/",
      agentCardSha256: "d".repeat(64),
      outboundCredentialConfigured: true,
      allowedSkillIds: ["peer.verify"],
      createdAt: "2026-09-07T06:00:00.000Z",
    }),
    to: "active",
    at: "2026-09-07T06:00:01.000Z",
  });
}

function discovery() {
  return {
    cardSha256: "d".repeat(64),
    selectedInterface: {
      url: "https://peer.example/a2a/",
      protocolBinding: "HTTP+JSON" as const,
      protocolVersion: "1.0" as const,
    },
    card: {
      name: "Peer",
      description: "External verification Agent",
      supportedInterfaces: [{
        url: "https://peer.example/a2a/",
        protocolBinding: "HTTP+JSON" as const,
        protocolVersion: "1.0" as const,
      }],
      version: "1",
      capabilities: { streaming: true },
      securitySchemes: {
        bearer: { httpAuthSecurityScheme: { scheme: "Bearer" as const } },
      },
      securityRequirements: [{ bearer: [] }],
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [{
        id: "peer.verify",
        name: "Verify",
        description: "Verify bounded work",
        tags: ["verification"],
      }],
    },
  };
}

function delegatedToken() {
  return {
    token: "opaque-delegated-token",
    envelope: {
      tokenId: `a2a-delegated-token:${"e".repeat(64)}`,
      tokenSha256: "e".repeat(64),
      internalTaskId: "delegation-task:delegation:one",
      expiresAt: "2026-09-07T06:05:00.000Z",
      audience: "asael-a2a-delegated-tool-gateway",
    },
  };
}

function outboundMapping(task: DelegationTaskV1) {
  const rollout = activeRollout();
  return buildA2ATaskMappingV1({
    tenantId: rollout.tenantId,
    ownerActorId: rollout.ownerActorId,
    peerId: rollout.peerId,
    rolloutId: rollout.rolloutId,
    rolloutSha256: rollout.rolloutSha256,
    direction: "outbound",
    externalTaskId: "remote-task:one",
    externalContextId: `a2a-context:${"a".repeat(64)}`,
    internalTaskId: task.taskId,
    internalDelegationId: task.delegationId,
    internalContractSha256: task.contractSha256,
    localAgentId: "atlas",
    localAgentDefinitionVersion: 1,
    negotiatedSkillId: "peer.verify",
    createdAt: "2026-09-07T06:00:31.000Z",
  });
}

function taskAt(state: "waiting") {
  let task = canonicalWorking();
  task = transitionDelegationTaskV1({
    task,
    transition: { to: state, reason: "clarification_required" },
    at: "2026-09-07T06:00:25.000Z",
  }).task;
  return task;
}

function canonicalWorking() {
  let task = buildDelegationTaskV1(buildContract());
  task = transitionDelegationTaskV1({
    task,
    transition: { to: "accepted" },
    at: "2026-09-07T06:00:10.000Z",
  }).task;
  return transitionDelegationTaskV1({
    task,
    transition: { to: "working" },
    at: "2026-09-07T06:00:20.000Z",
  }).task;
}

const parentExecutionScope = createExecutionScope({
  tenantId: "tenant-one",
  initiatingActorId: "actor-one",
  executingPrincipalType: "agent",
  executingPrincipalId: "principal:atlas:1",
  correlationId: "run-one",
  contextGrantIds: ["grant:context:one"],
  capabilityGrantIds: ["grant:capability:one"],
  purpose: "agent.run",
});
