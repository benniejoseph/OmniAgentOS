import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tickWorkflowRun: vi.fn() }));

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/workflows/runner", () => ({
  tickWorkflowRun: mocks.tickWorkflowRun,
}));

describe("workflow queue deadline", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-workflow-queue-deadline-"),
    );
    mocks.tickWorkflowRun.mockReset().mockImplementation(
      async (workflowRunId: string) => ({
        run: { id: workflowRunId, status: "completed" },
        steps: [],
        events: [],
      }),
    );
  });

  it("tells each tick when the drain's time budget runs out", async () => {
    const { createWorkflowRun } = await import("@/lib/workflows/store");
    const { processAllTenantWorkflowQueues } = await import(
      "@/lib/workflows/queue"
    );
    const tenantId = "tenant-queue-deadline";
    const created = await createWorkflowRun({
      tenantId,
      goal: "Tidy this week's notes",
    });

    const startedAt = Date.now();
    const result = await processAllTenantWorkflowQueues({
      tenantIds: [tenantId],
      timeBudgetMs: 30_000,
      limit: 1,
    });
    const finishedAt = Date.now();

    expect(result.completed).toBe(1);
    expect(mocks.tickWorkflowRun).toHaveBeenCalledTimes(1);
    const [workflowRunId, options] = mocks.tickWorkflowRun.mock.calls[0];
    expect(workflowRunId).toBe(created.run.id);
    expect(options).toMatchObject({ tenantId });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(options.deadlineAt).toBeGreaterThanOrEqual(startedAt + 30_000);
    expect(options.deadlineAt).toBeLessThanOrEqual(finishedAt + 30_000);
  });
});
