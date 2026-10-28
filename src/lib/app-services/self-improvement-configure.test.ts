import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServiceCaller } from "./contracts";
import { selfImprovementPolicySchema } from "@/lib/self-improvement/contracts";
const mock = vi.hoisted(() => ({ configure: vi.fn(), source: vi.fn() }));
vi.mock("./contracts", async original => ({ ...await original<typeof import("./contracts")>(),
  appServiceActorBinding: () => ({ canonicalActorId: "actor:owner" }),
  // Synthetic admission; retain the real result envelope and receipt sealing.
  authorizeAppServiceCall: (_caller: unknown, contract: unknown) => ({ contract,
    authoritySha256: "a".repeat(64), idempotencyKeySha256: "b".repeat(64) }) }));
vi.mock("@/lib/self-improvement/store", async original => ({ ...await original<typeof import("@/lib/self-improvement/store")>(), configureSelfImprovement: mock.configure }));
vi.mock("@/lib/app-builder/github", () => ({ resolveBuilderGithubRepository: mock.source }));
import { configureSelfImprovementService } from "./self-improvement";
const caller = { context: { tenantId: "tenant", actorId: "owner@example.test", role: "admin", source: "session" } } as AppServiceCaller;
const input = { projectId: "project", repositoryId: "42", dailyBudgetUsd: 100, autoReleaseRoutineChanges: true };
beforeEach(() => {
  mock.configure.mockReset(); mock.source.mockReset();
  mock.source.mockResolvedValue({ repository: { fullName: "benniejoseph/omniagentos", owner: "benniejoseph", name: "omniagentos", defaultBranch: "main" } });
  mock.configure.mockImplementation(async value => value);
});
describe("Improvement budget configuration", () => {
  it("seals the exact selected cycle allowance and applies the conservative new-policy default", async () => {
    await configureSelfImprovementService(caller, { ...input, maxCycleBudgetUsd: 2 });
    expect(mock.configure).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: "tenant", ownerActorId: "actor:owner",
      policy: expect.objectContaining({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 2 }) }));
    await configureSelfImprovementService(caller, input);
    expect(mock.configure).toHaveBeenLastCalledWith(expect.objectContaining({ policy: expect.objectContaining({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 10 }) }));
    await configureSelfImprovementService(caller, { ...input, dailyBudgetUsd: 3 });
    expect(mock.configure).toHaveBeenLastCalledWith(expect.objectContaining({ policy: expect.objectContaining({ dailyBudgetUsd: 3, maxCycleBudgetUsd: 3 }) }));
  });
  it("rejects invalid cycle allowances before any repository resolution or settings mutation", async () => {
    for (const maxCycleBudgetUsd of [0, -1, 11, Infinity, null]) {
      await expect(configureSelfImprovementService(caller, { ...input, dailyBudgetUsd: 10, maxCycleBudgetUsd })).rejects.toThrow();
    }
    expect(mock.source).not.toHaveBeenCalled(); expect(mock.configure).not.toHaveBeenCalled();
  });
});

describe("owner-admitted engineering token cap", () => {
  it.each([undefined, 600_000])("persists the optional %s cap inside the sealed owner policy", async maxEngineeringTokensPerRun => {
    const result = await configureSelfImprovementService(caller, { ...input, expectedGeneration: 3,
      ...(maxEngineeringTokensPerRun !== undefined ? { maxEngineeringTokensPerRun } : {}) });
    expect(mock.configure).toHaveBeenCalledOnce();
    const saved = mock.configure.mock.calls[0][0];
    expect(saved).toMatchObject({ tenantId: "tenant", ownerActorId: "actor:owner", expectedGeneration: 3,
      policy: { dailyBudgetUsd: 100, maxCycleBudgetUsd: 10 } });
    expect(saved.policy.maxEngineeringTokensPerRun).toBe(maxEngineeringTokensPerRun);
    expect(selfImprovementPolicySchema.parse(saved.policy)).toEqual(saved.policy);
    expect(result.data.configuration.policy).toEqual(saved.policy);
    if (maxEngineeringTokensPerRun === undefined) expect(saved.policy).not.toHaveProperty("maxEngineeringTokensPerRun");
  });
  it("rejects unauthorized or out-of-range configuration before persistence", async () => {
    await expect(configureSelfImprovementService({ ...caller, context: { ...caller.context, role: "operator" } }, { ...input, maxEngineeringTokensPerRun: 600_000 })).rejects.toThrow(/application owner/);
    await expect(configureSelfImprovementService(caller, { ...input, maxEngineeringTokensPerRun: 1_000_001 })).rejects.toThrow();
    expect(mock.configure).not.toHaveBeenCalled();
    expect(mock.source).not.toHaveBeenCalled();
  });
});
