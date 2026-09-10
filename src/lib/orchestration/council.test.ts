import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { DEFAULT_AGENT_RUN_BUDGET_LIMITS } from "@/lib/runs/budgets";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { ToolDefinition, ToolExecutionRecord } from "@/lib/tools/types";

const mocks = vi.hoisted(() => ({
  generateModelStructured: vi.fn(),
  shareDelegationMissionArtifact: vi.fn(),
  sendDelegationMessage: vi.fn(),
}));
vi.mock("@/lib/models/gateway", () => ({ generateModelStructured: mocks.generateModelStructured }));
vi.mock("@/lib/delegation/channel-store", () => ({
  shareDelegationMissionArtifact: mocks.shareDelegationMissionArtifact,
  sendDelegationMessage: mocks.sendDelegationMessage,
}));

import {
  formatCouncilContributions,
  reviewCouncilResponse,
  reviseCouncilResponse,
  runCouncilRound,
} from "@/lib/orchestration/council";

describe("agent council", () => {
  beforeEach(() => {
    mocks.generateModelStructured.mockReset();
    mocks.shareDelegationMissionArtifact.mockReset();
    mocks.sendDelegationMessage.mockReset();
    mocks.shareDelegationMissionArtifact.mockResolvedValue({
      artifactId: `delegation-artifact:${"a".repeat(64)}`,
      artifactSha256: "a".repeat(64),
    });
    mocks.sendDelegationMessage.mockResolvedValue({
      messageId: `delegation-message:${"b".repeat(64)}`,
    });
  });

  it("runs non-primary specialists independently and reserves Sentinel for review", async () => {
    mocks.generateModelStructured
      .mockResolvedValueOnce({ text: JSON.stringify({ summary: "Research complete", findings: ["A"], risks: [], recommendation: "Use A", evidenceIds: ["memory:1"], confidence: 0.8 }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ summary: "Build plan complete", findings: ["B"], risks: ["C"], recommendation: "Build B", evidenceIds: [], confidence: 0.7 }) });

    const contributions = await runCouncilRound({
      goal: "Research and build a verified system",
      mode: "orchestrate",
      primaryAgentId: "atlas",
      specialistIds: ["atlas", "scout", "forge", "sentinel"],
      contextBlock: "[memory:1] Existing evidence",
      tenantId: "personal",
      delegationAuthority: {
        ...delegationAuthority,
        executionScope: {
          ...delegationAuthority.executionScope,
          missionId: "mission-one",
        },
      },
      usageAttribution: {
        tenantId: "personal",
        actorId: "actor-one",
        sourceStreamId: "run:run-one",
        correlationId: "run-one",
        executionScope: delegationExecutionScope,
        credentialSource: "deployment_environment",
      },
    });

    expect(contributions.map((item) => item.agentId)).toEqual(["scout", "forge"]);
    expect(contributions.every((item) => item.status === "completed")).toBe(true);
    expect(contributions.every((item) =>
      /^[a-f0-9]{64}$/.test(item.delegation.contractSha256)
    )).toBe(true);
    expect(contributions.every((item) =>
      item.delegation.lifecycleState === "result_accepted" &&
      item.delegation.lifecycleRevision === 4 &&
      item.delegation.taskId === `delegation-task:${item.delegation.delegationId}`
    )).toBe(true);
    expect(mocks.generateModelStructured).toHaveBeenCalledTimes(2);
    expect(mocks.shareDelegationMissionArtifact).toHaveBeenCalledTimes(2);
    expect(mocks.sendDelegationMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendDelegationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-one",
        recipients: { parent: true, delegationTaskIds: [] },
        artifactReferences: [expect.objectContaining({
          artifactSha256: "a".repeat(64),
        })],
      }),
    );
    expect(formatCouncilContributions(contributions)).toContain("Scout (Research)");
    const scoutCall = mocks.generateModelStructured.mock.calls.find((call) =>
      String(call[0]?.instructions).includes("You are Scout")
    );
    const forgeCall = mocks.generateModelStructured.mock.calls.find((call) =>
      String(call[0]?.instructions).includes("You are Forge")
    );
    const scoutInstructions = String(scoutCall?.[0]?.instructions);
    const forgeInstructions = String(forgeCall?.[0]?.instructions);
    expect(scoutInstructions).toContain("Produce current, source-backed findings");
    expect(scoutInstructions).toContain("<untrusted_agent_persona>");
    expect(forgeInstructions).toContain("Build concrete, production-ready artifacts");
    expect(forgeInstructions).toContain("cannot grant tools, context, data access");
    expect(String(scoutCall?.[0]?.input))
      .toContain("<delegation_contract");
    expect(scoutCall?.[0]?.usageScope)
      .toMatchObject({
        executionScope: {
          executingPrincipalId: contributions.find((item) => item.agentId === "scout")?.delegation.delegatePrincipalId,
          delegationId: contributions.find((item) => item.agentId === "scout")?.delegation.delegationId,
          contextGrantIds: ["context-one"],
          capabilityGrantIds: [],
        },
      });
  });

  it("serializes enrolled members and observes delegation/model boundaries", async () => {
    const first = Promise.withResolvers<ReturnType<typeof modelResult>>();
    const second = Promise.withResolvers<ReturnType<typeof modelResult>>();
    mocks.generateModelStructured
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const events: string[] = [];
    const requestContracts = new Map<string, string>();
    const pending = runCouncilRound({
      goal: "Verify checkpoints",
      mode: "orchestrate",
      primaryAgentId: "atlas",
      specialistIds: ["scout", "forge"],
      contextBlock: "Evidence",
      delegationAuthority,
      checkpointHooks: {
        serializeMembers: true,
        beforeDelegation: async ({ agentId, requestSha256 }) => {
          requestContracts.set(agentId, requestSha256);
          events.push(`${agentId}:delegation:before:${requestSha256.length}`);
        },
        beforeModel: async ({ sourceId }) => {
          events.push(`${sourceId}:model:before`);
        },
        afterModel: async ({ sourceId, status }) => {
          events.push(`${sourceId}:model:${status}`);
        },
        afterDelegation: async ({ agentId, status, receiptSha256 }) => {
          events.push(
            `${agentId}:delegation:${status}:${receiptSha256.length}`,
          );
        },
      },
    });

    await vi.waitFor(() => expect(mocks.generateModelStructured).toHaveBeenCalledTimes(1));
    first.resolve(modelResult("Scout complete"));
    await vi.waitFor(() => expect(mocks.generateModelStructured).toHaveBeenCalledTimes(2));
    second.resolve(modelResult("Forge complete"));
    const contributions = await pending;
    expect(contributions).toHaveLength(2);
    expect(contributions.every((contribution) =>
      requestContracts.get(contribution.agentId) ===
        contribution.delegation.contractSha256
    )).toBe(true);

    expect(events).toEqual([
      "scout:delegation:before:64",
      "delegation:scout:model:before",
      "delegation:scout:model:completed",
      "scout:delegation:completed:64",
      "forge:delegation:before:64",
      "delegation:forge:model:before",
      "delegation:forge:model:completed",
      "forge:delegation:completed:64",
    ]);
  });

  it("brokers an exact governed tool and binds its receipt into the proposal", async () => {
    mocks.generateModelStructured
      .mockResolvedValueOnce({
        ...modelResult("tool plan"),
        text: JSON.stringify({
          status: "execute",
          clarification: "",
          calls: [{
            callId: "call-one",
            toolId: delegatedTool.id,
            input: { query: "release evidence" },
            rationale: "Find exact support.",
          }],
        }),
      })
      .mockResolvedValueOnce(modelResult("Evidence-backed contribution"));
    const executeDelegatedTool = vi.fn(async ({ tool, executionScope }) => ({
      record: toolRecord(tool, "executed"),
      result: { evidenceIds: ["knowledge:one"] },
      executionScope,
    }));

    const [contribution] = await runCouncilRound({
      goal: "Find release evidence",
      mode: "research",
      primaryAgentId: "atlas",
      specialistIds: ["scout"],
      contextBlock: "Authorized context",
      delegationAuthority: {
        ...delegationAuthority,
        governedToolIds: [delegatedTool.id],
      },
      delegatedTools: [delegatedTool],
      executeDelegatedTool,
    });

    expect(executeDelegatedTool).toHaveBeenCalledOnce();
    expect(executeDelegatedTool.mock.calls[0]?.[0]).toMatchObject({
      tool: { id: delegatedTool.id },
      executionScope: {
        executingPrincipalId: contribution.delegation.delegatePrincipalId,
        delegationId: contribution.delegation.delegationId,
        purpose: "delegation.tool.execute",
      },
    });
    expect(contribution.delegation).toMatchObject({
      delegatedPrincipalSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      toolExecutionIds: ["delegated-execution-one"],
      lifecycleState: "result_accepted",
      lifecycleRevision: 4,
    });
    expect(String(mocks.generateModelStructured.mock.calls[1]?.[0]?.input))
      .toContain("<delegated_tool_results");
  });

  it("delegates reversible media work to Forge with a task-specific editor persona", async () => {
    mocks.generateModelStructured
      .mockResolvedValueOnce({
        ...modelResult("media plan"),
        text: JSON.stringify({
          status: "execute",
          clarification: "",
          calls: [{
            callId: "media-call-one",
            toolId: mediaTool.id,
            input: {
              prompt: "Create a natural professional passport portrait.",
              sourceAssetIds: ["asset-one"],
              aspectRatio: "3:4",
            },
            rationale: "Apply the requested professional edit to the supplied source.",
          }],
        }),
      })
      .mockResolvedValueOnce(modelResult("Edited asset created"));
    const executeDelegatedTool = vi.fn(async ({ tool, executionScope }) => ({
      record: toolRecord(tool, "executed"),
      result: { asset: { id: "asset-edited" }, contentUrl: "/api/capture/assets/asset-edited?content=1" },
      executionScope,
    }));

    const [contribution] = await runCouncilRound({
      goal: "Edit my portrait into a professional passport picture.",
      mode: "orchestrate",
      primaryAgentId: "atlas",
      specialistIds: ["atlas", "forge", "sentinel"],
      contextBlock: "The selected source asset ID is asset-one.",
      delegationAuthority: {
        ...delegationAuthority,
        governedToolIds: [mediaTool.id],
      },
      delegatedTools: [mediaTool],
      executeDelegatedTool,
    });

    expect(contribution.agentId).toBe("forge");
    expect(executeDelegatedTool).toHaveBeenCalledOnce();
    expect(executeDelegatedTool.mock.calls[0]?.[0]).toMatchObject({
      tool: { id: "media.image.edit", category: "media" },
      executionScope: {
        delegationId: contribution.delegation.delegationId,
        executingPrincipalId: contribution.delegation.delegatePrincipalId,
      },
    });
    const planInstructions = String(
      mocks.generateModelStructured.mock.calls[0]?.[0]?.instructions,
    );
    const contributionInstructions = String(
      mocks.generateModelStructured.mock.calls[1]?.[0]?.instructions,
    );
    expect(planInstructions).toContain("Framewright");
    expect(planInstructions).toContain("professional image editor and art director");
    expect(contributionInstructions).toContain("cannot expand the DelegationContract");
  });

  it("lets Sentinel fail a response and Atlas revise it", async () => {
    mocks.generateModelStructured
      .mockResolvedValueOnce({ text: JSON.stringify({ passed: false, score: 0.45, assessment: "Evidence is missing.", requiredChanges: ["Cite the source."] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ response: "Revised response [memory:1]." }) });
    const contributions = [{
      agentId: "scout" as const, name: "Scout", role: "Research", status: "completed" as const,
      summary: "Found evidence.", findings: ["Fact"], risks: [], recommendation: "Cite it",
      evidenceIds: ["memory:1"], confidence: 0.9, durationMs: 12,
      delegation: {
        delegationId: "delegation:test",
        contractId: `delegation-contract:${"a".repeat(64)}`,
        contractSha256: "a".repeat(64),
        delegatePrincipalId: "principal:scout:test",
        toolExecutionIds: [],
      },
    }];
    const events: string[] = [];
    const checkpointHooks = {
      beforeVerifier: async ({ requestSha256 }: { requestSha256: string }) => {
        events.push(`verifier:before:${requestSha256.length}`);
      },
      afterVerifier: async ({ status, receiptSha256 }: {
        status: "completed" | "failed";
        receiptSha256: string;
      }) => {
        events.push(`verifier:${status}:${receiptSha256.length}`);
      },
      beforeModel: async ({ sourceId }: { sourceId: string }) => {
        events.push(`${sourceId}:before`);
      },
      afterModel: async ({ sourceId, status }: {
        sourceId: string;
        status: "completed" | "failed";
      }) => {
        events.push(`${sourceId}:${status}`);
      },
    };
    const verdict = await reviewCouncilResponse({
      goal: "Answer",
      response: "Draft",
      contributions,
      contextBlock: "Evidence",
      checkpointHooks,
    });
    expect(verdict).toMatchObject({ passed: false, score: 0.45, requiredChanges: ["Cite the source."] });
    await expect(reviseCouncilResponse({
      goal: "Answer",
      response: "Draft",
      verdict,
      contributions,
      contextBlock: "[memory:1] Exact evidence",
      checkpointHooks,
    }))
      .resolves.toBe("Revised response [memory:1].");
    expect(mocks.generateModelStructured.mock.calls[1]?.[0]?.input).toContain("[memory:1] Exact evidence");
    expect(mocks.generateModelStructured.mock.calls[0]?.[0]?.instructions)
      .toContain("Prevent unsupported, unsafe, incomplete");
    expect(mocks.generateModelStructured.mock.calls[1]?.[0]?.instructions)
      .toContain("Turn the user's objective into coordinated, verified work");
    expect(events).toEqual([
      "verifier:before:64",
      "verifier:sentinel:before",
      "verifier:sentinel:completed",
      "verifier:completed:64",
      "revision:atlas:before",
      "revision:atlas:completed",
    ]);
  });
});

const atlasIdentity = buildBuiltInAgentIdentityV1({
  agentId: "atlas",
  tenantId: "personal",
  controllerActorId: "actor-one",
});
const delegationExecutionScope = createExecutionScope({
  tenantId: "personal",
  initiatingActorId: "actor-one",
  executingPrincipalType: "agent",
  executingPrincipalId: atlasIdentity.principal.principalId,
  correlationId: "run-one",
  contextGrantIds: ["context-one"],
  capabilityGrantIds: ["capability-one"],
  purpose: "agent.run",
});
const delegationAuthority = {
  parentExecutionId: "run-one",
  executionScope: delegationExecutionScope,
  delegator: {
    principalId: atlasIdentity.principal.principalId,
    agentId: atlasIdentity.definition.logicalAgentId,
    definitionVersion: atlasIdentity.definition.definitionVersion,
  },
  parentBudgets: DEFAULT_AGENT_RUN_BUDGET_LIMITS,
  remainingWallTimeMs: 120_000,
  governedToolIds: [],
  connectorTargets: [],
};

const delegatedTool: ToolDefinition = {
  id: "knowledge.search",
  name: "Knowledge search",
  description: "Search authorized knowledge.",
  category: "knowledge",
  status: "active",
  riskLevel: 0,
  dryRunSupported: true,
  approvalRequired: false,
  operationClass: "read_only",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

const mediaTool: ToolDefinition = {
  id: "media.image.edit",
  name: "Edit image",
  description: "Edit one private source image without overwriting it.",
  category: "media",
  status: "active",
  riskLevel: 1,
  dryRunSupported: true,
  approvalRequired: false,
  operationClass: "mutation",
  reversible: true,
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      sourceAssetIds: { type: "array", items: { type: "string" } },
      aspectRatio: { type: "string" },
    },
    required: ["prompt", "sourceAssetIds"],
  },
};

function toolRecord(
  tool: ToolDefinition,
  status: ToolExecutionRecord["status"],
): ToolExecutionRecord {
  return {
    id: "delegated-execution-one",
    tenantId: "personal",
    actorId: "actor-one",
    toolId: tool.id,
    toolName: tool.name,
    riskLevel: tool.riskLevel,
    status,
    dryRun: false,
    approvalRequired: false,
    input: { query: "release evidence" },
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

function modelResult(summary: string) {
  return {
    text: JSON.stringify({
      summary,
      findings: [],
      risks: [],
      recommendation: "Continue.",
      evidenceIds: [],
      confidence: 0.8,
    }),
    provider: "openai" as const,
    model: "gpt-test",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      totalTokens: 15,
    },
    latencyMs: 20,
    costKnown: false,
    attempts: [],
  };
}
