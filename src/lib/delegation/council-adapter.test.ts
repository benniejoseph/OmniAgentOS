import { describe, expect, it } from "vitest";

import { buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { buildCouncilMemberDelegationContractV1 } from "@/lib/delegation/council-adapter";
import { DEFAULT_AGENT_RUN_BUDGET_LIMITS } from "@/lib/runs/budgets";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { ToolDefinition } from "@/lib/tools/types";

describe("P8.1 council delegation adapter", () => {
  it("binds a read-only council contribution to exact parent and child identities", () => {
    const contract = buildCouncilMemberDelegationContractV1({
      authority,
      agentId: "scout",
      goal: "Compare the supplied evidence and identify material uncertainty.",
      mode: "research",
      contextBlock,
      attempt: 1,
      createdAt: "2026-09-07T06:00:00.000Z",
    });

    expect(contract).toMatchObject({
      delegator: { agentId: "atlas", definitionVersion: 1 },
      delegate: { agentId: "scout", definitionVersion: 1 },
      purpose: "council.member.scout",
      grants: {
        contextGrantIds: ["context-one"],
        capabilityGrantIds: [],
        governedToolIds: [],
      },
      budgets: { modelTurns: 1, toolCalls: 0, agents: 1, retries: 0 },
      verifier: {
        agentId: "sentinel",
        method: "deterministic_schema_and_evidence",
      },
    });
    expect(contract.inputArtifacts).toHaveLength(1);
    expect(contract.delegate.principalId).toMatch(
      /^delegated-principal:[a-f0-9]{64}$/,
    );
    expect(contract.inputArtifacts[0].byteCount).toBe(
      Buffer.byteLength(contextBlock, "utf8"),
    );
    expect(JSON.stringify(contract)).not.toContain(contextBlock);
  });

  it("rejects a delegator principal that is not executing the parent run", () => {
    expect(() => buildCouncilMemberDelegationContractV1({
      authority: {
        ...authority,
        delegator: { ...authority.delegator, principalId: "principal:other" },
      },
      agentId: "forge",
      goal: "Build the artifact.",
      mode: "execute",
      contextBlock: "",
      attempt: 1,
    })).toThrow(/does not match its execution scope/);
  });

  it("attenuates an exact governed tool set and budgets its planning turn", () => {
    const contract = buildCouncilMemberDelegationContractV1({
      authority: {
        ...authority,
        governedToolIds: [tool.id],
      },
      agentId: "scout",
      goal: "Find the supporting release evidence.",
      mode: "research",
      contextBlock,
      attempt: 1,
      tools: [tool],
      createdAt: "2026-09-07T06:00:00.000Z",
    });
    expect(contract).toMatchObject({
      grants: {
        governedToolIds: [tool.id],
        capabilityGrantIds: ["capability-one"],
      },
      budgets: { modelTurns: 2, toolCalls: 3, browserActions: 0 },
    });
  });
});

const tenantId = "tenant-one";
const actorId = "actor-one";
const atlas = buildBuiltInAgentIdentityV1({
  agentId: "atlas",
  tenantId,
  controllerActorId: actorId,
});
const executionScope = createExecutionScope({
  tenantId,
  initiatingActorId: actorId,
  executingPrincipalType: "agent",
  executingPrincipalId: atlas.principal.principalId,
  correlationId: "run-one",
  contextGrantIds: ["context-one"],
  capabilityGrantIds: ["capability-one"],
  purpose: "agent.run",
});
const authority = {
  parentExecutionId: "run-one",
  executionScope,
  delegator: {
    principalId: atlas.principal.principalId,
    agentId: atlas.definition.logicalAgentId,
    definitionVersion: atlas.definition.definitionVersion,
  },
  parentBudgets: DEFAULT_AGENT_RUN_BUDGET_LIMITS,
  remainingWallTimeMs: 120_000,
  governedToolIds: [],
  connectorTargets: [],
};
const contextBlock = "[memory:one] The first source supports the release boundary.";
const tool: ToolDefinition = {
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
