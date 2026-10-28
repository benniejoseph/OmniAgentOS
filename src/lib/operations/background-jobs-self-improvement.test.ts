import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationJobRecord } from "./job-queue";
import { initialSelfImprovementRuntime } from "@/lib/self-improvement/runtime";

const mock = vi.hoisted(() => ({ get: vi.fn(), execute: vi.fn(), lease: vi.fn(), update: vi.fn(), complete: vi.fn(), defer: vi.fn(), fail: vi.fn(), heartbeat: vi.fn() }));
vi.mock("@/lib/self-improvement/store", async original => ({ ...await original<typeof import("@/lib/self-improvement/store")>(), getSelfImprovementCycle: mock.get }));
vi.mock("@/lib/self-improvement/worker", () => ({ executeSelfImprovementJob: mock.execute }));
vi.mock("./job-queue", async original => ({ ...await original<typeof import("./job-queue")>(), leaseOperationJobs: mock.lease,
  updateOperationJobPayload: mock.update, completeOperationJob: mock.complete, deferOperationJob: mock.defer, failOperationJob: mock.fail, heartbeatOperationJob: mock.heartbeat }));
import { processBackgroundOperationQueue } from "./background-jobs";
import { getDatabaseActorContext } from "@/lib/db/client";

const owner = "actor:11111111-1111-4111-8111-111111111111";
const job: OperationJobRecord = { id: "job", tenantId: "tenant", type: "self_improvement.cycle.tick", payload: { actorId: owner, cycleId: "cycle" },
  status: "running", priority: 1, attempt: 1, maxAttempts: 1, leaseOwner: "worker", runAt: "2026-10-28T08:00:00.000Z",
  createdAt: "2026-10-28T08:00:00.000Z", updatedAt: "2026-10-28T08:00:00.000Z" };
function pendingTypecheck() {
  return { ...initialSelfImprovementRuntime(), phase: "verify", plan: { summary: "Synthetic change", sourcePaths: ["src/example.ts"],
    focusedTestPaths: ["src/example.test.ts"], adjacentTestPaths: ["src/neighbor.test.ts"], acceptanceCriteria: ["Preserve a valid control."] },
  checks: [{ executionId: "lint", command: "lint_focused", paths: ["src/example.ts"], outputSha256: "a".repeat(64), workspaceSha256: "b".repeat(64),
    exitCode: 0, totalTests: 0, passedTests: 0, failedTests: 0, completedAt: job.createdAt }] };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(job.createdAt));
  for (const fn of Object.values(mock)) fn.mockReset();
  mock.lease.mockResolvedValueOnce([job]).mockResolvedValue([]);
  for (const fn of [mock.update, mock.complete, mock.defer, mock.fail, mock.heartbeat]) fn.mockResolvedValue(job);
  mock.fail.mockResolvedValue({ ...job, status: "failed" });
  mock.get.mockImplementation(async () => {
    expect(getDatabaseActorContext()).toEqual([owner]);
    return { cycle: { revision: 7, stage: "validating" }, runtime: pendingTypecheck() };
  });
  mock.execute.mockResolvedValue({ resourceId: "cycle", stage: "validating" });
});
afterEach(() => vi.useRealTimers());

describe("daily self-improvement typecheck dispatch", () => {
  it("keeps the real phase guard live beyond 240s, fences the saved revision and retains lease heartbeats", async () => {
    mock.execute.mockImplementation(async (_job, signal: AbortSignal, revision: number) => {
      expect(revision).toBe(7); expect(getDatabaseActorContext()).toEqual([owner]);
      await vi.advanceTimersByTimeAsync(245_000);
      expect(signal.aborted).toBe(false);
      return { resourceId: "cycle", stage: "validating" };
    });
    expect(await processBackgroundOperationQueue({ tenantId: job.tenantId, limit: 1, selfImprovementTypecheckDeadlineAt: Date.now() + 270_000 }))
      .toMatchObject({ completed: 1, failed: 0 });
    expect(mock.heartbeat).toHaveBeenCalled();
    expect(mock.get).toHaveBeenCalledWith({ tenantId: job.tenantId, ownerActorId: owner }, "cycle");
    expect(mock.execute).toHaveBeenCalledOnce(); expect(mock.complete).toHaveBeenCalledOnce();
  });
  it.each([undefined, 249_999, 0])("defers the compiler before execution when a full bounded window is unavailable (%s)", remaining => {
    return processBackgroundOperationQueue({ tenantId: job.tenantId, limit: 1,
      ...(remaining === undefined ? {} : { selfImprovementTypecheckDeadlineAt: Date.now() + remaining }) }).then(result => {
      expect(result).toMatchObject({ deferred: 1, completed: 0 });
      expect(mock.execute).not.toHaveBeenCalled(); expect(mock.defer).toHaveBeenCalledOnce();
    });
  });
  it("does not grant the compiler window to an ordinary model phase", async () => {
    mock.get.mockResolvedValue({ cycle: { revision: 7, stage: "implementing" }, runtime: { ...pendingTypecheck(), phase: "implement" } });
    mock.execute.mockImplementation(async (_job, signal: AbortSignal, revision: number | undefined) => {
      expect(revision).toBeUndefined();
      await vi.advanceTimersByTimeAsync(240_000);
      expect(signal.aborted).toBe(true);
      signal.throwIfAborted();
    });
    expect(await processBackgroundOperationQueue({ tenantId: job.tenantId, limit: 1, selfImprovementTypecheckDeadlineAt: Date.now() + 270_000 }))
      .toMatchObject({ failed: 1, completed: 0 });
    expect(mock.complete).not.toHaveBeenCalled();
  });
  it("does not let an arbitrary caller deadline remove the 270s phase limit", async () => {
    mock.execute.mockImplementation(async (_job, signal: AbortSignal) => {
      await vi.advanceTimersByTimeAsync(270_000); expect(signal.aborted).toBe(true); signal.throwIfAborted();
    });
    expect(await processBackgroundOperationQueue({ tenantId: job.tenantId, limit: 1, selfImprovementTypecheckDeadlineAt: Date.now() + 900_000 }))
      .toMatchObject({ failed: 1, completed: 0 });
    expect(mock.complete).not.toHaveBeenCalled();
  });
  it("finalizes an admission-read failure under the existing job lease without starting work", async () => {
    mock.get.mockRejectedValue(new Error("Owner-scoped admission is unavailable."));
    expect(await processBackgroundOperationQueue({ tenantId: job.tenantId, limit: 1, selfImprovementTypecheckDeadlineAt: Date.now() + 270_000 }))
      .toMatchObject({ failed: 1, completed: 0 });
    expect(mock.fail).toHaveBeenCalledWith(job.id, "Owner-scoped admission is unavailable.", job.leaseOwner, job.tenantId);
    expect(mock.execute).not.toHaveBeenCalled(); expect(mock.complete).not.toHaveBeenCalled();
  });
});
