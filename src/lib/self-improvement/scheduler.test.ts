import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  enqueue: vi.fn(), claim: vi.fn(), due: vi.fn(), runnable: vi.fn(), stored: vi.fn(), notify: vi.fn(), release: vi.fn(),
}));
vi.mock("@/lib/app-builder/github", () => ({ resolveBuilderGithubRepository: async () => ({ baseSha: "a".repeat(40), repository: { owner: "asael", name: "app", defaultBranch: "main" } }) }));
vi.mock("@/lib/operations/job-queue", () => ({ enqueueOperationJob: fixture.enqueue }));
vi.mock("./store", () => ({ claimDueSelfImprovementCycles: fixture.claim, listDueSelfImprovementConfigurations: fixture.due,
  listRunnableSelfImprovementCyclesForTenant: fixture.runnable, getSelfImprovementCycle: fixture.stored, releaseSelfImprovementExecutionLease: fixture.release }));
vi.mock("./notifications", () => ({ processDueSelfImprovementNotificationsForTenant: fixture.notify }));
import { processDueSelfImprovementForTenant } from "./scheduler";
const stored = { cycle: { id: "cycle", scope: { tenantId: "tenant", ownerActorId: "owner" }, revision: 1 } };
beforeEach(() => { vi.clearAllMocks(); fixture.runnable.mockResolvedValue([]); fixture.due.mockResolvedValue([]); fixture.stored.mockResolvedValue(stored); });
describe("self-improvement scheduling recovery", () => {
  it("repairs a claim-to-enqueue interruption without creating a new cycle or releasing another worker's lease", async () => {
    fixture.runnable.mockResolvedValue([{ ownerActorId: "owner", cycleId: "cycle" }]);
    await processDueSelfImprovementForTenant({ tenantId: "tenant", deadlineAt: Date.now() + 60_000 });
    expect(fixture.enqueue).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "self-improvement:cycle", dedupeMode: "idempotent", maxAttempts: 1 }));
    expect(fixture.claim).not.toHaveBeenCalled(); expect(fixture.release).not.toHaveBeenCalled(); expect(fixture.notify).toHaveBeenCalledTimes(1);
  });
  it("resolves one exact repository head and yields its fresh lease before enqueuing", async () => {
    fixture.due.mockResolvedValue([{ id: "config", ownerActorId: "owner", generation: 2, repositoryId: "1", repository: { owner: "asael", name: "app", defaultBranch: "main" } }]);
    fixture.claim.mockResolvedValue([{ outcome: "claimed", cycle: { ...stored, leaseToken: "new-lease" } }]);
    await processDueSelfImprovementForTenant({ tenantId: "tenant", deadlineAt: Date.now() + 60_000 });
    expect(fixture.claim).toHaveBeenCalledWith({ tenantId: "tenant", targets: [{ configurationId: "config", ownerActorId: "owner", expectedGeneration: 2, baseRevision: "a".repeat(40) }] });
    expect(fixture.release).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1, leaseToken: "new-lease" }));
    expect(fixture.enqueue).toHaveBeenCalledTimes(1);
  });
});
