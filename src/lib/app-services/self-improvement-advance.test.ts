import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServiceCaller } from "./contracts";
import type { StoredSelfImprovementCycle } from "@/lib/self-improvement/store";
import { createSelfImprovementPolicy } from "@/lib/self-improvement/policy";
import { initialSelfImprovementRuntime } from "@/lib/self-improvement/runtime";
const mock = vi.hoisted(() => ({ get: vi.fn(), configuration: vi.fn(), pin: vi.fn(), execute: vi.fn() }));
vi.mock("./contracts", () => ({ appServiceActorBinding: () => ({ canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" }), authorizeAppServiceCall: () => ({}), completeAppServiceCall: (_call: unknown, data: unknown) => data }));
vi.mock("@/lib/self-improvement/store", async original => ({ ...await original<typeof import("@/lib/self-improvement/store")>(), getSelfImprovementCycle: mock.get,
  getSelfImprovementConfiguration: mock.configuration, assertConfiguredSelfImprovementOwner: mock.pin }));
vi.mock("@/lib/self-improvement/worker", () => ({ executeSelfImprovementJob: mock.execute }));
vi.mock("@/lib/self-improvement/scheduler", () => ({ enqueueSelfImprovementCycle: vi.fn() }));
import { advanceSelfImprovementService } from "./self-improvement";
const owner = { tenantId: "candidate", ownerActorId: "actor:11111111-1111-4111-8111-111111111111" };
const caller = { context: { tenantId: owner.tenantId, actorId: "owner@example.test", role: "admin", source: "session" }, idempotencyKey: "advance-one" } as AppServiceCaller;
let stored: StoredSelfImprovementCycle;
const configuration = (paused = false, generation = 2) => ({ ...owner, id: stored.configurationId, projectId: stored.projectId, repositoryId: stored.repositoryId,
  repository: stored.cycle.scope.repository, paused, generation, policy: stored.cycle.policy });
beforeEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
  const now = new Date().toISOString(), policy = createSelfImprovementPolicy({ maxCycleBudgetUsd: 100 });
  stored = { configurationId: "config", configurationGeneration: 2, projectId: "project", repositoryId: "42", day: now.slice(0, 10),
    leaseExpiresAt: new Date(0).toISOString(), runtime: initialSelfImprovementRuntime(), spendUsd: 0, usageState: "known", controllerId: null, controllerHold: null,
    cycle: { id: "cycle", scope: { ...owner, repository: { owner: "asael", name: "app", defaultBranch: "main" }, baseRevision: "a".repeat(40) }, policy,
      stage: "observing", revision: 7, signal: null, candidate: null, validation: null, approval: null, release: null, releaseReceipt: null,
      correctionsUsed: 0, dailyReservationUsd: 100, createdAt: now, updatedAt: now } };
  mock.get.mockImplementation(async () => stored);
  mock.configuration.mockImplementation(async () => configuration());
  mock.execute.mockImplementation(async () => { stored = { ...stored, cycle: { ...stored.cycle, revision: 9 }, runtime: { ...stored.runtime, setupStep: "bind" } };
    return { __deferOperation: true, resourceId: "cycle", delaySeconds: 2 }; });
});
describe("one owner-authorized improvement phase", () => {
  it("advances only the admitted exact revision and rejects a repeated old request", async () => {
    const result = await advanceSelfImprovementService(caller, { cycleId: "cycle", expectedRevision: 7 });
    expect(result).toMatchObject({ cycle: { id: "cycle", revision: 9 } });
    expect(mock.pin).toHaveBeenCalledWith(owner);
    expect(mock.execute).toHaveBeenCalledWith({ tenantId: owner.tenantId, payload: { actorId: owner.ownerActorId, cycleId: "cycle" } }, expect.any(AbortSignal), 7);
    await expect(advanceSelfImprovementService(caller, { cycleId: "cycle", expectedRevision: 7 })).rejects.toThrow(/revision changed/);
    expect(mock.execute).toHaveBeenCalledOnce();
  });
  it("does not accept internal-header or non-admin callers", async () => {
    await expect(advanceSelfImprovementService({ ...caller, context: { ...caller.context, source: "headers" } }, { cycleId: "cycle", expectedRevision: 7 })).rejects.toThrow(/authenticated application owner/);
    await expect(advanceSelfImprovementService({ ...caller, context: { ...caller.context, role: "operator" } }, { cycleId: "cycle", expectedRevision: 7 })).rejects.toThrow(/authenticated application owner/);
    expect(mock.get).not.toHaveBeenCalled(); expect(mock.execute).not.toHaveBeenCalled();
  });
  it("preserves an active executor lease, policy pause, and unknown usage hold", async () => {
    stored = { ...stored, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
    await expect(advanceSelfImprovementService(caller, { cycleId: "cycle", expectedRevision: 7 })).rejects.toThrow(/Another executor/);
    stored = { ...stored, leaseExpiresAt: new Date(0).toISOString() };
    mock.configuration.mockResolvedValue(configuration(true));
    await expect(advanceSelfImprovementService(caller, { cycleId: "cycle", expectedRevision: 7 })).rejects.toThrow(/paused/);
    mock.configuration.mockResolvedValue(configuration()); stored = { ...stored, usageState: "unknown" };
    await expect(advanceSelfImprovementService(caller, { cycleId: "cycle", expectedRevision: 7 })).rejects.toThrow(/usage reconciliation/);
    expect(mock.execute).not.toHaveBeenCalled();
  });
  it("resumes the admitted phase after pause generations change but refuses repository drift", async () => {
    mock.configuration.mockResolvedValue(configuration(false, 4));
    await expect(advanceSelfImprovementService(caller, { cycleId: "cycle", expectedRevision: 7 })).resolves.toMatchObject({ cycle: { revision: 9 } });
    mock.configuration.mockResolvedValue({ ...configuration(false, 5), repository: { ...stored.cycle.scope.repository, defaultBranch: "different" } });
    await expect(advanceSelfImprovementService(caller, { cycleId: "cycle", expectedRevision: 9 })).rejects.toThrow(/repository changed/);
    expect(mock.execute).toHaveBeenCalledOnce();
  });
  it("never advances a settled cycle or a cancelled HTTP request", async () => {
    stored = { ...stored, cycle: { ...stored.cycle, stage: "no_change" } };
    await expect(advanceSelfImprovementService(caller, { cycleId: "cycle", expectedRevision: 7 })).rejects.toThrow(/no coding phase/);
    await expect(advanceSelfImprovementService(caller, { cycleId: "cycle", expectedRevision: 7 }, { abortSignal: AbortSignal.abort() })).rejects.toThrow();
    expect(mock.execute).not.toHaveBeenCalled();
  });
});
