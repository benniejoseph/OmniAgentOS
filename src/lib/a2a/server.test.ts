import { beforeEach, describe, expect, it, vi } from "vitest";

const taskStoreMocks = vi.hoisted(() => ({
  appendA2AExchange: vi.fn(),
  createA2ATaskMapping: vi.fn(),
  getA2ATaskMapping: vi.fn(),
  listA2ATaskMappings: vi.fn(),
  readA2ATaskProjection: vi.fn(),
}));
const delegationMocks = vi.hoisted(() => ({
  getDelegationTask: vi.fn(),
  transitionDelegationTask: vi.fn(),
}));
const councilMocks = vi.hoisted(() => ({ runCouncilRound: vi.fn() }));

vi.mock("@/lib/a2a/task-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/a2a/task-store")>(),
  ...taskStoreMocks,
}));
vi.mock("@/lib/delegation/store", () => delegationMocks);
vi.mock("@/lib/orchestration/council", () => councilMocks);

import {
  getInboundA2ATaskV1,
  sendInboundA2AMessageV1,
} from "@/lib/a2a/server";
import type { AuthorizedA2APrincipal } from "@/lib/a2a/auth";
import { A2ATaskStoreError } from "@/lib/a2a/task-store";
import {
  buildA2APeerRolloutV1,
  transitionA2APeerRolloutV1,
} from "@/lib/a2a/rollout";

describe("A2A server adapter", () => {
  beforeEach(() => {
    for (const mock of Object.values(taskStoreMocks)) mock.mockReset();
    for (const mock of Object.values(delegationMocks)) mock.mockReset();
    councilMocks.runCouncilRound.mockReset();
    taskStoreMocks.appendA2AExchange.mockImplementation(async (input) => input);
    taskStoreMocks.createA2ATaskMapping.mockResolvedValue(mapping());
    taskStoreMocks.readA2ATaskProjection.mockResolvedValue({
      task: task(),
      history: [],
      artifacts: [],
      exchanges: [],
    });
  });

  it("executes a new request through one canonical delegation and parent verification", async () => {
    taskStoreMocks.getA2ATaskMapping.mockRejectedValue(
      new A2ATaskStoreError("not found", 404),
    );
    councilMocks.runCouncilRound.mockResolvedValue([contribution()]);
    delegationMocks.getDelegationTask.mockResolvedValue(task());
    const statuses: string[] = [];
    const result = await sendInboundA2AMessageV1({
      principal: principal(),
      request: request(),
      onStatus: (update) => {
        statuses.push(update.state);
      },
    });

    expect(councilMocks.runCouncilRound).toHaveBeenCalledWith(
      expect.objectContaining({
        specialistIds: ["scout"],
        delegationAuthority: expect.objectContaining({ governedToolIds: [] }),
      }),
    );
    expect(taskStoreMocks.createA2ATaskMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "inbound",
        localAgentId: "scout",
        negotiatedSkillId: "asael.scout.agent-capability:scout:research",
      }),
    );
    expect(taskStoreMocks.appendA2AExchange).toHaveBeenCalledTimes(3);
    expect(statuses[0]).toBe("TASK_STATE_SUBMITTED");
    expect(result.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("returns the prior canonical mapping for an idempotent message retry", async () => {
    taskStoreMocks.getA2ATaskMapping.mockResolvedValue(mapping());
    const result = await sendInboundA2AMessageV1({
      principal: principal(),
      request: request(),
    });
    expect(result.id).toBe("a2a-task:one");
    expect(councilMocks.runCouncilRound).not.toHaveBeenCalled();
    expect(taskStoreMocks.createA2ATaskMapping).not.toHaveBeenCalled();
  });

  it("rejects a local Agent outside the exact peer rollout", async () => {
    taskStoreMocks.getA2ATaskMapping.mockRejectedValue(
      new A2ATaskStoreError("not found", 404),
    );
    await expect(sendInboundA2AMessageV1({
      principal: principal(),
      request: request({ metadata: { asaelAgentId: "forge" } }),
    })).rejects.toThrow(/outside this peer rollout/i);
    expect(councilMocks.runCouncilRound).not.toHaveBeenCalled();
  });

  it("keeps task reads bound to the active peer rollout", async () => {
    taskStoreMocks.getA2ATaskMapping.mockResolvedValue({
      ...mapping(),
      rolloutSha256: "f".repeat(64),
    });
    await expect(getInboundA2ATaskV1({
      principal: principal(),
      taskId: "a2a-task:one",
    })).rejects.toThrow(/outside the active peer rollout/i);
  });
});

function request(messageOverrides: Record<string, unknown> = {}) {
  return {
    message: {
      messageId: "message:one",
      role: "ROLE_USER",
      parts: [{ text: "Research the bounded question.", mediaType: "text/plain" }],
      ...messageOverrides,
    },
    configuration: { acceptedOutputModes: ["application/json"] },
  };
}

function principal(): AuthorizedA2APrincipal {
  return {
    keyId: "key:one",
    tenantId: "tenant:one",
    actorId: "actor:one",
    name: "Peer key",
    scopes: ["a2a:discover", "a2a:tasks:read", "a2a:tasks:write"],
    peer: activeRollout(),
  };
}

function activeRollout() {
  return transitionA2APeerRolloutV1({
    rollout: buildA2APeerRolloutV1({
      tenantId: "tenant:one",
      ownerActorId: "actor:one",
      peerId: "peer:one",
      generation: 1,
      direction: "inbound",
      mode: "enabled",
      interfaceUrl: "https://peer.example/a2a/",
      agentCardSha256: "a".repeat(64),
      inboundServiceApiKeyId: "key:one",
      outboundCredentialConfigured: false,
      allowedSkillIds: ["peer.identity"],
      allowedInboundAgentIds: ["scout"],
      createdAt: "2026-09-07T00:00:00.000Z",
    }),
    to: "active",
    at: "2026-09-07T00:00:01.000Z",
  });
}

function mapping() {
  const rollout = activeRollout();
  return {
    schemaVersion: 1 as const,
    version: "p8.6-a2a-task-mapping:1" as const,
    mappingId: `a2a-task-map:${"b".repeat(64)}`,
    mappingSha256: "c".repeat(64),
    tenantId: rollout.tenantId,
    ownerActorId: rollout.ownerActorId,
    peerId: rollout.peerId,
    rolloutId: rollout.rolloutId,
    rolloutSha256: rollout.rolloutSha256,
    direction: "inbound" as const,
    externalTaskId: "a2a-task:one",
    externalContextId: "a2a-context:one",
    internalTaskId: "delegation-task:one",
    internalDelegationId: "delegation:one",
    internalContractSha256: "d".repeat(64),
    localAgentId: "scout" as const,
    localAgentDefinitionVersion: 1,
    negotiatedSkillId: "asael.scout.agent-capability:scout:research",
    createdAt: "2026-09-07T00:00:02.000Z",
  };
}

function task() {
  return {
    taskId: "delegation-task:one",
    delegationId: "delegation:one",
    tenantId: "tenant:one",
    ownerActorId: "actor:one",
    delegateAgentId: "scout",
    delegateDefinitionVersion: 1,
    contractSha256: "d".repeat(64),
    state: "result_accepted" as const,
    lifecycleRevision: 4,
    updatedAt: "2026-09-07T00:00:03.000Z",
  };
}

function contribution() {
  return {
    agentId: "scout",
    name: "Scout",
    role: "Research specialist",
    status: "completed",
    summary: "Verified summary",
    findings: ["Finding"],
    risks: [],
    recommendation: "Proceed",
    evidenceIds: [],
    confidence: 0.9,
    durationMs: 10,
    delegation: {
      delegationId: "delegation:one",
      contractId: "delegation-contract:one",
      contractSha256: "d".repeat(64),
      delegatePrincipalId: "principal:one",
      toolExecutionIds: [],
      taskId: "delegation-task:one",
      lifecycleState: "result_accepted",
      lifecycleRevision: 4,
    },
  };
}
