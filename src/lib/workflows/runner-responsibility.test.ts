import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunDetail } from "./types";
const mocks = vi.hoisted(() => ({ read: vi.fn(), authority: vi.fn(), pilot: vi.fn(), model: vi.fn(), context: vi.fn(), transition: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/workflows/store", async (original) => ({ ...await original<typeof import("@/lib/workflows/store")>(),
  getWorkflowRunDetail: mocks.read, getWorkflowRunExecutionAuthority: mocks.authority, transitionWorkflowRunWithEvents: mocks.transition, appendWorkflowEvent: mocks.event }));
vi.mock("@/lib/responsibilities/runtime", () => ({ tickResponsibilityWorkflow: mocks.pilot }));
vi.mock("@/lib/models/gateway", async (original) => ({ ...await original<typeof import("@/lib/models/gateway")>(), generateModelStructured: mocks.model }));
vi.mock("@/lib/rag/context-engine", async (original) => ({ ...await original<typeof import("@/lib/rag/context-engine")>(), buildContextPack: mocks.context }));
import { tickWorkflowRun } from "./runner";
beforeEach(() => { vi.clearAllMocks(); });
describe("Responsibility deterministic workflow routing", () => {
  it("routes a pinned pilot directly and never falls through to planning when admission rejects", async () => {
    const detail = { run: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tenantId: "tenant-a", status: "queued", input: { executionAuthorityRequired: true, metadata: { responsibilityRuntime: {} } } }, steps: [], events: [] } as unknown as WorkflowRunDetail;
    mocks.read.mockResolvedValue(detail); mocks.authority.mockResolvedValue({ executionScope: { purpose: "responsibility.runtime.v1" } });
    mocks.pilot.mockRejectedValue(new Error("generation fenced"));
    await expect(tickWorkflowRun(detail.run.id)).rejects.toThrow("generation fenced");
    expect(mocks.pilot).toHaveBeenCalledWith(detail, {});
    expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.context).not.toHaveBeenCalled(); expect(mocks.transition).not.toHaveBeenCalled();
  });
  it("cannot escape pilot validation by dropping the metadata from its bound purpose", async () => {
    const detail = { run: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "queued", input: { executionAuthorityRequired: true } }, steps: [], events: [] } as unknown as WorkflowRunDetail;
    mocks.read.mockResolvedValue(detail); mocks.authority.mockResolvedValue({ executionScope: { purpose: "responsibility.runtime.v1" } });
    mocks.pilot.mockRejectedValue(new Error("missing binding"));
    await expect(tickWorkflowRun(detail.run.id)).rejects.toThrow("missing binding"); expect(mocks.model).not.toHaveBeenCalled();
  });
  it.each(["paused", "waiting_approval", "running", "canceled", "completed", "failed"])("preserves the ordinary %s workflow guard before specialized dispatch", async (status) => {
    const detail = { run: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tenantId: "tenant-a", status,
      input: { executionAuthorityRequired: true, metadata: { responsibilityRuntime: {} } } }, steps: [], events: [] } as unknown as WorkflowRunDetail;
    mocks.read.mockResolvedValue(detail); mocks.authority.mockResolvedValue({ executionScope: { purpose: "responsibility.runtime.v1" } });
    await expect(tickWorkflowRun(detail.run.id)).resolves.toBe(detail);
    expect(mocks.pilot).not.toHaveBeenCalled(); expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.transition).not.toHaveBeenCalled();
  });
});
