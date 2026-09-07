import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getA2APeer: vi.fn(),
  getDelegationTask: vi.fn(),
  checkSharedRateLimit: vi.fn(),
  executeGovernedTool: vi.fn(),
  claimExternalA2AToolCall: vi.fn(),
}));

vi.mock("@/lib/a2a/store", () => ({ getA2APeer: mocks.getA2APeer }));
vi.mock("@/lib/delegation/store", () => ({ getDelegationTask: mocks.getDelegationTask }));
vi.mock("@/lib/http/rate-limit", () => ({ checkSharedRateLimit: mocks.checkSharedRateLimit }));
vi.mock("@/lib/tools/executor", () => ({ executeGovernedTool: mocks.executeGovernedTool }));
vi.mock("@/lib/tools/audit-store", () => ({ publicToolExecution: (value: unknown) => value }));
vi.mock("@/lib/a2a/safety-store", () => ({
  claimExternalA2AToolCall: mocks.claimExternalA2AToolCall,
}));

import {
  A2ADelegatedToolError,
  executeDelegatedA2AToolV1,
} from "@/lib/a2a/delegated-tools";
import {
  buildA2APeerRolloutV1,
  transitionA2APeerRolloutV1,
} from "@/lib/a2a/rollout";

describe("delegated A2A governed tool gateway", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getA2APeer.mockResolvedValue(activeRollout());
    mocks.getDelegationTask.mockResolvedValue(task());
    mocks.checkSharedRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.executeGovernedTool.mockResolvedValue({
      record: {
        id: "tool-execution:one",
        toolId: "knowledge.search",
        toolName: "Knowledge search",
        status: "executed",
        riskLevel: 0,
        approvalRequired: false,
        dryRun: false,
        input: {},
        output: { matches: [] },
        createdAt: "2026-09-07T06:01:00.000Z",
        completedAt: "2026-09-07T06:01:01.000Z",
      },
      result: { matches: [] },
    });
    mocks.claimExternalA2AToolCall.mockResolvedValue({
      charged: true,
      state: { reservation: { forceMutationApproval: true } },
    });
  });

  it("re-enters the governed executor with the exact delegated principal", async () => {
    const result = await executeDelegatedA2AToolV1({
      envelope: envelope(),
      request: {
        toolId: "knowledge.search",
        input: { query: "bounded" },
        idempotencyKey: "remote-call:one",
      },
    });

    expect(mocks.executeGovernedTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: "knowledge.search",
      input: { query: "bounded" },
      dryRun: false,
      approved: false,
      forceApproval: true,
      context: expect.objectContaining({
        tenantId: "tenant:one",
        actorId: "actor:one",
        role: "viewer",
        source: "service",
      }),
      executionScope: expect.objectContaining({
        executingPrincipalType: "agent",
        executingPrincipalId: "principal:remote:one",
        delegationId: "delegation:one",
        contextGrantIds: ["context:one"],
        capabilityGrantIds: ["capability:one"],
      }),
      idempotencyKey: "a2a-delegated-token:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:remote-call:one",
    }));
    expect(mocks.claimExternalA2AToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        internalTaskId: "delegation-task:one",
        toolId: "knowledge.search",
        idempotencyKey: "remote-call:one",
      }),
    );
    expect(result.execution).toMatchObject({ status: "executed", output: { matches: [] } });
  });

  it("fails closed for tools, tasks, or rollout generations outside authority", async () => {
    await expect(executeDelegatedA2AToolV1({
      envelope: envelope(),
      request: { toolId: "memory.write", input: {}, idempotencyKey: "call:one" },
    })).rejects.toMatchObject({ status: 403, code: "authority_denied" } satisfies Partial<A2ADelegatedToolError>);
    expect(mocks.executeGovernedTool).not.toHaveBeenCalled();

    mocks.getDelegationTask.mockResolvedValue({ ...task(), state: "completed_proposed" });
    await expect(executeDelegatedA2AToolV1({
      envelope: envelope(),
      request: { toolId: "knowledge.search", input: {}, idempotencyKey: "call:two" },
    })).rejects.toMatchObject({ status: 403 });

    mocks.getDelegationTask.mockResolvedValue(task());
    mocks.getA2APeer.mockResolvedValue({ ...activeRollout(), rolloutSha256: "f".repeat(64) });
    await expect(executeDelegatedA2AToolV1({
      envelope: envelope(),
      request: { toolId: "knowledge.search", input: {}, idempotencyKey: "call:three" },
    })).rejects.toMatchObject({ status: 403 });
  });
});

function envelope() {
  const rollout = activeRollout();
  return {
    schemaVersion: 1 as const,
    version: "p8.6-a2a-delegated-token:1" as const,
    tokenId: `a2a-delegated-token:${"a".repeat(64)}`,
    tokenSha256: "a".repeat(64),
    audience: "asael-a2a-delegated-tool-gateway" as const,
    principal: {
      schemaVersion: 1 as const,
      version: "p8.2-delegated-principal:1" as const,
      principalId: "principal:remote:one",
      principalSha256: "b".repeat(64),
      tenantId: "tenant:one",
      initiatingActorId: "actor:one",
      parentPrincipalId: "principal:atlas:one",
      delegationId: "delegation:one",
      delegationContractSha256: "c".repeat(64),
      agentId: "remote-agent",
      definitionVersion: 1,
      audience: "asael-governed-tool-executor" as const,
      purpose: "Execute a bounded external task.",
      contextGrantIds: ["context:one"],
      capabilityGrantIds: ["capability:one"],
      governedToolIds: ["knowledge.search"],
      connectorTargets: [],
      issuedAt: "2026-09-07T06:00:00.000Z",
      expiresAt: "2026-09-07T06:05:00.000Z",
      canRedelegate: false as const,
      credentialMaterialIncluded: false as const,
    },
    parentExecutionId: "execution:one",
    workspaceId: null,
    projectId: null,
    missionId: null,
    internalTaskId: "delegation-task:one",
    rolloutId: rollout.rolloutId,
    rolloutSha256: rollout.rolloutSha256,
    peerId: "peer:one",
    issuedAt: "2026-09-07T06:00:00.000Z",
    expiresAt: "2026-09-07T06:05:00.000Z",
    credentialMaterialIncluded: false as const,
  };
}

function task() {
  return {
    tenantId: "tenant:one",
    ownerActorId: "actor:one",
    parentExecutionId: "execution:one",
    delegationId: "delegation:one",
    delegatePrincipalId: "principal:remote:one",
    contractSha256: "c".repeat(64),
    state: "working",
  };
}

function activeRollout() {
  return transitionA2APeerRolloutV1({
    rollout: buildA2APeerRolloutV1({
      tenantId: "tenant:one",
      ownerActorId: "actor:one",
      peerId: "peer:one",
      generation: 1,
      direction: "outbound",
      mode: "enabled",
      interfaceUrl: "https://peer.example/a2a/",
      agentCardSha256: "d".repeat(64),
      outboundCredentialConfigured: true,
      allowedSkillIds: ["remote.skill"],
      createdAt: "2026-09-07T06:00:00.000Z",
    }),
    to: "active",
    at: "2026-09-07T06:00:01.000Z",
  });
}
