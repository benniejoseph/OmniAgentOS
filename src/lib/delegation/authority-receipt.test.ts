import { describe, expect, it } from "vitest";

import { buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import {
  buildDelegationAuthorityReceiptV1,
  parseDelegationAuthorityReceiptV1,
} from "@/lib/delegation/authority-receipt";
import { buildCouncilMemberDelegationContractV1 } from "@/lib/delegation/council-adapter";
import { buildDelegationTaskV1 } from "@/lib/delegation/lifecycle";
import { DEFAULT_AGENT_RUN_BUDGET_LIMITS } from "@/lib/runs/budgets";
import { createExecutionScope } from "@/lib/security/execution-scope";

describe("P11.5 delegation authority receipt", () => {
  it("records only the exact attenuated grants and rejects tampering", () => {
    const contract = contractFixture();
    const receipt = buildDelegationAuthorityReceiptV1(
      contract,
      buildDelegationTaskV1(contract),
    );

    expect(receipt).toMatchObject({
      purpose: "council.member.scout",
      scope: { projectId: "project-one", missionId: "mission-one" },
      grants: {
        contextGrantIds: ["context-one"],
        capabilityGrantIds: [],
        governedToolIds: [],
      },
      verifier: { agentId: "sentinel", definitionVersion: 1 },
    });
    expect(() => parseDelegationAuthorityReceiptV1({
      ...receipt,
      grants: { ...receipt.grants, contextGrantIds: ["context-other"] },
    })).toThrow(/integrity is invalid/);
  });
});

export function contractFixture() {
  const atlas = buildBuiltInAgentIdentityV1({
    agentId: "atlas",
    tenantId: "tenant-one",
    controllerActorId: "actor-one",
  });
  const executionScope = createExecutionScope({
    tenantId: "tenant-one",
    initiatingActorId: "actor-one",
    executingPrincipalType: "agent",
    executingPrincipalId: atlas.principal.principalId,
    projectId: "project-one",
    missionId: "mission-one",
    correlationId: "run-one",
    contextGrantIds: ["context-one"],
    capabilityGrantIds: ["capability-one"],
    purpose: "agent.run",
  });
  return buildCouncilMemberDelegationContractV1({
    authority: {
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
    },
    agentId: "scout",
    goal: "Verify the release evidence.",
    mode: "research",
    contextBlock: "Authorized evidence context.",
    attempt: 1,
    createdAt: "2026-09-07T06:00:00.000Z",
  });
}
