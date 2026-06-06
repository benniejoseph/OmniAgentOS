import { hasOpenAIKey } from "@/lib/config";
import { hashPassword, verifyPassword } from "@/lib/auth/crypto";
import { isAuthEnforced } from "@/lib/auth/store";
import { getStorageBackend, hasDatabaseUrl } from "@/lib/db/client";
import {
  createAlertWebhookSignature,
  dispatchAlertDeliveries,
  enqueueAlertDeliveriesForActiveIncidents,
  getAlertDeliveryPolicies,
  getAlertSchedulerState,
  getAlertDeliveryStats,
  getAlertTargetHealth,
  retryFailedAlertDeliveries,
  runScheduledAlertDispatch,
} from "@/lib/diagnostics/alerts";
import { getHealthStats, runSystemDiagnostics } from "@/lib/diagnostics/health";
import {
  acknowledgeIncident,
  getIncidentAlertTargets,
  getIncidentPlaybooks,
  getIncidentStats,
  listIncidents,
} from "@/lib/diagnostics/incidents";
import { runIncidentPlaybook } from "@/lib/diagnostics/playbooks";
import { executeGovernedTool } from "@/lib/tools/executor";
import { connectionCatalog } from "@/lib/connectors/catalog";
import { getCapabilityRegistry } from "@/lib/orchestration/registry";
import { getMemoryGraphStats, rebuildMemoryGraph, searchMemoryGraph } from "@/lib/memory/graph";
import { listMemories, saveMemory } from "@/lib/memory/store";
import { getApprovalQueue, getOperationsOverview } from "@/lib/operations/queue";
import { buildContextPack, getContextEngineStats } from "@/lib/rag/context-engine";
import { retrieveContext } from "@/lib/rag/retriever";
import { canPerform, redactSensitive } from "@/lib/security/context";
import { enqueueWorkflowRunTick, processWorkflowQueue } from "@/lib/workflows/queue";
import { executeDynamicWorkflowPlan, getWorkflowPlanNodeExecutionStats } from "@/lib/workflows/executor";
import { buildDynamicWorkflowPlan, getWorkflowPlanStats } from "@/lib/workflows/planner";
import { createWorkflowRun, getWorkflowRunDetail, updateWorkflowStep } from "@/lib/workflows/store";
import { createWorkflowTrigger, dispatchWorkflowTrigger, getWorkflowTriggerStats } from "@/lib/workflows/triggers";
import {
  completeEvalRun,
  createEvalRun,
  failEvalRun,
  getEvalRunDetail,
  saveEvalResult,
} from "@/lib/evaluations/store";
import type {
  EvalCaseDefinition,
  EvalResultRecord,
  EvalResultStatus,
  EvalRunSummary,
} from "@/lib/evaluations/types";

type CaseResult = {
  status: EvalResultStatus;
  score: number;
  output: Record<string, unknown>;
  estimatedCostUsd?: number;
};

export const defaultEvalCases: EvalCaseDefinition[] = [
  {
    id: "system.readiness",
    name: "System readiness",
    description: "Checks core registry status, storage backend, OpenAI config, and database config.",
    type: "system",
    input: {},
    expected: {
      activeTools: ["tool.executor", "connector.openapi", "workflow.temporal", "workflow.plan_executor", "workflow.webhook_trigger"],
      storage: "configured",
    },
  },
  {
    id: "retrieval.context_quality",
    name: "Retrieval quality",
    description: "Runs hybrid memory/RAG retrieval for durable workflow and connector context.",
    type: "retrieval",
    input: {
      query: "durable workflow runtime approval persisted report OpenAPI connector",
      limit: 6,
    },
    expected: {
      minContextCount: 1,
      maxLatencyMs: 6000,
    },
  },
  {
    id: "retrieval.context_engine",
    name: "Context engine",
    description: "Builds an adaptive evidence pack with mode routing, diversity, confidence, and trace persistence.",
    type: "retrieval",
    input: {
      query: "review the agentic workflow architecture across RAG, memory, approvals, operations, and security",
      limit: 6,
    },
    expected: {
      minSelectedEvidence: 1,
      tracePersisted: true,
      allowedModes: ["global", "hybrid"],
    },
  },
  {
    id: "memory.graph_engine",
    name: "Graph memory engine",
    description: "Builds concept/entity communities from durable memories and retrieval traces, then verifies graph evidence can feed the context engine.",
    type: "retrieval",
    input: {
      query: "adaptive RAG graph memory workflow approvals evaluation security",
      limit: 6,
    },
    expected: {
      minNodes: 4,
      minEdges: 3,
      minGraphResults: 1,
      contextSelectsGraph: true,
    },
  },
  {
    id: "tool.policy_dry_run",
    name: "Governed tool policy",
    description: "Dry-runs a read-only governed tool and verifies risk/audit policy behavior.",
    type: "tool",
    input: {
      toolId: "runs.list",
      input: { limit: 2 },
      dryRun: true,
    },
    expected: {
      status: "dry_run",
      riskLevel: 0,
    },
  },
  {
    id: "workflow.lifecycle",
    name: "Workflow lifecycle",
    description: "Starts a workflow, ticks it to completion, and verifies persisted result output.",
    type: "workflow",
    input: {
      goal: "Evaluation harness workflow lifecycle smoke.",
      requireApproval: false,
      maxTicks: 8,
    },
    expected: {
      finalStatus: "completed",
      maxTicks: 8,
    },
  },
  {
    id: "workflow.dynamic_planner",
    name: "Dynamic workflow planner",
    description: "Builds a typed workflow DAG with tool selection, approval policy, validation, persistence, and workflow-run integration.",
    type: "workflow",
    input: {
      goal: "Plan a production-safe agent workflow that researches context, chooses tools, verifies output, and persists memory.",
      mode: "orchestrate",
    },
    expected: {
      minNodes: 4,
      minSelectedTools: 2,
      validDag: true,
      persisted: true,
    },
  },
  {
    id: "workflow.plan_executor",
    name: "Plan-driven workflow executor",
    description: "Executes dynamic workflow DAG nodes through governed tool decisions, node persistence, and verification-ready summaries.",
    type: "workflow",
    input: {
      goal: "Execute a production-safe dynamic plan with retrieval, tool decisions, verification, and memory-ready outputs.",
      mode: "orchestrate",
    },
    expected: {
      minCompletedNodes: 3,
      minToolExecutions: 2,
      persisted: true,
      noFailedNodes: true,
    },
  },
  {
    id: "workflow.webhook_triggers",
    name: "Webhook workflow triggers",
    description: "Creates a workflow trigger, dispatches an external event, persists trigger audit data, and enqueues a workflow run.",
    type: "workflow",
    input: {
      eventType: "issue.created",
      source: "evaluation-webhook",
      summary: "Evaluate signed-event workflow trigger path.",
    },
    expected: {
      workflowEnqueued: true,
      eventPersisted: true,
      triggerCountIncremented: true,
    },
  },
  {
    id: "security.rbac_controls",
    name: "RBAC security controls",
    description: "Verifies role permissions and sensitive metadata redaction.",
    type: "security",
    input: {
      deniedRole: "viewer",
      deniedAction: "manage.connector",
      allowedRole: "admin",
      allowedAction: "read.security",
    },
    expected: {
      viewerDenied: true,
      adminAllowed: true,
      secretRedacted: true,
    },
  },
  {
    id: "auth.identity_controls",
    name: "Identity controls",
    description: "Verifies password hashing, session auth mode reporting, and identity RBAC permissions.",
    type: "security",
    input: {
      passwordFixture: "session auth regression",
    },
    expected: {
      passwordVerified: true,
      viewerDeniedIdentity: true,
      adminAllowedIdentity: true,
    },
  },
  {
    id: "operations.approval_center",
    name: "Operations approval center",
    description: "Verifies the approval queue, operations overview, and connection catalog surfaces.",
    type: "operations",
    input: {},
    expected: {
      minCatalogTargets: 8,
      operationsSummary: true,
      approvalStats: true,
    },
  },
  {
    id: "operations.self_healing",
    name: "Self-healing diagnostics",
    description: "Runs production diagnostics with repair enabled, persists health evidence, and validates component/SLO metrics.",
    type: "operations",
    input: {
      repair: true,
    },
    expected: {
      minComponents: 10,
      healthPersisted: true,
      metricsAvailable: true,
      recoveryLedger: true,
    },
  },
  {
    id: "operations.incident_management",
    name: "Incident management",
    description: "Validates incident lifecycle sync, alert routing metadata, acknowledgement actions, and remediation playbook availability.",
    type: "operations",
    input: {
      runDiagnostics: true,
      actorId: "evaluation",
    },
    expected: {
      playbooks: true,
      alertTargets: true,
      lifecycleActions: true,
      eventLedger: true,
    },
  },
  {
    id: "operations.alert_delivery",
    name: "Alert delivery",
    description: "Queues and dispatches incident alert deliveries with target policy metadata, retry state, and signed webhook support.",
    type: "operations",
    input: {
      runDiagnostics: true,
      dispatchLimit: 10,
    },
    expected: {
      policies: true,
      targets: true,
      deliveryLifecycle: true,
      signedWebhook: true,
    },
  },
  {
    id: "operations.alert_scheduler",
    name: "Alert scheduler",
    description: "Exercises the secured production cron alert path, scheduler metadata, limits, and delivery progress signals.",
    type: "operations",
    input: {
      queueLimit: 10,
      dispatchLimit: 10,
    },
    expected: {
      schedulerMetadata: true,
      registryTool: "ops.alert_scheduler",
      deliveryProgress: true,
    },
  },
  {
    id: "operations.alert_target_health",
    name: "Alert target health",
    description: "Validates non-secret target readiness probes, blocked external target accounting, and failed-delivery retry controls.",
    type: "operations",
    input: {
      retryLimit: 5,
    },
    expected: {
      internalTargetsHealthy: true,
      secretSafe: true,
      retryControl: true,
      registryTool: "ops.alert_target_health",
    },
  },
];

export async function runEvaluationSuite({
  suite = "core",
  caseIds,
}: {
  suite?: string;
  caseIds?: string[];
} = {}) {
  const cases = defaultEvalCases.filter((item) => !caseIds?.length || caseIds.includes(item.id));
  const run = await createEvalRun({ suite, total: cases.length });
  const savedResults: EvalResultRecord[] = [];

  try {
    for (const evalCase of cases) {
      const startedAt = Date.now();
      try {
        const result = await runEvalCase(evalCase);
        const latencyMs = Date.now() - startedAt;
        savedResults.push(
          await saveEvalResult({
            evalRunId: run.id,
            caseId: evalCase.id,
            caseName: evalCase.name,
            caseType: evalCase.type,
            status: result.status,
            score: clampScore(result.score),
            latencyMs,
            estimatedCostUsd: result.estimatedCostUsd || estimateCost(evalCase, result.output),
            input: evalCase.input,
            output: result.output,
          }),
        );
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        savedResults.push(
          await saveEvalResult({
            evalRunId: run.id,
            caseId: evalCase.id,
            caseName: evalCase.name,
            caseType: evalCase.type,
            status: "fail",
            score: 0,
            latencyMs,
            estimatedCostUsd: estimateCost(evalCase, { error: String(error) }),
            input: evalCase.input,
            error: error instanceof Error ? error.message : "Evaluation case failed.",
          }),
        );
      }
    }

    const summary = summarizeResults(savedResults, cases.length);
    if (summary.failed > 0) {
      await failEvalRun(run.id, summary, `${summary.failed} evaluation case(s) failed.`);
    } else {
      await completeEvalRun(run.id, summary);
    }
  } catch (error) {
    const summary = summarizeResults(savedResults, cases.length);
    await failEvalRun(run.id, summary, error instanceof Error ? error.message : "Evaluation suite failed.");
  }

  return getEvalRunDetail(run.id);
}

async function runEvalCase(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  if (evalCase.id === "system.readiness") {
    return evaluateSystemReadiness();
  }

  if (evalCase.id === "retrieval.context_quality") {
    return evaluateRetrieval(evalCase);
  }

  if (evalCase.id === "retrieval.context_engine") {
    return evaluateContextEngine(evalCase);
  }

  if (evalCase.id === "memory.graph_engine") {
    return evaluateMemoryGraph(evalCase);
  }

  if (evalCase.id === "tool.policy_dry_run") {
    return evaluateToolPolicy(evalCase);
  }

  if (evalCase.id === "workflow.lifecycle") {
    return evaluateWorkflowLifecycle(evalCase);
  }

  if (evalCase.id === "workflow.dynamic_planner") {
    return evaluateDynamicPlanner(evalCase);
  }

  if (evalCase.id === "workflow.plan_executor") {
    return evaluatePlanExecutor(evalCase);
  }

  if (evalCase.id === "workflow.webhook_triggers") {
    return evaluateWebhookTriggers(evalCase);
  }

  if (evalCase.id === "security.rbac_controls") {
    return evaluateSecurityControls();
  }

  if (evalCase.id === "auth.identity_controls") {
    return evaluateIdentityControls();
  }

  if (evalCase.id === "operations.approval_center") {
    return evaluateOperationsCenter();
  }

  if (evalCase.id === "operations.self_healing") {
    return evaluateSelfHealingDiagnostics(evalCase);
  }

  if (evalCase.id === "operations.incident_management") {
    return evaluateIncidentManagement(evalCase);
  }

  if (evalCase.id === "operations.alert_delivery") {
    return evaluateAlertDelivery(evalCase);
  }

  if (evalCase.id === "operations.alert_scheduler") {
    return evaluateAlertScheduler(evalCase);
  }

  if (evalCase.id === "operations.alert_target_health") {
    return evaluateAlertTargetHealth(evalCase);
  }

  throw new Error(`No evaluator registered for ${evalCase.id}.`);
}

async function evaluateSystemReadiness(): Promise<CaseResult> {
  const registry = getCapabilityRegistry();
  const activeToolIds = new Set(registry.tools.filter((tool) => tool.status === "active").map((tool) => tool.id));
  const requiredTools = ["tool.executor", "connector.openapi", "workflow.temporal"];
  const missingTools = requiredTools.filter((toolId) => !activeToolIds.has(toolId));
  const output = {
    openaiConfigured: hasOpenAIKey(),
    databaseConfigured: hasDatabaseUrl(),
    storageBackend: getStorageBackend(),
    missingTools,
    activeTools: [...activeToolIds],
  };

  return {
    status: missingTools.length ? "fail" : "pass",
    score: missingTools.length ? 0.4 : 1,
    output,
  };
}

async function evaluateRetrieval(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const query = String(evalCase.input.query || "");
  const limit = Number(evalCase.input.limit || 6);
  const retrieval = await retrieveContext(query, limit);
  const contextCount = retrieval.results.length;
  const score = Math.min(1, contextCount / Number(evalCase.expected.minContextCount || 1));

  return {
    status: contextCount >= Number(evalCase.expected.minContextCount || 1) ? "pass" : "warn",
    score,
    output: {
      query,
      contextCount,
      memoryCount: retrieval.memoryResults.length,
      knowledgeCount: retrieval.knowledgeResults.length,
      topReasons: retrieval.results.slice(0, 3).flatMap((item) => item.result.reasons).slice(0, 6),
    },
    estimatedCostUsd: estimateTextCost(query),
  };
}

async function evaluateContextEngine(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const query = String(evalCase.input.query || "");
  const limit = Number(evalCase.input.limit || 6);
  const pack = await buildContextPack(query, { limit });
  const stats = await getContextEngineStats();
  const allowedModes = Array.isArray(evalCase.expected.allowedModes)
    ? evalCase.expected.allowedModes.map(String)
    : ["hybrid", "global", "memory_first", "local"];
  const checks = {
    selectedEvidence: pack.results.length >= Number(evalCase.expected.minSelectedEvidence || 1),
    tracePersisted: Boolean(pack.trace?.id),
    modeAllowed: allowedModes.includes(pack.profile.mode),
    confidenceAvailable: pack.results.every((item) => item.confidence >= 0 && item.confidence <= 1),
    contextPacked: pack.contextBlock.includes("Context Engine Profile") && pack.contextBlock.includes("Critical Evidence Recap"),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      query,
      checks,
      profile: pack.profile,
      traceId: pack.trace?.id,
      selectedCount: pack.results.length,
      topEvidence: pack.results.slice(0, 3).map((item) => ({
        kind: item.kind,
        title: item.title,
        confidence: item.confidence,
        utilityScore: item.utilityScore,
        reasons: item.reasons.slice(0, 5),
      })),
      traceStats: {
        traces: stats.traces,
        averageLatencyMs: stats.averageLatencyMs,
        byMode: stats.byMode,
      },
    },
    estimatedCostUsd: estimateTextCost(query),
  };
}

async function evaluateMemoryGraph(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const query = String(evalCase.input.query || "");
  const limit = Number(evalCase.input.limit || 6);
  await ensureGraphEvalSeedMemory();
  const rebuild = await rebuildMemoryGraph({
    source: "evaluation",
    memoryLimit: 500,
    traceLimit: 200,
  });
  const graphResults = await searchMemoryGraph(query, { limit });
  const pack = await buildContextPack(query, { limit });
  const stats = await getMemoryGraphStats();
  const checks = {
    nodesBuilt: stats.nodes >= Number(evalCase.expected.minNodes || 1),
    edgesBuilt: stats.edges >= Number(evalCase.expected.minEdges || 1),
    communitiesAvailable: stats.communities >= 1,
    graphSearchResults: graphResults.length >= Number(evalCase.expected.minGraphResults || 1),
    contextSelectsGraph: pack.results.some((item) => item.kind === "graph") === Boolean(evalCase.expected.contextSelectsGraph),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      query,
      checks,
      rebuild: {
        id: rebuild.build.id,
        nodeCount: rebuild.build.nodeCount,
        edgeCount: rebuild.build.edgeCount,
        latencyMs: rebuild.build.latencyMs,
      },
      stats: {
        nodes: stats.nodes,
        edges: stats.edges,
        communities: stats.communities,
        averageDegree: stats.averageDegree,
      },
      topGraphResults: graphResults.slice(0, 3).map((result) => ({
        label: result.node.label,
        kind: result.node.kind,
        communityId: result.communityId,
        score: result.score,
        neighbors: result.neighborhood.map((item) => item.node.label).slice(0, 5),
      })),
      contextEvidenceKinds: pack.results.map((item) => item.kind),
      traceId: pack.trace?.id,
    },
    estimatedCostUsd: estimateTextCost(query),
  };
}

async function ensureGraphEvalSeedMemory() {
  const title = "Graph memory evaluation seed";
  const memories = await listMemories();
  if (memories.some((memory) => memory.title === title)) {
    return;
  }

  await saveMemory({
    type: "procedure",
    title,
    content:
      "OmniAgent OS should connect adaptive RAG, graph memory, durable workflow approvals, pgvector retrieval, security controls, and evaluation traces into a multi-hop agentic orchestration context.",
    tags: ["graph-memory", "rag", "workflow", "approval", "evaluation", "security"],
    source: "evaluation",
    scope: "workspace",
    importance: 0.9,
  });
}

async function evaluateToolPolicy(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const result = await executeGovernedTool({
    toolId: String(evalCase.input.toolId),
    input: (evalCase.input.input || {}) as Record<string, unknown>,
    dryRun: Boolean(evalCase.input.dryRun),
  });
  const pass = result.record.status === evalCase.expected.status && result.record.riskLevel === evalCase.expected.riskLevel;

  return {
    status: pass ? "pass" : "fail",
    score: pass ? 1 : 0.25,
    output: {
      recordId: result.record.id,
      status: result.record.status,
      riskLevel: result.record.riskLevel,
      approvalRequired: result.record.approvalRequired,
      reason: result.record.reason,
    },
  };
}

async function evaluateWorkflowLifecycle(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const detail = await createWorkflowRun({
    goal: String(evalCase.input.goal),
    requireApproval: Boolean(evalCase.input.requireApproval),
    maxAttempts: 2,
    metadata: {
      source: "evaluation",
      caseId: evalCase.id,
    },
  });
  const maxTicks = Number(evalCase.input.maxTicks || 8);
  let current = detail;
  await enqueueWorkflowRunTick(detail.run.id, "evaluation_workflow_lifecycle");

  for (let index = 0; index < maxTicks && current?.run.status !== "completed" && current?.run.status !== "failed"; index++) {
    const queue = await processWorkflowQueue({
      workflowRunId: detail.run.id,
      limit: 1,
      bootstrapQueuedRuns: false,
    });
    current = queue.jobs[0]?.detail || (await getWorkflowRunDetail(detail.run.id)) || current;
  }

  const finalStatus = current?.run.status;
  const completedSteps = current?.steps.filter((step) => step.status === "completed").length || 0;
  const pass = finalStatus === evalCase.expected.finalStatus;
  const report = current?.run.result?.report;

  return {
    status: pass ? "pass" : "fail",
    score: pass ? 1 : completedSteps / 7,
    output: {
      workflowRunId: detail.run.id,
      finalStatus,
      completedSteps,
      queueBacked: true,
      resultKeys: current?.run.result ? Object.keys(current.run.result) : [],
      reportPreview: typeof report === "string" ? report.slice(0, 600) : undefined,
    },
    estimatedCostUsd: estimateCost(evalCase, { goal: evalCase.input.goal, report }),
  };
}

async function evaluateDynamicPlanner(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const goal = String(evalCase.input.goal || "");
  const mode = String(evalCase.input.mode || "orchestrate") as "orchestrate" | "research" | "execute" | "learn";
  const detail = await createWorkflowRun({
    goal,
    mode,
    requireApproval: false,
    maxAttempts: 2,
    metadata: {
      source: "evaluation",
      caseId: evalCase.id,
    },
  });
  const plan = await buildDynamicWorkflowPlan({
    goal,
    mode,
    workflowRunId: detail.run.id,
    requireApproval: false,
  });
  const stats = await getWorkflowPlanStats();
  const checks = {
    nodeCount: plan.plan.nodes.length >= Number(evalCase.expected.minNodes || 1),
    selectedTools: plan.plan.selectedToolIds.length >= Number(evalCase.expected.minSelectedTools || 1),
    validDag: plan.validation.isDag === Boolean(evalCase.expected.validDag),
    dependenciesResolved: plan.validation.missingDependencies.length === 0,
    hasVerification: plan.plan.nodes.some((node) => node.kind === "verify"),
    persisted: Boolean(evalCase.expected.persisted) ? stats.total > 0 && plan.workflowRunId === detail.run.id : true,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      workflowRunId: detail.run.id,
      planId: plan.id,
      planner: plan.planner,
      model: plan.model,
      checks,
      nodeCount: plan.plan.nodes.length,
      edgeCount: plan.plan.edges.length,
      selectedToolIds: plan.plan.selectedToolIds,
      highestRiskLevel: plan.highestRiskLevel,
      approvalRequired: plan.approvalRequired,
      confidence: plan.confidence,
      validation: plan.validation,
      stats: {
        total: stats.total,
        averageConfidence: stats.averageConfidence,
      },
    },
    estimatedCostUsd: estimateTextCost(goal),
  };
}

async function evaluatePlanExecutor(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const goal = String(evalCase.input.goal || "");
  const mode = String(evalCase.input.mode || "orchestrate") as "orchestrate" | "research" | "execute" | "learn";
  const detail = await createWorkflowRun({
    goal,
    mode,
    requireApproval: false,
    maxAttempts: 2,
    metadata: {
      source: "evaluation",
      caseId: evalCase.id,
    },
  });
  const plan = await buildDynamicWorkflowPlan({
    goal,
    mode,
    workflowRunId: detail.run.id,
    requireApproval: false,
  });
  await updateWorkflowStep(detail.run.id, "retrieve_context", {
    status: "completed",
    output: {
      contextCount: 0,
      contextBlock: "Plan executor evaluation uses direct DAG execution.",
    },
    completedAt: new Date().toISOString(),
  });
  await updateWorkflowStep(detail.run.id, "plan", {
    status: "completed",
    output: {
      id: plan.id,
      planner: plan.planner,
      model: plan.model,
      status: plan.status,
      contextTraceId: plan.contextTraceId,
      validation: plan.validation,
      highestRiskLevel: plan.highestRiskLevel,
      approvalRequired: plan.approvalRequired,
      confidence: plan.confidence,
      plan: plan.plan,
      objective: goal,
      tasks: plan.plan.nodes.map((node) => node.label),
      acceptanceCriteria: plan.plan.acceptanceCriteria,
      selectedToolIds: plan.plan.selectedToolIds,
      connectorTargets: plan.plan.connectorTargets,
      contextCount: 0,
    },
    completedAt: new Date().toISOString(),
  });

  const executionDetail = await getWorkflowRunDetail(detail.run.id);
  if (!executionDetail) {
    throw new Error("Workflow detail disappeared before plan execution.");
  }

  const summary = await executeDynamicWorkflowPlan(executionDetail);
  if (!summary) {
    throw new Error("Dynamic plan execution summary was not produced.");
  }

  const stats = await getWorkflowPlanNodeExecutionStats();
  const checks = {
    completedNodes: summary.completedNodes >= Number(evalCase.expected.minCompletedNodes || 1),
    toolExecutions: summary.toolExecutions >= Number(evalCase.expected.minToolExecutions || 1),
    persisted: Boolean(evalCase.expected.persisted) ? stats.total > 0 : true,
    noFailedNodes: Boolean(evalCase.expected.noFailedNodes) ? summary.failedNodes === 0 : true,
    linkedToRun: summary.workflowRunId === detail.run.id && summary.planId === plan.id,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      workflowRunId: detail.run.id,
      planId: plan.id,
      checks,
      summary: {
        status: summary.status,
        totalNodes: summary.totalNodes,
        completedNodes: summary.completedNodes,
        blockedNodes: summary.blockedNodes,
        failedNodes: summary.failedNodes,
        skippedNodes: summary.skippedNodes,
        toolExecutions: summary.toolExecutions,
        dryRunTools: summary.dryRunTools,
        executedTools: summary.executedTools,
      },
      nodeExecutions: summary.nodeExecutions.map((record) => ({
        nodeId: record.nodeId,
        nodeKind: record.nodeKind,
        status: record.status,
        toolExecutionIds: record.toolExecutionIds,
      })),
      stats: {
        total: stats.total,
        dryRunTools: stats.dryRunTools,
        executedTools: stats.executedTools,
      },
    },
    estimatedCostUsd: estimateTextCost(goal),
  };
}

async function evaluateWebhookTriggers(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const eventType = String(evalCase.input.eventType || "workflow.event");
  const source = String(evalCase.input.source || "evaluation-webhook");
  const summary = String(evalCase.input.summary || "Evaluate webhook trigger dispatch.");
  const trigger = await createWorkflowTrigger({
    name: "Evaluation webhook trigger",
    source,
    authMode: "none",
    goalTemplate: "Handle {{event.type}} from {{event.source}}: {{payload.summary}}",
    workflowMode: "orchestrate",
    requireApproval: false,
    metadata: {
      source: "evaluation",
      caseId: evalCase.id,
    },
  });
  const bodyText = JSON.stringify({
    type: eventType,
    summary,
    payloadId: `eval-${Date.now()}`,
  });
  const dispatch = await dispatchWorkflowTrigger({
    triggerId: trigger.id,
    bodyText,
    headers: {
      "x-event-type": eventType,
    },
  });
  const stats = await getWorkflowTriggerStats();
  const checks = {
    workflowEnqueued: Boolean(dispatch.workflow?.run.id && dispatch.queueJob?.id),
    eventPersisted: stats.events > 0 && dispatch.event.status === "enqueued",
    triggerCountIncremented: stats.latestTriggers.some((item) => item.id === trigger.id && item.triggerCount >= 1),
    signatureAccepted: dispatch.event.signatureVerified,
    goalRendered: dispatch.workflow?.run.goal.includes(eventType) && dispatch.workflow?.run.goal.includes(summary),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      triggerId: trigger.id,
      eventId: dispatch.event.id,
      workflowRunId: dispatch.workflow?.run.id,
      queueJobId: dispatch.queueJob?.id,
      checks,
      event: {
        status: dispatch.event.status,
        source: dispatch.event.source,
        eventType: dispatch.event.eventType,
        signatureVerified: dispatch.event.signatureVerified,
      },
      stats: {
        total: stats.total,
        active: stats.active,
        events: stats.events,
        enqueuedEvents: stats.enqueuedEvents,
        rejectedEvents: stats.rejectedEvents,
      },
    },
    estimatedCostUsd: estimateTextCost(bodyText),
  };
}

function evaluateSecurityControls(): CaseResult {
  const redacted = redactSensitive({
    apiKey: "example-secret-value-that-should-not-leak",
    nested: {
      authorization: "Bearer eyJexampleheader.examplepayload.examplesignature",
      harmless: "visible",
    },
  }) as {
    apiKey?: unknown;
    nested?: {
      authorization?: unknown;
      harmless?: unknown;
    };
  };

  const checks = {
    viewerDeniedConnectorManagement: !canPerform("viewer", "manage.connector"),
    operatorCanExecuteTools: canPerform("operator", "execute.tool"),
    adminCanReadSecurity: canPerform("admin", "read.security"),
    adminCanManageIdentity: canPerform("admin", "manage.identity"),
    secretRedacted: redacted.apiKey === "[redacted]" && redacted.nested?.authorization === "[redacted]",
    harmlessMetadataPreserved: redacted.nested?.harmless === "visible",
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  const pass = passed === total;

  return {
    status: pass ? "pass" : "fail",
    score: passed / total,
    output: {
      checks,
      redacted,
    },
  };
}

async function evaluateIdentityControls(): Promise<CaseResult> {
  const passwordHash = await hashPassword("session auth regression");
  const checks = {
    passwordVerified: await verifyPassword("session auth regression", passwordHash),
    wrongPasswordRejected: !(await verifyPassword("wrong password", passwordHash)),
    viewerDeniedIdentity: !canPerform("viewer", "manage.identity"),
    operatorDeniedIdentity: !canPerform("operator", "manage.identity"),
    adminAllowedIdentity: canPerform("admin", "manage.identity"),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : "fail",
    score: passed / total,
    output: {
      checks,
      authEnforced: isAuthEnforced(),
      hashFormat: passwordHash.split("$")[0],
    },
  };
}

async function evaluateOperationsCenter(): Promise<CaseResult> {
  const [approvals, operations] = await Promise.all([
    getApprovalQueue(10),
    getOperationsOverview(),
  ]);
  const checks = {
    catalogTargetsReady: connectionCatalog.length >= 8,
    catalogHasMcp: connectionCatalog.some((connector) => connector.adapter === "mcp"),
    catalogHasOpenApi: connectionCatalog.some((connector) => connector.adapter === "openapi"),
    approvalStatsAvailable: typeof approvals.stats.total === "number",
    operationsSummaryAvailable: typeof operations.summary.pendingApprovals === "number",
    latestLedgersAvailable: Array.isArray(operations.latest.toolExecutions) && Array.isArray(operations.latest.workflows),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : "fail",
    score: passed / total,
    output: {
      checks,
      approvalStats: approvals.stats,
      operationSummary: operations.summary,
      catalogTargets: connectionCatalog.map((connector) => ({
        id: connector.id,
        adapter: connector.adapter,
        riskLevel: connector.riskLevel,
      })),
    },
  };
}

async function evaluateSelfHealingDiagnostics(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const check = await runSystemDiagnostics({
    scope: "repair",
    repair: Boolean(evalCase.input.repair),
  });
  const stats = await getHealthStats();
  const expectedComponents = Number(evalCase.expected.minComponents || 8);
  const metricKeys = [
    "queueMaxAgeMs",
    "workflowCompletionRate",
    "evalPassRate",
    "plannerFallbackRate",
    "toolFailureRate",
    "triggerFailureRate",
    "staleWorkflowCount",
    "connectorErrors",
    "recoveryActions",
  ];
  const checks = {
    componentsAvailable: check.components.length >= expectedComponents,
    healthPersisted: Boolean(evalCase.expected.healthPersisted) ? stats.total > 0 && stats.latest?.id === check.id : true,
    metricsAvailable: Boolean(evalCase.expected.metricsAvailable)
      ? metricKeys.every((key) => typeof check.metrics[key] === "number")
      : true,
    recoveryLedger: Boolean(evalCase.expected.recoveryLedger) ? Array.isArray(check.recoveryActions) : true,
    statusValid: ["healthy", "degraded", "unhealthy"].includes(check.status),
    incidentConsistency: check.incidents.every((incident) =>
      check.components.some((component) => component.id === incident.componentId),
    ),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      checkId: check.id,
      status: check.status,
      scope: check.scope,
      checks,
      latencyMs: check.latencyMs,
      components: check.components.map((component) => ({
        id: component.id,
        status: component.status,
        metrics: component.metrics,
      })),
      incidents: check.incidents.map((incident) => ({
        componentId: incident.componentId,
        severity: incident.severity,
        message: incident.message,
      })),
      recoveryActions: check.recoveryActions.map((action) => ({
        id: action.id,
        status: action.status,
        message: action.message,
      })),
      stats: {
        total: stats.total,
        latestStatus: stats.latestStatus,
        incidents: stats.incidents,
        recoveryActions: stats.recoveryActions,
      },
    },
  };
}

async function evaluateIncidentManagement(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const actorId = String(evalCase.input.actorId || "evaluation");
  const check = evalCase.input.runDiagnostics
    ? await runSystemDiagnostics({ scope: "diagnostics" })
    : undefined;
  const playbooks = getIncidentPlaybooks();
  const alertTargets = getIncidentAlertTargets("critical");
  const activeBefore = await listIncidents({ status: "active", limit: 10 });
  const targetIncident = activeBefore[0];
  let actionSummary: Record<string, unknown> | undefined;

  if (targetIncident) {
    const acknowledgement = await acknowledgeIncident(targetIncident.id, {
      actorId,
      reason: "Evaluation acknowledgement smoke.",
      metadata: { caseId: evalCase.id },
    });
    const playbookId = acknowledgement?.incident.playbookIds.find((id) =>
      playbooks.some((playbook) => playbook.id === id && playbook.autoRunnable),
    );
    const playbookResult = playbookId
      ? await runIncidentPlaybook({
          incidentId: targetIncident.id,
          playbookId,
          actorId,
        })
      : null;
    actionSummary = {
      incidentId: targetIncident.id,
      acknowledged: acknowledgement?.incident.status === "acknowledged",
      playbookId,
      playbookStatus: playbookResult?.status,
      eventId: acknowledgement?.event.id,
    };
  }

  const stats = await getIncidentStats();
  const activeAfter = await listIncidents({ status: "active", limit: 10 });
  const checks = {
    healthSynced: check ? stats.total >= activeAfter.length : true,
    statsAvailable: typeof stats.active === "number" && typeof stats.open === "number",
    playbooksAvailable: Boolean(evalCase.expected.playbooks) ? playbooks.length >= 3 : true,
    alertTargetsAvailable: Boolean(evalCase.expected.alertTargets)
      ? alertTargets.some((target) => target.channel === "dashboard" && target.status === "ready") &&
        alertTargets.some((target) => target.channel === "ops" && target.status === "ready")
      : true,
    lifecycleActions: Boolean(evalCase.expected.lifecycleActions)
      ? !targetIncident || Boolean(actionSummary?.acknowledged)
      : true,
    eventLedger: Boolean(evalCase.expected.eventLedger)
      ? stats.total === 0 || stats.latestEvents.length > 0
      : true,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      checks,
      checkId: check?.id,
      actionSummary,
      stats: {
        total: stats.total,
        active: stats.active,
        open: stats.open,
        acknowledged: stats.acknowledged,
        resolved: stats.resolved,
        criticalOpen: stats.criticalOpen,
        warningOpen: stats.warningOpen,
      },
      activeIncidents: activeAfter.map((incident) => ({
        id: incident.id,
        componentId: incident.componentId,
        severity: incident.severity,
        status: incident.status,
        playbookIds: incident.playbookIds,
      })),
      playbooks: playbooks.map((playbook) => ({
        id: playbook.id,
        automation: playbook.automation,
        autoRunnable: playbook.autoRunnable,
      })),
      alertTargets: alertTargets.map((target) => ({
        id: target.id,
        channel: target.channel,
        status: target.status,
        targetEnv: target.targetEnv,
      })),
    },
  };
}

async function evaluateAlertDelivery(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  if (evalCase.input.runDiagnostics) {
    await runSystemDiagnostics({ scope: "diagnostics" });
  }
  const activeIncidents = await listIncidents({ status: "active", limit: 10 });
  const dispatchLimit = Number(evalCase.input.dispatchLimit || 10);
  const enqueued = activeIncidents.length
    ? await enqueueAlertDeliveriesForActiveIncidents(dispatchLimit)
    : [];
  const dispatch = await dispatchAlertDeliveries(dispatchLimit);
  const stats = await getAlertDeliveryStats();
  const policies = getAlertDeliveryPolicies();
  const signature = createAlertWebhookSignature(
    JSON.stringify({ test: "alert-delivery" }),
    "evaluation-secret",
  );
  const checks = {
    statsAvailable: typeof stats.total === "number" && typeof stats.runnable === "number",
    policiesAvailable: Boolean(evalCase.expected.policies) ? policies.length >= 2 : true,
    targetsVisible: Boolean(evalCase.expected.targets)
      ? stats.targets.some((target) => target.channel === "dashboard" && target.status === "ready") &&
        stats.targets.some((target) => target.channel === "ops" && target.status === "ready")
      : true,
    deliveryLifecycle: Boolean(evalCase.expected.deliveryLifecycle)
      ? !activeIncidents.length || enqueued.length > 0 || dispatch.processed.length > 0
      : true,
    dashboardOrOpsDelivered: !activeIncidents.length || dispatch.delivered > 0 || stats.delivered > 0,
    signedWebhook: Boolean(evalCase.expected.signedWebhook)
      ? typeof signature === "string" && signature.startsWith("sha256=")
      : true,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      checks,
      activeIncidentCount: activeIncidents.length,
      enqueued: enqueued.map((delivery) => ({
        id: delivery.id,
        targetId: delivery.targetId,
        channel: delivery.channel,
        status: delivery.status,
      })),
      dispatch: {
        processed: dispatch.processed.length,
        delivered: dispatch.delivered,
        skipped: dispatch.skipped,
        failed: dispatch.failed,
      },
      stats: {
        total: stats.total,
        queued: stats.queued,
        delivered: stats.delivered,
        failed: stats.failed,
        skipped: stats.skipped,
        readyTargets: stats.readyTargets,
        configuredExternalTargets: stats.configuredExternalTargets,
      },
      policies: policies.map((policy) => ({
        id: policy.id,
        channels: policy.channels,
        maxAttempts: policy.maxAttempts,
      })),
      signaturePreview: signature?.slice(0, 18),
    },
  };
}

async function evaluateAlertScheduler(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const queueLimit = Number(evalCase.input.queueLimit || 10);
  const dispatchLimit = Number(evalCase.input.dispatchLimit || 10);
  const activeIncidents = await listIncidents({ status: "active", limit: queueLimit });
  const schedulerBefore = getAlertSchedulerState();
  const scheduled = await runScheduledAlertDispatch({
    trigger: "evaluation.alert_scheduler",
    queueLimit,
    dispatchLimit,
  });
  const registry = getCapabilityRegistry();
  const activeToolIds = new Set(registry.tools.filter((tool) => tool.status === "active").map((tool) => tool.id));
  const checks = {
    schedulerMetadata: Boolean(evalCase.expected.schedulerMetadata)
      ? scheduled.scheduler.path === "/api/workflows/tick" &&
        scheduled.scheduler.schedule === "0 0 * * *" &&
        scheduled.scheduler.queueLimit >= 1 &&
        scheduled.scheduler.dispatchLimit >= 1
      : true,
    cronSecretInspectable: typeof scheduled.scheduler.cronSecretConfigured === "boolean",
    registryToolAvailable: activeToolIds.has(String(evalCase.expected.registryTool || "ops.alert_scheduler")),
    statsAvailable: typeof scheduled.stats.total === "number" && typeof scheduled.stats.runnable === "number",
    targetReadinessVisible: scheduled.scheduler.readyTargets >= 2,
    deliveryProgress: Boolean(evalCase.expected.deliveryProgress)
      ? !activeIncidents.length ||
        scheduled.enqueued.length > 0 ||
        scheduled.dispatch.processed.length > 0 ||
        scheduled.stats.delivered > 0
      : true,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      checks,
      activeIncidentCount: activeIncidents.length,
      schedulerBefore,
      schedulerAfter: scheduled.scheduler,
      trigger: scheduled.trigger,
      enqueued: scheduled.enqueued.length,
      dispatch: {
        processed: scheduled.dispatch.processed.length,
        delivered: scheduled.dispatch.delivered,
        skipped: scheduled.dispatch.skipped,
        failed: scheduled.dispatch.failed,
      },
      stats: {
        total: scheduled.stats.total,
        queued: scheduled.stats.queued,
        runnable: scheduled.stats.runnable,
        delivered: scheduled.stats.delivered,
        failed: scheduled.stats.failed,
        readyTargets: scheduled.stats.readyTargets,
      },
    },
  };
}

async function evaluateAlertTargetHealth(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const retryLimit = Number(evalCase.input.retryLimit || 5);
  const targetHealth = getAlertTargetHealth();
  const statsBefore = await getAlertDeliveryStats();
  const retried = await retryFailedAlertDeliveries({ limit: retryLimit, includeSkipped: true });
  const statsAfter = await getAlertDeliveryStats();
  const registry = getCapabilityRegistry();
  const activeToolIds = new Set(registry.tools.filter((tool) => tool.status === "active").map((tool) => tool.id));
  const targetSnapshot = targetHealth.map((target) => ({
    id: target.id,
    channel: target.channel,
    probeStatus: target.probeStatus,
    ready: target.ready,
    requiredEnv: target.requiredEnv,
    optionalEnv: target.optionalEnv,
    blockingReasons: target.blockingReasons,
    security: target.security,
  }));
  const serializedSnapshot = JSON.stringify(targetSnapshot);
  const checks = {
    targetHealthAvailable: targetHealth.length >= 5,
    internalTargetsHealthy: Boolean(evalCase.expected.internalTargetsHealthy)
      ? targetHealth.some((target) => target.channel === "dashboard" && target.probeStatus === "healthy") &&
        targetHealth.some((target) => target.channel === "ops" && target.probeStatus === "healthy")
      : true,
    blockedExternalCount: statsBefore.blockedExternalTargets === targetHealth.filter((target) =>
      !["dashboard", "ops"].includes(target.channel) && target.probeStatus !== "healthy",
    ).length,
    retryControl: Boolean(evalCase.expected.retryControl)
      ? retried.every((delivery) => delivery.status === "queued" && delivery.attempt === 0) &&
        statsAfter.retryableFailed <= statsBefore.retryableFailed
      : true,
    registryToolAvailable: activeToolIds.has(String(evalCase.expected.registryTool || "ops.alert_target_health")),
    secretSafe: Boolean(evalCase.expected.secretSafe)
      ? targetHealth.every((target) => target.security.secretValuesExposed === false) &&
        !/Bearer\s|npg_|sk-|xoxb-|whsec_|https:\/\/hooks\.slack\.com\/services\//i.test(serializedSnapshot)
      : true,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      checks,
      retried: retried.length,
      statsBefore: {
        failed: statsBefore.failed,
        skipped: statsBefore.skipped,
        retryableFailed: statsBefore.retryableFailed,
        blockedExternalTargets: statsBefore.blockedExternalTargets,
      },
      statsAfter: {
        queued: statsAfter.queued,
        failed: statsAfter.failed,
        skipped: statsAfter.skipped,
        retryableFailed: statsAfter.retryableFailed,
      },
      targetHealth: targetSnapshot,
    },
  };
}

function summarizeResults(results: EvalResultRecord[], total: number): EvalRunSummary {
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;
  const warnings = results.filter((result) => result.status === "warn").length;
  const averageLatencyMs = results.length
    ? Math.round(results.reduce((sum, result) => sum + result.latencyMs, 0) / results.length)
    : 0;
  const estimatedCostUsd = roundCost(results.reduce((sum, result) => sum + result.estimatedCostUsd, 0));

  return {
    total,
    passed,
    failed,
    warnings,
    averageLatencyMs,
    estimatedCostUsd,
  };
}

function estimateCost(evalCase: EvalCaseDefinition, output: Record<string, unknown> = {}) {
  return estimateTextCost(`${JSON.stringify(evalCase.input)}\n${JSON.stringify(output)}`);
}

function estimateTextCost(text: string) {
  const tokenEstimate = Math.ceil(text.length / 4);
  return roundCost((tokenEstimate / 1000) * 0.002);
}

function roundCost(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clampScore(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
