import { describe, expect, it } from "vitest";

import {
  A2ASafetyError,
  buildA2ASafetyReservationV1,
  EXTERNAL_A2A_BUDGET_LIMITS,
  EXTERNAL_A2A_SAFETY_POLICY,
} from "@/lib/a2a/safety";
import {
  buildA2APeerRolloutV1,
  transitionA2APeerRolloutV1,
} from "@/lib/a2a/rollout";
import { buildContract } from "@/lib/delegation/test-fixtures";
import { DEFAULT_AGENT_RUN_BUDGET_LIMITS } from "@/lib/runs/budgets";

describe("external A2A safety policy", () => {
  it("pins lower authority and builds a digest-bound reservation", () => {
    for (const dimension of Object.keys(EXTERNAL_A2A_BUDGET_LIMITS) as Array<
      keyof typeof EXTERNAL_A2A_BUDGET_LIMITS
    >) {
      expect(EXTERNAL_A2A_BUDGET_LIMITS[dimension]).toBeLessThanOrEqual(
        DEFAULT_AGENT_RUN_BUDGET_LIMITS[dimension],
      );
    }
    const reservation = buildA2ASafetyReservationV1({
      contract: buildContract(),
      internalTaskId: "delegation-task:one",
      rollout: rollout(),
      lineage: lineage(),
      createdAt: "2026-09-07T06:00:30.000Z",
    });
    expect(reservation).toMatchObject({
      trustTier: "external_untrusted",
      forceMutationApproval: true,
      canRedelegate: false,
      recursionDepth: 0,
      rootDelegationId: "delegation:one",
      maxToolCalls: 1,
    });
    expect(reservation.safetyId).toBe(`a2a-safety:${reservation.safetySha256}`);
  });

  it.each([
    ["cycle", { ancestorPeerIds: ["peer:one"], ancestorDelegationIds: ["delegation:parent"] }],
    ["recursion", {
      ancestorPeerIds: ["peer:a", "peer:b", "peer:c"],
      ancestorDelegationIds: ["delegation:a", "delegation:b", "delegation:c"],
    }],
    ["fan_out", { activeSiblingCount: EXTERNAL_A2A_SAFETY_POLICY.maxActiveFanOutPerParent }],
    ["root_budget", { activeRootReservedCostMicrousd: 950_001 }],
  ] as const)("fails closed for %s", (_label, overrides) => {
    expect(() => buildA2ASafetyReservationV1({
      contract: buildContract(),
      internalTaskId: "delegation-task:one",
      rollout: rollout(),
      lineage: lineage(overrides),
      createdAt: "2026-09-07T06:00:30.000Z",
    })).toThrow(A2ASafetyError);
  });

  it("rejects external budgets and deadlines above their conservative caps", () => {
    expect(() => buildA2ASafetyReservationV1({
      contract: buildContract({
        budgets: { ...buildContract().budgets, toolCalls: 5 },
      }),
      internalTaskId: "delegation-task:one",
      rollout: rollout(),
      lineage: lineage(),
      createdAt: "2026-09-07T06:00:30.000Z",
    })).toThrow(/lower-authority limit/i);

    const contract = buildContract({
      deadline: {
        createdAt: "2026-09-07T06:00:00.000Z",
        acceptBy: "2026-09-07T06:01:00.000Z",
        completeBy: "2026-09-07T06:06:00.000Z",
      },
    });
    expect(() => buildA2ASafetyReservationV1({
      contract,
      internalTaskId: "delegation-task:one",
      rollout: rollout(),
      lineage: lineage(),
      createdAt: "2026-09-07T06:00:30.000Z",
    })).toThrow(/deadline/i);
  });
});

type TestLineage = {
  ancestorDelegationIds: readonly string[];
  ancestorPeerIds: readonly string[];
  rootDelegationId: string;
  activeSiblingCount: number;
  activeRootTaskCount: number;
  activeRootReservedCostMicrousd: number;
};

function lineage(overrides: Partial<TestLineage> = {}): TestLineage {
  return {
    ancestorDelegationIds: [] as string[],
    ancestorPeerIds: [] as string[],
    rootDelegationId: "delegation:one",
    activeSiblingCount: 0,
    activeRootTaskCount: 0,
    activeRootReservedCostMicrousd: 0,
    ...overrides,
  };
}

function rollout() {
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
