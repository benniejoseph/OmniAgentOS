import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServiceCaller } from "./contracts";
import { createSelfImprovementPolicy } from "@/lib/self-improvement/policy";
import { initialSelfImprovementRuntime } from "@/lib/self-improvement/runtime";
import { improvementCycleResponseSchema } from "@/lib/self-improvement/app-contracts";
import type { StoredSelfImprovementCycle } from "@/lib/self-improvement/store";
const mock = vi.hoisted(() => ({ read: vi.fn(), retry: vi.fn() }));
vi.mock("@/lib/self-improvement/store", async original => ({ ...await original<typeof import("@/lib/self-improvement/store")>(),
  getSelfImprovementCycle: mock.read, getSelfImprovementSetupRetry: mock.retry }));
import { readSelfImprovementCycleService } from "./self-improvement";

const userId = "11111111-1111-4111-8111-111111111111", now = "2026-10-26T12:00:00.000Z";
const owner = { tenantId: "native-tenant", ownerActorId: `actor:${userId}` };
const cycleId = `self_cycle_${"a".repeat(64)}`;
const caller = (tenantId = owner.tenantId, id = userId) => createAppServiceCaller({ context: {
  tenantId, actorId: "owner@example.test", role: "admin", source: "mobile",
  auth: { userId: id, email: "owner@example.test", sessionId: "native-session", tenantName: "Native" },
  native: { deviceId: "mac", platform: "macos", clientContractVersion: 62 },
} });
let stored: StoredSelfImprovementCycle;
beforeEach(() => {
  mock.read.mockReset(); mock.retry.mockReset();
  stored = { configurationId: "config", configurationGeneration: 2, projectId: "project", repositoryId: "42", day: now.slice(0, 10),
    leaseExpiresAt: now, leaseToken: "private-store-lease", runtime: initialSelfImprovementRuntime(), spendUsd: 0, usageState: "known", controllerId: null, controllerHold: null,
    cycle: { id: cycleId, scope: { ...owner, repository: { owner: "asael", name: "app", defaultBranch: "main" }, baseRevision: "b".repeat(40) },
      policy: createSelfImprovementPolicy({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 10 }), stage: "observing", revision: 1,
      signal: null, candidate: null, validation: null, approval: null, release: null, releaseReceipt: null,
      correctionsUsed: 0, dailyReservationUsd: 10, leaseToken: "private-cycle-lease", createdAt: now, updatedAt: now } };
  mock.read.mockImplementation(async (scope, id) => scope.tenantId === owner.tenantId && scope.ownerActorId === owner.ownerActorId && id === cycleId ? stored : null);
});
describe("exact retained improvement cycle read", () => {
  it("binds native auth to the canonical owner and returns the published exact evidence shape", async () => {
    const result = await readSelfImprovementCycleService(caller(), cycleId);
    expect(mock.read).toHaveBeenCalledWith(owner, cycleId);
    expect(improvementCycleResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt }).cycle).toMatchObject({ id: cycleId, revision: 1, policy: { dailyBudgetUsd: 100, maxCycleBudgetUsd: 10 }, setupRetryAvailable: false });
    expect(result.receipt).toMatchObject({ operation: "app.self_improvement.show", accessMode: "read", idempotencyKeySha256: null });
    expect(JSON.stringify(result)).not.toMatch(/private-store-lease|private-cycle-lease|leaseToken|controllerId/);
  });
  it("does not expose an existing cycle from another tenant or canonical actor", async () => {
    expect((await readSelfImprovementCycleService(caller("foreign"), cycleId)).data.cycle).toBeNull();
    expect((await readSelfImprovementCycleService(caller(owner.tenantId, "22222222-2222-4222-8222-222222222222"), cycleId)).data.cycle).toBeNull();
    expect((await readSelfImprovementCycleService(caller(), `self_cycle_${"c".repeat(64)}`)).data.cycle).toBeNull();
    expect(mock.retry).not.toHaveBeenCalled();
  });
  it("never treats an email label as a native owner without authenticated identity", async () => {
    await expect(readSelfImprovementCycleService(createAppServiceCaller({ context: {
      tenantId: owner.tenantId, actorId: "owner@example.test", role: "admin", source: "mobile",
    } }), cycleId)).rejects.toThrow(/authenticated owner/);
    expect(mock.read).not.toHaveBeenCalled();
  });
  it("asks the existing recovery eligibility service only for the exact failed zero-spend record", async () => {
    stored = { ...stored, cycle: { ...stored.cycle, stage: "failed" } }; mock.retry.mockResolvedValue({ cycleId });
    expect((await readSelfImprovementCycleService(caller(), cycleId)).data.cycle?.setupRetryAvailable).toBe(true);
    expect(mock.retry).toHaveBeenCalledWith(owner, cycleId);
  });
});
