import { randomUUID } from "node:crypto";
import { getMcpConnectorStats } from "@/lib/connectors/store";
import { getOpenApiConnectorStats } from "@/lib/connectors/openapi-store";
import { ensureDatabaseSchema, getSql, getStorageBackend, getVectorStoreStatus, hasDatabaseUrl } from "@/lib/db/client";
import { syncIncidentsFromHealthCheck } from "@/lib/diagnostics/incidents";
import { getEvalStats } from "@/lib/evaluations/store";
import { getMemoryStats } from "@/lib/memory/store";
import { getOperationJobStats, listOperationJobs } from "@/lib/operations/job-queue";
import { reconcileOperationsRecovery } from "@/lib/operations/recovery";
import { getWorkflowPlanNodeExecutionStats } from "@/lib/workflows/executor";
import { listWorkflowPlans } from "@/lib/workflows/planner";
import { getWorkflowStats, listWorkflowRuns } from "@/lib/workflows/store";
import { getWorkflowTriggerStats } from "@/lib/workflows/triggers";
import type { WorkflowRunRecord, WorkflowStats } from "@/lib/workflows/types";
import { getRunStats } from "@/lib/runs/store";
import { getToolExecutionStats } from "@/lib/tools/audit-store";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import { hasOpenAIKey } from "@/lib/config";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export type HealthComponent = {
  id: string;
  name: string;
  status: HealthStatus;
  summary: string;
  metrics: Record<string, number | string | boolean | undefined>;
};

export type HealthIncident = {
  id: string;
  componentId: string;
  severity: "info" | "warning" | "critical";
  message: string;
  metadata?: Record<string, unknown>;
};

export type RecoveryAction = {
  id: string;
  status: "planned" | "completed" | "skipped" | "failed";
  message: string;
  metadata?: Record<string, unknown>;
};

export type SystemHealthRecord = {
  id: string;
  status: HealthStatus;
  scope: "health" | "diagnostics" | "repair";
  components: HealthComponent[];
  metrics: Record<string, number | string | boolean | undefined>;
  incidents: HealthIncident[];
  recoveryActions: RecoveryAction[];
  latencyMs: number;
  createdAt: string;
};

export type WorkflowHealthSummary = {
  status: HealthStatus;
  staleRunnable: number;
  recentUnhandledFailures: number;
  recoveredTerminalFailures: number;
  sampledFailedWorkflows: number;
  totalFailedWorkflows: number;
  staleWorkflowMs: number;
  failureWarnMs: number;
  degradedReason?: string;
};

type HealthLedger = {
  checks: SystemHealthRecord[];
};

type DiagnosticsInput = {
  repair?: boolean;
  scope?: SystemHealthRecord["scope"];
};

const staleWorkflowMs = 10 * 60 * 1000;
const workflowFailureWarnMs = 30 * 60 * 1000;
const queueAgeWarnMs = 5 * 60 * 1000;
const recoveryTerminalFailurePrefixes = [
  "Recovery failed stale workflow after max attempts were exhausted.",
  "Recovery failed workflow after stale fail-after threshold was exceeded.",
];
let healthFileWriteQueue: Promise<void> = Promise.resolve();

export async function runSystemDiagnostics(input: DiagnosticsInput = {}) {
  const startedAt = Date.now();
  const recoveryActions: RecoveryAction[] = [];

  if (input.repair) {
    const recovery = await reconcileOperationsRecovery({
      mode: "repair",
      limit: 10,
    });
    recoveryActions.push({
      id: "operation_jobs.expired_leases",
      status: recovery.expiredLeasesRepaired > 0 ? "completed" : "skipped",
      message: recovery.expiredLeasesRepaired > 0
        ? `Repaired ${recovery.expiredLeasesRepaired} expired operation job lease(s).`
        : "No expired operation job leases required repair.",
      metadata: { repairedJobs: recovery.expiredLeasesRepaired },
    });
    if (recovery.staleWorkflows.length) {
      for (const workflow of recovery.staleWorkflows) {
        recoveryActions.push({
          id: `workflow.${workflow.workflowRunId}`,
          status: workflow.disposition === "skipped" || workflow.disposition === "inspect" ? "skipped" : "completed",
          message: `${workflow.disposition} stale workflow ${workflow.workflowRunId}.`,
          metadata: {
            workflowRunId: workflow.workflowRunId,
            disposition: workflow.disposition,
            staleMs: workflow.staleMs,
            reason: workflow.reason,
            jobIds: workflow.jobIds,
          },
        });
      }
    } else {
      recoveryActions.push({
        id: "workflows.stale",
        status: "skipped",
        message: "No stale workflows required repair.",
      });
    }
  }

  const [
    database,
    vectorStore,
    operationJobs,
    operationJobRows,
    workflows,
    workflowRows,
    plans,
    planExecutions,
    triggers,
    evals,
    tools,
    agentRuns,
    memory,
    mcp,
    openapi,
  ] = await Promise.all([
    checkDatabase(),
    getVectorStoreStatus().catch((error) => ({
      configured: false,
      dimensions: 0,
      hnswSupported: false,
      error: error instanceof Error ? error.message : "Vector status unavailable.",
    })),
    getOperationJobStats(),
    listOperationJobs(100),
    getWorkflowStats(),
    listWorkflowRuns(100),
    listWorkflowPlans(100),
    getWorkflowPlanNodeExecutionStats(),
    getWorkflowTriggerStats(),
    getEvalStats(),
    getToolExecutionStats(),
    getRunStats(),
    getMemoryStats(),
    getMcpConnectorStats(),
    getOpenApiConnectorStats(),
  ]);

  const workflowHealth = summarizeWorkflowHealth(workflows, workflowRows);
  const queueMaxAgeMs = maxQueuedAge(operationJobRows);
  const workflowTerminal = (workflows.byStatus.completed || 0) + (workflows.byStatus.failed || 0) + (workflows.byStatus.canceled || 0);
  const workflowCompletionRate = workflowTerminal
    ? (workflows.byStatus.completed || 0) / workflowTerminal
    : 1;
  const plannerFallbackRate = plans.length
    ? plans.filter((plan) => plan.planner === "deterministic").length / plans.length
    : 0;
  const toolTerminal = tools.total || 0;
  const toolFailureRate = toolTerminal ? (tools.byStatus.failed || 0) / toolTerminal : 0;
  const triggerFailureRate = triggers.events
    ? (triggers.failedEvents + triggers.rejectedEvents) / triggers.events
    : 0;

  const components: HealthComponent[] = [
    {
      id: "database",
      name: "Database",
      status: database.ok ? "healthy" : process.env.VERCEL ? "unhealthy" : "degraded",
      summary: database.ok
        ? `Storage backend ${getStorageBackend()} is reachable.`
        : database.error || "Database is not configured.",
      metrics: {
        configured: hasDatabaseUrl(),
        storageBackend: getStorageBackend(),
        latencyMs: database.latencyMs,
      },
    },
    {
      id: "openai",
      name: "OpenAI",
      status: hasOpenAIKey() ? "healthy" : "degraded",
      summary: hasOpenAIKey() ? "OpenAI API key is configured." : "OpenAI API key is missing; model-backed paths use fallback behavior.",
      metrics: {
        configured: hasOpenAIKey(),
      },
    },
    {
      id: "vector_store",
      name: "Vector Store",
      status: vectorStore.configured ? "healthy" : hasDatabaseUrl() ? "degraded" : "degraded",
      summary: vectorStore.configured
        ? `pgvector HNSW index is configured at ${vectorStore.dimensions} dimensions.`
        : "Vector store is falling back to JSON embeddings or local storage.",
      metrics: {
        configured: vectorStore.configured,
        dimensions: vectorStore.dimensions,
        hnswSupported: vectorStore.hnswSupported,
      },
    },
    {
      id: "operation_queue",
      name: "Operation Queue",
      status: operationJobs.expiredLeases > 0
        ? "unhealthy"
        : (operationJobs.byStatus.failed || 0) > 0 || queueMaxAgeMs > queueAgeWarnMs
          ? "degraded"
          : "healthy",
      summary: `${operationJobs.runnable} runnable job(s), ${operationJobs.expiredLeases} expired lease(s).`,
      metrics: {
        total: operationJobs.total,
        queued: operationJobs.byStatus.queued || 0,
        running: operationJobs.byStatus.running || 0,
        failed: operationJobs.byStatus.failed || 0,
        runnable: operationJobs.runnable,
        delayed: operationJobs.delayed,
        expiredLeases: operationJobs.expiredLeases,
        maxQueuedAgeMs: queueMaxAgeMs,
      },
    },
    {
      id: "workflows",
      name: "Workflows",
      status: workflowHealth.status,
      summary: `${workflows.active} active workflow(s), ${workflowHealth.staleRunnable} stale runnable workflow(s), ${workflowHealth.recentUnhandledFailures} recent unhandled failed workflow(s).`,
      metrics: {
        total: workflows.total,
        active: workflows.active,
        waitingApproval: workflows.waitingApproval,
        failed: workflowHealth.totalFailedWorkflows,
        stale: workflowHealth.staleRunnable,
        recentUnhandledFailures: workflowHealth.recentUnhandledFailures,
        recoveredTerminalFailures: workflowHealth.recoveredTerminalFailures,
        sampledFailedWorkflows: workflowHealth.sampledFailedWorkflows,
        failureWarnMs: workflowHealth.failureWarnMs,
        completionRate: round(workflowCompletionRate),
      },
    },
    {
      id: "planner",
      name: "Planner",
      status: plannerFallbackRate > 0.7 && plans.length >= 5 ? "degraded" : "healthy",
      summary: `${plans.length} recent plan(s), ${Math.round(plannerFallbackRate * 100)}% deterministic fallback rate.`,
      metrics: {
        recentPlans: plans.length,
        fallbackRate: round(plannerFallbackRate),
        nodeExecutions: planExecutions.total,
        failedNodeExecutions: planExecutions.failed,
      },
    },
    {
      id: "triggers",
      name: "Triggers",
      status: triggerFailureRate > 0.2 ? "degraded" : "healthy",
      summary: `${triggers.active} active trigger(s), ${triggers.enqueuedEvents} enqueued event(s).`,
      metrics: {
        total: triggers.total,
        active: triggers.active,
        events: triggers.events,
        enqueuedEvents: triggers.enqueuedEvents,
        rejectedEvents: triggers.rejectedEvents,
        failedEvents: triggers.failedEvents,
        failureRate: round(triggerFailureRate),
      },
    },
    {
      id: "evaluations",
      name: "Evaluations",
      status: evals.latest && evals.latestPassRate < 1 ? "degraded" : "healthy",
      summary: evals.latest
        ? `Latest eval pass rate is ${Math.round(evals.latestPassRate * 100)}%.`
        : "No evaluation runs recorded yet.",
      metrics: {
        total: evals.total,
        latestPassRate: round(evals.latestPassRate),
        averageLatencyMs: evals.averageLatencyMs,
      },
    },
    {
      id: "tools",
      name: "Tools",
      status: toolFailureRate > 0.1 ? "degraded" : "healthy",
      summary: `${tools.total} tool execution(s), ${tools.byStatus.failed || 0} failed.`,
      metrics: {
        total: tools.total,
        failed: tools.byStatus.failed || 0,
        approvalRequired: tools.byStatus.approval_required || 0,
        failureRate: round(toolFailureRate),
      },
    },
    {
      id: "memory",
      name: "Memory",
      status: "healthy",
      summary: `${memory.total} memory record(s), ${agentRuns.consolidated.memories} learned item(s).`,
      metrics: {
        memories: memory.total,
        embedded: memory.embedded,
        agentRuns: agentRuns.total,
        consolidatedMemories: agentRuns.consolidated.memories,
      },
    },
    {
      id: "connectors",
      name: "Connectors",
      status: mcp.error + openapi.error > 0 ? "degraded" : "healthy",
      summary: `${mcp.error + openapi.error} connector error(s), ${mcp.toolCount + openapi.operationCount} active external tool(s).`,
      metrics: {
        mcpTotal: mcp.total,
        mcpErrors: mcp.error,
        openApiTotal: openapi.total,
        openApiErrors: openapi.error,
        externalTools: mcp.toolCount + openapi.operationCount,
      },
    },
  ];
  const incidents = deriveIncidents(components);
  const metrics = {
    queueMaxAgeMs,
    workflowCompletionRate: round(workflowCompletionRate),
    evalPassRate: round(evals.latestPassRate),
    plannerFallbackRate: round(plannerFallbackRate),
    toolFailureRate: round(toolFailureRate),
    triggerFailureRate: round(triggerFailureRate),
    staleWorkflowCount: workflowHealth.staleRunnable,
    recentUnhandledWorkflowFailures: workflowHealth.recentUnhandledFailures,
    recoveredWorkflowFailures: workflowHealth.recoveredTerminalFailures,
    failedWorkflowCount: workflowHealth.totalFailedWorkflows,
    connectorErrors: mcp.error + openapi.error,
    recoveryActions: recoveryActions.filter((action) => action.status === "completed").length,
  };
  const record: SystemHealthRecord = {
    id: randomUUID(),
    status: overallStatus(components),
    scope: input.scope || (input.repair ? "repair" : "diagnostics"),
    components,
    metrics,
    incidents,
    recoveryActions,
    latencyMs: Date.now() - startedAt,
    createdAt: new Date().toISOString(),
  };

  const saved = await saveHealthCheck(record);
  await syncIncidentsFromHealthCheck(saved).catch((error) => {
    console.warn("Incident sync failed.", error instanceof Error ? error.message : error);
  });
  return saved;
}

export async function getLatestHealthChecks(limit = 20) {
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_system_health_checks
      ORDER BY created_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(healthCheckFromRow);
  }

  const ledger = await readHealthLedger();
  return ledger.checks.slice(0, boundedLimit);
}

export async function getHealthStats() {
  const checks = await getLatestHealthChecks(100);
  const latest = checks[0];
  const byStatus = checks.reduce<Record<string, number>>((acc, check) => {
    acc[check.status] = (acc[check.status] || 0) + 1;
    return acc;
  }, {});

  return {
    total: checks.length,
    byStatus,
    latest,
    latestStatus: latest?.status || "degraded",
    incidents: latest?.incidents.length || 0,
    recoveryActions: latest?.recoveryActions.filter((action) => action.status === "completed").length || 0,
  };
}

async function checkDatabase() {
  if (!hasDatabaseUrl()) {
    return { ok: false, latencyMs: 0, error: "DATABASE_URL is not configured." };
  }
  const startedAt = Date.now();
  try {
    await ensureDatabaseSchema();
    await getSql()`SELECT 1 AS ok`;
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Database check failed.",
    };
  }
}

export function summarizeWorkflowHealth(
  workflows: Pick<WorkflowStats, "byStatus">,
  workflowRows: WorkflowRunRecord[],
  now = Date.now(),
  options: { staleWorkflowMs?: number; failureWarnMs?: number } = {},
): WorkflowHealthSummary {
  const staleThresholdMs = options.staleWorkflowMs ?? staleWorkflowMs;
  const failureWarnThresholdMs = options.failureWarnMs ?? workflowFailureWarnMs;
  const staleRunnable = workflowRows.filter((run) => isStaleWorkflow(run, now, staleThresholdMs));
  const sampledFailedWorkflows = workflowRows.filter((run) => run.status === "failed");
  const recoveredTerminalFailures = sampledFailedWorkflows.filter(isRecoveryTerminalFailure);
  const recentUnhandledFailures = sampledFailedWorkflows.filter((run) =>
    !isRecoveryTerminalFailure(run) && timestampAgeMs(run.updatedAt, now) <= failureWarnThresholdMs
  );
  const status: HealthStatus = staleRunnable.length > 0 || recentUnhandledFailures.length > 0 ? "degraded" : "healthy";

  return {
    status,
    staleRunnable: staleRunnable.length,
    recentUnhandledFailures: recentUnhandledFailures.length,
    recoveredTerminalFailures: recoveredTerminalFailures.length,
    sampledFailedWorkflows: sampledFailedWorkflows.length,
    totalFailedWorkflows: workflows.byStatus.failed || 0,
    staleWorkflowMs: staleThresholdMs,
    failureWarnMs: failureWarnThresholdMs,
    degradedReason: staleRunnable.length > 0
      ? "Stale queued or running workflows require recovery."
      : recentUnhandledFailures.length > 0
        ? "Recent unrecovered workflow failures require operator review."
        : undefined,
  };
}

function isStaleWorkflow(run: { status: string; updatedAt: string }, now = Date.now(), thresholdMs = staleWorkflowMs) {
  return ["queued", "running"].includes(run.status) && timestampAgeMs(run.updatedAt, now) > thresholdMs;
}

function isRecoveryTerminalFailure(run: WorkflowRunRecord) {
  return run.status === "failed" && recoveryTerminalFailurePrefixes.some((prefix) => run.error?.startsWith(prefix));
}

function timestampAgeMs(value: string, now = Date.now()) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : Number.POSITIVE_INFINITY;
}

function maxQueuedAge(jobs: Array<{ status: string; runAt: string }>) {
  const ages = jobs
    .filter((job) => job.status === "queued")
    .map((job) => Math.max(0, Date.now() - Date.parse(job.runAt)));
  return ages.length ? Math.max(...ages) : 0;
}

function deriveIncidents(components: HealthComponent[]): HealthIncident[] {
  return components
    .filter((component) => component.status !== "healthy")
    .map((component) => ({
      id: `${component.id}.${component.status}`,
      componentId: component.id,
      severity: component.status === "unhealthy" ? "critical" : "warning",
      message: component.summary,
      metadata: component.metrics,
    }));
}

function overallStatus(components: HealthComponent[]): HealthStatus {
  if (components.some((component) => component.status === "unhealthy")) {
    return "unhealthy";
  }
  if (components.some((component) => component.status === "degraded")) {
    return "degraded";
  }
  return "healthy";
}

async function saveHealthCheck(record: SystemHealthRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_system_health_checks (
        id, status, scope, components, metrics, incidents, recovery_actions,
        latency_ms, created_at
      )
      VALUES (
        ${record.id}, ${record.status}, ${record.scope},
        ${JSON.stringify(record.components)}::jsonb,
        ${JSON.stringify(record.metrics)}::jsonb,
        ${JSON.stringify(record.incidents)}::jsonb,
        ${JSON.stringify(record.recoveryActions)}::jsonb,
        ${record.latencyMs}, ${record.createdAt}
      )
    `;
    return record;
  }

  await mutateHealthLedger((ledger) => {
    ledger.checks = [record, ...ledger.checks.filter((check) => check.id !== record.id)];
    return trimHealthLedger(ledger);
  });
  return record;
}

async function readHealthLedger() {
  return readJsonFile<HealthLedger>(getHealthFile(), { checks: [] });
}

async function mutateHealthLedger(mutator: (ledger: HealthLedger) => HealthLedger) {
  healthFileWriteQueue = healthFileWriteQueue.then(
    async () => {
      const ledger = mutator(await readHealthLedger());
      await writeHealthLedger(ledger);
    },
    async () => {
      const ledger = mutator(await readHealthLedger());
      await writeHealthLedger(ledger);
    },
  );
  await healthFileWriteQueue;
}

async function writeHealthLedger(ledger: HealthLedger) {
  await writeJsonFile(getHealthFile(), trimHealthLedger(ledger));
}

function trimHealthLedger(ledger: HealthLedger): HealthLedger {
  return {
    checks: ledger.checks.slice(0, 500),
  };
}

function healthCheckFromRow(row: Record<string, unknown>): SystemHealthRecord {
  return {
    id: String(row.id),
    status: normalizeHealthStatus(row.status),
    scope: normalizeScope(row.scope),
    components: parseArray(row.components) as HealthComponent[],
    metrics: parseObject(row.metrics) || {},
    incidents: parseArray(row.incidents) as HealthIncident[],
    recoveryActions: parseArray(row.recovery_actions) as RecoveryAction[],
    latencyMs: Number(row.latency_ms || 0),
    createdAt: normalizeDate(row.created_at),
  };
}

function normalizeHealthStatus(value: unknown): HealthStatus {
  const status = String(value || "degraded");
  return status === "healthy" || status === "unhealthy" ? status : "degraded";
}

function normalizeScope(value: unknown): SystemHealthRecord["scope"] {
  const scope = String(value || "diagnostics");
  return scope === "health" || scope === "repair" ? scope : "diagnostics";
}

function parseArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseObject(value: unknown): Record<string, number | string | boolean | undefined> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, number | string | boolean | undefined>;
  }
  return undefined;
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function getHealthFile() {
  return getDataPath("system-health.json");
}
