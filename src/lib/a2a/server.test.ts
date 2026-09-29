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
const budgetMocks = vi.hoisted(() => ({ admitInboundA2ATask: vi.fn() }));

vi.mock("@/lib/a2a/task-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/a2a/task-store")>(),
  ...taskStoreMocks,
}));
vi.mock("@/lib/delegation/store", () => delegationMocks);
vi.mock("@/lib/orchestration/council", () => councilMocks);
vi.mock("@/lib/a2a/inbound-budget", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/a2a/inbound-budget")>(),
  ...budgetMocks,
}));

import {
  getInboundA2ATaskV1,
  sendInboundA2AMessageV1,
} from "@/lib/a2a/server";
import type { AuthorizedA2APrincipal } from "@/lib/a2a/auth";
import { inboundA2AUsageStreamId } from "@/lib/a2a/inbound-budget";
import { A2ATaskStoreError } from "@/lib/a2a/task-store";
import { A2AProtocolError } from "@/lib/a2a/v1-contracts";
import {
  buildA2APeerRolloutV1,
  transitionA2APeerRolloutV1,
} from "@/lib/a2a/rollout";

describe("A2A server adapter", () => {
  beforeEach(() => {
    for (const mock of Object.values(taskStoreMocks)) mock.mockReset();
    for (const mock of Object.values(delegationMocks)) mock.mockReset();
    councilMocks.runCouncilRound.mockReset();
    budgetMocks.admitInboundA2ATask.mockReset().mockResolvedValue(undefined);
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

    expect(budgetMocks.admitInboundA2ATask).toHaveBeenCalledWith(
      principal(),
      expect.objectContaining({ tokens: 12_000, costMicrousd: 500_000 }),
    );
    expect(councilMocks.runCouncilRound).toHaveBeenCalledWith(
      expect.objectContaining({
        specialistIds: ["scout"],
        delegationAuthority: expect.objectContaining({ governedToolIds: [] }),
      }),
    );
    const { delegationAuthority, usageAttribution } =
      councilMocks.runCouncilRound.mock.calls[0][0];
    expect(usageAttribution).toEqual({
      tenantId: "tenant:one",
      actorId: "actor:one",
      sourceStreamId: inboundA2AUsageStreamId(principal()),
      correlationId: delegationAuthority.executionScope.correlationId,
      causationId: delegationAuthority.executionScope.causationId,
      executionScope: delegationAuthority.executionScope,
    });
    expect(usageAttribution.causationId).toMatch(/^a2a-task:[0-9a-f]{64}$/);
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
    expect(budgetMocks.admitInboundA2ATask).not.toHaveBeenCalled();
    expect(councilMocks.runCouncilRound).not.toHaveBeenCalled();
    expect(taskStoreMocks.createA2ATaskMapping).not.toHaveBeenCalled();
  });

  it("refuses a task past its peer's budget before submitting it", async () => {
    taskStoreMocks.getA2ATaskMapping.mockRejectedValue(
      new A2ATaskStoreError("not found", 404),
    );
    const refusal = new A2AProtocolError("No room.", 429, "resource_exhausted");
    budgetMocks.admitInboundA2ATask.mockRejectedValue(refusal);
    const statuses: string[] = [];
    await expect(sendInboundA2AMessageV1({
      principal: principal(),
      request: request(),
      onStatus: (update) => {
        statuses.push(update.state);
      },
    })).rejects.toBe(refusal);
    expect(statuses).toEqual([]);
    expect(councilMocks.runCouncilRound).not.toHaveBeenCalled();
    expect(taskStoreMocks.createA2ATaskMapping).not.toHaveBeenCalled();
    expect(taskStoreMocks.appendA2AExchange).not.toHaveBeenCalled();
  });

  it("rejects a local Agent outside the exact peer rollout", async () => {
    taskStoreMocks.getA2ATaskMapping.mockRejectedValue(
      new A2ATaskStoreError("not found", 404),
    );
    await expect(sendInboundA2AMessageV1({
      principal: principal(),
      request: request({ metadata: { asaelAgentId: "forge" } }),
    })).rejects.toThrow(/outside this peer rollout/i);
    expect(budgetMocks.admitInboundA2ATask).not.toHaveBeenCalled();
    expect(councilMocks.runCouncilRound).not.toHaveBeenCalled();
  });

  it("marks an accepted result as untrusted output that passed structural checks", async () => {
    taskStoreMocks.getA2ATaskMapping.mockRejectedValue(
      new A2ATaskStoreError("not found", 404),
    );
    councilMocks.runCouncilRound.mockResolvedValue([contribution()]);
    delegationMocks.getDelegationTask.mockResolvedValue(task());
    const result = await sendInboundA2AMessageV1({
      principal: principal(),
      request: request(),
    });

    const artifacts = appendedPayloads().filter((payload) => payload.type === "artifact");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact.metadata).toMatchObject({
      untrusted: true,
      independentlyVerified: false,
    });
    expect(artifacts[0].artifact.description).not.toMatch(/verif/i);
    expect(result.metadata?.resultDisposition).toBe("structurally_accepted");
  });

  it("appends no result artifact unless the canonical task accepted the result", async () => {
    taskStoreMocks.getA2ATaskMapping.mockRejectedValue(
      new A2ATaskStoreError("not found", 404),
    );
    const rejected = { ...task(), state: "rejected" as const };
    delegationMocks.getDelegationTask.mockResolvedValue(rejected);
    taskStoreMocks.readA2ATaskProjection.mockResolvedValue({
      task: rejected,
      history: [],
      artifacts: [],
      exchanges: [],
    });
    for (const status of ["completed", "failed"]) {
      taskStoreMocks.appendA2AExchange.mockClear();
      councilMocks.runCouncilRound.mockResolvedValue([{ ...contribution(), status }]);
      const result = await sendInboundA2AMessageV1({
        principal: principal(),
        request: request(),
      });
      expect(appendedPayloads().map((payload) => payload.type), status)
        .toEqual(["message", "status"]);
      expect(result.status.state).toBe("TASK_STATE_REJECTED");
      expect(result.metadata?.resultDisposition).toBe("not_accepted");
    }
  });

  it("refuses an inbound task for Sentinel before any delegation", async () => {
    taskStoreMocks.getA2ATaskMapping.mockRejectedValue(
      new A2ATaskStoreError("not found", 404),
    );
    for (const [allowed, messageOverrides] of [
      [["scout", "sentinel"], { metadata: { asaelAgentId: "sentinel" } }],
      [["sentinel"], {}],
    ] as const) {
      await expect(sendInboundA2AMessageV1({
        principal: { ...principal(), peer: activeRollout(allowed) },
        request: request(messageOverrides),
      })).rejects.toMatchObject({
        status: 403,
        message: "The requested Asael Agent does not take inbound A2A tasks.",
      });
    }
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

function appendedPayloads() {
  return taskStoreMocks.appendA2AExchange.mock.calls.map(
    ([input]) => input.payload,
  );
}

function activeRollout(
  allowedInboundAgentIds: Parameters<
    typeof buildA2APeerRolloutV1
  >[0]["allowedInboundAgentIds"] = ["scout"],
) {
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
      allowedInboundAgentIds,
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
