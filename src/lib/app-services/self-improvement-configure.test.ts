import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServiceCaller } from "./contracts";
const mock = vi.hoisted(() => ({ configure: vi.fn(), source: vi.fn() }));
vi.mock("./contracts", () => ({ appServiceActorBinding: () => ({ canonicalActorId: "actor:owner" }),
  authorizeAppServiceCall: () => ({}), completeAppServiceCall: (_call: unknown, data: unknown) => data }));
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
