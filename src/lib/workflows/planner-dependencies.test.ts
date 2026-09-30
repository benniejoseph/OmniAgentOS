import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@/lib/tools/types";

const mocks = vi.hoisted(() => ({
  generateModelStructured: vi.fn(),
}));

vi.mock("@/lib/rag/context-engine", () => ({
  AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES: Object.freeze({
    memory: "authorized_only",
    knowledge: "canonical_authorized",
    topicGraph: "exclude",
    entityGraph: "authorized",
  }),
  AUTHORIZED_MEMORY_ONLY_RETRIEVAL_SOURCES: Object.freeze({
    memory: "authorized_only",
    knowledge: "exclude",
    topicGraph: "exclude",
    entityGraph: "exclude",
  }),
  buildContextPack: vi.fn(async () => ({ contextBlock: "", trace: undefined })),
}));
vi.mock("@/lib/capabilities/toolbox", () => ({
  loadProgressiveAgentTools: vi.fn(async () => ({
    definitions: [searchTool],
    omittedToolIds: [],
    schemaBytes: 0,
  })),
}));
vi.mock("@/lib/settings/runtime-models", () => ({
  resolveRuntimeModelAssignment: vi.fn(async () => ({
    configured: true,
    source: "deployment_environment",
    warnings: [],
    bind: <T>(request: T) => request,
  })),
}));
vi.mock("@/lib/models/gateway", () => ({
  generateModelStructured: mocks.generateModelStructured,
}));

import { buildDynamicWorkflowPlan } from "@/lib/workflows/planner";

const searchTool: ToolDefinition = {
  id: "knowledge.search",
  name: "Search knowledge",
  description: "Search tenant knowledge.",
  category: "knowledge",
  status: "active",
  riskLevel: 0,
  dryRunSupported: true,
  approvalRequired: false,
  operationClass: "read_only",
  reversible: true,
  inputSchema: { type: "object" },
};

const modelNode = (
  id: string,
  kind: string,
  dependsOn: string[],
  extra: Record<string, unknown> = {},
) => ({
  id,
  label: id,
  kind,
  description: `Complete ${id}.`,
  dependsOn,
  toolIds: [],
  connectorTargets: [],
  riskLevel: 0,
  approvalRequired: false,
  policy: "auto",
  acceptanceCriteria: [`${id} is complete.`],
  expectedOutputs: [`${id} notes`],
  ...extra,
});

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "asael-plan-dependencies-"),
  );
  delete process.env.DATABASE_URL;
});

describe("workflow plan dependencies", () => {
  it("makes each edge a dependency of the step it leads to", async () => {
    mocks.generateModelStructured.mockResolvedValueOnce({
      provider: "openai",
      model: "gpt-planner-test",
      text: JSON.stringify({
        objective: "Brief the team on this week's research",
        summary: "Research, search, check, and report.",
        mode: "orchestrate",
        assumptions: [],
        constraints: [],
        risks: [],
        acceptanceCriteria: ["The brief cites its sources."],
        nodes: [
          modelNode("research", "research", []),
          // Its search reads the research, which only an edge orders first.
          modelNode("search", "tool", [], {
            toolIds: [searchTool.id],
            inputBindings: [{
              dependencyNodeId: "research",
              targetToolId: searchTool.id,
              targetPath: "/query",
              artifactName: "",
            }],
          }),
          modelNode("verify", "verify", ["search"]),
          modelNode("report", "report", []),
        ],
        edges: [
          { from: "research", to: "search", condition: "completed" },
          { from: "search", to: "verify", condition: "completed" },
          { from: "research", to: "verify", condition: "completed" },
          { from: "verify", to: "report", condition: "completed" },
        ],
        selectedToolIds: [searchTool.id],
        connectorTargets: [],
        executionPolicy: {
          highestRiskLevel: 0,
          requiresApproval: false,
          defaultPolicy: "auto",
          notes: [],
        },
        verificationPlan: [],
        memoryPlan: [],
        confidence: 0.8,
      }),
    });

    const record = await buildDynamicWorkflowPlan({
      tenantId: "tenant-plan-dependencies",
      actorId: "owner@example.test",
      goal: "Brief the team on this week's research",
    });

    expect(record).toMatchObject({ planner: "openai", status: "planned" });
    expect(record.plan.nodes.map((node) => [
      node.id,
      node.dependsOn,
      node.execution?.dependencyNodeIds,
    ])).toEqual([
      ["research", [], []],
      ["search", ["research"], ["research"]],
      ["verify", ["search", "research"], ["search", "research"]],
      ["report", ["verify"], ["verify"]],
    ]);
    expect(record.plan.nodes[1].inputBindings).toEqual([{
      dependencyNodeId: "research",
      targetToolId: searchTool.id,
      targetPath: "/query",
      artifactName: "",
    }]);
  });
});
