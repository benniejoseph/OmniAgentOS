import { hasOpenAIKey } from "@/lib/config";
import { hashPassword, verifyPassword } from "@/lib/auth/crypto";
import { isAuthEnforced } from "@/lib/auth/store";
import { getStorageBackend, hasDatabaseUrl } from "@/lib/db/client";
import { executeGovernedTool } from "@/lib/tools/executor";
import { connectionCatalog } from "@/lib/connectors/catalog";
import { getCapabilityRegistry } from "@/lib/orchestration/registry";
import { getApprovalQueue, getOperationsOverview } from "@/lib/operations/queue";
import { retrieveContext } from "@/lib/rag/retriever";
import { canPerform, redactSensitive } from "@/lib/security/context";
import { createWorkflowRun } from "@/lib/workflows/store";
import { tickWorkflowRun } from "@/lib/workflows/runner";
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
      activeTools: ["tool.executor", "connector.openapi", "workflow.temporal"],
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

  if (evalCase.id === "tool.policy_dry_run") {
    return evaluateToolPolicy(evalCase);
  }

  if (evalCase.id === "workflow.lifecycle") {
    return evaluateWorkflowLifecycle(evalCase);
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

  for (let index = 0; index < maxTicks && current?.run.status !== "completed" && current?.run.status !== "failed"; index++) {
    current = await tickWorkflowRun(detail.run.id);
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
      resultKeys: current?.run.result ? Object.keys(current.run.result) : [],
      reportPreview: typeof report === "string" ? report.slice(0, 600) : undefined,
    },
    estimatedCostUsd: estimateCost(evalCase, { goal: evalCase.input.goal, report }),
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
