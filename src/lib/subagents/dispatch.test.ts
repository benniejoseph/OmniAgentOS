import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ after: vi.fn(), drain: vi.fn(), deadline: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/observability/request-timing", () => ({ requestWorkDeadline: mocks.deadline }));
vi.mock("@/lib/subagents/worker", () => ({ DURABLE_SPECIALIST_BUDGET_MS: 240000, processAllTenantDurableSpecialistQueues: mocks.drain }));
import { scheduleDurableSpecialistQueueDrain } from "@/lib/subagents/dispatch";
describe("dispatch repair timing check", () => {
 beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(1000000); vi.resetAllMocks(); mocks.deadline.mockReturnValue(Date.now()+290000); mocks.drain.mockResolvedValue({leased:1,completed:1,failed:0,stale:0}); });
 afterEach(() => vi.useRealTimers());
 it("retains specialist work beyond the fast tick's 45 seconds", async () => {
   let finish!: () => void;
   mocks.drain.mockImplementation(() => new Promise(resolve => { finish = () => resolve({leased:1,completed:1,failed:0,stale:0}); }));
   const result = scheduleDurableSpecialistQueueDrain({tenantIds:["tenant-test"],limit:1,routeMaxDurationSeconds:300});
   expect(result).toMatchObject({scheduled:1,completed:0,leased:0});
   expect(mocks.drain).not.toHaveBeenCalled();
   const held = mocks.after.mock.calls[0][0];
   expect(held).toBeInstanceOf(Promise);
   await Promise.resolve();
   expect(mocks.drain).toHaveBeenCalledWith({tenantIds:["tenant-test"],limit:1,timeBudgetMs:240000});
   let settled=false; held.then(()=>settled=true);
   await vi.advanceTimersByTimeAsync(60000);
   expect(settled).toBe(false);
   finish(); await held;
   expect(settled).toBe(true);
 });
 it("starts no work if lifecycle registration fails", async () => {
   mocks.after.mockImplementation(()=>{throw Error("no request lifecycle")});
   expect(()=>scheduleDurableSpecialistQueueDrain({tenantIds:["tenant-test"],limit:1,routeMaxDurationSeconds:300})).toThrow("no request lifecycle");
   await Promise.resolve(); expect(mocks.drain).not.toHaveBeenCalled();
 });
 it("does not admit a specialist without its bounded execution window", async () => {
   mocks.deadline.mockReturnValue(Date.now()+45000);
   expect(scheduleDurableSpecialistQueueDrain({tenantIds:["tenant-test"],limit:1,routeMaxDurationSeconds:60}).scheduled).toBe(0);
   await Promise.resolve(); expect(mocks.drain).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
 });
});
