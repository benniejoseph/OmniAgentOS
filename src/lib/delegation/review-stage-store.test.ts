import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), ensure: vi.fn() }));
vi.mock("@/lib/db/client", async original => ({
  ...await original<typeof import("@/lib/db/client")>(),
  hasDatabaseUrl: () => true, ensureDatabaseSchema: mocks.ensure,
  getSql: () => ({ transaction: mocks.transaction }),
  runWithDatabaseActorScope: async (_tenant: string, _owners: string[], work: () => unknown) => work(),
}));
import { buildAgentRunIdentityPinV1, buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { buildExecutionContract, executionParentBudgets } from "@/lib/delegation/test-fixtures";
import { executionScopeFromDelegationContract } from "@/lib/delegation/runtime";
import { DYNAMIC_DELEGATION_LIFECYCLE_BUDGET, dynamicDelegationReviewPolicy } from "@/lib/delegation/runtime-policy";
import { getDelegationReviewStages } from "@/lib/delegation/review-stage-store";

describe("review-stage immutable policy admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Stop at the transaction boundary: this fixture proves admission, not SQL.
    mocks.transaction.mockRejectedValue(new Error("admitted to transaction"));
  });
  it.each([[180_000, 180_000], [240_000, 240_000], [180_000, 240_000], [240_000, 180_000]])(
    "binds lifecycle %d to its exact policy %d", async (wallTimeMs, policyWallTimeMs) => {
      const budgets = { ...DYNAMIC_DELEGATION_LIFECYCLE_BUDGET, wallTimeMs };
      const policy = dynamicDelegationReviewPolicy({ ...budgets, wallTimeMs: policyWallTimeMs });
      const base = buildExecutionContract();
      const contract = buildExecutionContract({ budgets,
        parentAuthority: { grants: base.grants, budgets: { ...executionParentBudgets, tokens: 104_000 }, completeBy: base.deadline.completeBy },
        verifier: { verifierContractId: base.verifier.verifierContractId, verifierPolicyId: policy.id,
          verifierPolicySha256: policy.sha256, runtimeAssignment: base.verifier.runtimeAssignment,
          method: "agent_then_deterministic", requiredEvidenceKinds: base.verifier.requiredEvidenceKinds,
          acceptanceThreshold: 0.8, completionDisposition: "proposed_only", parentAcceptanceRequired: true,
          identityPin: buildAgentRunIdentityPinV1({ runId: "run-verifier", identity: buildBuiltInAgentIdentityV1({
            agentId: "sentinel", tenantId: "tenant-one", controllerActorId: "actor-one",
          }) }),
        },
      });
      await expect(getDelegationReviewStages({ contract, executionScope: executionScopeFromDelegationContract(contract) }))
        .rejects.toThrow(wallTimeMs === policyWallTimeMs ? "admitted to transaction" : "authority does not match");
      expect(mocks.transaction).toHaveBeenCalledTimes(wallTimeMs === policyWallTimeMs ? 1 : 0);
    },
  );
});
