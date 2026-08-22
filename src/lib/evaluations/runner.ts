import { hasOpenAIKey } from "@/lib/config";
import { hashPassword, verifyPassword } from "@/lib/auth/crypto";
import { isAuthEnforced } from "@/lib/auth/store";
import {
  getDatabaseTenantContext,
  getStorageBackend,
  hasDatabaseUrl,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
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
import { getHealthStats, runSystemDiagnostics, summarizeWorkflowHealth } from "@/lib/diagnostics/health";
import {
  acknowledgeIncident,
  getIncidentAlertTargets,
  getIncidentPlaybooks,
  getIncidentStats,
  listIncidents,
  resolveIncidentByFingerprint,
} from "@/lib/diagnostics/incidents";
import { runIncidentPlaybook } from "@/lib/diagnostics/playbooks";
import { executeGovernedTool } from "@/lib/tools/executor";
import { connectionCatalog } from "@/lib/connectors/catalog";
import {
  createMcpConnectorRecord,
  listMcpConnectors,
  saveMcpConnector,
} from "@/lib/connectors/store";
import {
  createOpenApiConnectorRecord,
  listOpenApiConnectors,
  saveOpenApiConnector,
} from "@/lib/connectors/openapi-store";
import { getCapabilityRegistry } from "@/lib/orchestration/registry";
import { createSloIncidentFingerprint, runObservabilitySloMonitor, type ObservabilitySloPolicy } from "@/lib/observability/slo-monitor";
import {
  applyObservabilitySloPolicyChange,
  deleteObservabilitySloPolicy,
  getObservabilitySloApprovalPolicyConfig,
  getObservabilitySloPolicyChange,
  getObservabilitySloPolicy,
  listObservabilitySloApprovalPolicyVersions,
  listObservabilitySloPolicyChanges,
  listObservabilitySloPolicies,
  requestObservabilitySloPolicyChange,
  rollbackObservabilitySloPolicyChange,
  saveObservabilitySloApprovalPolicyConfig,
  saveObservabilitySloPolicy,
  type ObservabilitySloApprovalPolicyConfig,
} from "@/lib/observability/slo-policy-store";
import { getObservabilityStats, listObservabilityEvents, recordRuntimeEvent } from "@/lib/observability/store";
import { getMemoryGraphStats, rebuildMemoryGraph, searchMemoryGraph } from "@/lib/memory/graph";
import { listMemories, saveMemory, searchMemories } from "@/lib/memory/store";
import { getApprovalQueue, getOperationsOverview } from "@/lib/operations/queue";
import { reconcileOperationsRecovery } from "@/lib/operations/recovery";
import { buildContextPack, getContextEngineStats } from "@/lib/rag/context-engine";
import { retrieveContext } from "@/lib/rag/retriever";
import { canPerform, redactSensitive } from "@/lib/security/context";
import { cancelWorkflowRunTick, enqueueWorkflowRunTick, processWorkflowQueue } from "@/lib/workflows/queue";
import { executeDynamicWorkflowPlan, getWorkflowPlanNodeExecutionStats } from "@/lib/workflows/executor";
import { buildDynamicWorkflowPlan, getWorkflowPlanStats } from "@/lib/workflows/planner";
import { signalWorkflowRun } from "@/lib/workflows/runner";
import { createWorkflowRun, getWorkflowRunDetail, listWorkflowRuns, updateWorkflowRun, updateWorkflowStep } from "@/lib/workflows/store";
import {
  createWorkflowTrigger,
  dispatchWorkflowTrigger,
  getWorkflowTriggerStats,
  signWorkflowTriggerPayload,
} from "@/lib/workflows/triggers";
import {
  completeEvalRun,
  createEvalRun,
  failEvalRun,
  getEvalRunDetail,
  saveEvalResult,
} from "@/lib/evaluations/store";
import type {
  EvalCaseGovernance,
  EvalCaseDefinition,
  EvalResultRecord,
  EvalResultStatus,
  EvalRunSummary,
  EvalSafetyMode,
} from "@/lib/evaluations/types";
import type { SecurityRole } from "@/lib/security/types";
import type { WorkflowRunRecord } from "@/lib/workflows/types";

type CaseResult = {
  status: EvalResultStatus;
  score: number;
  output: Record<string, unknown>;
  estimatedCostUsd?: number;
};

type RawEvalCaseDefinition = Omit<EvalCaseDefinition, "governance">;

export type EvalGovernanceSummary = {
  production: boolean;
  totalCases: number;
  selectedCaseIds: string[];
  bySafetyMode: Record<EvalSafetyMode, number>;
  mutatingCases: number;
  maxRiskLevel: number;
  requiresMutationApproval: boolean;
};

export type EvalGovernanceDecision = {
  allowed: boolean;
  violations: string[];
  summary: EvalGovernanceSummary;
};

export const evalSafetyOrder: Record<EvalSafetyMode, number> = {
  read_only: 0,
  synthetic: 1,
  mutation_allowed: 2,
};

const rawEvalCases: RawEvalCaseDefinition[] = [
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
    id: "security.tenant_isolation",
    name: "Tenant isolation boundary",
    description: "Seeds two synthetic tenants and verifies memory, connectors, workflow runs, and observability stay isolated.",
    type: "security",
    input: {
      surfaces: ["memory", "connectors", "workflows", "observability"],
    },
    expected: {
      noCrossTenantMemory: true,
      noCrossTenantConnectors: true,
      noCrossTenantWorkflows: true,
      noCrossTenantObservability: true,
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
      workflowRiskSummary: true,
      recoveryHistory: true,
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
    id: "operations.queue_recovery",
    name: "Queue recovery",
    description: "Validates stale workflow inspection, safe requeue/fail reconciliation, bounded drain reporting, cleanup, and registry exposure.",
    type: "operations",
    input: {
      goal: "Evaluation queue recovery stale workflow fixture.",
    },
    expected: {
      inspectFindsStale: true,
      requeueRecovery: true,
      failRecovery: true,
      drainReported: true,
      cleanup: true,
      registryTool: "ops.queue_recovery",
    },
  },
  {
    id: "operations.health_semantics",
    name: "Health semantics",
    description: "Validates live health distinguishes current workflow failure pressure from recovered terminal workflow history.",
    type: "operations",
    input: {},
    expected: {
      recoveredFailuresDoNotDegrade: true,
      recentUnhandledFailuresDegrade: true,
      staleRunnableDegrades: true,
      oldFailuresDoNotDegrade: true,
    },
  },
  {
    id: "operations.eval_governance",
    name: "Evaluation governance",
    description: "Validates production evaluation policy metadata, safe-suite filtering, mutation gating, admin override requirements, and registry exposure.",
    type: "operations",
    input: {},
    expected: {
      metadataComplete: true,
      safeSuiteExcludesMutations: true,
      productionMutationBlocked: true,
      adminOverrideAllowed: true,
      registryTool: "ops.eval_governance",
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
  {
    id: "operations.observability_console",
    name: "Observability console",
    description: "Validates durable runtime event persistence, correlation IDs, SLO summaries, redaction, and observability registry exposure.",
    type: "operations",
    input: {
      markerCategory: "system",
    },
    expected: {
      eventPersisted: true,
      correlationId: true,
      sloSummary: true,
      registryTool: "ops.observability_console",
      secretSafe: true,
    },
  },
  {
    id: "operations.slo_alerting",
    name: "SLO alerting",
    description: "Validates observability SLO breach detection, incident creation, alert queueing, recovery policy metadata, and registry exposure.",
    type: "operations",
    input: {
      route: "/api/evaluations",
    },
    expected: {
      breachDetected: true,
      incidentAction: true,
      alertQueued: true,
      policyEvidence: true,
      registryTool: "ops.slo_alerting",
    },
  },
  {
    id: "operations.slo_policy_management",
    name: "SLO policy management",
    description: "Validates durable SLO policy configuration for thresholds, severities, routing, suppression, enablement, and cleanup.",
    type: "operations",
    input: {
      policyPrefix: "eval_policy",
    },
    expected: {
      persisted: true,
      thresholdsConfigurable: true,
      severityConfigurable: true,
      routingConfigurable: true,
      suppressionConfigurable: true,
      cleanup: true,
      registryTool: "ops.slo_policy_management",
    },
  },
  {
    id: "operations.slo_policy_change_control",
    name: "SLO policy change control",
    description: "Validates governed SLO policy change requests, approval application, immutable history, quorum-backed rollback, and registry exposure.",
    type: "operations",
    input: {
      policyPrefix: "eval_governed_policy",
    },
    expected: {
      approvalRequest: true,
      approvalApply: true,
      history: true,
      rollbackRequest: true,
      rollbackApply: true,
      cleanup: true,
      registryTool: "ops.slo_policy_change_control",
    },
  },
  {
    id: "operations.slo_multi_party_approval",
    name: "SLO multi-party approval",
    description: "Validates high-risk SLO policy quorum, required approver roles, requester separation, signed evidence, and final application.",
    type: "operations",
    input: {
      policyPrefix: "eval_quorum_policy",
    },
    expected: {
      highRiskPolicy: true,
      requesterBlocked: true,
      firstApprovalPending: true,
      quorumApply: true,
      signedEvidence: true,
      cleanup: true,
      registryTool: "ops.slo_multi_party_approval",
    },
  },
  {
    id: "operations.slo_approval_policy_admin",
    name: "SLO approval policy admin",
    description: "Validates versioned SLO approval policy administration, custom quorums, emergency break-glass application, restore, and registry exposure.",
    type: "operations",
    input: {
      policyPrefix: "eval_approval_policy_admin",
    },
    expected: {
      customPolicySaved: true,
      versionHistory: true,
      customQuorumApplied: true,
      breakGlassApplied: true,
      restored: true,
      registryTool: "ops.slo_approval_policy_admin",
    },
  },
];

const evalGovernanceById: Record<string, EvalCaseGovernance> = {
  "system.readiness": evalGovernance("read_only", 0, false, "none", [
    "Reads capability registry and environment configuration only.",
  ]),
  "retrieval.context_quality": evalGovernance("read_only", 0, false, "none", [
    "Runs retrieval checks without creating operational records.",
  ]),
  "retrieval.context_engine": evalGovernance("synthetic", 1, true, "audit_retained", [
    "Persists retrieval trace evidence for auditability.",
  ]),
  "memory.graph_engine": evalGovernance("mutation_allowed", 2, true, "audit_retained", [
    "Seeds evaluation memory and rebuilds graph memory artifacts.",
  ]),
  "tool.policy_dry_run": evalGovernance("synthetic", 1, true, "audit_retained", [
    "Creates dry-run tool audit evidence only.",
  ]),
  "workflow.lifecycle": evalGovernance("mutation_allowed", 2, true, "audit_retained", [
    "Creates and ticks durable workflow records.",
  ]),
  "workflow.dynamic_planner": evalGovernance("mutation_allowed", 2, true, "audit_retained", [
    "Creates durable workflow and planner records.",
  ]),
  "workflow.plan_executor": evalGovernance("mutation_allowed", 2, true, "audit_retained", [
    "Executes persisted plan-node ledgers and governed tool decisions.",
  ]),
  "workflow.webhook_triggers": evalGovernance("mutation_allowed", 2, true, "audit_retained", [
    "Creates trigger, event, workflow, and queue records.",
  ]),
  "security.rbac_controls": evalGovernance("read_only", 0, false, "none", [
    "Pure RBAC and redaction checks.",
  ]),
  "security.tenant_isolation": evalGovernance("mutation_allowed", 3, true, "audit_retained", [
    "Seeds two synthetic tenant namespaces across shared ledgers and verifies cross-tenant reads are blocked.",
  ]),
  "auth.identity_controls": evalGovernance("read_only", 0, false, "none", [
    "Pure password hash and RBAC checks.",
  ]),
  "operations.approval_center": evalGovernance("read_only", 0, false, "none", [
    "Reads operations ledgers and catalog readiness.",
  ]),
  "operations.self_healing": evalGovernance("mutation_allowed", 2, true, "audit_retained", [
    "Runs repair diagnostics and may reconcile queue/workflow state.",
  ]),
  "operations.queue_recovery": evalGovernance("mutation_allowed", 3, true, "self_cleaning", [
    "Creates stale workflow fixtures, requeues jobs, and fails exhausted fixtures.",
  ]),
  "operations.health_semantics": evalGovernance("synthetic", 0, false, "none", [
    "Uses synthetic in-memory workflow health fixtures.",
  ]),
  "operations.eval_governance": evalGovernance("synthetic", 0, false, "none", [
    "Pure governance policy regression using in-memory decisions.",
  ]),
  "operations.incident_management": evalGovernance("mutation_allowed", 2, true, "audit_retained", [
    "Runs diagnostics, incident acknowledgement, and playbook paths.",
  ]),
  "operations.alert_delivery": evalGovernance("mutation_allowed", 2, true, "audit_retained", [
    "Queues or dispatches incident alert delivery records.",
  ]),
  "operations.alert_scheduler": evalGovernance("mutation_allowed", 2, true, "audit_retained", [
    "Exercises scheduled alert queue and dispatch paths.",
  ]),
  "operations.alert_target_health": evalGovernance("mutation_allowed", 1, true, "audit_retained", [
    "May retry failed alert delivery records.",
  ]),
  "operations.observability_console": evalGovernance("synthetic", 1, true, "audit_retained", [
    "Writes a low-risk runtime event marker.",
  ]),
  "operations.slo_alerting": evalGovernance("mutation_allowed", 2, true, "self_cleaning", [
    "Creates temporary SLO policy and incident evidence, then resolves evaluation incident.",
  ]),
  "operations.slo_policy_management": evalGovernance("mutation_allowed", 2, true, "self_cleaning", [
    "Creates temporary SLO policy configuration and deletes it.",
  ]),
  "operations.slo_policy_change_control": evalGovernance("mutation_allowed", 3, true, "self_cleaning", [
    "Creates, approves, applies, rolls back, and cleans up governed SLO changes.",
  ]),
  "operations.slo_multi_party_approval": evalGovernance("mutation_allowed", 3, true, "self_cleaning", [
    "Exercises high-risk quorum approval records and cleans up temporary policy.",
  ]),
  "operations.slo_approval_policy_admin": evalGovernance("mutation_allowed", 3, true, "manual_review", [
    "Temporarily changes global SLO approval policy and restores it.",
  ]),
};

export const defaultEvalCases: EvalCaseDefinition[] = rawEvalCases.map((evalCase) => ({
  ...evalCase,
  governance: evalGovernanceById[evalCase.id] || evalGovernance("synthetic", 1, true, "manual_review", [
    "Fallback governance applied; classify this case explicitly before production use.",
  ]),
}));

export function selectEvaluationCases({
  caseIds,
  maxSafetyMode,
}: {
  caseIds?: string[];
  maxSafetyMode?: EvalSafetyMode;
}) {
  const knownIds = new Set(defaultEvalCases.map((evalCase) => evalCase.id));
  const unknownCaseIds = (caseIds || []).filter((caseId) => !knownIds.has(caseId));
  const selectedIds = new Set(caseIds || []);
  const maxSafetyRank = maxSafetyMode ? evalSafetyOrder[maxSafetyMode] : undefined;
  const cases = defaultEvalCases.filter((evalCase) => {
    if (selectedIds.size && !selectedIds.has(evalCase.id)) {
      return false;
    }
    if (maxSafetyRank !== undefined && evalSafetyOrder[evalCase.governance.safetyMode] > maxSafetyRank) {
      return false;
    }
    return true;
  });

  return { cases, unknownCaseIds };
}

export function summarizeEvaluationGovernance(cases: EvalCaseDefinition[], production = isProductionRuntime()): EvalGovernanceSummary {
  const bySafetyMode: Record<EvalSafetyMode, number> = {
    read_only: 0,
    synthetic: 0,
    mutation_allowed: 0,
  };
  for (const evalCase of cases) {
    bySafetyMode[evalCase.governance.safetyMode] += 1;
  }
  const mutatingCases = cases.filter((evalCase) => evalCase.governance.writesToDatabase).length;

  return {
    production,
    totalCases: cases.length,
    selectedCaseIds: cases.map((evalCase) => evalCase.id),
    bySafetyMode,
    mutatingCases,
    maxRiskLevel: cases.reduce((max, evalCase) => Math.max(max, evalCase.governance.riskLevel), 0),
    requiresMutationApproval: cases.some((evalCase) => evalCase.governance.production.requiresMutationApproval),
  };
}

export function evaluateEvaluationGovernance({
  cases,
  role,
  allowMutation = false,
  reason,
  production = isProductionRuntime(),
}: {
  cases: EvalCaseDefinition[];
  role: SecurityRole;
  allowMutation?: boolean;
  reason?: string;
  production?: boolean;
}): EvalGovernanceDecision {
  const summary = summarizeEvaluationGovernance(cases, production);
  const violations: string[] = [];
  const mutationCases = cases.filter((evalCase) =>
    evalCase.governance.safetyMode === "mutation_allowed" ||
    evalCase.governance.production.requiresMutationApproval
  );

  if (!cases.length) {
    violations.push("No evaluation cases were selected.");
  }

  if (production && mutationCases.length) {
    if (!allowMutation) {
      violations.push("Production mutation-capable evaluation cases require allowMutation=true.");
    }
    if (!["admin", "system"].includes(role)) {
      violations.push("Production mutation-capable evaluation cases require admin or system role.");
    }
    if (!reason || reason.trim().length < 12) {
      violations.push("Production mutation-capable evaluation cases require an operator reason.");
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
    summary,
  };
}

export function defaultEvaluationMaxSafetyMode(production = isProductionRuntime()): EvalSafetyMode {
  return production ? "synthetic" : "mutation_allowed";
}

export function isProductionRuntime() {
  return process.env.VERCEL_ENV === "production" || Boolean(process.env.VERCEL);
}

function evalGovernance(
  safetyMode: EvalSafetyMode,
  riskLevel: 0 | 1 | 2 | 3,
  writesToDatabase: boolean,
  cleanup: EvalCaseGovernance["cleanup"],
  notes: string[],
): EvalCaseGovernance {
  const mutationAllowed = safetyMode === "mutation_allowed";
  return {
    safetyMode,
    riskLevel,
    writesToDatabase,
    cleanup,
    production: {
      allowedByDefault: !mutationAllowed,
      requiresAdmin: mutationAllowed,
      requiresMutationApproval: mutationAllowed,
    },
    notes,
  };
}

export async function runEvaluationSuite({
  suite = "core",
  caseIds,
  tenantId,
}: {
  suite?: string;
  caseIds?: string[];
  tenantId?: string;
} = {}) {
  const cases = defaultEvalCases.filter((item) => !caseIds?.length || caseIds.includes(item.id));
  const runTenantId =
    tenantId ||
    getDatabaseTenantContext() ||
    process.env.OMNIAGENT_DEFAULT_TENANT ||
    "default";
  return runWithDatabaseTenantScope(runTenantId, async () => {
    const run = await createEvalRun({
      suite,
      total: cases.length,
      tenantId: runTenantId,
    });
    const savedResults: EvalResultRecord[] = [];

    try {
      for (const evalCase of cases) {
        const startedAt = Date.now();
        try {
          const result = await runEvalCase(evalCase);
          const latencyMs = Date.now() - startedAt;
          savedResults.push(
            await saveEvalResult({
              tenantId: runTenantId,
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
              tenantId: runTenantId,
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

    return getEvalRunDetail(run.id, { tenantId: runTenantId });
  });
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

  if (evalCase.id === "security.tenant_isolation") {
    return evaluateTenantIsolation(evalCase);
  }

  if (evalCase.id === "auth.identity_controls") {
    return evaluateIdentityControls();
  }

  if (evalCase.id === "operations.approval_center") {
    return evaluateOperationsCenter(evalCase);
  }

  if (evalCase.id === "operations.self_healing") {
    return evaluateSelfHealingDiagnostics(evalCase);
  }

  if (evalCase.id === "operations.queue_recovery") {
    return evaluateQueueRecovery(evalCase);
  }

  if (evalCase.id === "operations.health_semantics") {
    return evaluateHealthSemantics(evalCase);
  }

  if (evalCase.id === "operations.eval_governance") {
    return evaluateEvalGovernance(evalCase);
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

  if (evalCase.id === "operations.observability_console") {
    return evaluateObservabilityConsole(evalCase);
  }

  if (evalCase.id === "operations.slo_alerting") {
    return evaluateSloAlerting(evalCase);
  }

  if (evalCase.id === "operations.slo_policy_management") {
    return evaluateSloPolicyManagement(evalCase);
  }

  if (evalCase.id === "operations.slo_policy_change_control") {
    return evaluateSloPolicyChangeControl(evalCase);
  }

  if (evalCase.id === "operations.slo_multi_party_approval") {
    return evaluateSloMultiPartyApproval(evalCase);
  }

  if (evalCase.id === "operations.slo_approval_policy_admin") {
    return evaluateSloApprovalPolicyAdmin(evalCase);
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

  const stats = await getWorkflowPlanNodeExecutionStats({
    tenantId: executionDetail.run.tenantId,
  });
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
  const evaluationSecretEnv = "OMNIAGENT_TRIGGER_EVALUATION_SECRET";
  const evaluationSecret = process.env[evaluationSecretEnv]?.trim();
  const trigger = await createWorkflowTrigger({
    name: "Evaluation webhook trigger",
    source,
    authMode: evaluationSecret ? "hmac_sha256" : "none",
    secretEnvVar: evaluationSecret ? evaluationSecretEnv : undefined,
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
  const signed = evaluationSecret
    ? signWorkflowTriggerPayload({ secret: evaluationSecret, bodyText })
    : undefined;
  const dispatch = await dispatchWorkflowTrigger({
    triggerId: trigger.id,
    bodyText,
    headers: {
      "x-event-type": eventType,
      ...(signed
        ? {
            "x-omni-timestamp": signed.timestamp,
            "x-omni-signature": signed.signature,
          }
        : {}),
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

async function evaluateTenantIsolation(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tenantA = `eval_isolation_a_${suffix}`;
  const tenantB = `eval_isolation_b_${suffix}`;
  const markerA = `tenant-a-marker-${suffix}`;
  const markerB = `tenant-b-marker-${suffix}`;
  const correlationId = `eval-tenant-isolation-${suffix}`;
  let workflowA: Awaited<ReturnType<typeof createWorkflowRun>> | undefined;
  let workflowB: Awaited<ReturnType<typeof createWorkflowRun>> | undefined;

  try {
    const memoryA = await withDatabaseTenant(tenantA, () =>
      saveMemory({
        tenantId: tenantA,
        title: `Tenant A isolation ${suffix}`,
        content: `Only tenant A should see ${markerA}.`,
        tags: ["eval", "tenant-isolation", markerA],
        source: "evaluation",
        importance: 0.8,
      }),
    );
    const memoryB = await withDatabaseTenant(tenantB, () =>
      saveMemory({
        tenantId: tenantB,
        title: `Tenant B isolation ${suffix}`,
        content: `Only tenant B should see ${markerB}.`,
        tags: ["eval", "tenant-isolation", markerB],
        source: "evaluation",
        importance: 0.8,
      }),
    );

    const mcpA = await withDatabaseTenant(tenantA, () =>
      saveMcpConnector(
        createMcpConnectorRecord({
          tenantId: tenantA,
          name: `Eval MCP A ${suffix}`,
          endpoint: `https://example.com/mcp/${suffix}`,
          authType: "none",
          defaultRiskLevel: 1,
          approvalRequired: false,
        }),
      ),
    );
    const mcpB = await withDatabaseTenant(tenantB, () =>
      saveMcpConnector(
        createMcpConnectorRecord({
          tenantId: tenantB,
          name: `Eval MCP B ${suffix}`,
          endpoint: `https://example.com/mcp/${suffix}/b`,
          authType: "none",
          defaultRiskLevel: 1,
          approvalRequired: false,
        }),
      ),
    );
    const openApiA = await withDatabaseTenant(tenantA, () =>
      saveOpenApiConnector(
        createOpenApiConnectorRecord({
          tenantId: tenantA,
          name: `Eval OpenAPI A ${suffix}`,
          baseUrl: `https://api.example.com/${suffix}`,
          authType: "none",
          defaultRiskLevel: 1,
          approvalRequired: false,
        }),
      ),
    );
    const openApiB = await withDatabaseTenant(tenantB, () =>
      saveOpenApiConnector(
        createOpenApiConnectorRecord({
          tenantId: tenantB,
          name: `Eval OpenAPI B ${suffix}`,
          baseUrl: `https://api.example.com/${suffix}/b`,
          authType: "none",
          defaultRiskLevel: 1,
          approvalRequired: false,
        }),
      ),
    );

    workflowA = await withDatabaseTenant(tenantA, () =>
      createWorkflowRun({
        tenantId: tenantA,
        goal: `Tenant A isolation workflow ${markerA}`,
        mode: "research",
        requireApproval: true,
        maxAttempts: 1,
        metadata: { source: "evaluation", caseId: evalCase.id, marker: markerA },
      }),
    );
    workflowB = await withDatabaseTenant(tenantB, () =>
      createWorkflowRun({
        tenantId: tenantB,
        goal: `Tenant B isolation workflow ${markerB}`,
        mode: "research",
        requireApproval: true,
        maxAttempts: 1,
        metadata: { source: "evaluation", caseId: evalCase.id, marker: markerB },
      }),
    );
    const workflowAId = workflowA.run.id;
    const workflowBId = workflowB.run.id;

    const eventA = await withDatabaseTenant(tenantA, () =>
      recordRuntimeEvent({
        level: "info",
        category: "security",
        action: "evaluation.tenant_isolation_marker",
        correlationId,
        tenantId: tenantA,
        resourceType: "evaluation",
        resourceId: evalCase.id,
        message: `Tenant A observability marker ${markerA}.`,
        metadata: { marker: markerA, caseId: evalCase.id },
      }),
    );

    const [
      tenantAMemories,
      tenantBMemories,
      tenantASearchForA,
      tenantASearchForB,
      tenantBMcpConnectors,
      tenantBOpenApiConnectors,
      tenantBWorkflowRuns,
      tenantBWorkflowDetailForA,
      tenantBEventsForA,
    ] = await Promise.all([
      withDatabaseTenant(tenantA, () => listMemories({ tenantId: tenantA, limit: 50 })),
      withDatabaseTenant(tenantB, () => listMemories({ tenantId: tenantB, limit: 50 })),
      withDatabaseTenant(tenantA, () => searchMemories(markerA, { tenantId: tenantA, limit: 10 })),
      withDatabaseTenant(tenantA, () => searchMemories(markerB, { tenantId: tenantA, limit: 10 })),
      withDatabaseTenant(tenantB, () => listMcpConnectors(50, { tenantId: tenantB })),
      withDatabaseTenant(tenantB, () => listOpenApiConnectors(50, { tenantId: tenantB })),
      withDatabaseTenant(tenantB, () => listWorkflowRuns(50, { tenantId: tenantB })),
      withDatabaseTenant(tenantB, () => getWorkflowRunDetail(workflowAId, { tenantId: tenantB })),
      withDatabaseTenant(tenantB, () => listObservabilityEvents({ correlationId, tenantId: tenantB, limit: 20 })),
    ]);

    const checks = {
      tenantASeesOwnMemory: tenantAMemories.some((memory) => memory.id === memoryA.id),
      tenantADoesNotSeeTenantBMemory: !tenantAMemories.some((memory) => memory.id === memoryB.id),
      tenantBSeesOwnMemory: tenantBMemories.some((memory) => memory.id === memoryB.id),
      tenantBDoesNotSeeTenantAMemory: !tenantBMemories.some((memory) => memory.id === memoryA.id),
      tenantASearchFindsOwnMemory: tenantASearchForA.some((result) => result.record.id === memoryA.id),
      tenantASearchDoesNotFindTenantBMemory: !tenantASearchForB.some((result) => result.record.id === memoryB.id),
      tenantBSeesOwnMcpConnector: tenantBMcpConnectors.some((connector) => connector.id === mcpB.id),
      tenantBDoesNotSeeTenantAMcpConnector: !tenantBMcpConnectors.some((connector) => connector.id === mcpA.id),
      tenantBSeesOwnOpenApiConnector: tenantBOpenApiConnectors.some((connector) => connector.id === openApiB.id),
      tenantBDoesNotSeeTenantAOpenApiConnector: !tenantBOpenApiConnectors.some((connector) => connector.id === openApiA.id),
      tenantBSeesOwnWorkflow: tenantBWorkflowRuns.some((run) => run.id === workflowBId),
      tenantBDoesNotListTenantAWorkflow: !tenantBWorkflowRuns.some((run) => run.id === workflowAId),
      tenantBCannotGetTenantAWorkflowDetail: tenantBWorkflowDetailForA === null,
      tenantBDoesNotSeeTenantAObservabilityEvent: tenantBEventsForA.length === 0,
      tenantAEventPersisted: Boolean(eventA.id),
    };
    const passed = Object.values(checks).filter(Boolean).length;
    const total = Object.keys(checks).length;

    return {
      status: passed === total ? "pass" : passed >= total - 2 ? "warn" : "fail",
      score: passed / total,
      output: {
        checks,
        tenants: [tenantA, tenantB],
        seeded: {
          memoryA: memoryA.id,
          memoryB: memoryB.id,
          mcpA: mcpA.id,
          mcpB: mcpB.id,
          openApiA: openApiA.id,
          openApiB: openApiB.id,
          workflowA: workflowAId,
          workflowB: workflowBId,
          eventA: eventA.id,
        },
        storageBackend: getStorageBackend(),
        databaseConfigured: hasDatabaseUrl(),
      },
    };
  } finally {
    const workflowAId = workflowA?.run.id;
    const workflowBId = workflowB?.run.id;
    await Promise.all([
      workflowAId
        ? withDatabaseTenant(tenantA, async () => {
            await signalWorkflowRun(workflowAId, "cancel").catch(() => undefined);
            await cancelWorkflowRunTick(
              workflowAId,
              "Tenant-isolation evaluation cleanup.",
              tenantA,
            ).catch(() => undefined);
          })
        : Promise.resolve(),
      workflowBId
        ? withDatabaseTenant(tenantB, async () => {
            await signalWorkflowRun(workflowBId, "cancel").catch(() => undefined);
            await cancelWorkflowRunTick(
              workflowBId,
              "Tenant-isolation evaluation cleanup.",
              tenantB,
            ).catch(() => undefined);
          })
        : Promise.resolve(),
    ]);
  }
}

async function withDatabaseTenant<T>(tenantId: string, operation: () => Promise<T>) {
  return runWithDatabaseTenantScope(tenantId, operation);
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

async function evaluateOperationsCenter(evalCase: EvalCaseDefinition): Promise<CaseResult> {
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
    workflowRiskSummaryAvailable: Boolean(evalCase.expected.workflowRiskSummary)
      ? typeof operations.summary.liveWorkflowRisks === "number" &&
        typeof operations.summary.historicalFailedWorkflows === "number" &&
        typeof operations.summary.recentUnhandledWorkflowFailures === "number" &&
        typeof operations.summary.recoveredWorkflowFailures === "number"
      : true,
    recoveryHistoryAvailable: Boolean(evalCase.expected.recoveryHistory)
      ? Array.isArray(operations.latest.recoveryEvents)
      : true,
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
      recoveryEvents: operations.latest.recoveryEvents.map((event) => ({
        id: event.id,
        disposition: event.disposition,
        workflowRunId: event.workflowRunId,
        status: event.workflow.status,
      })),
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

async function evaluateQueueRecovery(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const requeueRun = await createWorkflowRun({
    goal: `${String(evalCase.input.goal || "Queue recovery fixture")} requeue`,
    mode: "orchestrate",
    requireApproval: false,
    maxAttempts: 3,
  });
  const failRun = await createWorkflowRun({
    goal: `${String(evalCase.input.goal || "Queue recovery fixture")} fail`,
    mode: "orchestrate",
    requireApproval: false,
    maxAttempts: 1,
  });
  await updateWorkflowRun(failRun.run.id, {
    attempt: failRun.run.maxAttempts,
    error: "Evaluation exhausted workflow fixture.",
  });

  let cleanup = false;
  try {
    const inspect = await reconcileOperationsRecovery({
      mode: "inspect",
      staleWorkflowMs: 0,
      failAfterMs: 60_000,
      limit: 10,
      actorId: "evaluation",
    });
    const repair = await reconcileOperationsRecovery({
      mode: "repair",
      staleWorkflowMs: 0,
      failAfterMs: 60_000,
      limit: 10,
      actorId: "evaluation",
    });
    const drain = await reconcileOperationsRecovery({
      mode: "drain",
      staleWorkflowMs: 60_000,
      failAfterMs: 60_000,
      limit: 5,
      drainLimit: 2,
      actorId: "evaluation",
    });
    const requeueDetail = await getWorkflowRunDetail(requeueRun.run.id);
    const failDetail = await getWorkflowRunDetail(failRun.run.id);
    const registry = getCapabilityRegistry();
    const activeToolIds = new Set(registry.tools.filter((tool) => tool.status === "active").map((tool) => tool.id));
    await signalWorkflowRun(requeueRun.run.id, "cancel").catch(() => undefined);
    await cancelWorkflowRunTick(requeueRun.run.id, "Evaluation queue recovery cleanup.").catch(() => undefined);
    await cancelWorkflowRunTick(failRun.run.id, "Evaluation queue recovery cleanup.").catch(() => undefined);
    cleanup = true;

    const checks = {
      inspectFindsStale: Boolean(evalCase.expected.inspectFindsStale)
        ? inspect.staleWorkflows.some((workflow) => workflow.workflowRunId === requeueRun.run.id) &&
          inspect.staleWorkflows.some((workflow) => workflow.workflowRunId === failRun.run.id)
        : true,
      requeueRecovery: Boolean(evalCase.expected.requeueRecovery)
        ? repair.staleWorkflows.some((workflow) =>
            workflow.workflowRunId === requeueRun.run.id &&
            workflow.disposition === "requeued" &&
            workflow.jobIds.length > 0
          ) &&
          requeueDetail?.events.some((event) => event.type === "workflow.recovery.requeued") === true
        : true,
      failRecovery: Boolean(evalCase.expected.failRecovery)
        ? repair.staleWorkflows.some((workflow) =>
            workflow.workflowRunId === failRun.run.id &&
            workflow.disposition === "failed"
          ) &&
          failDetail?.run.status === "failed" &&
          failDetail.events.some((event) => event.type === "workflow.recovery.failed")
        : true,
      drainReported: Boolean(evalCase.expected.drainReported)
        ? drain.mode === "drain" &&
          typeof drain.drain?.requested === "number" &&
          typeof drain.runnableJobsAfter === "number"
        : true,
      cleanup: Boolean(evalCase.expected.cleanup) ? cleanup : true,
      registryToolAvailable: activeToolIds.has(String(evalCase.expected.registryTool || "ops.queue_recovery")),
    };
    const passed = Object.values(checks).filter(Boolean).length;
    const total = Object.keys(checks).length;

    return {
      status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
      score: passed / total,
      output: {
        checks,
        workflowRunIds: {
          requeue: requeueRun.run.id,
          fail: failRun.run.id,
        },
        inspect: {
          staleWorkflows: inspect.staleWorkflows.length,
          runnableJobsBefore: inspect.runnableJobsBefore,
          runnableJobsAfter: inspect.runnableJobsAfter,
        },
        repair: {
          requeuedWorkflows: repair.requeuedWorkflows,
          failedWorkflows: repair.failedWorkflows,
          expiredLeasesRepaired: repair.expiredLeasesRepaired,
        },
        drain: drain.drain,
      },
    };
  } finally {
    if (!cleanup) {
      await signalWorkflowRun(requeueRun.run.id, "cancel").catch(() => undefined);
      await cancelWorkflowRunTick(requeueRun.run.id, "Evaluation queue recovery cleanup.").catch(() => undefined);
      await cancelWorkflowRunTick(failRun.run.id, "Evaluation queue recovery cleanup.").catch(() => undefined);
    }
  }
}

async function evaluateHealthSemantics(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const recoveredFailure = createSyntheticWorkflowRun({
    id: "health-semantics-recovered",
    status: "failed",
    error: "Recovery failed stale workflow after max attempts were exhausted.",
    updatedAt: new Date(now - 60_000).toISOString(),
    completedAt: new Date(now - 60_000).toISOString(),
  });
  const recentUnhandledFailure = createSyntheticWorkflowRun({
    id: "health-semantics-recent-failure",
    status: "failed",
    error: "Unhandled workflow executor failure.",
    updatedAt: new Date(now - 60_000).toISOString(),
    completedAt: new Date(now - 60_000).toISOString(),
  });
  const oldUnhandledFailure = createSyntheticWorkflowRun({
    id: "health-semantics-old-failure",
    status: "failed",
    error: "Older unhandled workflow executor failure.",
    updatedAt: new Date(now - 31 * 60_000).toISOString(),
    completedAt: new Date(now - 31 * 60_000).toISOString(),
  });
  const staleQueued = createSyntheticWorkflowRun({
    id: "health-semantics-stale",
    status: "queued",
    updatedAt: new Date(now - 11 * 60_000).toISOString(),
  });

  const recoveredOnly = summarizeWorkflowHealth({ byStatus: { failed: 1 } }, [recoveredFailure], now);
  const recentUnhandled = summarizeWorkflowHealth({ byStatus: { failed: 1 } }, [recentUnhandledFailure], now);
  const staleRunnable = summarizeWorkflowHealth({ byStatus: { queued: 1 } }, [staleQueued], now);
  const oldFailure = summarizeWorkflowHealth({ byStatus: { failed: 1 } }, [oldUnhandledFailure], now);
  const checks = {
    recoveredFailuresDoNotDegrade: Boolean(evalCase.expected.recoveredFailuresDoNotDegrade)
      ? recoveredOnly.status === "healthy" &&
        recoveredOnly.recoveredTerminalFailures === 1 &&
        recoveredOnly.totalFailedWorkflows === 1
      : true,
    recentUnhandledFailuresDegrade: Boolean(evalCase.expected.recentUnhandledFailuresDegrade)
      ? recentUnhandled.status === "degraded" && recentUnhandled.recentUnhandledFailures === 1
      : true,
    staleRunnableDegrades: Boolean(evalCase.expected.staleRunnableDegrades)
      ? staleRunnable.status === "degraded" && staleRunnable.staleRunnable === 1
      : true,
    oldFailuresDoNotDegrade: Boolean(evalCase.expected.oldFailuresDoNotDegrade)
      ? oldFailure.status === "healthy" &&
        oldFailure.sampledFailedWorkflows === 1 &&
        oldFailure.recentUnhandledFailures === 0
      : true,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      checks,
      recoveredOnly,
      recentUnhandled,
      staleRunnable,
      oldFailure,
    },
  };
}

async function evaluateEvalGovernance(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const allCases = defaultEvalCases;
  const safeSuite = selectEvaluationCases({ maxSafetyMode: "synthetic" }).cases;
  const mutatingSelection = selectEvaluationCases({ caseIds: ["operations.queue_recovery"] }).cases;
  const blocked = evaluateEvaluationGovernance({
    cases: mutatingSelection,
    role: "operator",
    production: true,
  });
  const allowed = evaluateEvaluationGovernance({
    cases: mutatingSelection,
    role: "admin",
    allowMutation: true,
    reason: "Production evaluation governance override regression.",
    production: true,
  });
  const registry = getCapabilityRegistry();
  const activeToolIds = new Set(registry.tools.filter((tool) => tool.status === "active").map((tool) => tool.id));
  const checks = {
    metadataComplete: Boolean(evalCase.expected.metadataComplete)
      ? allCases.every((item) =>
          item.governance &&
          typeof item.governance.safetyMode === "string" &&
          typeof item.governance.riskLevel === "number" &&
          typeof item.governance.writesToDatabase === "boolean" &&
          Boolean(item.governance.cleanup)
        )
      : true,
    safeSuiteExcludesMutations: Boolean(evalCase.expected.safeSuiteExcludesMutations)
      ? safeSuite.length > 0 && safeSuite.every((item) => item.governance.safetyMode !== "mutation_allowed")
      : true,
    productionMutationBlocked: Boolean(evalCase.expected.productionMutationBlocked)
      ? !blocked.allowed && blocked.violations.some((violation) => violation.includes("allowMutation=true"))
      : true,
    adminOverrideAllowed: Boolean(evalCase.expected.adminOverrideAllowed)
      ? allowed.allowed && allowed.summary.mutatingCases >= 1
      : true,
    registryToolAvailable: activeToolIds.has(String(evalCase.expected.registryTool || "ops.eval_governance")),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      checks,
      allCases: summarizeEvaluationGovernance(allCases, true),
      safeSuite: summarizeEvaluationGovernance(safeSuite, true),
      blocked,
      allowed,
    },
  };
}

function createSyntheticWorkflowRun(patch: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  const now = new Date().toISOString();
  return {
    id: "health-semantics",
    workflowType: "agent.workflow.v1",
    status: "queued",
    goal: "Synthetic health semantics fixture.",
    input: {
      goal: "Synthetic health semantics fixture.",
      mode: "orchestrate",
      requireApproval: false,
    },
    currentStep: "preflight",
    attempt: 0,
    maxAttempts: 3,
    approvalRequired: false,
    createdAt: now,
    updatedAt: now,
    ...patch,
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
      tenantId: targetIncident.tenantId,
      actorId,
      reason: "Evaluation acknowledgement smoke.",
      metadata: { caseId: evalCase.id },
    });
    const playbookId = acknowledgement?.incident.playbookIds.find((id) =>
      playbooks.some((playbook) => playbook.id === id && playbook.autoRunnable),
    );
    const playbookResult = playbookId
      ? await runIncidentPlaybook({
          tenantId: targetIncident.tenantId,
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

async function evaluateObservabilityConsole(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const correlationId = `eval:observability:${Date.now()}`;
  const marker = await recordRuntimeEvent({
    category: "system",
    action: "observability.eval_marker",
    route: "/api/evaluations",
    method: "POST",
    statusCode: 200,
    durationMs: 12,
    correlationId,
    resourceType: "evaluation",
    message: "Observability evaluation marker.",
    metadata: {
      fixtureToken: "sk-example-secret-value-that-must-redact",
      markerCategory: String(evalCase.input.markerCategory || "system"),
    },
  });
  const [events, stats] = await Promise.all([
    listObservabilityEvents({ correlationId, limit: 5 }),
    getObservabilityStats(),
  ]);
  const registry = getCapabilityRegistry();
  const activeToolIds = new Set(registry.tools.filter((tool) => tool.status === "active").map((tool) => tool.id));
  const serializedEvents = JSON.stringify(events);
  const checks = {
    eventPersisted: Boolean(evalCase.expected.eventPersisted) ? events.some((event) => event.id === marker.id) : true,
    correlationIdAvailable: Boolean(evalCase.expected.correlationId)
      ? events.every((event) => event.correlationId === correlationId)
      : true,
    statsAvailable: stats.total >= events.length && typeof stats.byLevel.info === "number",
    sloSummary: Boolean(evalCase.expected.sloSummary)
      ? typeof stats.slo.availability === "number" &&
        typeof stats.slo.errorRate === "number" &&
        typeof stats.slo.latencyP95Ms === "number"
      : true,
    registryToolAvailable: activeToolIds.has(String(evalCase.expected.registryTool || "ops.observability_console")),
    secretSafe: Boolean(evalCase.expected.secretSafe)
      ? !serializedEvents.includes("sk-example-secret-value-that-must-redact") &&
        serializedEvents.includes("[redacted]")
      : true,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      checks,
      markerId: marker.id,
      correlationId,
      stats: {
        total: stats.total,
        byLevel: stats.byLevel,
        byCategory: stats.byCategory,
        routeFailures: stats.routeFailures,
        averageDurationMs: stats.averageDurationMs,
        p95DurationMs: stats.p95DurationMs,
        slo: stats.slo,
      },
      eventSample: events.map((event) => ({
        id: event.id,
        level: event.level,
        category: event.category,
        action: event.action,
        correlationId: event.correlationId,
        metadata: event.metadata,
      })),
    },
  };
}

async function evaluateSloAlerting(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const correlationId = `eval:slo:${Date.now()}`;
  const route = String(evalCase.input.route || "/api/evaluations");
  await recordRuntimeEvent({
    level: "error",
    category: "evaluation",
    action: "observability.slo_eval_failure_marker",
    route,
    method: "POST",
    statusCode: 500,
    durationMs: 25,
    correlationId,
    resourceType: "evaluation",
    message: "SLO alerting evaluation failure marker.",
    metadata: {
      policyFixture: "route failure breach",
      synthetic: true,
      syntheticSource: "evaluation_fixture",
      sloExcluded: true,
    },
  });
  const policyId = `eval_route_failure_${Date.now()}`;
  const policies: ObservabilitySloPolicy[] = [
    {
      id: policyId,
      name: "Evaluation route failure policy",
      description: "Evaluation-only policy that breaches when at least one route failure exists.",
      metric: "routeFailures",
      comparator: "greater_than_or_equal",
      warningThreshold: 1,
      criticalThreshold: 5,
      warningSeverity: "warning",
      criticalSeverity: "critical",
      unit: "count",
      componentId: "observability",
      enabled: true,
      alertTargetIds: ["dashboard", "ops"],
      suppressionMinutes: 0,
      metadata: { source: "evaluation" },
    },
  ];
  const result = await runObservabilitySloMonitor({
    trigger: "evaluation.slo_alerting",
    actorId: "evaluation",
    correlationId,
    queueAlerts: true,
    resolveRecovered: false,
    policies,
  });
  const registry = getCapabilityRegistry();
  const activeToolIds = new Set(registry.tools.filter((tool) => tool.status === "active").map((tool) => tool.id));
  const action = result.incidentActions.find((item) => item.policyId === policyId);
  const checks = {
    breachDetected: Boolean(evalCase.expected.breachDetected)
      ? result.breaches.some((breach) => breach.policy.id === policyId)
      : true,
    incidentAction: Boolean(evalCase.expected.incidentAction)
      ? Boolean(action?.incident && action.event && (action.created || action.reopened || action.severityChanged))
      : true,
    alertQueued: Boolean(evalCase.expected.alertQueued)
      ? (action?.alertDeliveries.length || 0) >= 2 && result.queuedAlerts >= 2
      : true,
    policyEvidence: Boolean(evalCase.expected.policyEvidence)
      ? result.evaluations.some((evaluation) =>
          evaluation.policy.id === policyId &&
          evaluation.value >= 1 &&
          evaluation.threshold === 1 &&
          evaluation.message.includes("breached"),
        )
      : true,
    registryToolAvailable: activeToolIds.has(String(evalCase.expected.registryTool || "ops.slo_alerting")),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  const cleanup = await resolveIncidentByFingerprint(createSloIncidentFingerprint(policies[0]), {
    actorId: "evaluation",
    resolution: "Resolved evaluation-only SLO alerting incident.",
    metadata: { policyId, correlationId },
  }).catch(() => null);

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      checks,
      policyId,
      correlationId,
      result: {
        healthy: result.healthy,
        breaches: result.breaches.length,
        queuedAlerts: result.queuedAlerts,
        incidentActions: result.incidentActions.length,
      },
      cleanupResolved: Boolean(cleanup),
      action: action ? {
        incidentId: action.incident?.id,
        created: action.created,
        reopened: action.reopened,
        severityChanged: action.severityChanged,
        alertDeliveries: action.alertDeliveries.length,
      } : undefined,
    },
  };
}

async function evaluateSloPolicyManagement(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const policyId = `${String(evalCase.input.policyPrefix || "eval_policy")}_${Date.now()}`;
  const policy: ObservabilitySloPolicy = {
    id: policyId,
    name: "Evaluation configurable SLO policy",
    description: "Temporary evaluation policy for configurable SLO management.",
    metric: "routeFailures",
    comparator: "greater_than_or_equal",
    warningThreshold: 9999,
    criticalThreshold: 19999,
    warningSeverity: "info",
    criticalSeverity: "warning",
    unit: "count",
    componentId: "observability",
    enabled: true,
    alertTargetIds: ["dashboard", "ops"],
    suppressionMinutes: 17,
    metadata: { source: "evaluation" },
  };
  const saved = await saveObservabilitySloPolicy(policy);
  const fetched = await getObservabilitySloPolicy(policyId);
  const allPolicies = await listObservabilitySloPolicies({ includeDisabled: true });
  const registry = getCapabilityRegistry();
  const activeToolIds = new Set(registry.tools.filter((tool) => tool.status === "active").map((tool) => tool.id));
  const cleanup = await deleteObservabilitySloPolicy(policyId).catch(() => false);
  const afterCleanup = await getObservabilitySloPolicy(policyId);
  const checks = {
    persisted: Boolean(evalCase.expected.persisted)
      ? Boolean(fetched && allPolicies.some((item) => item.id === policyId))
      : true,
    thresholdsConfigurable: Boolean(evalCase.expected.thresholdsConfigurable)
      ? fetched?.warningThreshold === policy.warningThreshold && fetched?.criticalThreshold === policy.criticalThreshold
      : true,
    severityConfigurable: Boolean(evalCase.expected.severityConfigurable)
      ? fetched?.warningSeverity === "info" && fetched?.criticalSeverity === "warning"
      : true,
    routingConfigurable: Boolean(evalCase.expected.routingConfigurable)
      ? JSON.stringify(fetched?.alertTargetIds || []) === JSON.stringify(policy.alertTargetIds)
      : true,
    suppressionConfigurable: Boolean(evalCase.expected.suppressionConfigurable)
      ? fetched?.suppressionMinutes === 17
      : true,
    cleanup: Boolean(evalCase.expected.cleanup)
      ? cleanup === true && afterCleanup === null
      : true,
    registryToolAvailable: activeToolIds.has(String(evalCase.expected.registryTool || "ops.slo_policy_management")),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      checks,
      policyId,
      saved: {
        id: saved.id,
        warningThreshold: saved.warningThreshold,
        criticalThreshold: saved.criticalThreshold,
        warningSeverity: saved.warningSeverity,
        criticalSeverity: saved.criticalSeverity,
        alertTargetIds: saved.alertTargetIds,
        suppressionMinutes: saved.suppressionMinutes,
      },
      policyCount: allPolicies.length,
      cleanup,
    },
  };
}

async function evaluateSloPolicyChangeControl(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const policyId = `${String(evalCase.input.policyPrefix || "eval_governed_policy")}_${Date.now()}`;
  const baselinePolicy: ObservabilitySloPolicy = {
    id: policyId,
    name: "Evaluation governed SLO policy",
    description: "Temporary evaluation policy for governed SLO change control.",
    metric: "latencyP95Ms",
    comparator: "greater_than",
    warningThreshold: 9000,
    criticalThreshold: 18000,
    warningSeverity: "warning",
    criticalSeverity: "critical",
    unit: "ms",
    componentId: "observability",
    enabled: true,
    alertTargetIds: ["dashboard"],
    suppressionMinutes: 31,
    metadata: { source: "evaluation", governance: "baseline" },
  };
  const savedBaseline = await saveObservabilitySloPolicy(baselinePolicy);
  const requestedPolicy: ObservabilitySloPolicy = {
    ...savedBaseline,
    warningThreshold: 7000,
    criticalThreshold: 12000,
    warningSeverity: "info",
    criticalSeverity: "warning",
    alertTargetIds: ["dashboard", "ops"],
    suppressionMinutes: 13,
    metadata: { ...savedBaseline.metadata, governance: "requested" },
  };
  const requestedChange = await requestObservabilitySloPolicyChange({
    policyId,
    action: "upsert_policy",
    tenantId: "evaluation",
    requestedBy: "evaluation",
    reason: "Evaluation SLO policy governance request.",
    beforePolicy: savedBaseline,
    afterPolicy: requestedPolicy,
  });
  const fetchedPending = await getObservabilitySloPolicyChange(requestedChange.id);
  const pendingChanges = await listObservabilitySloPolicyChanges({ policyId, status: "pending", limit: 20 });
  const approval = await applyObservabilitySloPolicyChange(requestedChange.id, {
    reviewedBy: "evaluation",
    reviewReason: "Evaluation approval.",
  });
  const approvedPolicy = await getObservabilitySloPolicy(policyId);
  const historyAfterApproval = await listObservabilitySloPolicyChanges({ policyId, limit: 20 });
  const rollbackRequest = await rollbackObservabilitySloPolicyChange(requestedChange.id, {
    tenantId: "evaluation",
    requestedBy: "evaluation",
    reason: "Evaluation rollback request.",
  });
  const fetchedRollback = await getObservabilitySloPolicyChange(rollbackRequest.change.id);
  const rollbackFirstApproval = await applyObservabilitySloPolicyChange(rollbackRequest.change.id, {
    reviewedBy: "eval-admin-a",
    reviewedRole: "admin",
    reviewReason: "Evaluation rollback attestation from first admin.",
  });
  const rollbackApproval = await applyObservabilitySloPolicyChange(rollbackRequest.change.id, {
    reviewedBy: "eval-admin-b",
    reviewedRole: "admin",
    reviewReason: "Evaluation rollback attestation from second admin.",
  });
  const restoredPolicy = await getObservabilitySloPolicy(policyId);
  const cleanup = await deleteObservabilitySloPolicy(policyId).catch(() => false);
  const afterCleanup = await getObservabilitySloPolicy(policyId);
  const registry = getCapabilityRegistry();
  const activeToolIds = new Set(registry.tools.filter((tool) => tool.status === "active").map((tool) => tool.id));
  const checks = {
    approvalRequest: Boolean(evalCase.expected.approvalRequest)
      ? fetchedPending?.status === "pending" && pendingChanges.some((change) => change.id === requestedChange.id)
      : true,
    approvalApply: Boolean(evalCase.expected.approvalApply)
      ? approval.change.status === "applied" &&
        approvedPolicy?.warningThreshold === requestedPolicy.warningThreshold &&
        approvedPolicy?.criticalSeverity === requestedPolicy.criticalSeverity
      : true,
    history: Boolean(evalCase.expected.history)
      ? historyAfterApproval.some((change) =>
          change.id === requestedChange.id &&
          change.beforePolicy?.warningThreshold === baselinePolicy.warningThreshold &&
          change.afterPolicy?.warningThreshold === requestedPolicy.warningThreshold
        )
      : true,
    rollbackRequest: Boolean(evalCase.expected.rollbackRequest)
      ? fetchedRollback?.status === "pending" && fetchedRollback.rollbackChangeId === requestedChange.id
      : true,
    rollbackApply: Boolean(evalCase.expected.rollbackApply)
      ? rollbackApproval.change.status === "applied" &&
        rollbackFirstApproval.change.status === "pending" &&
        restoredPolicy?.warningThreshold === baselinePolicy.warningThreshold &&
        restoredPolicy?.criticalThreshold === baselinePolicy.criticalThreshold
      : true,
    cleanup: Boolean(evalCase.expected.cleanup)
      ? cleanup === true && afterCleanup === null
      : true,
    registryToolAvailable: activeToolIds.has(String(evalCase.expected.registryTool || "ops.slo_policy_change_control")),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      checks,
      policyId,
      requestedChange: {
        id: requestedChange.id,
        status: requestedChange.status,
        riskLevel: requestedChange.riskLevel,
      },
      approval: {
        status: approval.change.status,
        policies: approval.policies.length,
      },
      rollback: {
        id: rollbackRequest.change.id,
        firstApprovalStatus: rollbackFirstApproval.change.status,
        status: rollbackApproval.change.status,
        policies: rollbackApproval.policies.length,
        approvals: rollbackApproval.change.approvals.length,
      },
      cleanup,
    },
  };
}

async function evaluateSloMultiPartyApproval(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const policyId = `${String(evalCase.input.policyPrefix || "eval_quorum_policy")}_${Date.now()}`;
  const policy: ObservabilitySloPolicy = {
    id: policyId,
    name: "Evaluation quorum SLO policy",
    description: "Temporary evaluation policy for high-risk multi-party approval.",
    metric: "routeFailures",
    comparator: "greater_than_or_equal",
    warningThreshold: 8888,
    criticalThreshold: 18888,
    warningSeverity: "warning",
    criticalSeverity: "critical",
    unit: "count",
    componentId: "observability",
    enabled: true,
    alertTargetIds: ["dashboard"],
    suppressionMinutes: 29,
    metadata: { source: "evaluation", governance: "quorum" },
  };
  const saved = await saveObservabilitySloPolicy(policy);
  const change = await requestObservabilitySloPolicyChange({
    policyId,
    action: "delete_policy",
    tenantId: "evaluation",
    requestedBy: "eval-requester",
    reason: "Evaluation high-risk delete request.",
    beforePolicy: saved,
    afterPolicy: null,
  });
  const requesterBlocked = await applyObservabilitySloPolicyChange(change.id, {
    reviewedBy: "eval-requester",
    reviewedRole: "admin",
    reviewReason: "Requester self-approval should be rejected.",
  })
    .then(() => false)
    .catch(() => true);
  const firstApproval = await applyObservabilitySloPolicyChange(change.id, {
    reviewedBy: "eval-admin-a",
    reviewedRole: "admin",
    reviewReason: "First high-risk approval.",
  });
  const stillPresentAfterFirstApproval = await getObservabilitySloPolicy(policyId);
  const secondApproval = await applyObservabilitySloPolicyChange(change.id, {
    reviewedBy: "eval-system-b",
    reviewedRole: "system",
    reviewReason: "Second high-risk approval.",
  });
  const afterDelete = await getObservabilitySloPolicy(policyId);
  const history = await listObservabilitySloPolicyChanges({ policyId, limit: 10 });
  const cleanup = afterDelete === null ? true : await deleteObservabilitySloPolicy(policyId).catch(() => false);
  const registry = getCapabilityRegistry();
  const activeToolIds = new Set(registry.tools.filter((tool) => tool.status === "active").map((tool) => tool.id));
  const appliedChange = history.find((item) => item.id === change.id) || secondApproval.change;
  const checks = {
    highRiskPolicy: Boolean(evalCase.expected.highRiskPolicy)
      ? change.riskLevel === 3 &&
        change.approvalPolicy.quorum === 2 &&
        change.approvalPolicy.requiredRoles.includes("admin") &&
        change.approvalPolicy.requiredRoles.includes("system") &&
        change.approvalPolicy.allowRequesterApproval === false
      : true,
    requesterBlocked: Boolean(evalCase.expected.requesterBlocked) ? requesterBlocked : true,
    firstApprovalPending: Boolean(evalCase.expected.firstApprovalPending)
      ? firstApproval.change.status === "pending" &&
        firstApproval.approvalProgress.remaining === 1 &&
        Boolean(stillPresentAfterFirstApproval)
      : true,
    quorumApply: Boolean(evalCase.expected.quorumApply)
      ? secondApproval.change.status === "applied" &&
        secondApproval.approvalProgress.canApply === true &&
        afterDelete === null
      : true,
    signedEvidence: Boolean(evalCase.expected.signedEvidence)
      ? appliedChange.approvals.length === 2 &&
        appliedChange.approvals.every((approval) => approval.evidenceHash.length === 64 && approval.signature.length === 64) &&
        appliedChange.evidenceHash.length === 64
      : true,
    cleanup: Boolean(evalCase.expected.cleanup) ? cleanup === true : true,
    registryToolAvailable: activeToolIds.has(String(evalCase.expected.registryTool || "ops.slo_multi_party_approval")),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
    score: passed / total,
    output: {
      checks,
      policyId,
      change: {
        id: change.id,
        riskLevel: change.riskLevel,
        quorum: change.approvalPolicy.quorum,
        requiredRoles: change.approvalPolicy.requiredRoles,
      },
      firstApproval: {
        status: firstApproval.change.status,
        remaining: firstApproval.approvalProgress.remaining,
      },
      secondApproval: {
        status: secondApproval.change.status,
        approvals: secondApproval.change.approvals.length,
        evidenceHash: secondApproval.change.evidenceHash,
      },
      cleanup,
    },
  };
}

async function evaluateSloApprovalPolicyAdmin(evalCase: EvalCaseDefinition): Promise<CaseResult> {
  const originalPolicy = await getObservabilitySloApprovalPolicyConfig();
  const policyId = `${String(evalCase.input.policyPrefix || "eval_approval_policy_admin")}_${Date.now()}`;
  const breakGlassPolicyId = `${policyId}_break_glass`;
  let restored = false;
  let evaluationPolicyVersion: number | undefined;

  try {
    const customPolicy = createEvaluationApprovalPolicyConfig(originalPolicy);
    const savedPolicy = await saveObservabilitySloApprovalPolicyConfig(customPolicy, {
      changedBy: "evaluation",
      changeReason: "Evaluation custom SLO approval policy administration update.",
      expectedVersion: originalPolicy.version,
    });
    evaluationPolicyVersion = savedPolicy.version;
    const versionsAfterSave = await listObservabilitySloApprovalPolicyVersions({ limit: 10 });
    const baselinePolicy: ObservabilitySloPolicy = {
      id: policyId,
      name: "Evaluation approval-admin SLO policy",
      description: "Temporary policy for approval administration quorum verification.",
      metric: "latencyP95Ms",
      comparator: "greater_than",
      warningThreshold: 9100,
      criticalThreshold: 18100,
      warningSeverity: "warning",
      criticalSeverity: "critical",
      unit: "ms",
      componentId: "observability",
      enabled: true,
      alertTargetIds: ["dashboard"],
      suppressionMinutes: 23,
      metadata: { source: "evaluation", governance: "approval-admin-baseline" },
    };
    const savedBaseline = await saveObservabilitySloPolicy(baselinePolicy);
    const requestedPolicy: ObservabilitySloPolicy = {
      ...savedBaseline,
      warningThreshold: 7100,
      criticalThreshold: 13100,
      metadata: { ...savedBaseline.metadata, governance: "approval-admin-requested" },
    };
    const quorumChange = await requestObservabilitySloPolicyChange({
      policyId,
      action: "upsert_policy",
      tenantId: "evaluation",
      requestedBy: "eval-approval-admin-requester",
      reason: "Evaluation approval policy custom quorum request.",
      beforePolicy: savedBaseline,
      afterPolicy: requestedPolicy,
    });
    const firstApproval = await applyObservabilitySloPolicyChange(quorumChange.id, {
      reviewedBy: "eval-approval-admin-a",
      reviewedRole: "admin",
      reviewReason: "First approval under custom quorum.",
    });
    const secondApproval = await applyObservabilitySloPolicyChange(quorumChange.id, {
      reviewedBy: "eval-approval-admin-b",
      reviewedRole: "admin",
      reviewReason: "Second approval under custom quorum.",
    });
    const updatedPolicy = await getObservabilitySloPolicy(policyId);

    const breakGlassBaseline = await saveObservabilitySloPolicy({
      ...baselinePolicy,
      id: breakGlassPolicyId,
      name: "Evaluation break-glass SLO policy",
      metadata: { source: "evaluation", governance: "approval-admin-break-glass" },
    });
    const breakGlassChange = await requestObservabilitySloPolicyChange({
      policyId: breakGlassPolicyId,
      action: "delete_policy",
      tenantId: "evaluation",
      requestedBy: "eval-breakglass-requester",
      reason: "Evaluation high-risk break-glass delete request.",
      beforePolicy: breakGlassBaseline,
      afterPolicy: null,
    });
    const breakGlassApproval = await applyObservabilitySloPolicyChange(breakGlassChange.id, {
      reviewedBy: "eval-breakglass-system",
      reviewedRole: "system",
      reviewReason: "Emergency evaluation break-glass rationale for production recovery path.",
      breakGlass: true,
    });
    const afterBreakGlassDelete = await getObservabilitySloPolicy(breakGlassPolicyId);

    const restoredPolicy = await saveObservabilitySloApprovalPolicyConfig(originalPolicy, {
      changedBy: "evaluation",
      changeReason: "Restore original SLO approval policy after evaluation.",
      expectedVersion: savedPolicy.version,
    });
    restored = true;
    const registry = getCapabilityRegistry();
    const activeToolIds = new Set(registry.tools.filter((tool) => tool.status === "active").map((tool) => tool.id));
    const cleanupPrimary = await deleteObservabilitySloPolicy(policyId).catch(() => false);
    const cleanupBreakGlass = afterBreakGlassDelete === null
      ? true
      : await deleteObservabilitySloPolicy(breakGlassPolicyId).catch(() => false);
    const checks = {
      customPolicySaved: Boolean(evalCase.expected.customPolicySaved)
        ? savedPolicy.version > originalPolicy.version &&
          getApprovalRuleQuorum(savedPolicy, "risk_2_standard", 2) === 2 &&
          savedPolicy.breakGlass.enabled === true &&
          savedPolicy.breakGlass.reasonMinLength === 16
        : true,
      versionHistory: Boolean(evalCase.expected.versionHistory)
        ? versionsAfterSave.some((version) =>
            version.version === savedPolicy.version &&
            version.previousHash === originalPolicy.evidenceHash &&
            version.evidenceHash.length === 64
          )
        : true,
      customQuorumApplied: Boolean(evalCase.expected.customQuorumApplied)
        ? quorumChange.approvalPolicy.quorum === 2 &&
          firstApproval.change.status === "pending" &&
          firstApproval.approvalProgress.remaining === 1 &&
          secondApproval.change.status === "applied" &&
          updatedPolicy?.warningThreshold === requestedPolicy.warningThreshold
        : true,
      breakGlassApplied: Boolean(evalCase.expected.breakGlassApplied)
        ? breakGlassChange.approvalPolicy.breakGlassAllowed === true &&
          breakGlassApproval.change.status === "applied" &&
          breakGlassApproval.approvalProgress.breakGlassUsed === true &&
          afterBreakGlassDelete === null
        : true,
      restored: Boolean(evalCase.expected.restored)
        ? approvalPolicyEquivalent(restoredPolicy, originalPolicy)
        : true,
      registryToolAvailable: activeToolIds.has(String(evalCase.expected.registryTool || "ops.slo_approval_policy_admin")),
    };
    const passed = Object.values(checks).filter(Boolean).length;
    const total = Object.keys(checks).length;

    return {
      status: passed === total ? "pass" : passed >= total - 1 ? "warn" : "fail",
      score: passed / total,
      output: {
        checks,
        policyId,
        approvalPolicy: {
          previousVersion: originalPolicy.version,
          savedVersion: savedPolicy.version,
          restoredVersion: restoredPolicy.version,
          evidenceHash: savedPolicy.evidenceHash,
        },
        quorumChange: {
          id: quorumChange.id,
          quorum: quorumChange.approvalPolicy.quorum,
          firstApprovalStatus: firstApproval.change.status,
          finalStatus: secondApproval.change.status,
        },
        breakGlass: {
          id: breakGlassChange.id,
          status: breakGlassApproval.change.status,
          breakGlassUsed: breakGlassApproval.approvalProgress.breakGlassUsed,
        },
        cleanup: {
          primary: cleanupPrimary,
          breakGlass: cleanupBreakGlass,
        },
      },
    };
  } finally {
    if (!restored) {
      await saveObservabilitySloApprovalPolicyConfig(originalPolicy, {
        changedBy: "evaluation",
        changeReason: "Restore original SLO approval policy after interrupted evaluation.",
        expectedVersion: evaluationPolicyVersion,
      }).catch(() => undefined);
    }
    await deleteObservabilitySloPolicy(policyId).catch(() => undefined);
    await deleteObservabilitySloPolicy(breakGlassPolicyId).catch(() => undefined);
  }
}

function createEvaluationApprovalPolicyConfig(
  policy: ObservabilitySloApprovalPolicyConfig,
): ObservabilitySloApprovalPolicyConfig {
  const rules = policy.rules.filter((rule) =>
    rule.id !== "risk_2_standard" &&
    rule.id !== "risk_3_high" &&
    rule.id !== "rollback_policy" &&
    rule.action !== "rollback_policy" &&
    !(rule.action === "any" && (rule.riskLevel === 2 || rule.riskLevel === 3))
  );
  const lowRiskRule = policy.rules.find((rule) => rule.id === "risk_2_standard" || (rule.action === "any" && rule.riskLevel === 2));
  const highRiskRule = policy.rules.find((rule) => rule.id === "risk_3_high" || (rule.action === "any" && rule.riskLevel === 3));
  const rollbackRule = policy.rules.find((rule) => rule.id === "rollback_policy" || rule.action === "rollback_policy");

  return {
    ...policy,
    rules: [
      {
        ...(rollbackRule || createEvaluationApprovalRule("rollback_policy", 3)),
        id: "rollback_policy",
        action: "rollback_policy",
        riskLevel: 3,
        quorum: 2,
        requiredRoles: ["admin", "system"],
        allowRequesterApproval: false,
        attestationRequired: true,
        breakGlassAllowed: true,
      },
      {
        ...(highRiskRule || createEvaluationApprovalRule("risk_3_high", 3)),
        id: "risk_3_high",
        action: "any",
        riskLevel: 3,
        quorum: 2,
        requiredRoles: ["admin", "system"],
        allowRequesterApproval: false,
        breakGlassAllowed: true,
      },
      {
        ...(lowRiskRule || createEvaluationApprovalRule("risk_2_standard", 2)),
        id: "risk_2_standard",
        action: "any",
        riskLevel: 2,
        quorum: 2,
        requiredRoles: ["operator", "admin", "system"],
        allowRequesterApproval: true,
        attestationRequired: false,
        breakGlassAllowed: false,
      },
      ...rules,
    ],
    breakGlass: {
      ...policy.breakGlass,
      enabled: true,
      requiredRole: "system",
      reasonMinLength: 16,
      maxRiskLevel: 3,
      requireTicket: false,
    },
    metadata: {
      ...policy.metadata,
      evaluation: "slo_approval_policy_admin",
    },
  };
}

function createEvaluationApprovalRule(id: string, riskLevel: number) {
  const highRisk = riskLevel >= 3;
  return {
    id,
    action: "any" as const,
    riskLevel,
    quorum: highRisk ? 2 : 1,
    requiredRoles: highRisk ? (["admin", "system"] as const) : (["operator", "admin", "system"] as const),
    allowRequesterApproval: !highRisk,
    attestationRequired: false,
    breakGlassAllowed: highRisk,
    description: highRisk
      ? "High-risk SLO changes require two distinct admin/system approvals."
      : "Standard SLO changes require one operator, admin, or system approval.",
  };
}

function getApprovalRuleQuorum(policy: ObservabilitySloApprovalPolicyConfig, id: string, riskLevel: number) {
  return policy.rules.find((rule) => rule.id === id)?.quorum ||
    policy.rules.find((rule) => rule.action === "any" && rule.riskLevel === riskLevel)?.quorum ||
    0;
}

function approvalPolicyEquivalent(
  left: ObservabilitySloApprovalPolicyConfig,
  right: ObservabilitySloApprovalPolicyConfig,
) {
  return JSON.stringify(left.rules) === JSON.stringify(right.rules) &&
    JSON.stringify(left.breakGlass) === JSON.stringify(right.breakGlass);
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
