"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Cable,
  CheckCircle2,
  CircleHelp,
  Database,
  Download,
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
import { PersonalConnections } from "@/components/connectors/personal-connections";
import { McpConnections } from "@/components/connectors/mcp-connections";
import { PersonalDataControls } from "@/components/settings/personal-data-controls";
import {
  permissionMessage,
  type WorkspacePermission,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";
import type { NavIcon } from "@/lib/navigation";
import {
  ASAEL_PENDING_USER_PROVISION_KEY,
  LEGACY_PENDING_USER_PROVISION_KEY,
} from "@/lib/browser-storage-keys";
import { workflowControlRunsFrom } from "@/lib/workflows/client-controls";
import styles from "../daybook-workspaces.module.css";

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
export type FormValue = string | boolean;

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
  secondaryStatus?: string;
  meta?: string;
  time?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  secondaryTone?: "neutral" | "success" | "warning" | "danger";
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

export type ActionField = {
  name: string;
  label: string;
  type: "text" | "password" | "textarea" | "select" | "checkbox" | "json";
  placeholder?: string;
  defaultValue?: FormValue;
  options?: { label: string; value: string }[];
};

export type DomainAction = {
  id: string;
  title: string;
  description: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  fields: ActionField[];
  buildPath?: (values: Record<string, FormValue>) => string;
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
const openApiAuthOptions = [
  ...authOptions,
  { label: "API key header env", value: "api_key_header_env" },
];

const ActivityIcon = Layers3;

const DomainActionForms = dynamic(
  () =>
    import("@/components/app-shell/domain-action-forms").then(
      (module) => module.DomainActionForms,
    ),
  {
    loading: () => (
      <div className="space-y-3" role="status" aria-label="Loading action controls">
        {[0, 1].map((item) => (
          <div
            key={item}
            className="h-28 animate-pulse rounded-md border border-line bg-background"
          />
        ))}
      </div>
    ),
  },
);

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
            status: `${stringValue(item.type, "memory")} · ${stringValue(item.claimStatus, "active")}`,
            meta: `${stringValue(item.id)} · ${Math.round(numberValue(item.confidence, 0.7) * 100)}% confidence · ${stringValue(item.assertedBy, "system")} · ${tagsValue(item.tags) || stringValue(item.source, "unknown source")}`,
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
        id: "correct-memory",
        title: "Correct memory",
        description: "Create a new claim that supersedes an inaccurate memory while preserving its history.",
        method: "PATCH",
        path: "/api/memory",
        fields: [
          { name: "memoryId", label: "Memory ID", type: "text", placeholder: "Memory record ID" },
          { name: "title", label: "Corrected title", type: "text", placeholder: "Updated title" },
          { name: "content", label: "Corrected content", type: "textarea", placeholder: "What should Asael remember instead?" },
          { name: "contradiction", label: "Mark the previous claim as contradicted", type: "checkbox", defaultValue: false },
        ],
        buildPath: (values) => `/api/memory/${encodeURIComponent(textValue(values.memoryId))}`,
        buildPayload: (values) => ({
          title: textValue(values.title),
          content: textValue(values.content),
          contradiction: Boolean(values.contradiction),
          confidence: 1,
        }),
      },
      {
        id: "forget-memory",
        title: "Forget memory",
        description: "Irreversibly scrub a memory's content and remove it from recall.",
        method: "DELETE",
        path: "/api/memory",
        fields: [
          { name: "memoryId", label: "Memory ID", type: "text", placeholder: "Memory record ID" },
        ],
        buildPath: (values) => `/api/memory/${encodeURIComponent(textValue(values.memoryId))}`,
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
          arrayPath(data, "workflows.runs").map((item) => {
            const outcome = stringPath(item, "canonicalStatus.status", "");
            return {
              title: stringValue(item.goal, "Workflow run"),
              status: stringValue(item.status, "unknown"),
              secondaryStatus: outcome
                ? `Outcome: ${outcome.replaceAll("_", " ")}`
                : undefined,
              meta: `${stringValue(item.currentStep, "preflight")} · ${stringValue(item.id, "unknown ID")}`,
              time: stringValue(item.updatedAt || item.createdAt),
              tone: toneForStatus(item.status),
              secondaryTone: toneForStatus(outcome),
            };
          }),
      },
      {
        title: "Generated plans",
        description: "AI or deterministic plans with risk, confidence, and policy validation.",
        emptyLabel: "No plans generated yet. Preview a plan before starting a run.",
        rows: (data) =>
          arrayPath(data, "plans.plans").map((item) => ({
            title: stringValue(item.goal, "Workflow plan"),
            status: `risk ${stringValue(item.highestRiskLevel, "0")}`,
            meta: `${stringPath(item, "plan.mode", "orchestrate")} · confidence ${stringValue(item.confidence, "0")} · ${stringValue(item.id, "unknown ID")}`,
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
        description: "Create a durable run. Paste the previewed plan ID to execute that exact reviewed plan.",
        method: "POST",
        path: "/api/workflows",
        fields: [
          ...workflowGoalFields,
          {
            name: "planId",
            label: "Reviewed plan ID (recommended)",
            type: "text",
            placeholder: "Paste the ID returned by Preview plan",
          },
        ],
        buildPayload: (values) => ({
          ...workflowPayload(values),
          planId: textValue(values.planId) || undefined,
        }),
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
        id: "control-workflow",
        title: "Control workflow",
        description: "Choose a recent workflow run to see only the controls valid for its current state.",
        method: "POST",
        path: "/api/workflows/:id/signal",
        fields: [
          {
            name: "runId",
            label: "Workflow run ID",
            type: "text",
            placeholder: "workflow run ID",
          },
          {
            name: "signal",
            label: "Signal",
            type: "select",
            defaultValue: "pause",
            options: ["pause", "resume", "cancel", "retry"].map((value) => ({
              label: value[0].toUpperCase() + value.slice(1),
              value,
            })),
          },
        ],
        buildPath: (values) => {
          const runId = textValue(values.runId);
          if (!runId) {
            throw new Error("Workflow run ID is required.");
          }
          return `/api/workflows/${encodeURIComponent(runId)}/signal`;
        },
        buildPayload: (values) => ({ signal: textValue(values.signal, "pause") }),
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
    eyebrow: "Google, MCP, OpenAPI",
    description: "Connect personal sources and governed tools, then keep their permissions, freshness, and health visible in one place.",
    icon: Cable,
    endpoints: [
      { key: "oauth", label: "Personal sources", path: "/api/oauth?ownerScope=readable" },
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
      { title: "Govern", body: "Send operations to Tools for risk and approval policy.", icon: Wrench },
    ],
    sections: [
      {
        title: "OpenAPI connectors",
        description: "REST APIs imported as governed operations.",
        emptyLabel: "No OpenAPI connectors imported.",
        rows: (data) =>
          arrayPath(data, "openapi.connectors").map((item) => {
            const pending = numberPath(item, "review.pendingCount");
            const contracts = arrayPath(item, "review.contracts")
              .map((contract) => stringValue(contract.name))
              .filter(Boolean)
              .slice(0, 3)
              .join(", ");
            return {
              title: stringValue(item.name, "OpenAPI connector"),
              status: pending ? "review required" : stringValue(item.status, "unknown"),
              meta: pending
                ? `${pending} pending${contracts ? `: ${contracts}` : ""} · connector ${stringValue(item.id)}`
                : stringValue(item.baseUrl || item.specUrl, "base URL"),
              time: stringValue(item.updatedAt || item.createdAt),
              tone: pending ? "warning" : toneForStatus(item.status),
            };
          }),
      },
      {
        title: "Catalog suggestions",
        description: "Potential systems to connect next.",
        emptyLabel: "No catalog entries loaded.",
        rows: (data) =>
          arrayPath(data, "catalog.connectors")
            .filter(
              (item) =>
                !["gmail", "google-drive", "google-calendar"].includes(
                  stringValue(item.id),
                ),
            )
            .map((item) => ({
              title: stringValue(item.name, "Connector"),
              status: stringValue(item.status, "planned"),
              meta: stringValue(item.adapter, "adapter"),
              tone: stringValue(item.status) === "planned" ? "neutral" : "success",
            })),
      },
    ],
    actions: [
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
          { name: "authType", label: "Auth", type: "select", defaultValue: "none", options: openApiAuthOptions },
          { name: "authTokenEnv", label: "Token env", type: "text", placeholder: "OMNIAGENT_CONNECTOR_CRM_TOKEN" },
          { name: "authHeaderName", label: "API key header", type: "text", placeholder: "x-api-key (API key auth only)" },
          { name: "defaultRiskLevel", label: "Default risk", type: "select", defaultValue: "2", options: riskOptions },
        ],
        buildPayload: (values) => ({
          name: textValue(values.name),
          specUrl: optionalText(values.specUrl),
          baseUrl: optionalText(values.baseUrl),
          authType: textValue(values.authType, "none"),
          authTokenEnv: optionalText(values.authTokenEnv),
          authHeaderName: optionalText(values.authHeaderName),
          defaultRiskLevel: numberValue(values.defaultRiskLevel, 2),
          approvalRequired: numberValue(values.defaultRiskLevel, 2) >= 2,
          importSpec: true,
        }),
      },
    ],
  },
  tools: {
    title: "Tools",
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
        id: "live-web-search",
        title: "Run live web search",
        description: "Search current public web sources through the governed read-only web.search tool.",
        method: "POST",
        path: "/api/tools/execute",
        fields: [
          { name: "query", label: "Search query", type: "textarea", placeholder: "Research Claude Fable 5 released today and cite multiple sources." },
          { name: "searchContextSize", label: "Depth", type: "select", defaultValue: "medium", options: ["low", "medium", "high"].map((value) => ({ label: value, value })) },
        ],
        buildPayload: (values) => ({
          toolId: "web.search",
          input: {
            query: textValue(values.query),
            searchContextSize: textValue(values.searchContextSize, "medium"),
            limit: 8,
          },
          dryRun: false,
        }),
      },
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
      { key: "failureFeedback", label: "Failure feedback", path: "/api/evaluations/failure-feedback?limit=50" },
      { key: "release", label: "Release evidence", path: "/api/release/evidence" },
      { key: "isolation", label: "Tenant isolation", path: "/api/security/isolation-report" },
    ],
    metrics: [
      { label: "Eval runs", description: "Recorded suite executions", value: (data) => numberPath(data, "evaluations.stats.total") },
      { label: "Cases", description: "Available regression cases", value: (data) => arrayPath(data, "evaluations.cases").length.toString() },
      { label: "Recurring", description: "Active repeated failure categories", value: (data) => numberPath(data, "failureFeedback.summary.activeRecurring"), tone: "warning" },
      { label: "Rule review", description: "Inactive harness proposals awaiting review", value: (data) => numberPath(data, "failureFeedback.summary.proposedRules"), tone: "warning" },
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
        title: "Recurring failures",
        description: "Minimized replay clusters derived from repeated case failures.",
        emptyLabel: "No recurring failure category is active.",
        rows: (data) =>
          arrayPath(data, "failureFeedback.clusters").map((item) => ({
            title: stringValue(item.caseId, "Evaluation case"),
            status: stringValue(item.status, "unknown"),
            meta: `${stringValue(item.failureCategory, "failure")} · ${numberValue(item.failureCount, 0)} total · ${numberValue(item.consecutiveFailures, 0)} consecutive`,
            time: stringValue(item.updatedAt),
            tone: stringValue(item.status) === "resolved" ? "success" : "warning",
          })),
      },
      {
        title: "Harness rule proposals",
        description: "Versioned prompt, tool, runtime, and regression changes. Review never applies a change automatically.",
        emptyLabel: "No harness rule proposal is waiting.",
        rows: (data) =>
          arrayPath(data, "failureFeedback.proposals").map((item) => ({
            title: stringValue(item.target, "Harness rule"),
            status: stringValue(item.status, "proposed"),
            meta: `v${numberValue(item.version, 1)} · ${stringValue(item.kind, "rule")} · review only`,
            time: stringValue(item.updatedAt),
            tone: stringValue(item.status) === "approved"
              ? "success"
              : stringValue(item.status) === "rejected"
                ? "neutral"
                : "warning",
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
      {
        id: "review-harness-rule",
        title: "Review harness rule",
        description: "Approve or reject one versioned proposal. Approval records evidence but does not modify prompts, tools, or runtime code.",
        method: "POST",
        path: "/api/evaluations/failure-feedback",
        fields: [
          { name: "proposalId", label: "Proposal id", type: "text", placeholder: "Paste a proposal id from the review list" },
          { name: "decision", label: "Decision", type: "select", defaultValue: "approved", options: [
            { label: "Approve", value: "approved" },
            { label: "Reject", value: "rejected" },
          ] },
          { name: "reason", label: "Review reason", type: "textarea", placeholder: "Explain how the minimized replay evidence supports this decision." },
        ],
        buildPayload: (values) => ({
          proposalId: textValue(values.proposalId),
          decision: textValue(values.decision, "approved"),
          reason: textValue(values.reason),
        }),
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
      { key: "retention", label: "Retention policy", path: "/api/security/retention" },
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
      {
        title: "Sensitive-data retention",
        description: "Automatic expiry windows applied by the dedicated worker.",
        emptyLabel: "Retention policy is unavailable.",
        rows: (data) => [
          metricRow("Pending approvals", `${numberPath(data, "retention.policy.pendingApprovalDays")} days`),
          metricRow("Pending access requests", `${numberPath(data, "retention.policy.pendingAccessRequestDays")} days`),
          metricRow("Reviewed access requests", `${numberPath(data, "retention.policy.reviewedAccessRequestDays")} days`),
          metricRow("Raw episode memory", `${numberPath(data, "retention.policy.episodeMemoryDays")} days`),
          metricRow("Consolidated memory", `${numberPath(data, "retention.policy.consolidatedMemoryDays")} days`),
          metricRow("Retrieval traces", `${numberPath(data, "retention.policy.retrievalTraceDays")} days`),
          metricRow("Completed workflows", `${numberPath(data, "retention.policy.workflowDays")} days`),
          metricRow("Webhook events", `${numberPath(data, "retention.policy.triggerEventDays")} days`),
          metricRow("Completed queue jobs", `${numberPath(data, "retention.policy.operationJobDays")} days`),
          metricRow("Run content", `${numberPath(data, "retention.policy.runContentDays")} days`),
          metricRow("Tool payloads", `${numberPath(data, "retention.policy.toolPayloadDays")} days`),
          metricRow("Operational events", `${numberPath(data, "retention.policy.domainEventDays")} days`),
          metricRow("Security audits", `${numberPath(data, "retention.policy.securityAuditDays")} days`),
        ],
      },
    ],
    actions: [
      {
        id: "sweep-retention",
        title: "Run tenant retention",
        description: "Remove expired terminal payloads and close approvals older than policy. Executing work and recent decisions are preserved.",
        method: "POST",
        path: "/api/security/retention",
        fields: [],
        buildPayload: () => ({ scope: "tenant" }),
      },
    ],
  },
  settings: {
    title: "Settings",
    eyebrow: "Workspace and runtime configuration",
    description: "Manage your private runtime, model providers, storage, portable archive, and release readiness.",
    icon: Database,
    endpoints: [
      { key: "session", label: "Session", path: "/api/auth/session" },
      { key: "capabilities", label: "Capabilities", path: "/api/capabilities?view=settings" },
      { key: "health", label: "Health", path: "/api/health" },
      { key: "release", label: "Release evidence", path: "/api/release/evidence" },
    ],
    metrics: [
      { label: "Auth", description: "Authentication enforcement", value: (data) => booleanLabel(readPath(data, "session.authEnabled"), "enforced", "open") },
      { label: "Database", description: "Database configuration", value: (data) => booleanLabel(readPath(data, "capabilities.databaseConfigured"), "configured", "missing") },
      { label: "Storage", description: "Active persistence backend", value: (data) => stringPath(data, "capabilities.storageBackend", "unknown") },
      { label: "OpenAI", description: "Model provider readiness", value: (data) => booleanLabel(readPath(data, "capabilities.openaiConfigured"), "live", "fallback") },
      { label: "Gemini", description: "Multimodal provider readiness", value: (data) => booleanLabel(readPath(data, "capabilities.geminiConfigured"), "live", "missing") },
      { label: "Claude", description: "Anthropic provider readiness", value: (data) => booleanLabel(readPath(data, "capabilities.anthropicConfigured"), "live", "missing") },
    ],
    flow: [
      { title: "Runtime", body: "Confirm Vercel function health, cron, and deployment evidence.", icon: ActivityIcon },
      { title: "Storage", body: "Validate Neon Postgres, vector capability, memory, and ledgers.", icon: Database },
      { title: "Models", body: "Check OpenAI, Gemini, and Claude routing plus multimodal media readiness.", icon: Brain },
      { title: "Recover", body: "Keep portable exports and infrastructure backups ready before major changes.", icon: ShieldCheck },
    ],
    sections: [
      {
        title: "Configuration checklist",
        description: "Runtime prerequisites for production operation.",
        emptyLabel: "Configuration data unavailable.",
        rows: (data) => [
          metricRow("Auth enforcement", booleanLabel(readPath(data, "session.authEnabled"), "enforced", "open"), readPath(data, "session.authEnabled") ? "success" : "warning"),
          metricRow(
            "Bootstrap credentials",
            booleanLabel(readPath(data, "session.bootstrapConfigured"), "remove after first admin", "removed"),
            readPath(data, "session.bootstrapConfigured") ? "warning" : "success",
          ),
          metricRow("Database URL", booleanLabel(readPath(data, "capabilities.databaseConfigured"), "configured", "missing"), readPath(data, "capabilities.databaseConfigured") ? "success" : "danger"),
          metricRow("OpenAI API key", booleanLabel(readPath(data, "capabilities.openaiConfigured"), "configured", "fallback"), readPath(data, "capabilities.openaiConfigured") ? "success" : "warning"),
          metricRow("Gemini API key", booleanLabel(readPath(data, "capabilities.geminiConfigured"), "configured", "missing"), readPath(data, "capabilities.geminiConfigured") ? "success" : "warning"),
          metricRow("Anthropic API key", booleanLabel(readPath(data, "capabilities.anthropicConfigured"), "configured", "missing"), readPath(data, "capabilities.anthropicConfigured") ? "success" : "warning"),
          metricRow("Google media APIs", booleanLabel(readPath(data, "capabilities.googleMediaConfigured"), "configured", "missing"), readPath(data, "capabilities.googleMediaConfigured") ? "success" : "warning"),
          metricRow("Health endpoint", stringPath(data, "health.status", "unknown"), toneForStatus(readPath(data, "health.status"))),
        ],
      },
      {
        title: "Vector and memory backend",
        description: "Persistence and retrieval backend status.",
        emptyLabel: "Capability data unavailable.",
        rows: (data) => {
          const snapshotStatus = stringPath(
            data,
            "capabilities.storageSnapshot.status",
            "unknown",
          );
          const snapshotReason = stringPath(
            data,
            "capabilities.storageSnapshot.reason",
            "",
          );
          const snapshotCheckedAt = stringPath(
            data,
            "capabilities.storageSnapshot.checkedAt",
            "",
          );
          const memoryStatus = stringPath(
            data,
            "capabilities.memory.status",
            "unknown",
          );
          const knowledgeStatus = stringPath(
            data,
            "capabilities.knowledge.status",
            "unknown",
          );
          return [
            metricRow("Storage backend", stringPath(data, "capabilities.storageBackend", "unknown")),
            {
              title: "Storage snapshot",
              status: snapshotStatus,
              meta: snapshotReason
                ? `Fallback reason: ${snapshotReason}`
                : "Latest tenant-scoped aggregate read",
              ...(snapshotCheckedAt ? { time: snapshotCheckedAt } : {}),
              tone: toneForStatus(snapshotStatus),
            },
            metricRow("Vector store", stringPath(data, "capabilities.vectorStore.status", "unknown"), toneForStatus(readPath(data, "capabilities.vectorStore.status"))),
            metricRow(
              "Memory total",
              memoryStatus === "unavailable"
                ? "Unavailable"
                : numberPath(data, "capabilities.memory.total"),
              toneForStatus(memoryStatus),
            ),
            metricRow(
              "Knowledge documents",
              knowledgeStatus === "unavailable"
                ? "Unavailable"
                : numberPath(data, "capabilities.knowledge.documents"),
              toneForStatus(knowledgeStatus),
            ),
          ];
        },
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
  const {
    session: workspaceSession,
    status: sessionStatus,
    error: workspaceSessionError,
    role,
  } = useWorkspaceSession();
  const config = domainConfigs[domain];
  const Icon = config.icon;
  const usesDaybook = [
    "workflows",
    "evaluations",
    "monitoring",
    "security",
  ].includes(domain);
  const [resources, setResources] = useState<Record<string, ResourceState>>({});
  const [lastRefresh, setLastRefresh] = useState<string>();
  const [actionResult, setActionResult] = useState<ActionResult>();
  const [copyResultStatus, setCopyResultStatus] = useState<"copied" | "error">();
  const [runningAction, setRunningAction] = useState<string>();
  const [actionFormVersion, setActionFormVersion] = useState(0);
  const [advancedControlsOpen, setAdvancedControlsOpen] = useState(false);
  const [actionDefaults, setActionDefaults] = useState<
    Record<string, Record<string, FormValue>>
  >({});
  const [announcement, setAnnouncement] = useState("Workspace ready.");
  const loadController = useRef<AbortController | null>(null);
  const settingsRetryTimer = useRef<number | null>(null);
  const settingsRetryCount = useRef(0);
  const actionRequestKeys = useRef<
    Record<string, { signature: string; key: string }>
  >({});

  const data = useMemo(() => {
    return Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, value.data])) as DomainData;
  }, [resources]);

  async function load(options: { settingsRetry?: boolean } = {}) {
    if (!options.settingsRetry) {
      settingsRetryCount.current = 0;
    }
    if (settingsRetryTimer.current !== null) {
      window.clearTimeout(settingsRetryTimer.current);
      settingsRetryTimer.current = null;
    }
    if (sessionStatus === "loading") {
      return;
    }
    if (sessionStatus === "error" || !workspaceSession) {
      setResources(
        Object.fromEntries(
          config.endpoints.map((endpoint) => [
            endpoint.key,
            {
              status: "error",
              error: workspaceSessionError || "Session status is unavailable.",
            } satisfies ResourceState,
          ]),
        ),
      );
      setAnnouncement(`${config.title} could not verify the current session.`);
      return;
    }
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const session = asRecord(workspaceSession);
    setAnnouncement(`Refreshing ${config.title}.`);
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
        let resource: ResourceState;
        try {
          const data = await readJson(endpoint.path, {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15_000),
            ]),
          });
          resource = { status: "ready", data };
        } catch (error) {
          const message = error instanceof HttpError || error instanceof Error ? error.message : "Request failed.";
          const code = error instanceof HttpError ? error.status : undefined;
          resource = {
            status: "error",
            error:
              error instanceof DOMException && error.name === "TimeoutError"
                ? `${endpoint.label} took too long to respond.`
                : message,
            code,
          };
        }
        if (!controller.signal.aborted) {
          setResources((current) => ({
            ...current,
            [endpoint.key]: resource,
          }));
        }
        return [endpoint.key, resource] as const;
      }),
    );

    if (controller.signal.aborted) {
      return;
    }
    setLastRefresh(new Date().toLocaleTimeString());
    const settingsSnapshotDegraded =
      domain === "settings" &&
      entries.some(
        ([key, resource]) =>
          key === "capabilities" &&
          resource.status === "ready" &&
          stringPath(resource.data, "storageSnapshot.status", "") ===
            "degraded",
      );
    if (settingsSnapshotDegraded && settingsRetryCount.current < 3) {
      settingsRetryCount.current += 1;
      const retryDelayMs = 1_000 * settingsRetryCount.current;
      setAnnouncement(
        `Settings storage is warming. Retrying in ${settingsRetryCount.current} second${
          settingsRetryCount.current === 1 ? "" : "s"
        }.`,
      );
      settingsRetryTimer.current = window.setTimeout(() => {
        settingsRetryTimer.current = null;
        void load({ settingsRetry: true });
      }, retryDelayMs);
      return;
    }
    if (!settingsSnapshotDegraded) {
      settingsRetryCount.current = 0;
    }
    setAnnouncement(
      settingsSnapshotDegraded
        ? "Settings refreshed, but the storage snapshot is still unavailable. Use Refresh to try again."
        : entries.some(([, resource]) => resource.status === "error")
        ? `${config.title} refreshed with unavailable sources.`
        : `${config.title} refreshed.`,
    );
  }

  useEffect(() => {
    if (sessionStatus === "loading") {
      return;
    }
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      if (settingsRetryTimer.current !== null) {
        window.clearTimeout(settingsRetryTimer.current);
        settingsRetryTimer.current = null;
      }
      loadController.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, sessionStatus, workspaceSession]);

  useEffect(() => {
    if (domain !== "settings") {
      return;
    }

    let prefill: Record<string, FormValue> | undefined;
    try {
      const raw =
        window.sessionStorage.getItem(ASAEL_PENDING_USER_PROVISION_KEY) ||
        window.sessionStorage.getItem(LEGACY_PENDING_USER_PROVISION_KEY);
      const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
      const name = typeof parsed?.name === "string" ? parsed.name.trim().slice(0, 120) : "";
      const email = typeof parsed?.email === "string" ? parsed.email.trim().slice(0, 254) : "";
      const accessRequestId =
        typeof parsed?.accessRequestId === "string"
          ? parsed.accessRequestId.trim()
          : "";
      if (name && email && accessRequestId) {
        prefill = { accessRequestId, name, email };
      }
    } catch {
      // Settings stays usable when browser storage contains invalid data.
    }

    if (!prefill) {
      try {
        window.sessionStorage.removeItem(ASAEL_PENDING_USER_PROVISION_KEY);
        window.sessionStorage.removeItem(LEGACY_PENDING_USER_PROVISION_KEY);
      } catch {
        // Ignore unavailable browser storage.
      }
      return;
    }
    const provisioningDefaults = prefill;
    const timer = window.setTimeout(() => {
      setActionDefaults({ "create-user": provisioningDefaults });
      setActionFormVersion((version) => version + 1);
      setAdvancedControlsOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [domain]);

  const protectedError = Object.values(resources).find((resource) => resource.code === 401 || resource.code === 403);
  const anyLoading = Object.values(resources).some((resource) => resource.status === "loading");
  const approvalDisabledReason = permissionMessage(
    workspaceSession,
    sessionStatus,
    "manage.workflow",
  );
  const connectorReviewDisabledReason = permissionMessage(
    workspaceSession,
    sessionStatus,
    "manage.connector",
  );
  const personalSourceDisabledReason = permissionMessage(
    workspaceSession,
    sessionStatus,
    "write.memory",
  );

  async function runAction(action: DomainAction, values: Record<string, FormValue>) {
    const disabledReason = permissionMessage(
      workspaceSession,
      sessionStatus,
      actionPermission(action),
    );
    if (disabledReason) {
      setActionResult({ title: action.title, status: "error", message: disabledReason });
      return;
    }
    setRunningAction(action.id);
    setActionResult(undefined);
    setCopyResultStatus(undefined);
    setAnnouncement(`${action.title} started.`);
    try {
      const body = action.buildPayload?.(values);
      const sendsJson = action.method === "POST" || action.method === "PATCH";
      const actionPath = action.buildPath?.(values) || action.path;
      const requestSignature = JSON.stringify([actionPath, body || {}]);
      const previousRequest = actionRequestKeys.current[action.id];
      const requestKey =
        previousRequest?.signature === requestSignature
          ? previousRequest.key
          : crypto.randomUUID();
      actionRequestKeys.current[action.id] = {
        signature: requestSignature,
        key: requestKey,
      };
      const result = await readJson(actionPath, {
        method: action.method,
        headers: sendsJson
          ? {
              "content-type": "application/json",
              "idempotency-key": requestKey,
            }
          : undefined,
        body: sendsJson ? JSON.stringify(body || {}) : undefined,
      });
      const discoveryFailed = Boolean(readPath(result, "discoveryFailed"));
      const payloadError = stringValue(
        readPath(result, "error") ||
          (discoveryFailed ? readPath(result, "message") : undefined),
      );
      if (discoveryFailed || payloadError) {
        throw new Error(payloadError || `${action.title} failed.`);
      }
      delete actionRequestKeys.current[action.id];
      const jobStatus = stringValue(readPath(result, "job.status"));
      const jobId = stringValue(readPath(result, "job.id"));
      const queued = ["queued", "running"].includes(jobStatus);
      setActionResult({
        title: action.title,
        status: "success",
        message: queued
          ? `Action queued for background processing${jobId ? ` as ${jobId}` : ""}.`
          : "Action completed.",
        data: result,
      });
      if (action.id === "create-user") {
        try {
          window.sessionStorage.removeItem(ASAEL_PENDING_USER_PROVISION_KEY);
          window.sessionStorage.removeItem(LEGACY_PENDING_USER_PROVISION_KEY);
        } catch {
          // Ignore unavailable browser storage.
        }
      }
      setActionDefaults((current) => {
        if (!current[action.id]) {
          return current;
        }
        const next = { ...current };
        delete next[action.id];
        return next;
      });
      setActionFormVersion((version) => version + 1);
      setAnnouncement(
        queued
          ? `${action.title} queued for background processing.`
          : `${action.title} completed.`,
      );
      await load();
    } catch (error) {
      setActionResult({
        title: action.title,
        status: "error",
        message: error instanceof Error ? error.message : "Action failed.",
      });
      setAnnouncement(`${action.title} failed.`);
    } finally {
      setRunningAction(undefined);
    }
  }

  async function copyActionResult() {
    if (!actionResult?.data) {
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(actionResult.data, null, 2));
      setCopyResultStatus("copied");
      setAnnouncement("Action result copied to the clipboard.");
    } catch {
      setCopyResultStatus("error");
      setAnnouncement("Action result could not be copied.");
    }
  }

  async function decideApproval(item: JsonRecord, decision: "approve" | "reject") {
    const disabledReason = permissionMessage(
      workspaceSession,
      sessionStatus,
      "manage.workflow",
    );
    if (disabledReason) {
      setActionResult({ title: "Approval decision", status: "error", message: disabledReason });
      return;
    }
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

  async function reviewConnectorContracts(
    item: JsonRecord,
    kind: "mcp" | "openapi",
  ) {
    if (connectorReviewDisabledReason) {
      setActionResult({
        title: "Connector contract review",
        status: "error",
        message: connectorReviewDisabledReason,
      });
      return;
    }
    const id = textValue(item.id);
    const fingerprint = stringPath(item, "review.fingerprint", "");
    if (!id || !fingerprint) {
      setActionResult({
        title: "Connector contract review",
        status: "error",
        message:
          "The connector review changed or is incomplete. Refresh Integrations and try again.",
      });
      return;
    }

    const actionId = `review-${kind}-${id}`;
    const label = kind === "mcp" ? "MCP" : "OpenAPI";
    setRunningAction(actionId);
    setActionResult(undefined);
    setAnnouncement(`Approving the current ${label} contract catalog.`);
    try {
      const result = await readJson(
        kind === "mcp"
          ? `/api/connectors/${encodeURIComponent(id)}/review`
          : `/api/openapi-connectors/${encodeURIComponent(id)}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedFingerprint: fingerprint }),
        },
      );
      const promoted = numberValue(readPath(result, "promoted"), 0);
      setActionResult({
        title: `${label} contract review`,
        status: "success",
        message: promoted
          ? `Approved ${promoted} exact ${label} ${promoted === 1 ? "contract" : "contracts"} and activated the connector.`
          : "No pending contracts remained. The connector view was refreshed.",
        data: result,
      });
      setAnnouncement(`${label} contract review completed.`);
      await load();
    } catch (error) {
      setActionResult({
        title: `${label} contract review`,
        status: "error",
        message:
          error instanceof Error ? error.message : "Contract review failed.",
      });
      setAnnouncement(`${label} contract review failed.`);
    } finally {
      setRunningAction(undefined);
    }
  }

  return (
    <div
      className={clsx(
        "px-4 py-6 sm:px-6 lg:px-8",
        usesDaybook && styles.daybook,
        usesDaybook && styles.domain,
      )}
      aria-busy={anyLoading || Boolean(runningAction)}
      data-testid={`${domain}-workspace`}
    >
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <section className="rounded-lg border border-line bg-surface p-5" data-daybook="hero">
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
              disabled={anyLoading}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line bg-background px-3 text-sm font-semibold transition hover:bg-surface-raised"
            >
              {anyLoading ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
              Refresh
            </button>
            <Link
              href="/app/command"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-ink transition hover:brightness-105"
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
              <EndpointStatus key={endpoint.key} label={endpoint.label} status={state} />
            );
          })}
          {lastRefresh ? <span className="inline-flex items-center rounded-md border border-line bg-background px-2.5 py-1.5">Updated {lastRefresh}</span> : null}
        </div>
      </section>

      {protectedError ? (
        <section className="mt-4 rounded-lg border border-warning/45 bg-warning/10 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold">
                {protectedError.code === 401 ? "Sign in to load this workspace" : "Your role cannot load every source"}
              </p>
              <p className="mt-1 text-sm text-muted">{protectedError.error}</p>
              {protectedError.code === 403 ? <p className="mt-1 text-xs text-muted">Current role: {role}.</p> : null}
            </div>
            {protectedError.code === 401 ? (
              <Link href="/login" className="primary-button">Sign in</Link>
            ) : null}
          </div>
        </section>
      ) : null}

      {domain === "integrations" ? (
        <PersonalConnections
          payload={data.oauth}
          loading={resources.oauth?.status === "loading"}
          error={resources.oauth?.status === "error" ? resources.oauth.error : undefined}
          disabledReason={personalSourceDisabledReason}
          onRefresh={load}
        />
      ) : null}

      {domain === "integrations" ? (
        <div className="mt-4" data-daybook="mcp-manager">
          <McpConnections
            payload={data.connectors}
            loading={resources.connectors?.status === "loading"}
            error={
              resources.connectors?.status === "error"
                ? resources.connectors.error
                : undefined
            }
            disabledReason={connectorReviewDisabledReason}
            onRefresh={load}
          />
        </div>
      ) : null}

      {domain === "settings" ? <PersonalDataControls /> : null}

      {domain === "security" ? <section className="mt-4 flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 sm:flex-row sm:items-center sm:justify-between" data-daybook="panel"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Tamper-evident evidence</p><h2 className="mt-1 text-base font-semibold">Signed audit chain</h2><p className="mt-1 text-sm text-muted">Download a chronologically chained, HMAC-signed audit export for offline verification.</p></div><a href="/api/security/audits/export" download className="primary-button shrink-0"><Download size={15} aria-hidden="true" />Download signed audit</a></section> : null}

      <section className="mt-4 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4" data-daybook="metrics">
        {config.metrics.map((metric) => {
          const resource = resources[metricResourceKey(domain, metric.label)];
          const value = metricDisplayValue(metric, data, resource);
          return (
            <div key={metric.label} className="min-h-28 bg-surface p-4">
              <p className="text-xs text-muted">{metric.label}</p>
              <p className={clsx("mt-3 font-mono text-2xl", toneClass(metricDisplayTone(metric, value, resource)))}>
                {value}
              </p>
              <p className="mt-2 text-xs leading-5 text-muted">{metric.description}</p>
            </div>
          );
        })}
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[0.72fr_1.18fr_0.74fr]" data-daybook="spread">
        <div className="space-y-4">
          <Panel title="Workflow" description="How this page should be used.">
            <div className="space-y-3">
              {config.flow.map((step, index) => {
                const StepIcon = step.icon;
                return (
                  <div key={step.title} className="rounded-md border border-line bg-background p-3" data-daybook="flow-step">
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
          {domain === "integrations" ? (
            <ConnectorContractReviewPanel
              mcpConnectors={arrayPath(data, "connectors.connectors")}
              mcpTools={arrayPath(data, "connectors.tools")}
              openApiConnectors={arrayPath(data, "openapi.connectors")}
              openApiOperations={arrayPath(data, "openapi.operations")}
              runningAction={runningAction}
              disabledReason={connectorReviewDisabledReason}
              onReview={(item, kind) =>
                void reviewConnectorContracts(item, kind)
              }
            />
          ) : null}
          {domain === "approvals" ? (
            <ApprovalDecisionPanel
              items={arrayPath(data, "approvals.items")}
              runningAction={runningAction}
              disabledReason={approvalDisabledReason}
              onDecision={(item, decision) => void decideApproval(item, decision)}
            />
          ) : null}
          {config.sections.map((section) => (
            <DataPanel
              key={section.title}
              section={section}
              data={data}
              resources={sectionResourceStates(domain, section.title, resources)}
            />
          ))}
        </div>

        <div className="space-y-4">
          <Panel title="Actions" description={config.actions.length ? "Run page-specific operations without leaving this workspace." : "This surface is currently read and review focused."}>
            {config.actions.length ? (
              advancedControlsOpen ? (
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => setAdvancedControlsOpen(false)}
                    className="inline-flex min-h-10 w-full items-center justify-center rounded-md border border-line bg-background px-3 text-xs font-semibold transition hover:bg-surface-raised"
                    aria-expanded="true"
                  >
                    Hide advanced controls
                  </button>
                  <DomainActionForms
                    key={actionFormVersion}
                    actions={config.actions}
                    defaultValues={actionDefaults}
                    runningAction={runningAction}
                    disabledReasons={Object.fromEntries(
                      config.actions.map((action) => [
                        action.id,
                        permissionMessage(
                          workspaceSession,
                          sessionStatus,
                          actionPermission(action),
                        ),
                      ]),
                    )}
                    workflowRuns={workflowControlRunsFrom(
                      readPath(data, "workflows.runs"),
                    )}
                    onRun={(action, values) => void runAction(action, values)}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAdvancedControlsOpen(true)}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-line bg-background px-3 text-sm font-semibold transition hover:bg-surface-raised"
                  aria-expanded="false"
                >
                  Load advanced controls
                </button>
              )
            ) : (
              <div className="space-y-3">
                <div className="rounded-md border border-line bg-background p-4 text-sm leading-6 text-muted">
                  Review the live data, then use related workspaces for changes that need stronger guardrails.
                </div>
              </div>
            )}
          </Panel>

          {actionResult ? (
            <Panel title={actionResult.title} description={actionResult.status === "success" ? "Result from the last action." : "Action failed."}>
              <div
                className={clsx("rounded-md border p-3 text-sm", actionResult.status === "success" ? "border-success/35 bg-success/10" : "border-danger/35 bg-danger/10")}
                role={actionResult.status === "success" ? "status" : "alert"}
              >
                <div className="flex items-center gap-2 font-semibold">
                  {actionResult.status === "success" ? <CheckCircle2 size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}
                  {actionResult.message}
                </div>
                {actionResult.data ? (
                  <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-background p-3 text-xs text-muted">
                    {JSON.stringify(actionResult.data, null, 2)}
                  </pre>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {actionResult.data ? (
                    <button
                      type="button"
                      onClick={() => void copyActionResult()}
                      className="inline-flex min-h-9 items-center rounded-md border border-line bg-background px-3 text-xs font-semibold transition hover:bg-surface-raised"
                    >
                      {copyResultStatus === "copied" ? "Copied" : "Copy result"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setActionResult(undefined);
                      setCopyResultStatus(undefined);
                    }}
                    className="inline-flex min-h-9 items-center rounded-md border border-line bg-background px-3 text-xs font-semibold transition hover:bg-surface-raised"
                  >
                    Clear result
                  </button>
                </div>
                {copyResultStatus === "error" ? (
                  <p className="mt-2 text-xs text-danger" role="alert">
                    Clipboard access failed. Select the result text and copy it manually.
                  </p>
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
    <section className="rounded-lg border border-line bg-surface p-4" data-daybook="panel">
      <div className="mb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

function EndpointStatus({ label, status }: { label: string; status: ResourceState["status"] }) {
  const Icon =
    status === "ready"
      ? CheckCircle2
      : status === "error"
        ? AlertTriangle
        : status === "loading"
          ? Loader2
          : CircleHelp;
  const stateLabel =
    status === "ready"
      ? "Ready"
      : status === "error"
        ? "Unavailable"
        : status === "loading"
          ? "Loading"
          : "Unknown";
  return (
    <span className="inline-flex min-h-8 items-center gap-2 rounded-md border border-line bg-background px-2.5 py-1.5" data-daybook="status">
      <Icon
        size={13}
        className={clsx(
          status === "ready"
            ? "text-success"
            : status === "error"
              ? "text-danger"
              : "text-muted",
          status === "loading" && "animate-spin",
        )}
        aria-hidden="true"
      />
      <span>{label}: {stateLabel}</span>
    </span>
  );
}

function DataPanel({
  section,
  data,
  resources,
}: {
  section: DataSection;
  data: DomainData;
  resources: ResourceState[];
}) {
  const rows = section.rows(data).filter((row) => row.title || row.status || row.meta);
  const loading = resources.some((resource) => resource.status === "loading" || resource.status === "idle");
  const errors = resources.filter((resource) => resource.status === "error");
  return (
    <Panel title={section.title} description={section.description}>
      {loading && rows.length ? (
        <div className="mb-3 rounded-md border border-info/40 bg-info/10 p-3 text-xs leading-5 text-muted" role="status">
          Refreshing. The last loaded rows remain visible.
        </div>
      ) : null}
      {errors.length ? (
        <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 p-3" role="alert">
          <p className="text-sm font-semibold">Source unavailable</p>
          {errors.map((resource, index) => (
            <p key={`${resource.code || "error"}-${index}`} className="mt-1 text-xs leading-5 text-muted">
              {resource.error || "This source could not be loaded."}
            </p>
          ))}
        </div>
      ) : null}
      {loading && !rows.length ? (
        <div className="space-y-2" role="status" aria-label={`Loading ${section.title}`}>
          {[0, 1, 2].map((index) => (
            <div key={index} className="rounded-md border border-line bg-background p-3">
              <div className="h-3 w-2/3 animate-pulse rounded bg-surface-raised" />
              <div className="mt-3 h-3 w-1/3 animate-pulse rounded bg-surface-raised" />
            </div>
          ))}
        </div>
      ) : rows.length ? (
        <div className="divide-y divide-line overflow-hidden rounded-md border border-line bg-background" data-daybook="list">
          {rows.slice(0, 8).map((row, index) => (
            <div key={`${row.title}-${index}`} className="grid gap-3 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{row.title}</p>
                <p className="mt-1 line-clamp-2 text-xs text-muted [overflow-wrap:anywhere]">
                  {row.meta || "No extra context"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {row.status ? <span className={clsx("rounded-md px-2 py-1 font-mono text-xs", statusPillClass(row.tone || toneForStatus(row.status)))}>{row.status}</span> : null}
                {row.secondaryStatus ? <span className={clsx("rounded-md px-2 py-1 font-mono text-xs", statusPillClass(row.secondaryTone || "neutral"))}>{row.secondaryStatus}</span> : null}
                {row.time ? <span className="font-mono text-xs text-muted">{formatTime(row.time)}</span> : null}
              </div>
            </div>
          ))}
        </div>
      ) : !errors.length ? (
        <div className="rounded-md border border-dashed border-line bg-background p-4 text-sm leading-6 text-muted">{section.emptyLabel}</div>
      ) : null}
    </Panel>
  );
}

function ConnectorContractReviewPanel({
  mcpConnectors,
  mcpTools,
  openApiConnectors,
  openApiOperations,
  runningAction,
  disabledReason,
  onReview,
}: {
  mcpConnectors: JsonRecord[];
  mcpTools: JsonRecord[];
  openApiConnectors: JsonRecord[];
  openApiOperations: JsonRecord[];
  runningAction?: string;
  disabledReason?: string;
  onReview: (item: JsonRecord, kind: "mcp" | "openapi") => void;
}) {
  const reviews = [
    ...mcpConnectors.map((connector) => ({
      connector,
      kind: "mcp" as const,
      contracts: mcpTools.filter(
        (tool) =>
          textValue(tool.connectorId) === textValue(connector.id) &&
          textValue(tool.status) === "pending_review",
      ),
    })),
    ...openApiConnectors.map((connector) => ({
      connector,
      kind: "openapi" as const,
      contracts: openApiOperations.filter(
        (operation) =>
          textValue(operation.connectorId) === textValue(connector.id) &&
          textValue(operation.status) === "pending_review",
      ),
    })),
  ].filter(
    ({ connector }) => isConnectorReviewable(connector),
  );

  if (!reviews.length) {
    return null;
  }

  return (
    <Panel
      title="Contract review queue"
      description="Inspect newly discovered operations here. Approval activates the connector and is bound to this exact catalog, so a concurrent contract change is rejected."
    >
      {disabledReason ? (
        <div className="mb-3 rounded-md border border-warning/45 bg-warning/10 p-3 text-xs leading-5 text-muted">
          {disabledReason}
        </div>
      ) : null}
      <div className="space-y-3">
        {reviews.map(({ connector, kind, contracts }) => {
          const id = textValue(connector.id);
          const actionId = `review-${kind}-${id}`;
          const pendingCount = numberValue(
            readPath(connector, "review.pendingCount"),
            contracts.length,
          );
          const label = kind === "mcp" ? "MCP" : "OpenAPI";
          const busy = runningAction === actionId;
          return (
            <article
              key={`${kind}-${id}`}
              aria-label={`${stringValue(
                connector.name,
                `${label} connector`,
              )} ${label} contract review`}
              className="rounded-md border border-warning/45 bg-warning/10 p-3"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {stringValue(connector.name, `${label} connector`)}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {pendingCount} newly discovered{" "}
                    {pendingCount === 1 ? "contract needs" : "contracts need"}{" "}
                    review before execution.
                  </p>
                </div>
                <span className="shrink-0 rounded-md bg-warning/15 px-2 py-1 font-mono text-xs text-warning">
                  {label}
                </span>
              </div>

              <ul className="mt-3 divide-y divide-line overflow-hidden rounded-md border border-line bg-background">
                {contracts.slice(0, 8).map((contract, index) => (
                  <li
                    key={textValue(contract.id, `${id}-${index}`)}
                    className="p-3"
                  >
                    <p className="text-xs font-semibold [overflow-wrap:anywhere]">
                      {connectorContractLabel(contract, kind)}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted [overflow-wrap:anywhere]">
                      {connectorContractMeta(contract)}
                    </p>
                  </li>
                ))}
              </ul>
              {contracts.length > 8 ? (
                <p className="mt-2 text-xs text-muted">
                  Plus {contracts.length - 8} more contracts in this exact
                  catalog.
                </p>
              ) : null}

              <button
                type="button"
                onClick={() => onReview(connector, kind)}
                disabled={Boolean(disabledReason) || Boolean(runningAction)}
                className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-semibold text-primary-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-55"
              >
                {busy ? (
                  <Loader2
                    size={14}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <ShieldCheck size={14} aria-hidden="true" />
                )}
                {busy
                  ? "Approving and activating"
                  : "Approve and activate connector"}
              </button>
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

export function mcpConnectorRow(item: JsonRecord): Row {
  const pending = numberValue(readPath(item, "review.pendingCount"), 0);
  const connectorStatus = stringValue(item.status, "unknown");
  const needsReview = isConnectorReviewable(item);
  const contracts = arrayPath(item, "review.contracts")
    .map((contract) => stringValue(contract.name))
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");
  return {
    title: stringValue(item.name, "MCP connector"),
    status: needsReview ? "review required" : connectorStatus,
    meta: needsReview
      ? `${pending} pending${contracts ? `: ${contracts}` : ""} · connector ${stringValue(item.id)}`
      : stringValue(item.endpoint, "endpoint"),
    time: stringValue(item.updatedAt || item.createdAt),
    tone: needsReview ? "warning" : toneForStatus(connectorStatus),
  };
}

export function isConnectorReviewable(connector: JsonRecord) {
  const status = textValue(connector.status);
  return (
    (status === "active" || status === "disabled") &&
    numberValue(readPath(connector, "review.pendingCount"), 0) > 0
  );
}

function connectorContractLabel(
  contract: JsonRecord,
  kind: "mcp" | "openapi",
) {
  if (kind === "openapi") {
    return `${textValue(contract.method, "operation").toUpperCase()} ${textValue(
      contract.path,
      stringValue(contract.operationId, "Unnamed operation"),
    )}`;
  }
  return stringValue(
    contract.title || contract.name,
    "Unnamed MCP tool",
  );
}

function connectorContractMeta(contract: JsonRecord) {
  const risk = textValue(contract.riskLevel, "unknown");
  const approval = Boolean(contract.approvalRequired)
    ? "approval required"
    : "no per-call approval";
  const properties = Object.keys(
    asRecord(readPath(contract, "inputSchema.properties")),
  ).slice(0, 6);
  const inputSummary = properties.length
    ? `inputs: ${properties.join(", ")}`
    : "no declared inputs";
  const description = textValue(contract.summary || contract.description);
  return [
    `risk ${risk}`,
    approval,
    inputSummary,
    description,
  ]
    .filter(Boolean)
    .join(" · ");
}

function ApprovalDecisionPanel({
  items,
  runningAction,
  disabledReason,
  onDecision,
}: {
  items: JsonRecord[];
  runningAction?: string;
  disabledReason?: string;
  onDecision: (item: JsonRecord, decision: "approve" | "reject") => void;
}) {
  return (
    <Panel title="Decision queue" description="Approve or reject blocking items from the same surface that shows their risk and reason.">
      {disabledReason ? (
        <div className="rounded-md border border-warning/45 bg-warning/10 p-4 text-sm leading-6 text-muted">
          <span className="font-semibold text-foreground">Decision controls unavailable.</span> {disabledReason}
        </div>
      ) : items.length ? (
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
                      disabled={isRunning || Boolean(disabledReason)}
                      title={disabledReason}
                      onClick={() => onDecision(item, "reject")}
                      className="inline-flex h-9 items-center justify-center rounded-md border border-line px-3 text-xs font-semibold transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      disabled={isRunning || Boolean(disabledReason)}
                      title={disabledReason}
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

const metricResourceKeys: Record<DomainConsoleKey, Record<string, string>> = {
  knowledge: {
    Memories: "capabilities",
    Documents: "capabilities",
    "Graph nodes": "capabilities",
    "Retrieval traces": "capabilities",
  },
  workflows: {
    Active: "workflows",
    Waiting: "workflows",
    "Queue jobs": "operations",
    Triggers: "triggers",
  },
  approvals: {
    "Total pending": "approvals",
    Tools: "approvals",
    Workflows: "approvals",
    "SLO policy": "approvals",
  },
  integrations: {
    "MCP active": "connectors",
    OpenAPI: "openapi",
    Catalog: "catalog",
    Tools: "tools",
  },
  tools: {
    Registered: "tools",
    "Approval waits": "approvals",
    Failed: "tools",
    "Dry runs": "tools",
  },
  evaluations: {
    "Eval runs": "evaluations",
    Cases: "evaluations",
    Recurring: "failureFeedback",
    "Rule review": "failureFeedback",
    "Release gate": "release",
    Isolation: "isolation",
  },
  monitoring: {
    Events: "observability",
    SLO: "slo",
    Breaches: "slo",
    Incidents: "incidents",
  },
  security: {
    Role: "context",
    Tenant: "context",
    Audits: "audits",
    Isolation: "isolation",
  },
  settings: {
    Auth: "session",
    Database: "capabilities",
    Storage: "capabilities",
    OpenAI: "capabilities",
    Users: "identity",
  },
};

const sectionResourceKeys: Record<DomainConsoleKey, Record<string, string[]>> = {
  knowledge: {
    "Recent memories": ["memory"],
    "Knowledge documents": ["knowledge"],
    "Graph recall": ["graph"],
  },
  workflows: {
    "Live workflow runs": ["workflows"],
    "Generated plans": ["plans"],
    Triggers: ["triggers"],
  },
  approvals: {
    "Approval queue": ["approvals"],
    "Operational blockers": ["operations"],
  },
  integrations: {
    "MCP connectors": ["connectors"],
    "OpenAPI connectors": ["openapi"],
    "Catalog suggestions": ["catalog"],
  },
  tools: {
    "Available tools": ["tools"],
    "Pending tool approvals": ["approvals"],
  },
  evaluations: {
    "Evaluation runs": ["evaluations"],
    "Recurring failures": ["failureFeedback"],
    "Harness rule proposals": ["failureFeedback"],
    "Release gate": ["release"],
    Cases: ["evaluations"],
  },
  monitoring: {
    "Runtime timeline": ["observability"],
    "SLO breaches": ["slo"],
    Incidents: ["incidents"],
  },
  security: {
    "Audit records": ["audits"],
    "RBAC rules": ["context"],
    "Release security gate": ["release"],
    "Sensitive-data retention": ["retention"],
  },
  settings: {
    "Configuration checklist": ["session", "capabilities", "health"],
    "Vector and memory backend": ["capabilities"],
    "Team members": ["identity"],
  },
};

function metricResourceKey(domain: DomainConsoleKey, label: string) {
  return metricResourceKeys[domain][label];
}

function metricDisplayValue(
  metric: MetricConfig,
  data: DomainData,
  resource?: ResourceState,
) {
  if (!resource || resource.status === "idle" || resource.status === "loading") {
    return "Loading";
  }
  if (resource.status === "error") {
    return "Unavailable";
  }
  const value = metric.value(data);
  return value || "Unknown";
}

function metricDisplayTone(
  metric: MetricConfig,
  value: string,
  resource?: ResourceState,
): MetricConfig["tone"] {
  if (!resource || resource.status !== "ready" || ["Loading", "Unavailable", "Unknown"].includes(value)) {
    return "neutral";
  }
  const statusTone = toneForStatus(value);
  if (statusTone !== "neutral") {
    return statusTone;
  }
  if (/^-?\d+(\.\d+)?$/.test(value) && Number(value) === 0) {
    return "neutral";
  }
  return metric.tone || "neutral";
}

function sectionResourceStates(
  domain: DomainConsoleKey,
  title: string,
  resources: Record<string, ResourceState>,
) {
  return (sectionResourceKeys[domain][title] || [])
    .map((key) => resources[key])
    .filter((resource): resource is ResourceState => Boolean(resource));
}

function actionPermission(action: DomainAction): WorkspacePermission {
  if (action.method === "GET" || action.path.startsWith("/api/retrieval/plan")) {
    return "read";
  }
  if (
    action.path.startsWith("/api/memory") ||
    action.path.startsWith("/api/ingest")
  ) {
    return "write.memory";
  }
  if (
    action.path.startsWith("/api/connectors") ||
    action.path.startsWith("/api/openapi-connectors")
  ) {
    return "manage.connector";
  }
  if (action.path.startsWith("/api/auth/control-plane")) {
    return "manage.identity";
  }
  if (action.path.startsWith("/api/security/retention")) {
    return "manage.identity";
  }
  if (action.path.startsWith("/api/tools")) {
    return "execute.tool";
  }
  if (action.path.startsWith("/api/evaluations")) {
    return "run.evaluation";
  }
  if (
    action.path.startsWith("/api/workflows") ||
    action.path.startsWith("/api/operations") ||
    action.path.startsWith("/api/observability")
  ) {
    return "manage.workflow";
  }
  return "read";
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
  if (required === "manage.identity" && !hasRole(role, ["admin", "system"])) {
    return { allowed: false, code: 403, message: "Admin role required to manage workspace identities." };
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
  if (path.startsWith("/api/auth/control-plane")) {
    return "manage.identity";
  }
  if (
    path.startsWith("/api/release/evidence") ||
    path.startsWith("/api/security/audits") ||
    path.startsWith("/api/security/isolation-report") ||
    path.startsWith("/api/security/retention") ||
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

function stringPath(source: unknown, path: string, fallback = "Unknown") {
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
  return "Unknown";
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
  if (typeof value !== "boolean") {
    return "unknown";
  }
  return value ? trueLabel : falseLabel;
}

function summaryValue(value: unknown) {
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    return "No summary";
  }
  const passed = stringValue(record.passed, "unknown");
  const failed = stringValue(record.failed, "unknown");
  const warnings = stringValue(record.warnings, "unknown");
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
      meta: `${stringValue(summary.failures, "unknown")} failures / ${stringValue(summary.warnings, "unknown")} warnings`,
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
  if (["healthy", "passed", "success", "succeeded", "completed", "executed", "active", "allow", "approved", "ready", "info"].includes(text)) {
    return "success";
  }
  if (["warn", "warning", "waiting", "waiting_approval", "partial", "queued", "paused", "pending", "degraded", "dry_run", "unavailable"].includes(text)) {
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
