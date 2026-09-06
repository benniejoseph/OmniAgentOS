import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type {
  WorkflowDynamicPlan,
  WorkflowPlanNode,
  WorkflowPlanNodeExecutionRecord,
  WorkflowReplanDirectiveV1,
  WorkflowReplanTrigger,
} from "@/lib/workflows/types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const replanDirectiveSchema = z.object({
  schemaVersion: z.literal(1),
  previousPlanId: z.string().trim().min(1).max(200),
  previousPlanSha256: z.string().regex(SHA256_PATTERN),
  trigger: z.enum(["assumption", "observation", "tool", "verification"]),
  failureNodeIds: z.array(z.string().trim().min(1).max(120)).min(1).max(18),
  affectedNodeIds: z.array(z.string().trim().min(1).max(120)).min(1).max(18),
  reusedNodes: z.array(z.object({
    nodeId: z.string().trim().min(1).max(120),
    executionId: z.string().trim().min(1).max(240),
    sourcePlanId: z.string().trim().min(1).max(200),
    nodeSha256: z.string().regex(SHA256_PATTERN),
    outputSha256: z.string().regex(SHA256_PATTERN),
  }).strict()).max(18),
  approvalInvalidated: z.boolean(),
  contextGrantsInvalidated: z.literal(true),
  capabilityGrantsInvalidated: z.literal(true),
  previousContextTraceId: z.string().trim().min(1).max(240).optional(),
}).strict().superRefine((value, context) => {
  const failures = new Set(value.failureNodeIds);
  const affected = new Set(value.affectedNodeIds);
  const reused = new Set(value.reusedNodes.map((reference) => reference.nodeId));
  if (failures.size !== value.failureNodeIds.length) {
    context.addIssue({ code: "custom", message: "Workflow replan failure nodes must be unique." });
  }
  if (affected.size !== value.affectedNodeIds.length) {
    context.addIssue({ code: "custom", message: "Workflow replan affected nodes must be unique." });
  }
  if (reused.size !== value.reusedNodes.length) {
    context.addIssue({ code: "custom", message: "Workflow replan reused nodes must be unique." });
  }
  if ([...failures].some((nodeId) => !affected.has(nodeId))) {
    context.addIssue({ code: "custom", message: "Workflow replan failures must be inside the affected subtree." });
  }
  if (value.reusedNodes.some((reference) =>
    affected.has(reference.nodeId) || reference.sourcePlanId !== value.previousPlanId
  )) {
    context.addIssue({ code: "custom", message: "Workflow replan reuse lineage is inconsistent." });
  }
});

export function createWorkflowReplanDirective({
  previousPlanId,
  previousPlan,
  nodeExecutions,
  verificationFailures,
  approvalInvalidated,
  previousContextTraceId,
}: {
  previousPlanId: string;
  previousPlan: WorkflowDynamicPlan;
  nodeExecutions: readonly WorkflowPlanNodeExecutionRecord[];
  verificationFailures: readonly string[];
  approvalInvalidated: boolean;
  previousContextTraceId?: string;
}): WorkflowReplanDirectiveV1 {
  const nodesById = new Map(previousPlan.nodes.map((node) => [node.id, node]));
  const executionsByNode = new Map(
    nodeExecutions
      .filter((record) => record.planId === previousPlanId)
      .map((record) => [record.nodeId, record]),
  );
  const explicitFailures = new Set(
    previousPlan.nodes.flatMap((node) =>
      verificationFailures.some((failure) => mentionsNodeId(failure, node.id))
        ? [node.id]
        : []
    ),
  );
  for (const node of previousPlan.nodes) {
    const execution = executionsByNode.get(node.id);
    if (
      !execution ||
      execution.status !== "completed" ||
      !execution.output
    ) {
      explicitFailures.add(node.id);
    }
    if (executionHasFailedAcceptance(execution)) {
      explicitFailures.add(node.id);
    }
  }
  if (explicitFailures.size === 0) {
    for (const nodeId of terminalNodeIds(previousPlan.nodes)) {
      explicitFailures.add(nodeId);
    }
  }
  const affected = descendantClosure(previousPlan.nodes, explicitFailures);
  const failureNodeIds = previousPlan.nodes
    .filter((node) => explicitFailures.has(node.id))
    .map((node) => node.id);
  const affectedNodeIds = previousPlan.nodes
    .filter((node) => affected.has(node.id))
    .map((node) => node.id);
  const reusedNodes = previousPlan.nodes.flatMap((node) => {
    if (affected.has(node.id)) return [];
    const execution = executionsByNode.get(node.id);
    if (!execution || execution.status !== "completed" || !execution.output) {
      return [];
    }
    return [{
      nodeId: node.id,
      executionId: execution.id,
      sourcePlanId: previousPlanId,
      nodeSha256: workflowPlanNodeSha256(node),
      outputSha256: canonicalJsonSha256(execution.output),
    }];
  });
  const directive: WorkflowReplanDirectiveV1 = {
    schemaVersion: 1,
    previousPlanId,
    previousPlanSha256: workflowPlanDefinitionSha256(previousPlan),
    trigger: classifyReplanTrigger({
      nodesById,
      failureNodeIds,
      verificationFailures,
    }),
    failureNodeIds,
    affectedNodeIds,
    reusedNodes,
    approvalInvalidated,
    contextGrantsInvalidated: true,
    capabilityGrantsInvalidated: true,
    ...(previousContextTraceId ? { previousContextTraceId } : {}),
  };
  return parseWorkflowReplanDirective(directive);
}

export function applyWorkflowSubtreeReplan({
  previousPlanId,
  previousPlan,
  candidatePlan,
  directive: rawDirective,
}: {
  previousPlanId: string;
  previousPlan: WorkflowDynamicPlan;
  candidatePlan: WorkflowDynamicPlan;
  directive: WorkflowReplanDirectiveV1;
}) {
  const directive = parseWorkflowReplanDirective(rawDirective);
  if (
    directive.previousPlanId !== previousPlanId ||
    directive.previousPlanSha256 !== workflowPlanDefinitionSha256(previousPlan)
  ) {
    throw new Error("Workflow replan directive does not bind the previous plan.");
  }
  const previousIds = previousPlan.nodes.map((node) => node.id);
  const candidateById = new Map(candidatePlan.nodes.map((node) => [node.id, node]));
  if (
    candidateById.size !== previousIds.length ||
    previousIds.some((nodeId) => !candidateById.has(nodeId))
  ) {
    throw new Error("Workflow subtree replan must preserve the exact bounded node ID set.");
  }
  const affected = new Set(directive.affectedNodeIds);
  if (affected.size === 0 || [...affected].some((nodeId) => !candidateById.has(nodeId))) {
    throw new Error("Workflow subtree replan has an invalid affected node set.");
  }
  const reusableByNode = new Map(
    directive.reusedNodes.map((reference) => [reference.nodeId, reference]),
  );
  const unaffectedNodes = previousPlan.nodes.filter((node) => !affected.has(node.id));
  if (
    reusableByNode.size !== unaffectedNodes.length ||
    unaffectedNodes.some((node) => {
      const reference = reusableByNode.get(node.id);
      return !reference || reference.nodeSha256 !== workflowPlanNodeSha256(node);
    })
  ) {
    throw new Error("Workflow subtree replan does not bind every unaffected node execution.");
  }
  const mergedNodes = previousPlan.nodes.map((node) =>
    affected.has(node.id) ? candidateById.get(node.id)! : node
  );
  if (!mergedNodes.some((node) =>
    affected.has(node.id) &&
    workflowPlanNodeSha256(node) !== workflowPlanNodeSha256(
      previousPlan.nodes.find((previous) => previous.id === node.id)!,
    )
  )) {
    throw new Error("Workflow subtree replan did not materially change affected work.");
  }
  const edgeConditions = new Map(candidatePlan.edges.map((edge) => [
    `${edge.from}\0${edge.to}`,
    edge.condition,
  ]));
  const edges = mergedNodes.flatMap((node) => node.dependsOn.map((dependencyId) => ({
    from: dependencyId,
    to: node.id,
    condition: edgeConditions.get(`${dependencyId}\0${node.id}`) || "completed",
  })));
  const selectedToolIds = unique(mergedNodes.flatMap((node) => node.toolIds));
  const connectorTargets = unique(mergedNodes.flatMap((node) => node.connectorTargets));
  const highestRiskLevel = Math.max(
    candidatePlan.executionPolicy.highestRiskLevel,
    ...mergedNodes.map((node) => node.riskLevel),
  ) as 0 | 1 | 2 | 3;
  const requiresApproval = Boolean(
    directive.approvalInvalidated ||
    candidatePlan.executionPolicy.requiresApproval ||
    mergedNodes.some((node) => node.approvalRequired || node.riskLevel >= 2),
  );
  return {
    ...candidatePlan,
    objective: previousPlan.objective,
    mode: previousPlan.mode,
    nodes: mergedNodes,
    edges,
    selectedToolIds,
    connectorTargets,
    executionPolicy: {
      ...candidatePlan.executionPolicy,
      highestRiskLevel,
      requiresApproval,
      defaultPolicy: requiresApproval
        ? "approval_required" as const
        : candidatePlan.executionPolicy.defaultPolicy,
    },
    replan: directive,
  } satisfies WorkflowDynamicPlan;
}

export function resolveWorkflowReusedNodeExecutions(
  plan: WorkflowDynamicPlan,
  records: readonly WorkflowPlanNodeExecutionRecord[],
) {
  if (!plan.replan) return [];
  const directive = parseWorkflowReplanDirective(plan.replan);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const nodesById = new Map(plan.nodes.map((node) => [node.id, node]));
  return directive.reusedNodes.map((reference) => {
    const node = nodesById.get(reference.nodeId);
    const record = recordsById.get(reference.executionId);
    if (
      !node ||
      workflowPlanNodeSha256(node) !== reference.nodeSha256 ||
      !record ||
      record.planId !== reference.sourcePlanId ||
      record.nodeId !== reference.nodeId ||
      record.status !== "completed" ||
      !record.output ||
      canonicalJsonSha256(record.output) !== reference.outputSha256
    ) {
      throw new Error(`Workflow reusable node ${reference.nodeId} failed lineage validation.`);
    }
    return record;
  });
}

export function parseWorkflowReplanDirective(value: unknown) {
  return replanDirectiveSchema.parse(value) as WorkflowReplanDirectiveV1;
}

export function workflowPlanNodeSha256(node: WorkflowPlanNode) {
  return canonicalJsonSha256(node);
}

export function workflowPlanDefinitionSha256(plan: WorkflowDynamicPlan) {
  const { replan: _replan, ...definition } = plan;
  void _replan;
  return canonicalJsonSha256(definition);
}

function descendantClosure(
  nodes: readonly WorkflowPlanNode[],
  roots: ReadonlySet<string>,
) {
  const affected = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!affected.has(node.id) && node.dependsOn.some((id) => affected.has(id))) {
        affected.add(node.id);
        changed = true;
      }
    }
  }
  return affected;
}

function terminalNodeIds(nodes: readonly WorkflowPlanNode[]) {
  const dependencies = new Set(nodes.flatMap((node) => node.dependsOn));
  return nodes.filter((node) => !dependencies.has(node.id)).map((node) => node.id);
}

function executionHasFailedAcceptance(
  execution: WorkflowPlanNodeExecutionRecord | undefined,
) {
  const nodeResult = recordValue(execution?.output?.nodeResult);
  return Array.isArray(nodeResult?.acceptanceChecks) &&
    nodeResult.acceptanceChecks.some((value) => recordValue(value)?.passed === false);
}

function classifyReplanTrigger({
  nodesById,
  failureNodeIds,
  verificationFailures,
}: {
  nodesById: ReadonlyMap<string, WorkflowPlanNode>;
  failureNodeIds: readonly string[];
  verificationFailures: readonly string[];
}): WorkflowReplanTrigger {
  const combined = verificationFailures.join(" ").toLowerCase();
  if (combined.includes("assumption")) return "assumption";
  if (combined.includes("observation")) return "observation";
  if (failureNodeIds.some((nodeId) => (nodesById.get(nodeId)?.toolIds.length || 0) > 0)) {
    return "tool";
  }
  return "verification";
}

function mentionsNodeId(value: string, nodeId: string) {
  if (nodeId.length < 3) return false;
  const escaped = escapeRegExp(nodeId);
  return [
    new RegExp(`^\\s*${escaped}([^a-z0-9_-]|$)`, "i"),
    new RegExp(`[\u0060'\"]${escaped}[\u0060'\"]`, "i"),
    new RegExp(`(^|[^a-z0-9_-])node\\s+${escaped}([^a-z0-9_-]|$)`, "i"),
    new RegExp(`(^|[^a-z0-9_-])${escaped}\\s+node([^a-z0-9_-]|$)`, "i"),
  ].some((pattern) => pattern.test(value));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}
