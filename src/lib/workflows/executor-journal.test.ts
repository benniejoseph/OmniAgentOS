import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendWorkflowEvent: vi.fn(),
  executeGovernedTool: vi.fn(),
  generateModelStructured: vi.fn(),
  getGovernedTool: vi.fn(),
  getWorkflowRunExecutionAuthority: vi.fn(),
  governedToolOperationClass: vi.fn(),
  resolveRuntimeModelAssignment: vi.fn(),
}));

vi.mock("@/lib/connectors/governed-tools", () => ({
  getMcpGovernedTool: vi.fn(),
  getOpenApiGovernedTool: vi.fn(),
}));
vi.mock("@/lib/models/gateway", () => ({
  generateModelStructured: mocks.generateModelStructured,
}));
vi.mock("@/lib/settings/runtime-models", () => ({
  resolveRuntimeModelAssignment: mocks.resolveRuntimeModelAssignment,
}));
vi.mock("@/lib/tools/executor", () => ({
  EffectReceiptFinalizationError: class EffectReceiptFinalizationError extends Error {},
  executeGovernedTool: mocks.executeGovernedTool,
  governedToolOperationClass: mocks.governedToolOperationClass,
}));
vi.mock("@/lib/tools/registry", () => ({
  getGovernedTool: mocks.getGovernedTool,
}));
vi.mock("@/lib/workflows/store", () => ({
  appendWorkflowEvent: mocks.appendWorkflowEvent,
  getWorkflowRunExecutionAuthority: mocks.getWorkflowRunExecutionAuthority,
}));

import { appendDomainEvent, listStreamEvents } from "@/lib/events/store";
import { getDataPath } from "@/lib/storage/paths";
import {
  executeDynamicWorkflowPlan,
  listWorkflowPlanNodeExecutionsForRun,
} from "@/lib/workflows/executor";
import { withWorkflowNodeContract } from "@/lib/workflows/node-contract";
import {
  foldWorkflowJournal,
  planWorkflowJournalTransition,
  WorkflowJournalDivergenceError,
  WorkflowJournalFenceError,
  workflowJournalEntryId,
  workflowJournalEventType,
  workflowJournalNodeDigests,
  workflowJournalOutputSha256,
  workflowJournalStreamId,
} from "@/lib/workflows/step-journal";
import type {
  WorkflowDynamicPlan,
  WorkflowPlanNode,
  WorkflowPlanNodeExecutionRecord,
  WorkflowRunDetail,
} from "@/lib/workflows/types";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-workflow-step-journal-"),
  );
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.getWorkflowRunExecutionAuthority.mockResolvedValue(undefined);
  mocks.resolveRuntimeModelAssignment.mockResolvedValue({
    configured: true,
    source: "deployment_environment",
    assignmentId: undefined,
    bind: <T>(request: T) => request,
  });
  let calls = 0;
  mocks.generateModelStructured.mockImplementation(async () => {
    calls += 1;
    return successfulModelResult(calls);
  });
});

describe("workflow plan-node step journal", () => {
  it("journals each node attempt under the pass of the claimed execute step", async () => {
    const detail = workflowDetail("workflow-journal-pass", [agentNode("draft")], 2);

    await expect(executeDynamicWorkflowPlan(detail)).resolves.toMatchObject({
      status: "completed",
    });

    const [row] = await listWorkflowPlanNodeExecutionsForRun(detail.run.id);
    const entries = await journalEntries(detail.run.id);
    expect(entries.map((entry) => [entry.kind, entry.attempt, entry.pass])).toEqual([
      ["started", 1, 2],
      ["settled", 1, 2],
    ]);
    expect(entries[1]).toMatchObject({
      status: "completed",
      outputSha256: workflowJournalOutputSha256(row),
      errorSha256: null,
    });
  });

  it("reuses a journaled row on the next pass without running it again", async () => {
    const detail = workflowDetail("workflow-journal-reuse", [agentNode("draft")], 1);
    await executeDynamicWorkflowPlan(detail);
    mocks.generateModelStructured.mockClear();

    await expect(executeDynamicWorkflowPlan(withPass(detail, 2))).resolves.toMatchObject({
      status: "completed",
    });

    expect(mocks.generateModelStructured).not.toHaveBeenCalled();
    expect(await journalEntries(detail.run.id)).toHaveLength(2);
  });

  it("journals a node skipped behind a failed dependency as a settled attempt", async () => {
    const detail = workflowDetail(
      "workflow-journal-skip",
      [agentNode("draft"), { ...agentNode("review"), dependsOn: ["draft"] }],
      1,
    );
    mocks.generateModelStructured.mockRejectedValue(new Error("The model is unavailable."));

    await executeDynamicWorkflowPlan(detail);

    const review = workflowJournalNodeDigests({
      planId: `plan-${detail.run.id}`,
      nodeId: "review",
    }).nodeSha256;
    const entries = (await journalEntries(detail.run.id))
      .filter((entry) => entry.nodeSha256 === review);
    expect(entries.map((entry) => [entry.kind, entry.attempt, entry.status])).toEqual([
      ["started", 1, undefined],
      ["settled", 1, "skipped"],
    ]);
  });

  it("fences a stale pass before it starts a node a newer pass owns", async () => {
    const detail = workflowDetail(
      "workflow-journal-stale",
      [agentNode("draft"), agentNode("review")],
      2,
    );
    await journalStart(detail.run.id, `plan-${detail.run.id}`, "review", 3);

    await expect(executeDynamicWorkflowPlan(detail))
      .rejects.toBeInstanceOf(WorkflowJournalFenceError);

    expect(mocks.generateModelStructured).not.toHaveBeenCalled();
    await expect(listWorkflowPlanNodeExecutionsForRun(detail.run.id)).resolves.toEqual([]);
  });

  it("fails closed when a completed row is not the outcome the journal settled", async () => {
    const detail = workflowDetail("workflow-journal-diverged", [agentNode("draft")], 1);
    await executeDynamicWorkflowPlan(detail);
    await tamperNodeRows(detail.run.id, (record) => ({
      ...record,
      output: { ...record.output, summary: "A result no pass produced." },
    }));
    mocks.generateModelStructured.mockClear();

    await expect(executeDynamicWorkflowPlan(withPass(detail, 2)))
      .rejects.toBeInstanceOf(WorkflowJournalDivergenceError);

    expect(mocks.generateModelStructured).not.toHaveBeenCalled();
    expect(mocks.appendWorkflowEvent).toHaveBeenCalledWith(
      detail.run.id,
      "workflow.journal.diverged",
      {
        planId: `plan-${detail.run.id}`,
        nodes: [{
          planId: `plan-${detail.run.id}`,
          nodeId: "draft",
          reason: "the row's output is not the output attempt 1 settled with",
        }],
      },
    );
  });
});

async function journalEntries(workflowRunId: string) {
  const events = await listStreamEvents(workflowJournalStreamId(workflowRunId), {
    tenantId: "tenant-1",
  });
  return events.map((event) => event.payload as Record<string, unknown>);
}

async function journalStart(
  workflowRunId: string,
  planId: string,
  nodeId: string,
  pass: number,
) {
  const planned = planWorkflowJournalTransition(
    foldWorkflowJournal(workflowRunId, []),
    { workflowRunId, planId, nodeId },
    { kind: "start", inputSha256: "b".repeat(64) },
    pass,
  );
  for (const entry of planned.entries) {
    await appendDomainEvent({
      id: workflowJournalEntryId(entry),
      streamId: workflowJournalStreamId(workflowRunId),
      type: workflowJournalEventType(entry),
      tenantId: "tenant-1",
      payload: entry,
    });
  }
}

async function tamperNodeRows(
  workflowRunId: string,
  change: (record: WorkflowPlanNodeExecutionRecord) => WorkflowPlanNodeExecutionRecord,
) {
  const file = getDataPath("workflow-node-executions.json");
  const ledger = JSON.parse(await readFile(file, "utf8")) as {
    records: WorkflowPlanNodeExecutionRecord[];
  };
  ledger.records = ledger.records.map((record) =>
    record.workflowRunId === workflowRunId ? change(record) : record
  );
  await writeFile(file, JSON.stringify(ledger));
}

function withPass(detail: WorkflowRunDetail, pass: number): WorkflowRunDetail {
  return {
    ...detail,
    steps: detail.steps.map((step) =>
      step.stepKey === "execute" ? { ...step, attempt: pass } : step
    ),
  };
}

function agentNode(id: string): WorkflowPlanNode {
  return withWorkflowNodeContract({
    id,
    label: `Analyze ${id}`,
    kind: "research",
    description: `Produce substantive analysis for ${id}.`,
    dependsOn: [],
    toolIds: [],
    connectorTargets: [],
    riskLevel: 0,
    approvalRequired: false,
    policy: "auto",
    acceptanceCriteria: ["The branch produced substantive analysis."],
    expectedOutputs: ["branch analysis"],
  });
}

function workflowDetail(
  workflowRunId: string,
  nodes: WorkflowPlanNode[],
  pass: number,
): WorkflowRunDetail {
  const plan = workflowPlan(nodes);
  const at = "2026-10-01T00:00:00.000Z";
  return {
    run: {
      id: workflowRunId,
      tenantId: "tenant-1",
      workflowType: "agent.workflow.v1",
      status: "running",
      goal: plan.objective,
      input: { goal: plan.objective, metadata: { actorId: "actor-1" } },
      currentStep: "execute",
      attempt: 1,
      maxAttempts: 3,
      approvalRequired: false,
      createdAt: at,
      updatedAt: at,
    },
    steps: [
      {
        id: `plan-step-${workflowRunId}`,
        tenantId: "tenant-1",
        workflowRunId,
        stepKey: "plan",
        label: "Plan",
        status: "completed",
        attempt: 1,
        maxAttempts: 3,
        input: {},
        output: {
          id: `plan-${workflowRunId}`,
          planner: "deterministic",
          confidence: 1,
          validation: { isDag: true },
          plan,
        },
        createdAt: at,
        updatedAt: at,
      },
      {
        id: `execute-step-${workflowRunId}`,
        tenantId: "tenant-1",
        workflowRunId,
        stepKey: "execute",
        label: "Execute",
        status: "running",
        attempt: pass,
        maxAttempts: 5,
        input: {},
        createdAt: at,
        updatedAt: at,
      },
    ],
    events: [],
  };
}

function workflowPlan(nodes: WorkflowPlanNode[]): WorkflowDynamicPlan {
  return {
    objective: "Execute a bounded journaled workflow.",
    summary: "Exercise the plan-node step journal.",
    mode: "orchestrate",
    assumptions: [],
    constraints: [],
    risks: [],
    acceptanceCriteria: nodes.flatMap((node) => node.acceptanceCriteria),
    nodes,
    edges: nodes.flatMap((node) => node.dependsOn.map((dependencyId) => ({
      from: dependencyId,
      to: node.id,
      condition: "completed",
    }))),
    selectedToolIds: [],
    connectorTargets: [],
    executionPolicy: {
      highestRiskLevel: 0,
      requiresApproval: false,
      defaultPolicy: "auto",
      notes: [],
    },
    verificationPlan: [],
    memoryPlan: [],
    confidence: 1,
  };
}

function successfulModelResult(index: number) {
  return {
    text: JSON.stringify({
      status: "completed",
      summary: `Branch ${index} completed with substantive analysis.`,
      artifacts: [{
        name: "branch analysis",
        kind: "analysis",
        content: `Substantive independently derived result ${index}.`,
        evidenceIds: [],
      }],
      acceptanceChecks: [{
        criterion: "The branch produced substantive analysis.",
        passed: true,
        evidenceIds: [],
        note: "The artifact contains a concrete result.",
      }],
      sideEffectClaimed: false,
    }),
    provider: "openai",
    model: "gpt-test",
    usage: {
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 0,
      totalTokens: 140,
    },
    latencyMs: 12,
    costKnown: false,
    attempts: [{
      provider: "openai",
      model: "gpt-test",
      status: "completed",
      latencyMs: 12,
    }],
    usageReceiptRecorded: true,
    usageReceiptId: `usage-${index}`,
    providerRequestId: `provider-request-${index}`,
  };
}
