import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), lease: vi.fn(), child: vi.fn(), parent: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ runWithDatabaseActorScope: async (_t: string, _a: string[], action: () => unknown) => action() }));
vi.mock("@/lib/runs/store", () => ({ getAgentRun: mocks.get }));
vi.mock("@/lib/delegation/execution-store", () => ({ listDelegationExecutions: mocks.list }));
vi.mock("@/lib/delegation/worker", () => ({ processDelegationExecutionJob: mocks.child }));
vi.mock("@/lib/delegation/parent-continuation", () => ({ processParentContinuationJob: mocks.parent }));
vi.mock("@/lib/operations/job-queue", () => ({ getAgentExecuteJobDedupeKey: (id: string) => `agent:${id}`, leaseOperationJobByDedupeKey: mocks.lease }));
import { dispatchParentDelegatedWork } from "@/lib/delegation/dispatch";
const input = () => ({ tenantId: "tenant-a", ownerActorId: "owner", canonicalActorId: "canonical", parentRunId: "root", deadline: Date.now()+60_000 });
beforeEach(() => {
  vi.clearAllMocks(); mocks.get.mockResolvedValue({ id: "root", ownerActorId: "owner", agentId: "atlas", status: "completed" });
  mocks.list.mockResolvedValue([{ state: "queued", childRunId: "child-a" }, { state: "verified", childRunId: "child-b" }]);
  mocks.lease.mockImplementation(async key => ({ outcome: "leased", job: { id: key } }));
});
it("leases only this parent's queued child and return job without a tenant tick", async () => {
  await dispatchParentDelegatedWork(input());
  expect(mocks.lease.mock.calls.map(call => call[0])).toEqual(["agent:child-a", "delegation-parent:root"]);
  expect(mocks.lease.mock.calls.every(call => call[1].queuedOnly === true)).toBe(true);
  expect(mocks.child).toHaveBeenCalledTimes(1); expect(mocks.parent).toHaveBeenCalledTimes(1);
});
it("does not replay a job owned by the scheduler or stopped parent", async () => {
  mocks.lease.mockResolvedValue({ outcome: "busy" }); await dispatchParentDelegatedWork(input());
  expect(mocks.child).not.toHaveBeenCalled(); expect(mocks.parent).not.toHaveBeenCalled();
  mocks.get.mockResolvedValue({ id: "root", ownerActorId: "owner", agentId: "atlas", status: "canceled" });
  mocks.lease.mockClear(); await dispatchParentDelegatedWork(input()); expect(mocks.lease).not.toHaveBeenCalled();
});
