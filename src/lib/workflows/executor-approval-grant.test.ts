import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createExecutionScope } from "@/lib/security/execution-scope";
import type { ToolDefinition } from "@/lib/tools/types";
import { authorizeWorkflowToolWithGrant } from "@/lib/workflows/executor";
import type {
  WorkflowDynamicPlan,
  WorkflowPlanNode,
  WorkflowRunDetail,
} from "@/lib/workflows/types";

let dataDir = "";
let priorDatabaseUrl: string | undefined;
let priorDataDir: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "omni-workflow-grants-"));
  priorDatabaseUrl = process.env.DATABASE_URL;
  priorDataDir = process.env.OMNIAGENT_DATA_DIR;
  delete process.env.DATABASE_URL;
  process.env.OMNIAGENT_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
  if (priorDataDir === undefined) delete process.env.OMNIAGENT_DATA_DIR;
  else process.env.OMNIAGENT_DATA_DIR = priorDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

const tool: ToolDefinition = {
  id: "connector.demo.create",
  name: "Create demo record",
  description: "Creates a reversible demo record.",
  category: "connector",
  status: "active",
  riskLevel: 2,
  dryRunSupported: true,
  approvalRequired: true,
  operationClass: "mutation",
  reversible: true,
  inputSchema: { type: "object", additionalProperties: false },
};
const plannedInput = { accountId: "account-one", value: "reviewed" };
const nodeOne = node("node-one");
const nodeTwo = node("node-two");
const plan: WorkflowDynamicPlan = {
  objective: "Create two reviewed records.",
  summary: "Run the same reversible action twice.",
  mode: "execute",
  assumptions: [],
  constraints: [],
  risks: [],
  acceptanceCriteria: ["Both records exist."],
  nodes: [nodeOne, nodeTwo],
  edges: [],
  selectedToolIds: [tool.id],
  connectorTargets: ["account-one"],
  executionPolicy: {
    highestRiskLevel: 2,
    requiresApproval: true,
    defaultPolicy: "approval_required",
    notes: [],
  },
  verificationPlan: [],
  memoryPlan: [],
  confidence: 0.9,
};

describe("workflow plan approval grants", () => {
  it("uses one human plan approval for repeated exact reviewed actions", async () => {
    const approvedAt = new Date(Date.now() - 1_000).toISOString();
    const detail = approvedDetail(approvedAt);
    const executionScope = scope();
    const first = await authorizeWorkflowToolWithGrant({
      detail,
      plan,
      planId: "plan-one",
      node: nodeOne,
      tool,
      toolInput: plannedInput,
      executionScope,
      executionKey: "node-one-execution",
    });
    const second = await authorizeWorkflowToolWithGrant({
      detail,
      plan,
      planId: "plan-one",
      node: nodeTwo,
      tool,
      toolInput: plannedInput,
      executionScope,
      executionKey: "node-two-execution",
    });

    expect(first).toMatchObject({
      grant: { maxUses: 2, usedUses: 1, state: "active" },
      claim: { useOrdinal: 1 },
    });
    expect(second).toMatchObject({
      grant: {
        grantId: first?.grant.grantId,
        maxUses: 2,
        usedUses: 2,
        state: "exhausted",
      },
      claim: { useOrdinal: 2 },
    });
  });

  it("requires per-action approval for changed or dynamically bound targets", async () => {
    const detail = approvedDetail(new Date(Date.now() - 1_000).toISOString());
    await expect(authorizeWorkflowToolWithGrant({
      detail,
      plan,
      planId: "plan-one",
      node: nodeOne,
      tool,
      toolInput: { ...plannedInput, value: "changed after review" },
      executionScope: scope(),
      executionKey: "changed-execution",
    })).resolves.toBeUndefined();
    await expect(authorizeWorkflowToolWithGrant({
      detail,
      plan,
      planId: "plan-one",
      node: {
        ...nodeOne,
        inputBindings: [{
          dependencyNodeId: "source",
          targetToolId: tool.id,
          targetPath: "/accountId",
          artifactName: "account",
        }],
      },
      tool,
      toolInput: plannedInput,
      executionScope: scope(),
      executionKey: "dynamic-execution",
    })).resolves.toBeUndefined();
  });
});

function node(id: string): WorkflowPlanNode {
  return {
    id,
    label: "Create record",
    kind: "tool",
    description: "Create the exact reviewed record.",
    dependsOn: [],
    toolIds: [tool.id],
    toolInputs: [{ toolId: tool.id, inputJson: JSON.stringify(plannedInput) }],
    connectorTargets: ["account-one"],
    riskLevel: 2,
    approvalRequired: true,
    policy: "approval_required",
    acceptanceCriteria: ["Record exists."],
    expectedOutputs: ["record"],
  };
}

function scope() {
  return createExecutionScope({
    tenantId: "tenant-one",
    initiatingActorId: "actor-one",
    executingPrincipalType: "system",
    executingPrincipalId: "workflow:run-one",
    correlationId: "workflow-run-one",
    purpose: "workflow.tool.execute",
  });
}

function approvedDetail(approvedAt: string): WorkflowRunDetail {
  return {
    run: {
      id: "run-one",
      tenantId: "tenant-one",
      workflowType: "dynamic",
      status: "running",
      goal: "Create records.",
      input: { goal: "Create records." },
      currentStep: "execute",
      attempt: 1,
      maxAttempts: 3,
      approvalRequired: true,
      approvedAt,
      createdAt: approvedAt,
      updatedAt: approvedAt,
    },
    steps: [],
    events: [{
      id: "workflow-approval-one",
      tenantId: "tenant-one",
      workflowRunId: "run-one",
      type: "workflow.approved",
      payload: { actorId: "actor-one" },
      createdAt: approvedAt,
    }],
  };
}
