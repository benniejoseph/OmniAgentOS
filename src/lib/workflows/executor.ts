import { randomUUID } from "node:crypto";
import { getMcpGovernedTool, getOpenApiGovernedTool } from "@/lib/connectors/governed-tools";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import { executeGovernedTool } from "@/lib/tools/executor";
import { getGovernedTool } from "@/lib/tools/registry";
import type { ToolDefinition, ToolExecutionRecord } from "@/lib/tools/types";
import { appendWorkflowEvent } from "@/lib/workflows/store";
import type {
  WorkflowDynamicPlan,
  WorkflowPlanExecutionSummary,
  WorkflowPlanNode,
  WorkflowPlanNodeExecutionRecord,
  WorkflowPlanNodeExecutionStats,
  WorkflowPlanNodeExecutionStatus,
  WorkflowRunDetail,
} from "@/lib/workflows/types";

type WorkflowNodeExecutionLedger = {
  records: WorkflowPlanNodeExecutionRecord[];
};

type ParsedPlanOutput = {
  id: string;
  planner: string;
  confidence: number;
  validation: Record<string, unknown>;
  plan: WorkflowDynamicPlan;
};

type ToolExecutionSummary = {
  id: string;
  toolId: string;
  status: ToolExecutionRecord["status"];
  dryRun: boolean;
  approvalRequired: boolean;
  riskLevel: number;
  reason?: string;
  result?: unknown;
};

let nodeExecutionFileWriteQueue: Promise<void> = Promise.resolve();

export async function executeDynamicWorkflowPlan(detail: WorkflowRunDetail): Promise<WorkflowPlanExecutionSummary | null> {
  const parsedPlan = parseWorkflowPlanOutput(stepOutput(detail, "plan"));
  if (!parsedPlan) {
    return null;
  }

  const sortedNodes = topologicalSort(parsedPlan.plan.nodes);
  const priorRecords = await listWorkflowPlanNodeExecutionsForRun(detail.run.id, 250);
  const existingByNode = new Map(
    priorRecords
      .filter((record) => record.planId === parsedPlan.id)
      .map((record) => [record.nodeId, record]),
  );
  const recordsByNode = new Map<string, WorkflowPlanNodeExecutionRecord>();
  const nodeExecutions: WorkflowPlanNodeExecutionRecord[] = [];

  for (const node of sortedNodes) {
    const existing = existingByNode.get(node.id);
    if (existing && isReusableNodeExecution(existing)) {
      recordsByNode.set(node.id, existing);
      nodeExecutions.push(existing);
      continue;
    }

    const blockedDependencies = node.dependsOn
      .map((dependencyId) => recordsByNode.get(dependencyId))
      .filter((record) => record && record.status !== "completed");

    if (blockedDependencies.length) {
      const record = await saveWorkflowPlanNodeExecution({
        ...baseNodeExecutionRecord({ detail, planId: parsedPlan.id, node, existing }),
        status: "skipped",
        output: {
          skipped: true,
          blockedDependencies: blockedDependencies.map((record) => ({
            nodeId: record?.nodeId,
            status: record?.status,
          })),
        },
        completedAt: new Date().toISOString(),
      });
      recordsByNode.set(node.id, record);
      nodeExecutions.push(record);
      await appendWorkflowEvent(detail.run.id, "workflow.plan_node.skipped", {
        planId: parsedPlan.id,
        nodeId: node.id,
        blockedDependencies: blockedDependencies.length,
      });
      continue;
    }

    const runningRecord = await saveWorkflowPlanNodeExecution({
      ...baseNodeExecutionRecord({ detail, planId: parsedPlan.id, node, existing }),
      status: "running",
      startedAt: new Date().toISOString(),
      error: undefined,
    });
    await appendWorkflowEvent(detail.run.id, "workflow.plan_node.started", {
      planId: parsedPlan.id,
      nodeId: node.id,
      kind: node.kind,
      toolCount: node.toolIds.length,
    });

    try {
      const result = await executePlanNode({
        detail,
        plan: parsedPlan.plan,
        planId: parsedPlan.id,
        node,
        dependencyRecords: node.dependsOn
          .map((dependencyId) => recordsByNode.get(dependencyId))
          .filter((record): record is WorkflowPlanNodeExecutionRecord => Boolean(record)),
      });
      const record = await saveWorkflowPlanNodeExecution({
        ...baseNodeExecutionRecord({ detail, planId: parsedPlan.id, node, existing: runningRecord }),
        status: result.status,
        toolExecutionIds: result.toolExecutions.map((tool) => tool.id),
        output: {
          ...result.output,
          toolExecutions: result.toolExecutions,
        },
        error: result.error,
        startedAt: runningRecord.startedAt || new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      recordsByNode.set(node.id, record);
      nodeExecutions.push(record);
      await appendWorkflowEvent(detail.run.id, "workflow.plan_node.completed", {
        planId: parsedPlan.id,
        nodeId: node.id,
        status: record.status,
        toolExecutionIds: record.toolExecutionIds,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plan node execution failed.";
      const record = await saveWorkflowPlanNodeExecution({
        ...baseNodeExecutionRecord({ detail, planId: parsedPlan.id, node, existing: runningRecord }),
        status: "failed",
        error: message,
        startedAt: runningRecord.startedAt || new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      recordsByNode.set(node.id, record);
      nodeExecutions.push(record);
      await appendWorkflowEvent(detail.run.id, "workflow.plan_node.failed", {
        planId: parsedPlan.id,
        nodeId: node.id,
        error: message,
      });
    }
  }

  const summary = summarizePlanExecution({
    workflowRunId: detail.run.id,
    planId: parsedPlan.id,
    nodeExecutions,
  });
  await appendWorkflowEvent(detail.run.id, "workflow.plan_execution.completed", {
    planId: parsedPlan.id,
    status: summary.status,
    completedNodes: summary.completedNodes,
    toolExecutions: summary.toolExecutions,
    dryRunTools: summary.dryRunTools,
    executedTools: summary.executedTools,
  });

  return summary;
}

export async function listWorkflowPlanNodeExecutions(limit = 100) {
  const boundedLimit = Math.min(Math.max(limit, 1), 500);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_workflow_node_executions
      ORDER BY updated_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(workflowPlanNodeExecutionFromRow);
  }

  const ledger = await readNodeExecutionLedger();
  return ledger.records.slice(0, boundedLimit);
}

export async function listWorkflowPlanNodeExecutionsForRun(workflowRunId: string, limit = 100) {
  const boundedLimit = Math.min(Math.max(limit, 1), 500);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_workflow_node_executions
      WHERE workflow_run_id = ${workflowRunId}
      ORDER BY created_at ASC
      LIMIT ${boundedLimit}
    `;
    return rows.map(workflowPlanNodeExecutionFromRow);
  }

  const ledger = await readNodeExecutionLedger();
  return ledger.records
    .filter((record) => record.workflowRunId === workflowRunId)
    .slice(0, boundedLimit);
}

export async function getWorkflowPlanNodeExecutionStats(): Promise<WorkflowPlanNodeExecutionStats> {
  const records = await listWorkflowPlanNodeExecutions(500);
  const byStatus = records.reduce<Record<string, number>>((acc, record) => {
    acc[record.status] = (acc[record.status] || 0) + 1;
    return acc;
  }, {});
  const toolSummaries = records.flatMap((record) => parseToolSummaries(record.output));

  return {
    total: records.length,
    byStatus,
    approvalRequired: records.filter((record) => record.approvalRequired).length,
    blocked: byStatus.blocked || 0,
    failed: byStatus.failed || 0,
    dryRunTools: toolSummaries.filter((tool) => tool.dryRun).length,
    executedTools: toolSummaries.filter((tool) => !tool.dryRun && tool.status === "executed").length,
    latest: records.slice(0, 5),
  };
}

export function parseWorkflowPlanOutput(output: Record<string, unknown> | undefined): ParsedPlanOutput | undefined {
  if (!output || typeof output !== "object") {
    return undefined;
  }

  if (typeof output.id !== "string" || !output.plan || typeof output.plan !== "object") {
    return undefined;
  }

  const plan = output.plan as WorkflowDynamicPlan;
  if (!Array.isArray(plan.nodes) || !Array.isArray(plan.edges)) {
    return undefined;
  }

  return {
    id: output.id,
    planner: typeof output.planner === "string" ? output.planner : "unknown",
    confidence: typeof output.confidence === "number" ? output.confidence : 0,
    validation: output.validation && typeof output.validation === "object"
      ? output.validation as Record<string, unknown>
      : {},
    plan,
  };
}

async function executePlanNode({
  detail,
  plan,
  planId,
  node,
  dependencyRecords,
}: {
  detail: WorkflowRunDetail;
  plan: WorkflowDynamicPlan;
  planId: string;
  node: WorkflowPlanNode;
  dependencyRecords: WorkflowPlanNodeExecutionRecord[];
}): Promise<{
  status: WorkflowPlanNodeExecutionStatus;
  output: Record<string, unknown>;
  toolExecutions: ToolExecutionSummary[];
  error?: string;
}> {
  const toolExecutions: ToolExecutionSummary[] = [];

  if (node.kind === "approval") {
    return {
      status: "completed",
      output: {
        approvalCaptured: Boolean(detail.run.approvedAt),
        approvedAt: detail.run.approvedAt,
        approvalRequired: node.approvalRequired,
        approvalDeferred: node.approvalRequired && !detail.run.approvedAt,
        policy: node.policy,
      },
      toolExecutions,
    };
  }

  for (const toolId of node.toolIds.slice(0, 6)) {
    const tool = await getToolDefinition(toolId, { tenantId: detail.run.tenantId });
    const dryRun = shouldDryRunTool({ toolId, tool, node });
    const execution = await executeGovernedTool({
      toolId,
      input: buildToolInput({ detail, plan, planId, node, toolId, dependencyRecords }),
      dryRun,
      approved: Boolean(detail.run.approvedAt && !dryRun),
      context: {
        tenantId: normalizeTenantId(detail.run.tenantId),
        actorId: "workflow",
        role: "system",
        source: "default",
      },
      approvalReason: detail.run.approvedAt
        ? `Workflow ${detail.run.id} was approved before plan-node execution.`
        : undefined,
    });
    toolExecutions.push({
      id: execution.record.id,
      toolId: execution.record.toolId,
      status: execution.record.status,
      dryRun: execution.record.dryRun,
      approvalRequired: execution.record.approvalRequired,
      riskLevel: execution.record.riskLevel,
      reason: execution.record.reason,
      result: execution.result,
    });
  }

  const failed = toolExecutions.find((tool) => tool.status === "failed");
  const blocked = toolExecutions.find((tool) => tool.status === "blocked");
  const waitingApproval = toolExecutions.find((tool) => tool.status === "approval_required");
  const status: WorkflowPlanNodeExecutionStatus = failed
    ? "failed"
    : blocked
      ? "blocked"
      : waitingApproval
        ? "waiting_approval"
        : "completed";

  return {
    status,
    output: {
      artifact: buildNodeArtifact({ detail, node, dependencyRecords, toolExecutions }),
      acceptanceCriteria: node.acceptanceCriteria,
      expectedOutputs: node.expectedOutputs,
      dependencyNodeIds: dependencyRecords.map((record) => record.nodeId),
      connectorTargets: node.connectorTargets,
      policy: node.policy,
      dryRunOnly: toolExecutions.length > 0 && toolExecutions.every((tool) => tool.dryRun),
    },
    toolExecutions,
    error: failed?.reason || blocked?.reason || waitingApproval?.reason,
  };
}

async function getToolDefinition(
  toolId: string,
  options: { tenantId?: string } = {},
): Promise<ToolDefinition | undefined> {
  return getGovernedTool(toolId) ||
    await getMcpGovernedTool(toolId, options) ||
    await getOpenApiGovernedTool(toolId, options) ||
    undefined;
}

function shouldDryRunTool({
  toolId,
  tool,
  node,
}: {
  toolId: string;
  tool?: ToolDefinition;
  node: WorkflowPlanNode;
}) {
  if (!tool) {
    return true;
  }

  if (node.policy !== "auto" || node.approvalRequired || node.riskLevel >= 2 || tool.approvalRequired || tool.riskLevel >= 1) {
    return true;
  }

  if (toolId === "memory.write" || toolId === "knowledge.ingest") {
    return true;
  }

  if (tool.category === "mcp" || tool.category === "openapi" || tool.category === "connector") {
    return true;
  }

  return false;
}

function buildToolInput({
  detail,
  plan,
  planId,
  node,
  toolId,
  dependencyRecords,
}: {
  detail: WorkflowRunDetail;
  plan: WorkflowDynamicPlan;
  planId: string;
  node: WorkflowPlanNode;
  toolId: string;
  dependencyRecords: WorkflowPlanNodeExecutionRecord[];
}): Record<string, unknown> {
  const query = compactText([
    detail.run.goal,
    node.label,
    node.description,
    node.acceptanceCriteria.join(" "),
  ], 1400);

  if (toolId === "memory.search" || toolId === "knowledge.search") {
    return { query, limit: 5 };
  }

  if (toolId === "runs.list") {
    return { limit: 5 };
  }

  if (toolId === "memory.write") {
    return {
      title: `Workflow learning: ${node.label}`.slice(0, 120),
      content: compactText([
        `Workflow run: ${detail.run.id}`,
        `Plan: ${planId}`,
        `Goal: ${detail.run.goal}`,
        `Node: ${node.label}`,
        `Description: ${node.description}`,
        `Acceptance: ${node.acceptanceCriteria.join("; ")}`,
      ], 1800),
      type: node.kind === "memory" ? "procedure" : "episode",
      tags: ["workflow", "plan-execution", node.kind],
      importance: 0.58,
    };
  }

  if (toolId === "knowledge.ingest") {
    return {
      title: `Workflow artifact: ${node.label}`.slice(0, 120),
      content: compactText([
        `Objective: ${plan.objective}`,
        `Plan summary: ${plan.summary}`,
        `Node: ${node.label}`,
        `Description: ${node.description}`,
        `Expected outputs: ${node.expectedOutputs.join("; ")}`,
      ], 2800),
      source: `workflow:${detail.run.id}:plan:${planId}:node:${node.id}`,
      tags: ["workflow", "plan-execution", node.kind],
    };
  }

  return {
    goal: detail.run.goal,
    workflowRunId: detail.run.id,
    planId,
    nodeId: node.id,
    nodeLabel: node.label,
    nodeDescription: node.description,
    acceptanceCriteria: node.acceptanceCriteria,
    expectedOutputs: node.expectedOutputs,
    connectorTargets: node.connectorTargets,
    dependencyOutputs: dependencyRecords.map((record) => ({
      nodeId: record.nodeId,
      status: record.status,
      output: record.output,
    })),
  };
}

function buildNodeArtifact({
  detail,
  node,
  dependencyRecords,
  toolExecutions,
}: {
  detail: WorkflowRunDetail;
  node: WorkflowPlanNode;
  dependencyRecords: WorkflowPlanNodeExecutionRecord[];
  toolExecutions: ToolExecutionSummary[];
}) {
  return compactText([
    `${node.label}: ${node.description}`,
    node.acceptanceCriteria.length ? `Acceptance criteria: ${node.acceptanceCriteria.join("; ")}` : "",
    dependencyRecords.length
      ? `Dependencies completed: ${dependencyRecords.map((record) => `${record.nodeId}:${record.status}`).join(", ")}`
      : "No dependencies.",
    toolExecutions.length
      ? `Governed tools: ${toolExecutions.map((tool) => `${tool.toolId}:${tool.status}${tool.dryRun ? ":dry-run" : ""}`).join(", ")}`
      : "No tools required for this node.",
    `Workflow goal: ${detail.run.goal}`,
  ], 2400);
}

async function saveWorkflowPlanNodeExecution(record: WorkflowPlanNodeExecutionRecord) {
  const nextRecord = {
    ...record,
    tenantId: normalizeTenantId(record.tenantId),
    toolExecutionIds: record.toolExecutionIds || [],
    updatedAt: new Date().toISOString(),
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_workflow_node_executions (
        id, tenant_id, workflow_run_id, plan_id, node_id, node_label, node_kind, status,
        policy, risk_level, approval_required, tool_execution_ids, input, output,
        error, started_at, completed_at, created_at, updated_at
      )
      VALUES (
        ${nextRecord.id}, ${nextRecord.tenantId}, ${nextRecord.workflowRunId}, ${nextRecord.planId},
        ${nextRecord.nodeId}, ${nextRecord.nodeLabel}, ${nextRecord.nodeKind},
        ${nextRecord.status}, ${nextRecord.policy}, ${nextRecord.riskLevel},
        ${nextRecord.approvalRequired}, ${nextRecord.toolExecutionIds},
        ${JSON.stringify(nextRecord.input || {})}::jsonb,
        ${JSON.stringify(nextRecord.output || null)}::jsonb,
        ${nextRecord.error || null}, ${nextRecord.startedAt || null},
        ${nextRecord.completedAt || null}, ${nextRecord.createdAt}, ${nextRecord.updatedAt}
      )
      ON CONFLICT (plan_id, node_id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        node_label = EXCLUDED.node_label,
        node_kind = EXCLUDED.node_kind,
        status = EXCLUDED.status,
        policy = EXCLUDED.policy,
        risk_level = EXCLUDED.risk_level,
        approval_required = EXCLUDED.approval_required,
        tool_execution_ids = EXCLUDED.tool_execution_ids,
        input = EXCLUDED.input,
        output = EXCLUDED.output,
        error = EXCLUDED.error,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at,
        updated_at = EXCLUDED.updated_at
    `;
    return nextRecord;
  }

  await mutateNodeExecutionLedger((ledger) => {
    ledger.records = [nextRecord, ...ledger.records.filter((item) => item.id !== nextRecord.id && !(item.planId === nextRecord.planId && item.nodeId === nextRecord.nodeId))];
    return trimNodeExecutionLedger(ledger);
  });
  return nextRecord;
}

function baseNodeExecutionRecord({
  detail,
  planId,
  node,
  existing,
}: {
  detail: WorkflowRunDetail;
  planId: string;
  node: WorkflowPlanNode;
  existing?: WorkflowPlanNodeExecutionRecord;
}): WorkflowPlanNodeExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: existing?.id || randomUUID(),
    tenantId: normalizeTenantId(detail.run.tenantId),
    workflowRunId: detail.run.id,
    planId,
    nodeId: node.id,
    nodeLabel: node.label,
    nodeKind: node.kind,
    status: existing?.status || "pending",
    policy: node.policy,
    riskLevel: node.riskLevel,
    approvalRequired: node.approvalRequired,
    toolExecutionIds: existing?.toolExecutionIds || [],
    input: {
      goal: detail.run.goal,
      node,
      workflowMode: detail.run.input.mode || "orchestrate",
    },
    output: existing?.output,
    error: existing?.error,
    startedAt: existing?.startedAt,
    completedAt: existing?.completedAt,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function summarizePlanExecution({
  workflowRunId,
  planId,
  nodeExecutions,
}: {
  workflowRunId: string;
  planId: string;
  nodeExecutions: WorkflowPlanNodeExecutionRecord[];
}): WorkflowPlanExecutionSummary {
  const toolSummaries = nodeExecutions.flatMap((record) => parseToolSummaries(record.output));
  const failedNodes = nodeExecutions.filter((record) => record.status === "failed").length;
  const blockedNodes = nodeExecutions.filter((record) => record.status === "blocked").length;
  const waitingApprovalNodes = nodeExecutions.filter((record) => record.status === "waiting_approval").length;
  const skippedNodes = nodeExecutions.filter((record) => record.status === "skipped").length;
  const highestRiskLevel = toRiskLevel(Math.max(0, ...nodeExecutions.map((record) => record.riskLevel)));
  const status = failedNodes
    ? "failed"
    : blockedNodes
      ? "blocked"
      : waitingApprovalNodes
        ? "waiting_approval"
        : "completed";

  return {
    workflowRunId,
    planId,
    status,
    totalNodes: nodeExecutions.length,
    completedNodes: nodeExecutions.filter((record) => record.status === "completed").length,
    blockedNodes,
    failedNodes,
    skippedNodes,
    waitingApprovalNodes,
    toolExecutions: toolSummaries.length,
    dryRunTools: toolSummaries.filter((tool) => tool.dryRun).length,
    executedTools: toolSummaries.filter((tool) => !tool.dryRun && tool.status === "executed").length,
    approvalRequiredTools: toolSummaries.filter((tool) => tool.approvalRequired).length,
    highestRiskLevel,
    nodeExecutions,
  };
}

function topologicalSort(nodes: WorkflowPlanNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: WorkflowPlanNode[] = [];

  const visit = (node: WorkflowPlanNode) => {
    if (visited.has(node.id)) {
      return;
    }
    if (visiting.has(node.id)) {
      sorted.push(node);
      visited.add(node.id);
      return;
    }

    visiting.add(node.id);
    for (const dependencyId of node.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency) {
        visit(dependency);
      }
    }
    visiting.delete(node.id);
    visited.add(node.id);
    sorted.push(node);
  };

  for (const node of nodes) {
    visit(node);
  }

  return sorted;
}

function parseToolSummaries(output: Record<string, unknown> | undefined): ToolExecutionSummary[] {
  if (!output || !Array.isArray(output.toolExecutions)) {
    return [];
  }

  return output.toolExecutions
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      id: String(item.id || ""),
      toolId: String(item.toolId || ""),
      status: String(item.status || "dry_run") as ToolExecutionRecord["status"],
      dryRun: Boolean(item.dryRun),
      approvalRequired: Boolean(item.approvalRequired),
      riskLevel: Number(item.riskLevel || 0),
      reason: item.reason ? String(item.reason) : undefined,
      result: item.result,
    }));
}

function isReusableNodeExecution(record: WorkflowPlanNodeExecutionRecord) {
  return ["completed", "blocked", "skipped", "waiting_approval"].includes(record.status);
}

function stepOutput(detail: WorkflowRunDetail, stepKey: string) {
  return detail.steps.find((step) => step.stepKey === stepKey)?.output;
}

async function readNodeExecutionLedger() {
  return readJsonFile<WorkflowNodeExecutionLedger>(getNodeExecutionFile(), { records: [] });
}

async function mutateNodeExecutionLedger(mutator: (ledger: WorkflowNodeExecutionLedger) => WorkflowNodeExecutionLedger) {
  nodeExecutionFileWriteQueue = nodeExecutionFileWriteQueue.then(
    async () => {
      const ledger = mutator(await readNodeExecutionLedger());
      await writeNodeExecutionLedger(ledger);
    },
    async () => {
      const ledger = mutator(await readNodeExecutionLedger());
      await writeNodeExecutionLedger(ledger);
    },
  );
  await nodeExecutionFileWriteQueue;
}

async function writeNodeExecutionLedger(ledger: WorkflowNodeExecutionLedger) {
  await writeJsonFile(getNodeExecutionFile(), trimNodeExecutionLedger(ledger));
}

function trimNodeExecutionLedger(ledger: WorkflowNodeExecutionLedger): WorkflowNodeExecutionLedger {
  return {
    records: ledger.records.slice(0, 1000),
  };
}

function workflowPlanNodeExecutionFromRow(row: Record<string, unknown>): WorkflowPlanNodeExecutionRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
    workflowRunId: String(row.workflow_run_id),
    planId: String(row.plan_id),
    nodeId: String(row.node_id),
    nodeLabel: String(row.node_label),
    nodeKind: String(row.node_kind) as WorkflowPlanNodeExecutionRecord["nodeKind"],
    status: String(row.status) as WorkflowPlanNodeExecutionRecord["status"],
    policy: String(row.policy) as WorkflowPlanNodeExecutionRecord["policy"],
    riskLevel: Number(row.risk_level || 0) as WorkflowPlanNodeExecutionRecord["riskLevel"],
    approvalRequired: Boolean(row.approval_required),
    toolExecutionIds: parseTextArray(row.tool_execution_ids),
    input: parseObject(row.input) || {},
    output: parseObject(row.output),
    error: row.error ? String(row.error) : undefined,
    startedAt: row.started_at ? normalizeDate(row.started_at) : undefined,
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function parseTextArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeTenantId(value?: string) {
  return (value || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

function toRiskLevel(value: number): WorkflowPlanExecutionSummary["highestRiskLevel"] {
  if (value >= 3) {
    return 3;
  }
  if (value >= 2) {
    return 2;
  }
  if (value >= 1) {
    return 1;
  }
  return 0;
}

function compactText(parts: string[], limit: number) {
  return parts.filter(Boolean).join("\n").replace(/\s+\n/g, "\n").trim().slice(0, limit);
}

function getNodeExecutionFile() {
  return getDataPath("workflow-node-executions.json");
}
