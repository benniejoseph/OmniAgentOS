"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Cable,
  CheckCircle2,
  Database,
  FileText,
  GitBranch,
  Layers3,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Workflow,
  Wrench,
  XCircle,
} from "lucide-react";
import { clsx } from "clsx";
import type { NavIcon } from "@/lib/navigation";

export type DomainConsoleKey =
  | "knowledge"
  | "workflows"
  | "approvals"
  | "integrations"
  | "tools"
  | "evaluations"
  | "monitoring"
  | "security"
  | "settings";

type JsonRecord = Record<string, unknown>;
type FormValue = string | boolean;

type EndpointConfig = {
  key: string;
  label: string;
  path: string;
};

type ResourceState = {
  status: "idle" | "loading" | "ready" | "error";
  data?: unknown;
  error?: string;
  code?: number;
};

type MetricConfig = {
  label: string;
  description: string;
  value: (data: DomainData) => string;
  tone?: "neutral" | "success" | "warning" | "danger";
};

type Row = {
  title: string;
  status?: string;
  meta?: string;
  time?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
};

type DataSection = {
  title: string;
  description: string;
  emptyLabel: string;
  rows: (data: DomainData) => Row[];
};

type FlowStep = {
  title: string;
  body: string;
  icon: NavIcon;
};

type ActionField = {
  name: string;
  label: string;
  type: "text" | "textarea" | "select" | "checkbox" | "json";
  placeholder?: string;
  defaultValue?: FormValue;
  options?: { label: string; value: string }[];
};

type DomainAction = {
  id: string;
  title: string;
  description: string;
  method: "GET" | "POST";
  path: string;
  fields: ActionField[];
  buildPayload?: (values: Record<string, FormValue>) => JsonRecord | undefined;
};

type DomainConfig = {
  title: string;
  eyebrow: string;
  description: string;
  icon: NavIcon;
  endpoints: EndpointConfig[];
  metrics: MetricConfig[];
  flow: FlowStep[];
  sections: DataSection[];
  actions: DomainAction[];
};

type DomainData = Record<string, unknown>;

type ActionResult = {
  title: string;
  status: "success" | "error";
  message: string;
  data?: unknown;
};

const modeOptions = [
  { label: "Orchestrate", value: "orchestrate" },
  { label: "Research", value: "research" },
  { label: "Execute", value: "execute" },
  { label: "Learn", value: "learn" },
];

const riskOptions = [
  { label: "0 - read-only", value: "0" },
  { label: "1 - reversible", value: "1" },
  { label: "2 - external side effect", value: "2" },
  { label: "3 - high impact", value: "3" },
];

const authOptions = [
  { label: "No auth", value: "none" },
  { label: "Bearer token env", value: "bearer_env" },
];

const ActivityIcon = Layers3;

const memoryTypeOptions = ["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"].map((value) => ({ label: value, value }));
const safetyModeOptions = ["read_only", "synthetic", "mutation_allowed"].map((value) => ({ label: value.replace(/_/g, " "), value }));

const workflowGoalFields: ActionField[] = [
  { name: "goal", label: "Goal", type: "textarea", placeholder: "Investigate connector failures and create a remediation plan." },
  { name: "mode", label: "Mode", type: "select", defaultValue: "orchestrate", options: modeOptions },
  { name: "requireApproval", label: "Require approval", type: "checkbox", defaultValue: true },
];

const workflowPlanAction: DomainAction = {
  id: "preview-plan",
  title: "Preview plan",
  description: "Generate a typed workflow plan with policy and risk metadata before execution.",
  method: "POST",
  path: "/api/workflows/plan",
  fields: workflowGoalFields,
  buildPayload: workflowPayload,
};

const domainConfigs: Record<DomainConsoleKey, DomainConfig> = {
  knowledge: {
    title: "Knowledge",
    eyebrow: "Memory, RAG, provenance",
    description: "Operate the context layer: durable memories, document chunks, retrieval traces, graph recall, and source-backed evidence for agent work.",
    icon: Brain,
    endpoints: [
      { key: "capabilities", label: "Capability stats", path: "/api/capabilities" },
      { key: "memory", label: "Durable memories", path: "/api/memory?limit=12" },
      { key: "knowledge", label: "Knowledge documents", path: "/api/knowledge?limit=12" },
      { key: "graph", label: "Memory graph", path: "/api/memory/graph?limit=12" },
      { key: "retrieval", label: "Retrieval traces", path: "/api/retrieval/plan?limit=12" },
    ],
    metrics: [
      { label: "Memories", description: "Saved long-term records", value: (data) => numberPath(data, "capabilities.memory.total") },
      { label: "Documents", description: "Indexed knowledge sources", value: (data) => numberPath(data, "capabilities.knowledge.documents") },
      { label: "Graph nodes", description: "Entity and concept graph", value: (data) => numberPath(data, "capabilities.memoryGraph.nodes") },
      { label: "Retrieval traces", description: "Auditable context packs", value: (data) => numberPath(data, "capabilities.contextEngine.traces") },
    ],
    flow: [
      { title: "Capture", body: "Save decisions, facts, procedures, and raw documents.", icon: FileText },
      { title: "Index", body: "Chunk, embed, tag, and connect the sources to graph nodes.", icon: Database },
      { title: "Retrieve", body: "Test evidence packs before a run touches tools or workflows.", icon: Search },
      { title: "Consolidate", body: "Promote useful run output back into durable memory.", icon: Brain },
    ],
    sections: [
      {
        title: "Recent memories",
        description: "Durable facts, decisions, tasks, and procedures available to the agent.",
        emptyLabel: "No memories found. Add the first durable memory from the actions panel.",
        rows: (data) =>
          arrayPath(data, "memory.memories").map((item) => ({
            title: stringValue(item.title, "Untitled memory"),
            status: stringValue(item.type, "memory"),
            meta: tagsValue(item.tags),
            time: stringValue(item.updatedAt || item.createdAt),
          })),
      },
      {
        title: "Knowledge documents",
        description: "Documents and chunks indexed for source-backed RAG.",
        emptyLabel: "No documents indexed yet. Ingest a policy, guide, source note, or run report.",
        rows: (data) =>
          arrayPath(data, "knowledge.documents").map((item) => ({
            title: stringValue(item.title, "Untitled document"),
            status: `${stringValue(item.chunkCount, "0")} chunks`,
            meta: tagsValue(item.tags) || stringValue(item.sourceType, "source"),
            time: stringValue(item.updatedAt || item.createdAt),
          })),
      },
      {
        title: "Graph recall",
        description: "Top graph concepts and relationships extracted from memories and retrieval traces.",
        emptyLabel: "The graph has no nodes yet. Rebuild it after memory or retrieval activity.",
        rows: (data) =>
          arrayPath(data, "graph.nodes").map((item) => ({
            title: stringValue(item.label, "Graph node"),
            status: stringValue(item.kind, "node"),
            meta: `${stringValue(item.sourceCount, "0")} sources`,
            time: stringValue(item.updatedAt || item.createdAt),
          })),
      },
    ],
    actions: [
      {
        id: "add-memory",
        title: "Save memory",
        description: "Add one durable fact, decision, task, or procedure to long-term recall.",
        method: "POST",
        path: "/api/memory",
        fields: [
          { name: "title", label: "Title", type: "text", placeholder: "Release checklist owner" },
          { name: "type", label: "Type", type: "select", defaultValue: "knowledge", options: memoryTypeOptions },
          { name: "tags", label: "Tags", type: "text", placeholder: "release, owner, policy" },
          { name: "content", label: "Content", type: "textarea", placeholder: "Write the reusable context the agent should remember." },
        ],
        buildPayload: (values) => ({
          title: textValue(values.title),
          type: textValue(values.type, "knowledge"),
          tags: commaList(values.tags),
          content: textValue(values.content),
          importance: 0.78,
        }),
      },
      {
        id: "ingest-document",
        title: "Ingest document",
        description: "Create indexed chunks for RAG and provenance-backed retrieval.",
        method: "POST",
        path: "/api/ingest",
        fields: [
          { name: "title", label: "Document title", type: "text", placeholder: "Production release policy" },
          { name: "source", label: "Source", type: "text", placeholder: "manual://release-policy" },
          { name: "tags", label: "Tags", type: "text", placeholder: "release, policy" },
          { name: "content", label: "Content", type: "textarea", placeholder: "Paste the content to index." },
        ],
        buildPayload: (values) => ({
          title: textValue(values.title),
          source: textValue(values.source, "manual"),
          sourceType: "manual",
          tags: commaList(values.tags),
          content: textValue(values.content),
        }),
      },
      {
        id: "test-retrieval",
        title: "Test retrieval",
        description: "Build a context pack and persist the trace so it can be audited later.",
        method: "POST",
        path: "/api/retrieval/plan",
        fields: [
          { name: "query", label: "Question or goal", type: "textarea", placeholder: "What evidence is needed before releasing a workflow?" },
          { name: "limit", label: "Limit", type: "select", defaultValue: "8", options: ["4", "8", "12", "16", "24"].map((value) => ({ label: value, value })) },
        ],
        buildPayload: (values) => ({ query: textValue(values.query), limit: numberValue(values.limit, 8), persistTrace: true }),
      },
      {
        id: "rebuild-graph",
        title: "Rebuild graph",
        description: "Re-index memories and traces into a navigable recall graph.",
        method: "POST",
        path: "/api/memory/graph",
        fields: [
          { name: "source", label: "Build source", type: "text", defaultValue: "operator.console" },
          { name: "memoryLimit", label: "Memory limit", type: "select", defaultValue: "200", options: ["50", "100", "200", "500"].map((value) => ({ label: value, value })) },
        ],
        buildPayload: (values) => ({ source: textValue(values.source, "operator.console"), memoryLimit: numberValue(values.memoryLimit, 200) }),
      },
    ],
  },
  workflows: {
    title: "Workflows",
    eyebrow: "Durable plans, queues, triggers",
    description: "Turn goals into durable work that can be planned, queued, approved, retried, ticked, recovered, and audited.",
    icon: Workflow,
    endpoints: [
      { key: "workflows", label: "Workflow runs", path: "/api/workflows?limit=16" },
      { key: "plans", label: "Workflow plans", path: "/api/workflows/plan?limit=12" },
      { key: "triggers", label: "Triggers", path: "/api/triggers?limit=12" },
      { key: "operations", label: "Operations overview", path: "/api/operations" },
    ],
    metrics: [
      { label: "Active", description: "Runnable or running workflows", value: (data) => numberPath(data, "workflows.stats.active"), tone: "success" },
      { label: "Waiting", description: "Paused at approval gates", value: (data) => numberPath(data, "workflows.stats.waitingApproval"), tone: "warning" },
      { label: "Queue jobs", description: "Runnable operation jobs", value: (data) => numberPath(data, "operations.summary.runnableJobs") },
      { label: "Triggers", description: "Configured automation triggers", value: (data) => numberPath(data, "triggers.stats.total") },
    ],
    flow: [
      { title: "Plan", body: "Decompose a goal into policy-aware nodes and acceptance criteria.", icon: GitBranch },
      { title: "Start", body: "Create a workflow run with approval and retry posture.", icon: Play },
      { title: "Tick", body: "Lease queue work and advance runnable nodes.", icon: RefreshCw },
      { title: "Recover", body: "Inspect stale work, expired leases, and failed executions.", icon: ShieldCheck },
    ],
    sections: [
      {
        title: "Live workflow runs",
        description: "Current and recent durable executions.",
        emptyLabel: "No workflow runs yet. Start one from the action panel.",
        rows: (data) =>
          arrayPath(data, "workflows.runs").map((item) => ({
            title: stringValue(item.goal, "Workflow run"),
            status: stringValue(item.status, "unknown"),
            meta: stringValue(item.currentStep, "preflight"),
            time: stringValue(item.updatedAt || item.createdAt),
            tone: toneForStatus(item.status),
          })),
      },
      {
        title: "Generated plans",
        description: "AI or deterministic plans with risk, confidence, and policy validation.",
        emptyLabel: "No plans generated yet. Preview a plan before starting a run.",
        rows: (data) =>
          arrayPath(data, "plans.plans").map((item) => ({
            title: stringValue(item.goal, "Workflow plan"),
            status: `risk ${stringValue(item.highestRiskLevel, "0")}`,
            meta: `confidence ${stringValue(item.confidence, "0")}`,
            time: stringValue(item.updatedAt || item.createdAt),
            tone: numberValue(item.highestRiskLevel, 0) > 1 ? "warning" : "neutral",
          })),
      },
      {
        title: "Triggers",
        description: "External events that can create workflows from templates.",
        emptyLabel: "No triggers configured. Add one when a workflow should run from an external signal.",
        rows: (data) =>
          arrayPath(data, "triggers.triggers").map((item) => ({
            title: stringValue(item.name, "Workflow trigger"),
            status: stringValue(item.status, "unknown"),
            meta: stringValue(item.source, "manual"),
            time: stringValue(item.updatedAt || item.createdAt),
            tone: toneForStatus(item.status),
          })),
      },
    ],
    actions: [
      workflowPlanAction,
      {
        id: "start-workflow",
        title: "Start workflow",
        description: "Create a durable run and enqueue the first tick.",
        method: "POST",
        path: "/api/workflows",
        fields: workflowGoalFields,
        buildPayload: workflowPayload,
      },
      {
        id: "tick-queue",
        title: "Tick queue",
        description: "Process a small batch of workflow jobs and optionally run SLO checks.",
        method: "POST",
        path: "/api/workflows/tick",
        fields: [
          { name: "limit", label: "Queue limit", type: "select", defaultValue: "5", options: ["1", "3", "5", "10"].map((value) => ({ label: value, value })) },
          { name: "slo", label: "Run SLO monitor", type: "checkbox", defaultValue: true },
          { name: "alerts", label: "Dispatch alerts", type: "checkbox", defaultValue: false },
        ],
        buildPayload: (values) => ({ limit: numberValue(values.limit, 5), slo: Boolean(values.slo), alerts: Boolean(values.alerts) }),
      },
      {
        id: "inspect-recovery",
        title: "Inspect recovery",
        description: "Find stale workflows, expired leases, and queue repair candidates.",
        method: "POST",
        path: "/api/operations",
        fields: [{ name: "limit", label: "Limit", type: "select", defaultValue: "10", options: ["5", "10", "20", "50"].map((value) => ({ label: value, value })) }],
        buildPayload: (values) => ({ action: "inspect_recovery", limit: numberValue(values.limit, 10) }),
      },
    ],
  },
  approvals: {
    title: "Approvals",
    eyebrow: "Human control queue",
    description: "Review risky tool calls, workflow gates, and SLO policy changes with payload, reason, risk, and audit context.",
    icon: CheckCircle2,
    endpoints: [
      { key: "approvals", label: "Approval queue", path: "/api/approvals?limit=25" },
      { key: "operations", label: "Operations context", path: "/api/operations" },
    ],
    metrics: [
      { label: "Total pending", description: "All approval types", value: (data) => numberPath(data, "approvals.stats.total"), tone: "warning" },
      { label: "Tools", description: "Tool executions waiting", value: (data) => numberPath(data, "approvals.stats.tools") },
      { label: "Workflows", description: "Workflow gates waiting", value: (data) => numberPath(data, "approvals.stats.workflows") },
      { label: "SLO policy", description: "Policy changes waiting", value: (data) => numberPath(data, "approvals.stats.sloPolicies") },
    ],
    flow: [
      { title: "Inspect payload", body: "Understand the exact side effect and the requester reason.", icon: Search },
      { title: "Check risk", body: "Review risk level, tenant, actor, and policy source.", icon: AlertTriangle },
      { title: "Decide", body: "Approve only when the evidence and ticket justify the action.", icon: CheckCircle2 },
      { title: "Audit", body: "Every decision is written back to the execution ledger.", icon: FileText },
    ],
    sections: [
      {
        title: "Approval queue",
        description: "Items blocking execution until an operator decides.",
        emptyLabel: "No approvals are pending.",
        rows: approvalRows,
      },
      {
        title: "Operational blockers",
        description: "Related live risks that may influence the approval decision.",
        emptyLabel: "No operational blockers found.",
        rows: (data) => [
          metricRow("Pending approvals", numberPath(data, "operations.summary.pendingApprovals"), "warning"),
          metricRow("Connector errors", numberPath(data, "operations.summary.connectorErrors"), "danger"),
          metricRow("Stale workflows", numberPath(data, "operations.summary.staleWorkflows"), "warning"),
          metricRow("Failed tools", numberPath(data, "operations.summary.failedTools"), "danger"),
        ],
      },
    ],
    actions: [],
  },
  integrations: {
    title: "Integrations",
    eyebrow: "MCP, OpenAPI, connection catalog",
    description: "Connect external systems safely, discover operations, classify risk, and keep connector health visible before tools can use them.",
    icon: Cable,
    endpoints: [
      { key: "connectors", label: "MCP connectors", path: "/api/connectors" },
      { key: "openapi", label: "OpenAPI connectors", path: "/api/openapi-connectors" },
      { key: "catalog", label: "Connection catalog", path: "/api/connection-catalog" },
      { key: "tools", label: "Discovered tools", path: "/api/tools" },
    ],
    metrics: [
      { label: "MCP active", description: "Active MCP connectors", value: (data) => numberPath(data, "connectors.stats.active") },
      { label: "OpenAPI", description: "Imported REST connectors", value: (data) => numberPath(data, "openapi.stats.total") },
      { label: "Catalog", description: "Available templates", value: (data) => numberPath(data, "catalog.stats.total") },
      { label: "Tools", description: "Governed operations", value: (data) => arrayPath(data, "tools.tools").length.toString() },
    ],
    flow: [
      { title: "Choose", body: "Start from catalog, MCP endpoint, or OpenAPI spec.", icon: Database },
      { title: "Register", body: "Validate URLs, secret env references, and auth type.", icon: Cable },
      { title: "Discover", body: "Import available operations and suggested policies.", icon: Search },
      { title: "Govern", body: "Send operations to the Tool Catalog for risk and approval policy.", icon: Wrench },
    ],
    sections: [
      {
        title: "MCP connectors",
        description: "Registered Model Context Protocol servers and discovered tools.",
        emptyLabel: "No MCP connectors registered.",
        rows: (data) =>
          arrayPath(data, "connectors.connectors").map((item) => ({
            title: stringValue(item.name, "MCP connector"),
            status: stringValue(item.status, "unknown"),
            meta: stringValue(item.endpoint, "endpoint"),
            time: stringValue(item.updatedAt || item.createdAt),
            tone: toneForStatus(item.status),
          })),
      },
      {
        title: "OpenAPI connectors",
        description: "REST APIs imported as governed operations.",
        emptyLabel: "No OpenAPI connectors imported.",
        rows: (data) =>
          arrayPath(data, "openapi.connectors").map((item) => ({
            title: stringValue(item.name, "OpenAPI connector"),
            status: stringValue(item.status, "unknown"),
            meta: stringValue(item.baseUrl || item.specUrl, "base URL"),
            time: stringValue(item.updatedAt || item.createdAt),
            tone: toneForStatus(item.status),
          })),
      },
      {
        title: "Catalog suggestions",
        description: "Potential systems to connect next.",
        emptyLabel: "No catalog entries loaded.",
        rows: (data) =>
          arrayPath(data, "catalog.connectors").map((item) => ({
            title: stringValue(item.name, "Connector"),
            status: stringValue(item.status, "planned"),
            meta: stringValue(item.adapter, "adapter"),
            tone: stringValue(item.status) === "planned" ? "neutral" : "success",
          })),
      },
    ],
    actions: [
      {
        id: "register-mcp",
        title: "Register MCP connector",
        description: "Add a governed MCP endpoint and optionally discover its tools.",
        method: "POST",
        path: "/api/connectors",
        fields: [
          { name: "name", label: "Name", type: "text", placeholder: "Internal knowledge MCP" },
          { name: "endpoint", label: "Endpoint", type: "text", placeholder: "https://example.com/mcp" },
          { name: "authType", label: "Auth", type: "select", defaultValue: "none", options: authOptions },
          { name: "authTokenEnv", label: "Token env", type: "text", placeholder: "OMNIAGENT_CONNECTOR_TOKEN" },
          { name: "defaultRiskLevel", label: "Default risk", type: "select", defaultValue: "2", options: riskOptions },
          { name: "discover", label: "Discover tools now", type: "checkbox", defaultValue: true },
        ],
        buildPayload: (values) => ({
          name: textValue(values.name),
          endpoint: textValue(values.endpoint),
          authType: textValue(values.authType, "none"),
          authTokenEnv: optionalText(values.authTokenEnv),
          defaultRiskLevel: numberValue(values.defaultRiskLevel, 2),
          approvalRequired: numberValue(values.defaultRiskLevel, 2) >= 2,
          discover: Boolean(values.discover),
        }),
      },
      {
        id: "register-openapi",
        title: "Import OpenAPI",
        description: "Turn a public OpenAPI spec into governed operations.",
        method: "POST",
        path: "/api/openapi-connectors",
        fields: [
          { name: "name", label: "Name", type: "text", placeholder: "CRM API" },
          { name: "specUrl", label: "Spec URL", type: "text", placeholder: "https://example.com/openapi.json" },
          { name: "baseUrl", label: "Base URL override", type: "text", placeholder: "https://api.example.com" },
          { name: "authType", label: "Auth", type: "select", defaultValue: "none", options: authOptions },
          { name: "authTokenEnv", label: "Token env", type: "text", placeholder: "OMNIAGENT_CONNECTOR_CRM_TOKEN" },
          { name: "defaultRiskLevel", label: "Default risk", type: "select", defaultValue: "2", options: riskOptions },
        ],
        buildPayload: (values) => ({
          name: textValue(values.name),
          specUrl: optionalText(values.specUrl),
          baseUrl: optionalText(values.baseUrl),
          authType: textValue(values.authType, "none"),
          authTokenEnv: optionalText(values.authTokenEnv),
          defaultRiskLevel: numberValue(values.defaultRiskLevel, 2),
          approvalRequired: numberValue(values.defaultRiskLevel, 2) >= 2,
          importSpec: true,
        }),
      },
    ],
  },
  tools: {
    title: "Tool Catalog",
    eyebrow: "Risk, dry-run, execution audit",
    description: "Govern every capability the agent can call: source, input schema, risk level, approval requirement, dry-run support, and execution history.",
    icon: Wrench,
    endpoints: [
      { key: "tools", label: "Tool registry", path: "/api/tools" },
      { key: "approvals", label: "Approval queue", path: "/api/approvals?limit=12" },
    ],
    metrics: [
      { label: "Registered", description: "Active and planned tools", value: (data) => arrayPath(data, "tools.tools").length.toString() },
      { label: "Approval waits", description: "Tool approvals pending", value: (data) => numberPath(data, "approvals.stats.tools"), tone: "warning" },
      { label: "Failed", description: "Failed executions", value: (data) => numberPath(data, "tools.audits.byStatus.failed"), tone: "danger" },
      { label: "Dry runs", description: "Dry-run executions", value: (data) => numberPath(data, "tools.audits.byStatus.dry_run") },
    ],
    flow: [
      { title: "Discover", body: "Tools come from native registry, MCP, and OpenAPI imports.", icon: Search },
      { title: "Classify", body: "Risk levels decide dry-run and approval posture.", icon: ShieldCheck },
      { title: "Test", body: "Run safe preflight calls before side effects.", icon: Play },
      { title: "Audit", body: "Every input, decision, result, and actor is ledgered.", icon: FileText },
    ],
    sections: [
      {
        title: "Available tools",
        description: "Governed capabilities the agent can call.",
        emptyLabel: "No tools are registered.",
        rows: (data) =>
          arrayPath(data, "tools.tools").map((item) => ({
            title: stringValue(item.name || item.id, "Tool"),
            status: `risk ${stringValue(item.riskLevel, "0")}`,
            meta: `${stringValue(item.category, "tool")} / ${Boolean(item.approvalRequired) ? "approval" : "auto"}`,
            tone: numberValue(item.riskLevel, 0) >= 2 ? "warning" : "neutral",
          })),
      },
      {
        title: "Pending tool approvals",
        description: "Tool executions blocked by risk policy.",
        emptyLabel: "No tool approvals pending.",
        rows: (data) => approvalRows(data).filter((row) => row.meta?.includes("tool")),
      },
    ],
    actions: [
      {
        id: "dry-run-tool",
        title: "Tool dry run",
        description: "Execute a policy-safe dry run with explicit input JSON.",
        method: "POST",
        path: "/api/tools/execute",
        fields: [
          { name: "toolId", label: "Tool id", type: "text", placeholder: "memory.search" },
          { name: "input", label: "Input JSON", type: "json", defaultValue: "{}" },
        ],
        buildPayload: (values) => ({ toolId: textValue(values.toolId), input: parseJsonObject(values.input), dryRun: true }),
      },
    ],
  },
  evaluations: {
    title: "Evaluations",
    eyebrow: "Regression, reports, release gates",
    description: "Run safe evaluation suites, inspect case history, generate signed evidence, and understand release blockers before production changes.",
    icon: CheckCircle2,
    endpoints: [
      { key: "evaluations", label: "Evaluation runs", path: "/api/evaluations?limit=12" },
      { key: "release", label: "Release evidence", path: "/api/release/evidence" },
      { key: "isolation", label: "Tenant isolation", path: "/api/security/isolation-report" },
    ],
    metrics: [
      { label: "Eval runs", description: "Recorded suite executions", value: (data) => numberPath(data, "evaluations.stats.total") },
      { label: "Cases", description: "Available regression cases", value: (data) => arrayPath(data, "evaluations.cases").length.toString() },
      { label: "Release gate", description: "Current production readiness", value: (data) => stringPath(data, "release.report.releaseGate.status", "unknown"), tone: "success" },
      { label: "Isolation", description: "Tenant data boundary proof", value: (data) => stringPath(data, "isolation.report.status", "unknown") },
    ],
    flow: [
      { title: "Select", body: "Choose cases by safety mode, suite, or release gate.", icon: Search },
      { title: "Run", body: "Execute tests with governance checks and mutation controls.", icon: Play },
      { title: "Sign", body: "Generate report hash, signature, and evidence payload.", icon: FileText },
      { title: "Gate", body: "Promote only when release blockers are clear.", icon: ShieldCheck },
    ],
    sections: [
      {
        title: "Evaluation runs",
        description: "Recent test suites and their summaries.",
        emptyLabel: "No evaluation runs recorded.",
        rows: (data) =>
          arrayPath(data, "evaluations.runs").map((item) => ({
            title: stringValue(item.suite, "Evaluation suite"),
            status: stringValue(item.status, "unknown"),
            meta: summaryValue(item.summary),
            time: stringValue(item.completedAt || item.createdAt),
            tone: toneForStatus(item.status),
          })),
      },
      {
        title: "Release gate",
        description: "Current signed production readiness posture.",
        emptyLabel: "Release evidence is not available.",
        rows: (data) => releaseRows(data),
      },
      {
        title: "Cases",
        description: "Available evaluation cases and governance modes.",
        emptyLabel: "No cases loaded.",
        rows: (data) =>
          arrayPath(data, "evaluations.cases").map((item) => ({
            title: stringValue(item.name || item.id, "Evaluation case"),
            status: stringValue(item.safetyMode || item.maxSafetyMode, "safe"),
            meta: stringValue(item.category || item.description, "case"),
          })),
      },
    ],
    actions: [
      {
        id: "run-evals",
        title: "Run safe suite",
        description: "Run the default safe evaluation suite without mutation override.",
        method: "POST",
        path: "/api/evaluations",
        fields: [
          { name: "suite", label: "Suite name", type: "text", defaultValue: "operator-console" },
          { name: "maxSafetyMode", label: "Safety mode", type: "select", defaultValue: "synthetic", options: safetyModeOptions },
        ],
        buildPayload: (values) => ({ suite: textValue(values.suite, "operator-console"), maxSafetyMode: textValue(values.maxSafetyMode, "synthetic") }),
      },
    ],
  },
  monitoring: {
    title: "Monitoring",
    eyebrow: "Events, SLOs, incidents, alerts",
    description: "Operate reliability from runtime events, SLO snapshots, incidents, alert routing, diagnostics, and correlated workflow evidence.",
    icon: Layers3,
    endpoints: [
      { key: "observability", label: "Runtime events", path: "/api/observability?limit=24" },
      { key: "slo", label: "SLO snapshot", path: "/api/observability/slo" },
      { key: "incidents", label: "Incidents", path: "/api/incidents?status=active&limit=12" },
      { key: "alerts", label: "Alerts", path: "/api/alerts?limit=12" },
    ],
    metrics: [
      { label: "Events", description: "Runtime event count", value: (data) => numberPath(data, "observability.stats.total") },
      { label: "SLO", description: "Healthy policy snapshot", value: (data) => booleanLabel(readPath(data, "slo.healthy"), "healthy", "breach"), tone: "success" },
      { label: "Breaches", description: "Current SLO breaches", value: (data) => arrayPath(data, "slo.breaches").length.toString(), tone: "warning" },
      { label: "Incidents", description: "Open or acknowledged", value: (data) => numberPath(data, "incidents.stats.active"), tone: "danger" },
    ],
    flow: [
      { title: "Capture", body: "Collect runtime events with route, category, request, and correlation IDs.", icon: Database },
      { title: "Evaluate", body: "Run SLO policy checks and detect failure-budget pressure.", icon: ActivityIcon },
      { title: "Escalate", body: "Open incidents and queue alerts when production risk rises.", icon: AlertTriangle },
      { title: "Resolve", body: "Close the loop with diagnostics, recovery, and audit evidence.", icon: CheckCircle2 },
    ],
    sections: [
      {
        title: "Runtime timeline",
        description: "Recent production events and failures.",
        emptyLabel: "No observability events found.",
        rows: (data) =>
          arrayPath(data, "observability.events").map((item) => ({
            title: stringValue(item.message || item.action, "Runtime event"),
            status: stringValue(item.level, "info"),
            meta: `${stringValue(item.category, "system")} / ${stringValue(item.route, "route")}`,
            time: stringValue(item.createdAt),
            tone: toneForStatus(item.level),
          })),
      },
      {
        title: "SLO breaches",
        description: "Current policy breaches and reliability pressure.",
        emptyLabel: "No SLO breaches detected.",
        rows: (data) =>
          arrayPath(data, "slo.breaches").map((item) => ({
            title: stringValue(item.policyName || item.policyId, "SLO breach"),
            status: stringValue(item.severity, "warning"),
            meta: stringValue(item.reason || item.message, "policy"),
            tone: "warning",
          })),
      },
      {
        title: "Incidents",
        description: "Active incidents and alert targets.",
        emptyLabel: "No active incidents.",
        rows: (data) =>
          arrayPath(data, "incidents.incidents").map((item) => ({
            title: stringValue(item.title || item.summary, "Incident"),
            status: stringValue(item.status, "open"),
            meta: stringValue(item.severity, "severity"),
            time: stringValue(item.updatedAt || item.createdAt),
            tone: toneForStatus(item.status),
          })),
      },
    ],
    actions: [
      {
        id: "run-slo",
        title: "Run SLO monitor",
        description: "Evaluate SLO policies, queue alerts, and optionally dispatch notifications.",
        method: "POST",
        path: "/api/observability/slo",
        fields: [
          { name: "queueAlerts", label: "Queue alerts", type: "checkbox", defaultValue: true },
          { name: "dispatchAlerts", label: "Dispatch alerts", type: "checkbox", defaultValue: false },
        ],
        buildPayload: (values) => ({ action: "run_monitor", queueAlerts: Boolean(values.queueAlerts), dispatchAlerts: Boolean(values.dispatchAlerts) }),
      },
      {
        id: "record-marker",
        title: "Record marker",
        description: "Add an operator marker to the runtime timeline.",
        method: "POST",
        path: "/api/observability",
        fields: [
          { name: "message", label: "Marker", type: "textarea", placeholder: "Investigating connector latency after release gate run." },
          { name: "level", label: "Level", type: "select", defaultValue: "info", options: ["info", "warn", "error"].map((value) => ({ label: value, value })) },
          { name: "category", label: "Category", type: "select", defaultValue: "system", options: ["system", "workflow", "connector", "security", "evaluation"].map((value) => ({ label: value, value })) },
        ],
        buildPayload: (values) => ({
          action: "record_marker",
          message: textValue(values.message),
          level: textValue(values.level, "info"),
          category: textValue(values.category, "system"),
        }),
      },
    ],
  },
  security: {
    title: "Security",
    eyebrow: "Tenant isolation, RBAC, audit",
    description: "Inspect tenant context, RBAC rules, policy decisions, audit records, network and secret guardrails, and isolation evidence.",
    icon: ShieldCheck,
    endpoints: [
      { key: "context", label: "Security context", path: "/api/security/context" },
      { key: "audits", label: "Security audit", path: "/api/security/audits?limit=24" },
      { key: "isolation", label: "Isolation report", path: "/api/security/isolation-report" },
      { key: "release", label: "Release evidence", path: "/api/release/evidence" },
    ],
    metrics: [
      { label: "Role", description: "Current operator role", value: (data) => stringPath(data, "context.context.role", "unknown") },
      { label: "Tenant", description: "Current tenant scope", value: (data) => stringPath(data, "context.context.tenantId", "unknown") },
      { label: "Audits", description: "Security audit records", value: (data) => numberPath(data, "audits.stats.total") },
      { label: "Isolation", description: "Tenant isolation report", value: (data) => stringPath(data, "isolation.report.status", "unknown") },
    ],
    flow: [
      { title: "Authenticate", body: "Resolve session, tenant, role, and actor context.", icon: ShieldCheck },
      { title: "Authorize", body: "Apply RBAC action policy before sensitive API work.", icon: CheckCircle2 },
      { title: "Scope", body: "Set tenant-aware database access and row-level boundaries.", icon: Database },
      { title: "Audit", body: "Record allow, deny, trusted smoke, and operator actions.", icon: FileText },
    ],
    sections: [
      {
        title: "Audit records",
        description: "Recent security decisions and operator actions.",
        emptyLabel: "No security audits loaded.",
        rows: (data) =>
          arrayPath(data, "audits.records").map((item) => ({
            title: stringValue(item.action, "Security action"),
            status: stringValue(item.decision, "unknown"),
            meta: `${stringValue(item.resourceType, "resource")} / ${stringValue(item.actorId, "actor")}`,
            time: stringValue(item.createdAt),
            tone: stringValue(item.decision) === "deny" ? "danger" : "success",
          })),
      },
      {
        title: "RBAC rules",
        description: "Configured action policy exposed to this tenant.",
        emptyLabel: "No RBAC rules visible.",
        rows: (data) =>
          objectEntries(readPath(data, "context.policy.rbacRules")).map(([role, actions]) => ({
            title: role,
            status: `${Array.isArray(actions) ? actions.length : 0} actions`,
            meta: Array.isArray(actions) ? actions.slice(0, 4).join(", ") : "policy",
          })),
      },
      {
        title: "Release security gate",
        description: "Security-linked release blockers and warnings.",
        emptyLabel: "Release security evidence is not available.",
        rows: releaseRows,
      },
    ],
    actions: [],
  },
  settings: {
    title: "Settings",
    eyebrow: "Workspace and runtime configuration",
    description: "Understand runtime posture, model and storage configuration, auth state, release metadata, environment readiness, and tenant defaults.",
    icon: Database,
    endpoints: [
      { key: "session", label: "Session", path: "/api/auth/session" },
      { key: "capabilities", label: "Capabilities", path: "/api/capabilities" },
      { key: "health", label: "Health", path: "/api/health" },
      { key: "release", label: "Release evidence", path: "/api/release/evidence" },
    ],
    metrics: [
      { label: "Auth", description: "Authentication enforcement", value: (data) => booleanLabel(readPath(data, "session.authEnabled"), "enforced", "open") },
      { label: "Database", description: "Database configuration", value: (data) => booleanLabel(readPath(data, "capabilities.databaseConfigured"), "configured", "missing") },
      { label: "Storage", description: "Active persistence backend", value: (data) => stringPath(data, "capabilities.storageBackend", "unknown") },
      { label: "OpenAI", description: "Model provider readiness", value: (data) => booleanLabel(readPath(data, "capabilities.openaiConfigured"), "live", "fallback") },
    ],
    flow: [
      { title: "Runtime", body: "Confirm Vercel function health, cron, and deployment evidence.", icon: ActivityIcon },
      { title: "Storage", body: "Validate Neon Postgres, vector capability, memory, and ledgers.", icon: Database },
      { title: "Model", body: "Check OpenAI generation and embedding configuration.", icon: Brain },
      { title: "Govern", body: "Keep tenant, auth, release, and signing posture explicit.", icon: ShieldCheck },
    ],
    sections: [
      {
        title: "Configuration checklist",
        description: "Runtime prerequisites for production operation.",
        emptyLabel: "Configuration data unavailable.",
        rows: (data) => [
          metricRow("Auth enforcement", booleanLabel(readPath(data, "session.authEnabled"), "enforced", "open"), readPath(data, "session.authEnabled") ? "success" : "warning"),
          metricRow("Bootstrap configured", booleanLabel(readPath(data, "session.bootstrapConfigured"), "ready", "missing"), readPath(data, "session.bootstrapConfigured") ? "success" : "warning"),
          metricRow("Database URL", booleanLabel(readPath(data, "capabilities.databaseConfigured"), "configured", "missing"), readPath(data, "capabilities.databaseConfigured") ? "success" : "danger"),
          metricRow("OpenAI API key", booleanLabel(readPath(data, "capabilities.openaiConfigured"), "configured", "fallback"), readPath(data, "capabilities.openaiConfigured") ? "success" : "warning"),
          metricRow("Health endpoint", stringPath(data, "health.status", "unknown"), toneForStatus(readPath(data, "health.status"))),
        ],
      },
      {
        title: "Vector and memory backend",
        description: "Persistence and retrieval backend status.",
        emptyLabel: "Capability data unavailable.",
        rows: (data) => [
          metricRow("Storage backend", stringPath(data, "capabilities.storageBackend", "unknown")),
          metricRow("Vector store", stringPath(data, "capabilities.vectorStore.status", "unknown"), toneForStatus(readPath(data, "capabilities.vectorStore.status"))),
          metricRow("Memory total", numberPath(data, "capabilities.memory.total")),
          metricRow("Knowledge documents", numberPath(data, "capabilities.knowledge.documents")),
        ],
      },
    ],
    actions: [],
  },
};

function workflowPayload(values: Record<string, FormValue>) {
  return {
    goal: textValue(values.goal),
    mode: textValue(values.mode, "orchestrate"),
    requireApproval: Boolean(values.requireApproval),
  };
}

export function DomainConsole({ domain }: { domain: DomainConsoleKey }) {
  const config = domainConfigs[domain];
  const Icon = config.icon;
  const [resources, setResources] = useState<Record<string, ResourceState>>({});
  const [lastRefresh, setLastRefresh] = useState<string>();
  const [actionResult, setActionResult] = useState<ActionResult>();
  const [runningAction, setRunningAction] = useState<string>();

  const data = useMemo(() => {
    return Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, value.data])) as DomainData;
  }, [resources]);

  async function load() {
    let session: JsonRecord | undefined;
    try {
      session = asRecord(await readJson("/api/auth/session"));
    } catch {
      session = undefined;
    }
    setResources((current) => {
      const next = { ...current };
      for (const endpoint of config.endpoints) {
        const access = endpointAccess(endpoint.path, session);
        next[endpoint.key] = access.allowed
          ? { status: "loading", data: current[endpoint.key]?.data }
          : {
              status: "error",
              code: access.code,
              error: access.message,
              data: current[endpoint.key]?.data,
            };
      }
      return next;
    });

    const entries = await Promise.all(
      config.endpoints.map(async (endpoint) => {
        const access = endpointAccess(endpoint.path, session);
        if (!access.allowed) {
          return [
            endpoint.key,
            {
              status: "error",
              code: access.code,
              error: access.message,
            } satisfies ResourceState,
          ] as const;
        }
        try {
          const data = await readJson(endpoint.path);
          return [endpoint.key, { status: "ready", data } satisfies ResourceState] as const;
        } catch (error) {
          const message = error instanceof HttpError || error instanceof Error ? error.message : "Request failed.";
          const code = error instanceof HttpError ? error.status : undefined;
          return [endpoint.key, { status: "error", error: message, code } satisfies ResourceState] as const;
        }
      }),
    );

    setResources(Object.fromEntries(entries));
    setLastRefresh(new Date().toLocaleTimeString());
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain]);

  const protectedError = Object.values(resources).find((resource) => resource.code === 401 || resource.code === 403);

  async function runAction(action: DomainAction, values: Record<string, FormValue>) {
    setRunningAction(action.id);
    setActionResult(undefined);
    try {
      const body = action.buildPayload?.(values);
      const result = await readJson(action.path, {
        method: action.method,
        headers: action.method === "POST" ? { "content-type": "application/json" } : undefined,
        body: action.method === "POST" ? JSON.stringify(body || {}) : undefined,
      });
      setActionResult({
        title: action.title,
        status: "success",
        message: "Action completed.",
        data: result,
      });
      await load();
    } catch (error) {
      setActionResult({
        title: action.title,
        status: "error",
        message: error instanceof Error ? error.message : "Action failed.",
      });
    } finally {
      setRunningAction(undefined);
    }
  }

  async function decideApproval(item: JsonRecord, decision: "approve" | "reject") {
    const id = textValue(item.id);
    const kind = textValue(item.kind);
    if (!id || !kind) {
      setActionResult({ title: "Approval decision", status: "error", message: "Approval item is missing id or kind." });
      return;
    }
    setRunningAction(`${decision}-${id}`);
    try {
      const result = await readJson(`/api/approvals/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          decision,
          reason: decision === "approve" ? "Approved from operations console." : "Rejected from operations console.",
        }),
      });
      setActionResult({ title: "Approval decision", status: "success", message: `${decision} recorded.`, data: result });
      await load();
    } catch (error) {
      setActionResult({ title: "Approval decision", status: "error", message: error instanceof Error ? error.message : "Decision failed." });
    } finally {
      setRunningAction(undefined);
    }
  }

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-md bg-primary text-primary-ink">
                <Icon size={18} aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{config.eyebrow}</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-normal">{config.title}</h1>
              </div>
            </div>
            <p className="mt-4 max-w-4xl text-sm leading-6 text-muted">{config.description}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line bg-background px-3 text-sm font-semibold transition hover:bg-surface-raised"
            >
              <RefreshCw size={15} aria-hidden="true" />
              Refresh
            </button>
            <Link
              href="/app/command"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-ink transition hover:brightness-105"
            >
              New run
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2 text-xs text-muted">
          {config.endpoints.map((endpoint) => {
            const state = resources[endpoint.key]?.status || "idle";
            return (
              <span key={endpoint.key} className="inline-flex items-center gap-2 rounded-md border border-line bg-background px-2.5 py-1.5">
                <span className={clsx("size-2 rounded-full", state === "ready" ? "bg-success" : state === "error" ? "bg-danger" : "bg-warning")} />
                {endpoint.label}
              </span>
            );
          })}
          {lastRefresh ? <span className="inline-flex items-center rounded-md border border-line bg-background px-2.5 py-1.5">Updated {lastRefresh}</span> : null}
        </div>
      </section>

      {protectedError ? (
        <section className="mt-4 rounded-lg border border-warning/45 bg-warning/10 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Sign-in required for live console data</p>
              <p className="mt-1 text-sm text-muted">{protectedError.error}</p>
            </div>
            <Link href="/login" className="inline-flex h-10 items-center justify-center rounded-md bg-foreground px-3 text-sm font-semibold text-background">
              Sign in
            </Link>
          </div>
        </section>
      ) : null}

      <section className="mt-4 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4">
        {config.metrics.map((metric) => (
          <div key={metric.label} className="min-h-28 bg-surface p-4">
            <p className="text-xs text-muted">{metric.label}</p>
            <p className={clsx("mt-3 font-mono text-2xl", toneClass(metric.tone))}>{metric.value(data)}</p>
            <p className="mt-2 text-xs leading-5 text-muted">{metric.description}</p>
          </div>
        ))}
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[0.72fr_1.18fr_0.74fr]">
        <div className="space-y-4">
          <Panel title="Workflow" description="How this page should be used.">
            <div className="space-y-3">
              {config.flow.map((step, index) => {
                const StepIcon = step.icon;
                return (
                  <div key={step.title} className="rounded-md border border-line bg-background p-3">
                    <div className="flex items-center gap-3">
                      <span className="grid size-8 place-items-center rounded-md bg-primary/12 text-primary">
                        <StepIcon size={15} aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-mono text-muted">0{index + 1}</p>
                        <p className="truncate text-sm font-semibold">{step.title}</p>
                      </div>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-muted">{step.body}</p>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          {domain === "approvals" ? (
            <ApprovalDecisionPanel
              items={arrayPath(data, "approvals.items")}
              runningAction={runningAction}
              onDecision={(item, decision) => void decideApproval(item, decision)}
            />
          ) : null}
          {config.sections.map((section) => (
            <DataPanel key={section.title} section={section} data={data} />
          ))}
        </div>

        <div className="space-y-4">
          <Panel title="Actions" description={config.actions.length ? "Run page-specific operations without leaving this workspace." : "This surface is currently read and review focused."}>
            <div className="space-y-3">
              {config.actions.length ? (
                config.actions.map((action) => (
                  <ActionForm
                    key={action.id}
                    action={action}
                    loading={runningAction === action.id}
                    onRun={(values) => void runAction(action, values)}
                  />
                ))
              ) : (
                <div className="rounded-md border border-line bg-background p-4 text-sm leading-6 text-muted">
                  Review the live data, then use related workspaces for changes that need stronger guardrails.
                </div>
              )}
            </div>
          </Panel>

          {actionResult ? (
            <Panel title={actionResult.title} description={actionResult.status === "success" ? "Result from the last action." : "Action failed."}>
              <div className={clsx("rounded-md border p-3 text-sm", actionResult.status === "success" ? "border-success/35 bg-success/10" : "border-danger/35 bg-danger/10")}>
                <div className="flex items-center gap-2 font-semibold">
                  {actionResult.status === "success" ? <CheckCircle2 size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}
                  {actionResult.message}
                </div>
                {actionResult.data ? (
                  <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-background p-3 text-xs text-muted">
                    {JSON.stringify(actionResult.data, null, 2)}
                  </pre>
                ) : null}
              </div>
            </Panel>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Panel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

function DataPanel({ section, data }: { section: DataSection; data: DomainData }) {
  const rows = section.rows(data).filter((row) => row.title || row.status || row.meta);
  return (
    <Panel title={section.title} description={section.description}>
      {rows.length ? (
        <div className="divide-y divide-line overflow-hidden rounded-md border border-line bg-background">
          {rows.slice(0, 8).map((row, index) => (
            <div key={`${row.title}-${index}`} className="grid gap-3 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{row.title}</p>
                <p className="mt-1 truncate text-xs text-muted">{row.meta || "No extra context"}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {row.status ? <span className={clsx("rounded-md px-2 py-1 font-mono text-xs", statusPillClass(row.tone || toneForStatus(row.status)))}>{row.status}</span> : null}
                {row.time ? <span className="font-mono text-xs text-muted">{formatTime(row.time)}</span> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-line bg-background p-4 text-sm leading-6 text-muted">{section.emptyLabel}</div>
      )}
    </Panel>
  );
}

function ApprovalDecisionPanel({
  items,
  runningAction,
  onDecision,
}: {
  items: JsonRecord[];
  runningAction?: string;
  onDecision: (item: JsonRecord, decision: "approve" | "reject") => void;
}) {
  return (
    <Panel title="Decision queue" description="Approve or reject blocking items from the same surface that shows their risk and reason.">
      {items.length ? (
        <div className="space-y-3">
          {items.slice(0, 6).map((item) => {
            const id = textValue(item.id);
            const isRunning = runningAction === `approve-${id}` || runningAction === `reject-${id}`;
            return (
              <article key={id} className="rounded-md border border-line bg-background p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{stringValue(item.title, "Approval item")}</p>
                    <p className="mt-1 text-xs leading-5 text-muted">{stringValue(item.reason, "No reason supplied.")}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <span className="rounded-md border border-line px-2 py-1 font-mono text-xs text-muted">{stringValue(item.kind, "item")}</span>
                      <span className="rounded-md border border-warning/35 bg-warning/10 px-2 py-1 font-mono text-xs text-warning">risk {stringValue(item.riskLevel, "0")}</span>
                      <span className="rounded-md border border-line px-2 py-1 font-mono text-xs text-muted">{formatTime(stringValue(item.createdAt))}</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={() => onDecision(item, "reject")}
                      className="inline-flex h-9 items-center justify-center rounded-md border border-line px-3 text-xs font-semibold transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={() => onDecision(item, "approve")}
                      className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-xs font-semibold text-primary-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isRunning ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : "Approve"}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-line bg-background p-4 text-sm text-muted">No blocking approvals are waiting.</div>
      )}
    </Panel>
  );
}

function ActionForm({ action, loading, onRun }: { action: DomainAction; loading: boolean; onRun: (values: Record<string, FormValue>) => void }) {
  const initialValues = useMemo(() => {
    return Object.fromEntries(action.fields.map((field) => [field.name, field.defaultValue ?? (field.type === "checkbox" ? false : "")])) as Record<string, FormValue>;
  }, [action.fields]);
  const [values, setValues] = useState(initialValues);

  return (
    <form
      className="rounded-md border border-line bg-background p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onRun(values);
      }}
    >
      <p className="text-sm font-semibold">{action.title}</p>
      <p className="mt-1 text-xs leading-5 text-muted">{action.description}</p>
      <div className="mt-3 space-y-3">
        {action.fields.map((field) => (
          <FieldControl
            key={field.name}
            field={field}
            value={values[field.name]}
            onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
          />
        ))}
      </div>
      <button
        type="submit"
        disabled={loading}
        className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-semibold text-primary-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        Run action
      </button>
    </form>
  );
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: ActionField;
  value: FormValue;
  onChange: (value: FormValue) => void;
}) {
  if (field.type === "checkbox") {
    return (
      <label className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-xs">
        <span>{field.label}</span>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.currentTarget.checked)}
          className="size-4 accent-[var(--primary)]"
        />
      </label>
    );
  }

  const commonClass = "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary";
  return (
    <label className="block text-xs font-medium text-muted">
      {field.label}
      {field.type === "select" ? (
        <select value={textValue(value)} onChange={(event) => onChange(event.currentTarget.value)} className={commonClass}>
          {(field.options || []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === "textarea" || field.type === "json" ? (
        <textarea
          value={textValue(value)}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={field.placeholder}
          rows={field.type === "json" ? 4 : 5}
          className={commonClass}
        />
      ) : (
        <input
          type="text"
          value={textValue(value)}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={field.placeholder}
          className={commonClass}
        />
      )}
    </label>
  );
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const record = asRecord(body);
    const message = stringValue(record.message || record.error, `${path} returned ${response.status}`);
    throw new HttpError(response.status, message);
  }
  return body;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function endpointAccess(path: string, session?: JsonRecord) {
  if (isPublicEndpoint(path)) {
    return { allowed: true, code: 200, message: "" };
  }

  if (Boolean(session?.authEnabled) && !Boolean(session?.authenticated)) {
    return { allowed: false, code: 401, message: "Sign in to load protected production data." };
  }

  const role = sessionRole(session);
  const required = requiredAction(path);
  if (required === "read.security" && !hasRole(role, ["admin", "system"])) {
    return { allowed: false, code: 403, message: "Admin role required for security and release evidence." };
  }
  if (required === "manage.workflow" && !hasRole(role, ["operator", "admin", "system"])) {
    return { allowed: false, code: 403, message: "Operator role required for workflow and approval operations." };
  }

  return { allowed: true, code: 200, message: "" };
}

function isPublicEndpoint(path: string) {
  return path.startsWith("/api/auth/session") || path.startsWith("/api/health");
}

function requiredAction(path: string) {
  if (path.startsWith("/api/approvals") || path.startsWith("/api/operations")) {
    return "manage.workflow";
  }
  if (
    path.startsWith("/api/release/evidence") ||
    path.startsWith("/api/security/audits") ||
    path.startsWith("/api/security/isolation-report") ||
    path.startsWith("/api/observability") ||
    path.startsWith("/api/incidents") ||
    path.startsWith("/api/alerts")
  ) {
    return "read.security";
  }
  return "read";
}

function sessionRole(session?: JsonRecord) {
  return stringValue(readPath(session, "context.role") || readPath(session, "membership.role"), "viewer");
}

function hasRole(role: string, allowed: string[]) {
  return allowed.includes(role);
}

function objectEntries(value: unknown): Array<[string, unknown]> {
  return Object.entries(asRecord(value));
}

function readPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => asRecord(current)[segment], source);
}

function arrayPath(source: unknown, path: string): JsonRecord[] {
  const value = readPath(source, path);
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringPath(source: unknown, path: string, fallback = "0") {
  return stringValue(readPath(source, path), fallback);
}

function numberPath(source: unknown, path: string) {
  const value = readPath(source, path);
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toString() : value.toFixed(2);
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return "0";
}

function stringValue(value: unknown, fallback = "") {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function textValue(value: unknown, fallback = "") {
  const text = stringValue(value, fallback).trim();
  return text || fallback;
}

function optionalText(value: unknown) {
  const text = textValue(value);
  return text ? text : undefined;
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function commaList(value: unknown) {
  return textValue(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonObject(value: unknown) {
  const text = textValue(value, "{}");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Input JSON must be an object.");
  }
  return parsed as JsonRecord;
}

function tagsValue(value: unknown) {
  if (!Array.isArray(value)) {
    return "";
  }
  return value.map((item) => stringValue(item)).filter(Boolean).slice(0, 4).join(", ");
}

function booleanLabel(value: unknown, trueLabel: string, falseLabel: string) {
  return Boolean(value) ? trueLabel : falseLabel;
}

function summaryValue(value: unknown) {
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    return "No summary";
  }
  const passed = stringValue(record.passed, "0");
  const failed = stringValue(record.failed, "0");
  const warnings = stringValue(record.warnings, "0");
  return `${passed} passed / ${failed} failed / ${warnings} warnings`;
}

function metricRow(title: string, status: string, tone: Row["tone"] = "neutral"): Row {
  return { title, status, tone };
}

function approvalRows(data: DomainData): Row[] {
  return arrayPath(data, "approvals.items").map((item) => ({
    title: stringValue(item.title, "Approval item"),
    status: `risk ${stringValue(item.riskLevel, "0")}`,
    meta: `${stringValue(item.kind, "item")} / ${stringValue(item.status, "pending")}`,
    time: stringValue(item.createdAt),
    tone: "warning",
  }));
}

function releaseRows(data: DomainData): Row[] {
  const gate = asRecord(readPath(data, "release.report.releaseGate"));
  if (!Object.keys(gate).length) {
    return [];
  }
  const summary = asRecord(gate.summary);
  return [
    {
      title: "Release gate",
      status: stringValue(gate.status, "unknown"),
      meta: `${stringValue(summary.failures, "0")} failures / ${stringValue(summary.warnings, "0")} warnings`,
      tone: toneForStatus(gate.status),
    },
    {
      title: "Approved",
      status: booleanLabel(gate.approved, "yes", "no"),
      meta: "Final promotion state",
      tone: gate.approved ? "success" : "warning",
    },
  ];
}

function toneForStatus(value: unknown): Row["tone"] {
  const text = stringValue(value).toLowerCase();
  if (["healthy", "passed", "success", "completed", "executed", "active", "allow", "approved", "ready", "info"].includes(text)) {
    return "success";
  }
  if (["warn", "warning", "waiting_approval", "queued", "paused", "pending", "degraded", "dry_run"].includes(text)) {
    return "warning";
  }
  if (["error", "failed", "blocked", "deny", "unhealthy", "rejected", "open"].includes(text)) {
    return "danger";
  }
  return "neutral";
}

function toneClass(tone: MetricConfig["tone"]) {
  if (tone === "success") {
    return "text-success";
  }
  if (tone === "warning") {
    return "text-warning";
  }
  if (tone === "danger") {
    return "text-danger";
  }
  return "text-foreground";
}

function statusPillClass(tone: Row["tone"]) {
  if (tone === "success") {
    return "bg-success/10 text-success";
  }
  if (tone === "warning") {
    return "bg-warning/10 text-warning";
  }
  if (tone === "danger") {
    return "bg-danger/10 text-danger";
  }
  return "bg-surface text-muted";
}

function formatTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
