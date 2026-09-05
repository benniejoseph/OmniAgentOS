import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@/lib/tools/types";

const mocks = vi.hoisted(() => ({
  definitions: [] as ToolDefinition[],
}));

vi.mock("@/lib/rag/context-engine", () => ({
  buildContextPack: vi.fn().mockResolvedValue({ contextBlock: "", trace: undefined }),
}));

vi.mock("@/lib/capabilities/toolbox", () => ({
  loadProgressiveAgentTools: vi.fn(async () => ({
    definitions: mocks.definitions,
    omittedToolIds: [],
    schemaBytes: 0,
  })),
}));

const requiredTool: ToolDefinition = {
  id: "mcp:github:actions_run_trigger",
  name: "Trigger workflow",
  description: "Trigger one GitHub Actions workflow.",
  category: "mcp",
  status: "active",
  riskLevel: 2,
  dryRunSupported: true,
  approvalRequired: true,
  inputSchema: { type: "object" },
};

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-procedure-planner-"),
  );
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  mocks.definitions = [requiredTool];
});

describe("saved procedure planning", () => {
  it("uses the exact validated tool binding in a deterministic approval plan", async () => {
    const { buildDynamicWorkflowPlan } = await import("@/lib/workflows/planner");
    const input = {
      owner: "example",
      repo: "portfolio",
      workflow_id: "blog.yml",
      ref: "main",
    };
    const record = await buildDynamicWorkflowPlan({
      tenantId: "tenant-procedure",
      actorId: "actor-procedure",
      goal: "Run portfolio blog automation",
      requireApproval: true,
      requiredToolBindings: [{
        toolId: requiredTool.id,
        input,
      }],
    });

    expect(record).toMatchObject({
      planner: "deterministic",
      model: "saved-procedure-v1",
      approvalRequired: true,
    });
    expect(record.plan.selectedToolIds).toContain(requiredTool.id);
    const boundNodes = record.plan.nodes.filter((node) => node.toolIds.includes(requiredTool.id));
    expect(boundNodes.length).toBeGreaterThan(0);
    expect(boundNodes.every((node) => node.toolInputs?.some((binding) =>
      binding.toolId === requiredTool.id && binding.inputJson === JSON.stringify(input)
    ))).toBe(true);
  });

  it("fails closed when a required connector is unavailable", async () => {
    mocks.definitions = [];
    const { buildDynamicWorkflowPlan } = await import("@/lib/workflows/planner");
    await expect(buildDynamicWorkflowPlan({
      tenantId: "tenant-missing-procedure",
      actorId: "actor-procedure",
      goal: "Run portfolio blog automation",
      requiredToolBindings: [{ toolId: requiredTool.id, input: {} }],
    })).rejects.toThrow("Saved procedure dependencies are unavailable");
  });
});
