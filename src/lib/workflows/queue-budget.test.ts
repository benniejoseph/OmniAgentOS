import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";

vi.mock("next/server", () => ({ after: vi.fn() }));

describe("workflow queue budgets", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-workflow-queue-budget-"),
    );
  });

  it("does not authorize queue redelivery when the run retry budget is zero", async () => {
    const { createWorkflowRun } = await import("@/lib/workflows/store");
    const { enqueueWorkflowRunTick } = await import("@/lib/workflows/queue");
    const detail = await createWorkflowRun({
      tenantId: "tenant-budget",
      goal: "Run once only",
      budgetLimits: { ...WORKFLOW_RUN_BUDGET_LIMITS, retries: 0 },
    });

    await expect(enqueueWorkflowRunTick(
      detail.run.id,
      "test",
      undefined,
      "tenant-budget",
    )).resolves.toMatchObject({ maxAttempts: 1 });
  });

  it("preserves validated numeric token budgets when a run is read back", async () => {
    const { createWorkflowRun, getWorkflowRunDetail } = await import(
      "@/lib/workflows/store"
    );
    const created = await createWorkflowRun({
      tenantId: "tenant-budget-roundtrip",
      goal: "Keep numeric workflow budgets intact",
      budgetLimits: { ...WORKFLOW_RUN_BUDGET_LIMITS, tokens: 12_345 },
    });

    const detail = await getWorkflowRunDetail(created.run.id, {
      tenantId: "tenant-budget-roundtrip",
    });

    expect(detail?.run.input.budgetLimits).toMatchObject({ tokens: 12_345 });
    expect(typeof detail?.run.input.budgetLimits?.tokens).toBe("number");
  });
});
