import { createHash, randomUUID } from "node:crypto";
import {
  WORKFLOW_PLAN_MAX_COST_UNITS,
  WORKFLOW_PLAN_MAX_TOOL_CALLS,
  WORKFLOW_PLAN_MAX_WALL_CLOCK_MS,
  WORKFLOW_PLAN_NODES_PER_TICK,
} from "@/lib/config";
import { getMcpGovernedTool, getOpenApiGovernedTool } from "@/lib/connectors/governed-tools";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { redactSensitive } from "@/lib/security/context";
import {
  deriveExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import { executeGovernedTool } from "@/lib/tools/executor";
import { getGovernedTool } from "@/lib/tools/registry";
import type { ToolDefinition, ToolExecutionRecord } from "@/lib/tools/types";
import {
  appendWorkflowEvent,
  getWorkflowRunExecutionAuthority,
  type WorkflowExecutionAuthority,
} from "@/lib/workflows/store";
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
  costUnits: number;
};

export type WorkflowExecutionBudget = {
  startedAt: number;
  maxWallClockMs: number;
  maxToolCalls: number;
  maxCostUnits: number;
  toolCalls: number;
  costUnits: number;
};

export function createWorkflowExecutionBudget(
  input: Partial<
    Pick<
      WorkflowExecutionBudget,
      "startedAt" | "maxWallClockMs" | "maxToolCalls" | "maxCostUnits"
      | "toolCalls" | "costUnits"
    >
  > = {},
): WorkflowExecutionBudget {
  return {
    startedAt: input.startedAt ?? Date.now(),
    maxWallClockMs: input.maxWallClockMs ?? WORKFLOW_PLAN_MAX_WALL_CLOCK_MS,
    maxToolCalls: input.maxToolCalls ?? WORKFLOW_PLAN_MAX_TOOL_CALLS,
    maxCostUnits: input.maxCostUnits ?? WORKFLOW_PLAN_MAX_COST_UNITS,
    toolCalls: input.toolCalls ?? 0,
    costUnits: input.costUnits ?? 0,
  };
}

export function reserveWorkflowToolBudget({
  budget,
  tool,
  dryRun,
  now = Date.now(),
}: {
  budget: WorkflowExecutionBudget;
  tool?: ToolDefinition;
  dryRun: boolean;
  now?: number;
}) {
  if (now - budget.startedAt >= budget.maxWallClockMs) {
    throw new Error(
      `Workflow plan exceeded its ${budget.maxWallClockMs}ms wall-clock budget.`,
    );
  }
  const costUnits = workflowToolCostUnits(tool, dryRun);
  if (budget.toolCalls + 1 > budget.maxToolCalls) {
    throw new Error(
      `Workflow plan exceeded its ${budget.maxToolCalls}-call tool budget.`,
    );
  }
  if (budget.costUnits + costUnits > budget.maxCostUnits) {
    throw new Error(
      `Workflow plan exceeded its ${budget.maxCostUnits}-unit cost budget.`,
    );
  }
  budget.toolCalls += 1;
  budget.costUnits += costUnits;
}

export function workflowToolCostUnits(
  tool: ToolDefinition | undefined,
  dryRun: boolean,
) {
  if (dryRun) {
    return 1;
  }
  if (!tool) {
    return 1;
  }
  if (tool.category === "mcp" || tool.category === "openapi" || tool.category === "connector") {
    return 5;
  }
  if (tool.category === "web") {
    return 4;
  }
  return 1;
}

export async function executeDynamicWorkflowPlan(
  detail: WorkflowRunDetail,
  options: { abortSignal?: AbortSignal } = {},
): Promise<WorkflowPlanExecutionSummary | null> {
  throwIfAborted(options.abortSignal);
  const parsedPlan = parseWorkflowPlanOutput(stepOutput(detail, "plan"));
  if (!parsedPlan) {
    return null;
  }
  const executionAuthority = await getWorkflowRunExecutionAuthority(detail.run.id, {
    tenantId: detail.run.tenantId,
  });
  if (detail.run.input.executionAuthorityRequired && !executionAuthority) {
    throw new Error("Workflow execution authority is missing.");
  }

  const sortedNodes = topologicalSort(parsedPlan.plan.nodes);
  const priorRecords = await listWorkflowPlanNodeExecutionsForRun(detail.run.id, 250);
  const planRecords = priorRecords.filter(
    (record) => record.planId === parsedPlan.id,
  );
  const existingByNode = new Map(
    planRecords.map((record) => [record.nodeId, record]),
  );
  const priorToolExecutions = planRecords.flatMap((record) =>
    parseToolSummaries(record.output)
  );
  const recordsByNode = new Map<string, WorkflowPlanNodeExecutionRecord>();
  const nodeExecutions: WorkflowPlanNodeExecutionRecord[] = [];
  const toolCache = new Map<string, Promise<ToolDefinition | undefined>>();
  const priorElapsedMs = workflowPlanElapsedMs(planRecords);
  const budget = createWorkflowExecutionBudget({
    startedAt: Date.now() - priorElapsedMs,
    toolCalls: priorToolExecutions.length,
    costUnits: priorToolExecutions.reduce(
      (total, execution) => total + execution.costUnits,
      0,
    ),
  });
  let processedNodes = 0;
  let hasPendingNodes = false;

  for (const node of sortedNodes) {
    throwIfAborted(options.abortSignal);
    assertWorkflowWallClockBudget(budget);
    const existing = existingByNode.get(node.id);
    if (existing && isReusableNodeExecution(existing)) {
      recordsByNode.set(node.id, existing);
      nodeExecutions.push(existing);
      continue;
    }
    if (processedNodes >= WORKFLOW_PLAN_NODES_PER_TICK) {
      hasPendingNodes = true;
      continue;
    }
    processedNodes += 1;

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
        abortSignal: options.abortSignal,
        toolCache,
        budget,
        executionAuthority,
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
      if (options.abortSignal?.aborted) {
        await saveWorkflowPlanNodeExecution({
          ...baseNodeExecutionRecord({ detail, planId: parsedPlan.id, node, existing: runningRecord }),
          status: "pending",
          error: undefined,
          startedAt: undefined,
          completedAt: undefined,
        });
        await appendWorkflowEvent(detail.run.id, "workflow.plan_node.interrupted", {
          planId: parsedPlan.id,
          nodeId: node.id,
        });
        throw options.abortSignal.reason instanceof Error
          ? options.abortSignal.reason
          : new DOMException("Workflow plan execution was aborted.", "AbortError");
      }
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
    totalNodes: sortedNodes.length,
    hasPendingNodes,
    budget,
  });
  await appendWorkflowEvent(
    detail.run.id,
    summary.status === "running"
      ? "workflow.plan_execution.progress"
      : "workflow.plan_execution.completed",
    {
    planId: parsedPlan.id,
    status: summary.status,
    completedNodes: summary.completedNodes,
    toolExecutions: summary.toolExecutions,
    dryRunTools: summary.dryRunTools,
    executedTools: summary.executedTools,
    toolCalls: budget.toolCalls,
    costUnits: budget.costUnits,
    elapsedMs: summary.elapsedMs,
    },
  );

  return summary;
}

export async function listWorkflowPlanNodeExecutions(
  limit = 100,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const boundedLimit = Math.min(Math.max(limit, 1), 500);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_workflow_node_executions
      WHERE tenant_id = ${tenantId}
      ORDER BY updated_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(workflowPlanNodeExecutionFromRow);
  }

  const ledger = await readNodeExecutionLedger();
  return ledger.records
    .filter((record) => normalizeTenantId(record.tenantId) === tenantId)
    .slice(0, boundedLimit);
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

export async function getWorkflowPlanNodeExecutionStats(
  options: { tenantId?: string } = {},
): Promise<WorkflowPlanNodeExecutionStats> {
  const records = await listWorkflowPlanNodeExecutions(500, options);
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
  abortSignal,
  toolCache,
  budget,
  executionAuthority,
}: {
  detail: WorkflowRunDetail;
  plan: WorkflowDynamicPlan;
  planId: string;
  node: WorkflowPlanNode;
  dependencyRecords: WorkflowPlanNodeExecutionRecord[];
  abortSignal?: AbortSignal;
  toolCache: Map<string, Promise<ToolDefinition | undefined>>;
  budget: WorkflowExecutionBudget;
  executionAuthority?: WorkflowExecutionAuthority;
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

  const workflowApproved = Boolean(detail.run.approvedAt);
  const plannedTools = (await Promise.all(
    node.toolIds.slice(0, 6).map(async (toolId) => ({
      toolId,
      tool: await getCachedToolDefinition(toolCache, toolId, {
        tenantId: detail.run.tenantId,
      }),
    })),
  )).map(({ toolId, tool }) => ({
    toolId,
    tool,
    dryRun: shouldDryRunWorkflowTool({
      toolId,
      tool,
      node,
      workflowApproved,
    }),
  }));
  for (const { tool, dryRun } of plannedTools) {
    reserveWorkflowToolBudget({ budget, tool, dryRun });
  }
  const executeTool = async ({
    toolId,
    tool,
    dryRun,
  }: {
    toolId: string;
    tool?: ToolDefinition;
    dryRun: boolean;
  }): Promise<ToolExecutionSummary> => {
    throwIfAborted(abortSignal);
    const executionSignal = workflowBudgetAbortSignal(budget, abortSignal);
    const executionScope = executionAuthority?.executionScope;
    const initiatingActorId = executionScope?.initiatingActorId || "workflow";
    const execution = await executeGovernedTool({
      toolId,
      input: buildToolInput({ detail, plan, planId, node, toolId }),
      dryRun,
      approved: workflowApproved && !dryRun,
      context: {
        tenantId: normalizeTenantId(detail.run.tenantId),
        actorId: initiatingActorId,
        role: executionAuthority?.requesterRole || "system",
        source: "default",
      },
      approvalReason: detail.run.approvedAt
        ? `Workflow ${detail.run.id} was approved before plan-node execution.`
        : undefined,
      abortSignal: executionSignal,
      idempotencyKey: `workflow:${detail.run.id}:plan:${planId}:node:${node.id}:tool:${toolId}`,
      mcpSessionScope: {
        tenantId: normalizeTenantId(detail.run.tenantId),
        actorId: initiatingActorId,
        executionId: `workflow:${detail.run.id}`,
      },
      executionScope: executionScope
        ? workflowToolExecutionScope(executionScope, {
            workflowRunId: detail.run.id,
            planId,
            nodeId: node.id,
            toolId,
          })
        : undefined,
    });
    return {
      id: execution.record.id,
      toolId: execution.record.toolId,
      status: execution.record.status,
      dryRun: execution.record.dryRun,
      approvalRequired: execution.record.approvalRequired,
      riskLevel: execution.record.riskLevel,
      reason: execution.record.reason,
      result: execution.result,
      costUnits: workflowToolCostUnits(tool, dryRun),
    };
  };

  if (
    plannedTools.length > 1 &&
    plannedTools.every(({ tool }) => isIndependentReadOnlyTool(tool))
  ) {
    toolExecutions.push(...await Promise.all(plannedTools.map(executeTool)));
  } else {
    for (const plannedTool of plannedTools) {
      toolExecutions.push(await executeTool(plannedTool));
    }
  }

  const failed = toolExecutions.find(
    (tool) => tool.status === "failed" || tool.status === "executing",
  );
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
    error:
      failed?.reason ||
      (failed?.status === "executing"
        ? "A prior execution has no terminal result; the side effect was not replayed."
        : undefined) ||
      blocked?.reason ||
      waitingApproval?.reason,
  };
}

function workflowToolExecutionScope(
  workflowScope: ExecutionScope,
  input: {
    workflowRunId: string;
    planId: string;
    nodeId: string;
    toolId: string;
  },
) {
  const causationDigest = createHash("sha256")
    .update([
      input.workflowRunId,
      input.planId,
      input.nodeId,
      input.toolId,
    ].join("\0"))
    .digest("hex");
  return deriveExecutionScope(workflowScope, {
    executingPrincipalType: "system",
    executingPrincipalId: `workflow:${input.workflowRunId}`,
    causationId: `workflow.tool:${causationDigest}`,
    purpose: "workflow.tool.execute",
  });
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

function getCachedToolDefinition(
  cache: Map<string, Promise<ToolDefinition | undefined>>,
  toolId: string,
  options: { tenantId?: string },
) {
  const cacheKey = `${normalizeTenantId(options.tenantId)}:${toolId}`;
  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = getToolDefinition(toolId, options);
    cache.set(cacheKey, pending);
  }
  return pending;
}

export function isIndependentReadOnlyTool(tool: ToolDefinition | undefined) {
  return Boolean(
    tool &&
      tool.riskLevel === 0 &&
      !tool.approvalRequired &&
      ["memory", "knowledge", "runs", "missions", "web"].includes(tool.category) &&
      !["memory.write", "knowledge.ingest"].includes(tool.id),
  );
}

function assertWorkflowWallClockBudget(
  budget: WorkflowExecutionBudget,
  now = Date.now(),
) {
  if (now - budget.startedAt >= budget.maxWallClockMs) {
    throw new Error(
      `Workflow plan exceeded its ${budget.maxWallClockMs}ms wall-clock budget.`,
    );
  }
}

function workflowBudgetAbortSignal(
  budget: WorkflowExecutionBudget,
  signal?: AbortSignal,
) {
  const remaining = Math.max(
    1,
    budget.maxWallClockMs - (Date.now() - budget.startedAt),
  );
  const timeoutSignal = AbortSignal.timeout(remaining);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export function shouldDryRunWorkflowTool({
  toolId,
  tool,
  node,
  workflowApproved = false,
}: {
  toolId: string;
  tool?: ToolDefinition;
  node: WorkflowPlanNode;
  workflowApproved?: boolean;
}) {
  if (!tool) {
    return true;
  }

  if (node.policy === "dry_run" || node.policy === "manual") {
    return true;
  }

  if (workflowApproved) {
    // A workflow gate records one plan approval. It cannot satisfy the
    // independent two-admin quorum required for risk-3 tool execution, so keep
    // those calls as previews instead of creating detached approval records.
    return tool.riskLevel >= 3;
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
}: {
  detail: WorkflowRunDetail;
  plan: WorkflowDynamicPlan;
  planId: string;
  node: WorkflowPlanNode;
  toolId: string;
}): Record<string, unknown> {
  const query = compactText([
    detail.run.goal,
    node.label,
    node.description,
    node.acceptanceCriteria.join(" "),
  ], 1400);
  const plannedInput = node.toolInputs?.find(
    (toolInput) => toolInput.toolId === toolId,
  );
  if (plannedInput) {
    if (Buffer.byteLength(plannedInput.inputJson, "utf8") > 64_000) {
      throw new Error(`Planned input for ${toolId} exceeds 64,000 bytes.`);
    }
    try {
      const parsed: unknown = JSON.parse(plannedInput.inputJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // The explicit error below keeps malformed reviewed plans fail-closed.
    }
    throw new Error(`Planned input for ${toolId} is not a JSON object.`);
  }

  if (toolId === "memory.search" || toolId === "knowledge.search") {
    return { query, limit: 5 };
  }

  if (toolId === "web.search") {
    return {
      query,
      limit: 8,
      searchContextSize: node.kind === "research" ? "high" : "medium",
    };
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

  throw new Error(
    `Workflow plan ${planId} is missing reviewed input for ${toolId} on node ${node.id}.`,
  );
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
  const nextRecord = sanitizeWorkflowPlanNodeExecution({
    ...record,
    tenantId: normalizeTenantId(record.tenantId),
    toolExecutionIds: record.toolExecutionIds || [],
    updatedAt: new Date().toISOString(),
  });

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
        ${nextRecord.input || {}}::jsonb,
        ${nextRecord.output || null}::jsonb,
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
  totalNodes,
  hasPendingNodes,
  budget,
}: {
  workflowRunId: string;
  planId: string;
  nodeExecutions: WorkflowPlanNodeExecutionRecord[];
  totalNodes: number;
  hasPendingNodes: boolean;
  budget: WorkflowExecutionBudget;
}): WorkflowPlanExecutionSummary {
  const toolSummaries = nodeExecutions.flatMap((record) => parseToolSummaries(record.output));
  const failedNodes = nodeExecutions.filter((record) => record.status === "failed").length;
  const blockedNodes = nodeExecutions.filter((record) => record.status === "blocked").length;
  const waitingApprovalNodes = nodeExecutions.filter((record) => record.status === "waiting_approval").length;
  const skippedNodes = nodeExecutions.filter((record) => record.status === "skipped").length;
  const highestRiskLevel = toRiskLevel(Math.max(0, ...nodeExecutions.map((record) => record.riskLevel)));
  const status = hasPendingNodes
    ? "running"
    : failedNodes
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
    totalNodes,
    completedNodes: nodeExecutions.filter((record) => record.status === "completed").length,
    blockedNodes,
    failedNodes,
    skippedNodes,
    waitingApprovalNodes,
    toolExecutions: toolSummaries.length,
    dryRunTools: toolSummaries.filter((tool) => tool.dryRun).length,
    executedTools: toolSummaries.filter((tool) => !tool.dryRun && tool.status === "executed").length,
    approvalRequiredTools: toolSummaries.filter((tool) => tool.approvalRequired).length,
    toolCalls: budget.toolCalls,
    costUnits: budget.costUnits,
    elapsedMs: Math.max(0, Date.now() - budget.startedAt),
    highestRiskLevel,
    nodeExecutions,
  };
}

export function workflowPlanElapsedMs(
  records: readonly WorkflowPlanNodeExecutionRecord[],
) {
  return records.reduce((total, record) => {
    const startedAt = Date.parse(record.startedAt || "");
    const completedAt = Date.parse(record.completedAt || record.updatedAt);
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(completedAt) ||
      completedAt <= startedAt
    ) {
      return total;
    }
    return total + (completedAt - startedAt);
  }, 0);
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
      costUnits: Math.max(
        1,
        Number(
          item.costUnits ||
            (item.dryRun
              ? 1
              : String(item.toolId || "").startsWith("web.")
                ? 4
                : /^(connector|mcp|openapi)\./.test(String(item.toolId || ""))
                  ? 5
                  : 1),
        ),
      ),
    }));
}

function isReusableNodeExecution(record: WorkflowPlanNodeExecutionRecord) {
  return ["completed", "blocked", "skipped", "waiting_approval"].includes(record.status);
}

function stepOutput(detail: WorkflowRunDetail, stepKey: string) {
  return detail.steps.find((step) => step.stepKey === stepKey)?.output;
}

async function readNodeExecutionLedger() {
  const ledger = await readJsonFile<WorkflowNodeExecutionLedger>(
    getNodeExecutionFile(),
    { records: [] },
  );
  return {
    records: ledger.records.map(sanitizeWorkflowPlanNodeExecution),
  };
}

async function mutateNodeExecutionLedger(mutator: (ledger: WorkflowNodeExecutionLedger) => WorkflowNodeExecutionLedger) {
  await updateJsonFile<WorkflowNodeExecutionLedger>(
    getNodeExecutionFile(),
    { records: [] },
    (ledger) => trimNodeExecutionLedger(mutator(ledger)),
  );
}

function trimNodeExecutionLedger(ledger: WorkflowNodeExecutionLedger): WorkflowNodeExecutionLedger {
  const durable = ledger.records.filter(
    (record) => record.status === "pending" ||
      record.status === "running" ||
      record.status === "waiting_approval",
  );
  const terminal = ledger.records.filter(
    (record) => record.status !== "pending" &&
      record.status !== "running" &&
      record.status !== "waiting_approval",
  );
  return {
    records: [...durable, ...terminal.slice(0, Math.max(0, 1000 - durable.length))],
  };
}

function workflowPlanNodeExecutionFromRow(row: Record<string, unknown>): WorkflowPlanNodeExecutionRecord {
  return sanitizeWorkflowPlanNodeExecution({
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
  });
}

function sanitizeWorkflowPlanNodeExecution(
  record: WorkflowPlanNodeExecutionRecord,
): WorkflowPlanNodeExecutionRecord {
  return {
    ...record,
    input: redactSensitive(record.input) as Record<string, unknown>,
    output: record.output
      ? (redactSensitive(record.output) as Record<string, unknown>)
      : undefined,
    error: record.error
      ? String(redactSensitive(record.error)).slice(0, 2_000)
      : undefined,
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
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
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

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Workflow plan execution was aborted.", "AbortError");
  }
}
