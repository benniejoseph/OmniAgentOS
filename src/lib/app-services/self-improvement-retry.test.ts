import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServiceCaller } from "./contracts";
import type { StoredSelfImprovementCycle } from "@/lib/self-improvement/store";
import { createSelfImprovementPolicy } from "@/lib/self-improvement/policy";
const mock = vi.hoisted(() => ({ configuration: vi.fn(), retry: vi.fn(), enqueue: vi.fn(), source: vi.fn(), owner: vi.fn() }));
vi.mock("./contracts", () => ({ appServiceActorBinding: () => ({ canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" }), authorizeAppServiceCall: () => ({}), completeAppServiceCall: (_call: unknown, data: unknown) => data }));
vi.mock("@/lib/self-improvement/store", async original => ({ ...await original<typeof import("@/lib/self-improvement/store")>(),
  getSelfImprovementConfiguration: mock.configuration, retryPreAiSelfImprovementCycle: mock.retry, assertConfiguredSelfImprovementOwner: mock.owner }));
vi.mock("@/lib/self-improvement/scheduler", () => ({ enqueueSelfImprovementCycle: mock.enqueue }));
vi.mock("@/lib/app-builder/github", () => ({ resolveBuilderGithubRepository: mock.source }));
import { retrySelfImprovementService } from "./self-improvement";
const owner = { tenantId: "candidate", ownerActorId: "actor:11111111-1111-4111-8111-111111111111" };
const caller = { context: { tenantId: owner.tenantId, actorId: "owner@example.test", role: "admin", source: "session" }, idempotencyKey: "explicit-retry" } as AppServiceCaller;
const input = { configurationId: "config", expectedGeneration: 3, failedCycleId: "failed", expectedRevision: 5 };
const lineage = { cycleId: "failed", revision: 5, cycleSha256: "a".repeat(64), toolExecutionId: "tool", toolReceiptSha256: "b".repeat(64) };
let stored: StoredSelfImprovementCycle;
beforeEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
  const now = new Date().toISOString(), policy = createSelfImprovementPolicy({ dailyBudgetUsd: 10 });
  stored = { configurationId: "config", configurationGeneration: 3, projectId: "project", repositoryId: "42", day: now.slice(0, 10), leaseExpiresAt: now,
    runtime: {}, spendUsd: 0, usageState: "known", controllerId: null, controllerHold: null,
    cycle: { id: "new-cycle", scope: { ...owner, repository: { owner: "asael", name: "app", defaultBranch: "main" }, baseRevision: "c".repeat(40) }, policy,
      stage: "observing", revision: 1, signal: null, candidate: null, validation: null, approval: null, release: null, releaseReceipt: null,
      correctionsUsed: 0, dailyReservationUsd: 10, createdAt: now, updatedAt: now } };
  mock.configuration.mockResolvedValue({ id: "config", generation: 3, repositoryId: "42", repository: stored.cycle.scope.repository });
  mock.source.mockResolvedValue({ baseSha: "c".repeat(40), repository: stored.cycle.scope.repository });
  mock.retry.mockResolvedValue({ outcome: "claimed", cycle: stored, retryOf: lineage });
  mock.enqueue.mockResolvedValue({ id: "job", tenantId: owner.tenantId, type: "self_improvement.cycle.tick", status: "queued", payload: { actorId: owner.ownerActorId, cycleId: "new-cycle" } });
});
describe("explicit owner setup retry", () => {
  it("binds a new baseline and preserves failed-parent lineage without resuming or changing settings", async () => {
    expect(await retrySelfImprovementService(caller, input)).toEqual({ outcome: "claimed", cycle: expect.objectContaining({ id: "new-cycle", phase: "setup" }),
      operationJob: { id: "job", type: "self_improvement.cycle.tick", status: "queued" }, retryOf: lineage });
    expect(mock.retry).toHaveBeenCalledWith({ owner, ...input, baseRevision: "c".repeat(40) });
    expect(mock.enqueue).toHaveBeenCalledOnce();
  });
  it("rejects service/agent execution, non-admin owners and stale settings before admission", async () => {
    await expect(retrySelfImprovementService({ ...caller, context: { ...caller.context, source: "service" } }, input)).rejects.toThrow(/authenticated/);
    await expect(retrySelfImprovementService({ ...caller, context: { ...caller.context, role: "operator" } }, input)).rejects.toThrow(/authenticated/);
    await expect(retrySelfImprovementService(caller, { ...input, expectedGeneration: 2 })).rejects.toThrow(/current/);
    expect(mock.retry).not.toHaveBeenCalled(); expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("never queues an ineligible, paused or terminal retry and rejects a foreign queue receipt", async () => {
    mock.retry.mockResolvedValue({ outcome: "paused" });
    expect(await retrySelfImprovementService(caller, input)).toEqual({ outcome: "paused", cycle: null, operationJob: null, retryOf: null });
    mock.retry.mockResolvedValue({ outcome: "duplicate", cycle: { ...stored, cycle: { ...stored.cycle, stage: "failed" } }, retryOf: lineage });
    expect(await retrySelfImprovementService(caller, input)).toMatchObject({ operationJob: null, retryOf: lineage });
    expect(mock.enqueue).not.toHaveBeenCalled();
    mock.retry.mockResolvedValue({ outcome: "claimed", cycle: stored, retryOf: lineage });
    mock.enqueue.mockResolvedValue({ type: "self_improvement.cycle.tick", tenantId: "foreign", payload: {} });
    await expect(retrySelfImprovementService(caller, input)).rejects.toThrow(/admitted owner/);
  });
  it("rejects repository identity or default-branch drift before admission", async () => {
    for (const change of [{ owner: "other" }, { name: "different" }, { defaultBranch: "new-main" }]) {
      mock.source.mockResolvedValue({ baseSha: "c".repeat(40), repository: { ...stored.cycle.scope.repository, ...change } });
      await expect(retrySelfImprovementService(caller, input)).rejects.toThrow(/identity or default branch/);
    }
    expect(mock.retry).not.toHaveBeenCalled(); expect(mock.enqueue).not.toHaveBeenCalled();
  });
});
