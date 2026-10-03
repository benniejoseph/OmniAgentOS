import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResponsibilityError } from "./state";
import { runtimeConfiguration, runtimeHead, runtimeId, runtimeNow, runtimeOwner } from "./runtime-test-fixtures";
const mocks = vi.hoisted(() => ({ sql: vi.fn(), head: vi.fn(), draft: vi.fn(), persist: vi.fn(), resolve: vi.fn(), next: vi.fn(), reconcile: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ ensureDatabaseSchema: vi.fn(), hasDatabaseUrl: () => true, getSql: () => mocks.sql,
  runWithDatabaseActorScope: (_tenant: string, _actors: string[], work: () => unknown) => work(),
  runWithDatabaseSystemScope: (_reason: string, work: () => unknown) => work(), runWithManagedDatabaseTransaction: (_sql: unknown, work: () => unknown) => work() }));
vi.mock("./lifecycle-store", () => ({ withResponsibilityRuntimeTransaction: (_owner: unknown, work: (sql: unknown) => unknown) => work(mocks.sql),
  readRuntimeHead: mocks.head, readRuntimeDraft: mocks.draft, readRuntimeWake: vi.fn(), persistRuntimeTransition: mocks.persist,
  runtimeDatabaseNow: () => "2026-10-04T00:16:00.000Z", wakeFromRow: (row: { snapshot: unknown }) => row.snapshot }));
vi.mock("./runtime-references", () => ({ resolveResponsibilityPilot: mocks.resolve, nextPilotDue: mocks.next, resolveRuntimeOwnerContext: vi.fn(),
  assertSamePilot: (actual: { configurationSha256: string }, expected: { configurationSha256: string }) => {
    if (actual.configurationSha256 !== expected.configurationSha256) throw new ResponsibilityError("Changed", 409, "responsibility_authority_changed");
  } }));
vi.mock("./runtime", () => ({ reconcileResponsibilityWake: mocks.reconcile }));
vi.mock("@/lib/workflows/store", () => ({ createWorkflowRun: mocks.create }));
import { processDueResponsibilities } from "./scheduler";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.sql.mockImplementation(async (parts: TemplateStringsArray) => parts.join("?").includes("SELECT tenant_id,actor_id,responsibility_id")
    ? [{ tenant_id: runtimeOwner.tenantId, actor_id: runtimeOwner.actorId, responsibility_id: runtimeId }] : []);
  mocks.head.mockResolvedValue(runtimeHead); mocks.draft.mockResolvedValue({});
  mocks.resolve.mockResolvedValue({ configuration: runtimeConfiguration, schedule: {} });
  mocks.next.mockReturnValue("2026-10-05T00:00:00.000Z"); mocks.reconcile.mockResolvedValue(false);
});
describe("Responsibility bounded due admission", () => {
  it("skips an older scheduled instant without a wake, tool or cumulative debit", async () => {
    const summary = await processDueResponsibilities({ limit: 1 });
    expect(summary).toMatchObject({ inspected: 1, reconciled: 1, enqueued: 0, blocked: 0, failed: 0 });
    expect(mocks.persist).toHaveBeenCalledOnce();
    const transition = mocks.persist.mock.calls[0][1];
    expect(transition).toMatchObject({ action: "reconcile", previous: runtimeHead,
      current: { state: "active", reason: "missed_skipped", nextDueAt: "2026-10-05T00:00:00.000Z", budget: runtimeHead.budget },
      request: { previousDueAt: runtimeNow, outcome: "missed_skipped" } });
    expect(transition.wake).toBeUndefined(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["responsibility_authority_changed", "responsibility_owner_revoked"])("persists %s refusal as blocked instead of repeating an active due wake", async (code) => {
    mocks.resolve.mockRejectedValueOnce(new ResponsibilityError("Authority changed", code.endsWith("revoked") ? 403 : 409, code));
    expect(await processDueResponsibilities({ limit: 1 })).toMatchObject({ inspected: 1, blocked: 1, enqueued: 0, failed: 0 });
    expect(mocks.persist.mock.calls[0][1]).toMatchObject({ action: "block", current: { state: "blocked", generation: runtimeHead.generation + 1, reason: "authority_changed", budget: runtimeHead.budget, nextDueAt: null } });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not persist a successful refusal after procedure scope cleanup or SQL failure", async () => {
    mocks.resolve.mockRejectedValueOnce(new Error("Procedure scope cleanup unconfirmed"));
    expect(await processDueResponsibilities({ limit: 1 })).toMatchObject({ inspected: 1, failed: 1, blocked: 0, enqueued: 0 });
    expect(mocks.persist).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
});
