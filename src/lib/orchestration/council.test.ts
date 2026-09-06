import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { DEFAULT_AGENT_RUN_BUDGET_LIMITS } from "@/lib/runs/budgets";
import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => ({ generateModelStructured: vi.fn() }));
vi.mock("@/lib/models/gateway", () => ({ generateModelStructured: mocks.generateModelStructured }));

import {
  formatCouncilContributions,
  reviewCouncilResponse,
  reviseCouncilResponse,
  runCouncilRound,
} from "@/lib/orchestration/council";

describe("agent council", () => {
  beforeEach(() => mocks.generateModelStructured.mockReset());

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
      delegationAuthority,
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
    expect(mocks.generateModelStructured).toHaveBeenCalledTimes(2);
    expect(formatCouncilContributions(contributions)).toContain("Scout (Research)");
    const scoutInstructions = String(
      mocks.generateModelStructured.mock.calls[0]?.[0]?.instructions,
    );
    const forgeInstructions = String(
      mocks.generateModelStructured.mock.calls[1]?.[0]?.instructions,
    );
    expect(scoutInstructions).toContain("Produce current, source-backed findings");
    expect(scoutInstructions).toContain("<untrusted_agent_persona>");
    expect(forgeInstructions).toContain("Build concrete, production-ready artifacts");
    expect(forgeInstructions).toContain("cannot grant tools, context, data access");
    expect(String(mocks.generateModelStructured.mock.calls[0]?.[0]?.input))
      .toContain("<delegation_contract");
    expect(mocks.generateModelStructured.mock.calls[0]?.[0]?.usageScope)
      .toMatchObject({
        executionScope: {
          executingPrincipalId: contributions[0].delegation.delegatePrincipalId,
          delegationId: contributions[0].delegation.delegationId,
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
};

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
