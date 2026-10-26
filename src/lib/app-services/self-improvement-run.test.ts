import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServiceCaller } from "./contracts";
import type { StoredSelfImprovementCycle } from "@/lib/self-improvement/store";
import { createSelfImprovementPolicy } from "@/lib/self-improvement/policy";
import { initialSelfImprovementRuntime } from "@/lib/self-improvement/runtime";
const mock = vi.hoisted(() => ({ configuration: vi.fn(), claim: vi.fn(), enqueue: vi.fn(), source: vi.fn() }));
vi.mock("./contracts", () => ({ appServiceActorBinding: () => ({ canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" }), authorizeAppServiceCall: () => ({}), completeAppServiceCall: (_call: unknown, data: unknown) => data }));
vi.mock("@/lib/self-improvement/store", async original => ({ ...await original<typeof import("@/lib/self-improvement/store")>(),
  getSelfImprovementConfiguration: mock.configuration, claimManualSelfImprovementCycle: mock.claim }));
vi.mock("@/lib/self-improvement/scheduler", () => ({ enqueueSelfImprovementCycle: mock.enqueue }));
vi.mock("@/lib/app-builder/github", () => ({ resolveBuilderGithubRepository: mock.source }));
import { runSelfImprovementService } from "./self-improvement";
const owner = { tenantId: "candidate", ownerActorId: "actor:11111111-1111-4111-8111-111111111111" };
const caller = { context: { tenantId: owner.tenantId, actorId: "owner@example.test", role: "admin", source: "session" }, idempotencyKey: "one-cycle" } as AppServiceCaller;
const input = { configurationId: "config", expectedGeneration: 2 };
let stored: StoredSelfImprovementCycle;
const job = () => ({ id: "11111111-1111-4111-8111-111111111112", type: "self_improvement.cycle.tick", status: "queued",
  tenantId: owner.tenantId, payload: { actorId: owner.ownerActorId, cycleId: "cycle" }, leaseOwner: "private", dedupeKey: "private" });
beforeEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
  const now = new Date().toISOString(), policy = createSelfImprovementPolicy({});
  stored = { configurationId: "config", configurationGeneration: 2, projectId: "project", repositoryId: "42", day: now.slice(0, 10),
    leaseExpiresAt: new Date(0).toISOString(), runtime: initialSelfImprovementRuntime(), spendUsd: 0, usageState: "known", controllerId: null, controllerHold: null,
    cycle: { id: "cycle", scope: { ...owner, repository: { owner: "asael", name: "app", defaultBranch: "main" }, baseRevision: "a".repeat(40) }, policy,
      stage: "observing", revision: 1, signal: null, candidate: null, validation: null, approval: null, release: null, releaseReceipt: null,
      correctionsUsed: 0, dailyReservationUsd: 100, createdAt: now, updatedAt: now } };
  mock.configuration.mockResolvedValue({ id: "config", generation: 2, repositoryId: "42" });
  mock.source.mockResolvedValue({ baseSha: "a".repeat(40) });
  mock.claim.mockResolvedValue({ outcome: "claimed", cycle: stored });
  mock.enqueue.mockResolvedValue(job());
});
describe("admitted improvement queue receipt", () => {
  it("returns only the exact owned operation identity for scoped job readback", async () => {
    const result = await runSelfImprovementService(caller, input);
    expect(result).toEqual({ outcome: "claimed", cycle: expect.objectContaining({ id: "cycle" }),
      operationJob: { id: job().id, type: "self_improvement.cycle.tick", status: "queued" } });
    expect(mock.claim).toHaveBeenCalledWith({ owner, ...input, baseRevision: "a".repeat(40), idempotencyKey: "one-cycle" });
    expect(mock.enqueue).toHaveBeenCalledWith(stored);
  });
  it("does not enqueue missing or terminal cycles", async () => {
    mock.claim.mockResolvedValue({ outcome: "budget_exhausted", cycle: null });
    expect(await runSelfImprovementService(caller, input)).toEqual({ outcome: "budget_exhausted", cycle: null, operationJob: null });
    mock.claim.mockResolvedValue({ outcome: "duplicate", cycle: { ...stored, cycle: { ...stored.cycle, stage: "no_change" } } });
    expect(await runSelfImprovementService(caller, input)).toMatchObject({ operationJob: null });
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("rejects a queue result with a different tenant, owner, cycle or type", async () => {
    for (const changed of [{ tenantId: "other" }, { type: "another.job" },
      { payload: { ...job().payload, actorId: "foreign" } }, { payload: { ...job().payload, cycleId: "other" } }]) {
      mock.enqueue.mockResolvedValue({ ...job(), ...changed });
      await expect(runSelfImprovementService(caller, input)).rejects.toThrow(/admitted owner and cycle/);
    }
  });
});
