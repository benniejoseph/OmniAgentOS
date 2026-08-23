import {
  Activity,
  Brain,
  Cable,
  CheckCircle2,
  Database,
  FileText,
  GitBranch,
  Globe2,
  Layers3,
  LockKeyhole,
  Settings,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Workflow,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";

export type NavIcon = ComponentType<{ size?: number; className?: string }>;

export type AppNavItem = {
  href: string;
  label: string;
  description: string;
  icon: NavIcon;
  shortLabel?: string;
};

export type AppNavGroup = {
  label: string;
  items: AppNavItem[];
  collapsible?: boolean;
};

export type ProductPage = AppNavItem & {
  eyebrow: string;
  headline: string;
  summary: string;
  metrics: { label: string; value: string }[];
  architecture: { label: string; detail: string }[];
  signals: string[];
  sections: { title: string; body: string; points: string[] }[];
};

export const appNav: AppNavItem[] = [
  {
    href: "/app/command",
    label: "Start",
    shortLabel: "Start",
    description: "Describe an outcome and choose how the agent should run it.",
    icon: TerminalSquare,
  },
  {
    href: "/app",
    label: "Runs",
    shortLabel: "Runs",
    description: "Watch active and recent tasks, workflows, and blockers.",
    icon: Activity,
  },
  {
    href: "/app/approvals",
    label: "Approvals",
    shortLabel: "Approvals",
    description: "Review actions and access requests that need a decision.",
    icon: CheckCircle2,
  },
  {
    href: "/app/results",
    label: "Results",
    description: "Review completed work with its evidence and verification.",
    icon: FileText,
  },
  {
    href: "/app/workflows",
    label: "Workflows",
    description: "Multi-step jobs that run in the background with retries and approvals.",
    icon: Workflow,
  },
  {
    href: "/app/memory",
    label: "Knowledge",
    description: "What the agent remembers: saved facts, documents, and past learnings.",
    icon: Brain,
  },
  {
    href: "/app/connectors",
    label: "Integrations",
    shortLabel: "Integrate",
    description: "Connect external tools and APIs the agent is allowed to use.",
    icon: Cable,
  },
  {
    href: "/app/tools",
    label: "Tools",
    shortLabel: "Tools",
    description: "What the agent can do, with risk levels and an audit trail.",
    icon: Wrench,
  },
  {
    href: "/app/evaluations",
    label: "Quality Checks",
    shortLabel: "Checks",
    description: "Automated tests that verify the agent behaves before you rely on it.",
    icon: CheckCircle2,
  },
  {
    href: "/app/observability",
    label: "Monitoring",
    description: "System health: events, errors, alerts, and incidents.",
    icon: Layers3,
  },
  {
    href: "/app/security",
    label: "Security",
    description: "Access control, audit logs, and data isolation.",
    icon: ShieldCheck,
  },
  {
    href: "/app/settings",
    label: "Settings",
    description: "Models, environment, and configuration.",
    icon: Settings,
  },
];

// The everyday loop: give work, watch it, resolve blockers, review evidence.
export const primaryNavHrefs = ["/app/command", "/app", "/app/approvals", "/app/results"];

export const appNavGroups: AppNavGroup[] = [
  {
    label: "Operate",
    items: appNav.filter((item) => primaryNavHrefs.includes(item.href)),
  },
  {
    label: "Build and connect",
    collapsible: true,
    items: appNav.filter((item) =>
      [
        "/app/workflows",
        "/app/memory",
        "/app/connectors",
        "/app/tools",
      ].includes(item.href),
    ),
  },
  {
    label: "Admin",
    collapsible: true,
    items: appNav.filter((item) =>
      [
        "/app/evaluations",
        "/app/observability",
        "/app/security",
        "/app/settings",
      ].includes(item.href),
    ),
  },
];

function appNavItem(href: string) {
  const item = appNav.find((entry) => entry.href === href);
  if (!item) {
    throw new Error(`Missing app nav item for ${href}`);
  }
  return item;
}

export const productPages: Record<string, ProductPage> = {
  memory: {
    ...appNavItem("/app/memory"),
    eyebrow: "Memory + RAG",
    headline: "Long-horizon context that stays auditable.",
    summary: "Unify structured memory, source-backed retrieval, graph context, and embeddings into one durable substrate for every agent run.",
    metrics: [
      { label: "Memory modes", value: "4" },
      { label: "Vector backend", value: "HNSW" },
      { label: "Provenance", value: "Chunk" },
    ],
    architecture: [
      { label: "Ingest", detail: "documents, run output, decisions" },
      { label: "Index", detail: "chunks, embeddings, tags" },
      { label: "Retrieve", detail: "semantic, keyword, graph" },
      { label: "Consolidate", detail: "durable memories after runs" },
    ],
    signals: ["pgvector HNSW", "source chunk lineage", "memory graph builds", "retrieval traces"],
    sections: [
      {
        title: "Hybrid context engine",
        body: "Retrieve semantic, keyword, graph, and recent-run context before the model acts.",
        points: ["Source chunks", "Embedding vectors", "Trace ledger"],
      },
      {
        title: "Memory consolidation",
        body: "Successful runs can become durable knowledge with tags, importance, scope, and provenance.",
        points: ["Learned facts", "Run summaries", "Reusable plans"],
      },
      {
        title: "Graph-ready recall",
        body: "Entity and relationship layers make memory navigable when the task needs structure instead of only similarity.",
        points: ["Nodes", "Edges", "Build history"],
      },
    ],
  },
  workflows: {
    ...appNavItem("/app/workflows"),
    eyebrow: "Workflow OS",
    headline: "Durable agent work that survives retries, approvals, and recovery.",
    summary: "Plan, queue, tick, approve, signal, and recover complex agent workflows with auditable state transitions.",
    metrics: [
      { label: "Queue", value: "Durable" },
      { label: "Approvals", value: "Policy" },
      { label: "Recovery", value: "Auto" },
    ],
    architecture: [
      { label: "Plan", detail: "goals become typed nodes" },
      { label: "Queue", detail: "jobs lease and retry" },
      { label: "Tick", detail: "node execution advances state" },
      { label: "Recover", detail: "stale work is inspected or repaired" },
    ],
    signals: ["workflow events", "operation job leases", "approval waits", "recovery playbooks"],
    sections: [
      {
        title: "Plan execution",
        body: "Workflow plans turn goals into nodes with risk, dependencies, tool needs, and verification criteria.",
        points: ["Node graph", "Risk levels", "Execution traces"],
      },
      {
        title: "Queue operations",
        body: "Jobs are leased, retried, completed, failed, or recovered with production-safe queue semantics.",
        points: ["Leases", "Retries", "Drain controls"],
      },
      {
        title: "Human control",
        body: "Sensitive actions can pause for approval while preserving the full workflow state.",
        points: ["Approval queue", "Signals", "Audit events"],
      },
    ],
  },
  connectors: {
    ...appNavItem("/app/connectors"),
    eyebrow: "Connectivity",
    headline: "Connect to tools without turning every integration into a security exception.",
    summary: "Import MCP and OpenAPI capabilities, govern their risk, and block unsafe network or secret references by default.",
    metrics: [
      { label: "Protocols", value: "MCP + REST" },
      { label: "Secrets", value: "Redacted" },
      { label: "Network", value: "Guarded" },
    ],
    architecture: [
      { label: "Discover", detail: "MCP tools and OpenAPI specs" },
      { label: "Classify", detail: "risk and approval defaults" },
      { label: "Guard", detail: "private network and secret checks" },
      { label: "Operate", detail: "status, import, and execution audit" },
    ],
    signals: ["MCP catalog", "OpenAPI operations", "secret deny-list", "private endpoint block"],
    sections: [
      {
        title: "MCP connectors",
        body: "Discover external tools through governed MCP endpoints with status and tool inventory tracking.",
        points: ["Tool discovery", "Risk defaults", "Status sync"],
      },
      {
        title: "OpenAPI imports",
        body: "Turn REST APIs into governed operations with auth env references and operation-level policy.",
        points: ["Spec import", "Operation catalog", "Auth mapping"],
      },
      {
        title: "Connector safety",
        body: "Prevent private endpoint abuse and platform secret exfiltration before execution is possible.",
        points: ["Private network block", "Secret-name redaction", "Approval gates"],
      },
    ],
  },
  tools: {
    ...appNavItem("/app/tools"),
    eyebrow: "Governed Execution",
    headline: "Every tool call knows its risk before it runs.",
    summary: "Treat tools as governed capabilities with dry runs, approval rules, execution records, and operator-grade auditability.",
    metrics: [
      { label: "Risk levels", value: "0-3" },
      { label: "Dry run", value: "First" },
      { label: "Audit", value: "Full" },
    ],
    architecture: [
      { label: "Request", detail: "tool input enters policy" },
      { label: "Decide", detail: "risk controls side effects" },
      { label: "Execute", detail: "dry run or approved call" },
      { label: "Record", detail: "audit output and decision" },
    ],
    signals: ["risk policy", "dry-run support", "approval queue", "tool execution ledger"],
    sections: [
      {
        title: "Policy first",
        body: "Tool execution is routed through policy before side effects are allowed.",
        points: ["Risk scoring", "Approval required", "Reason capture"],
      },
      {
        title: "Execution audit",
        body: "Inputs, decisions, outputs, actor, tenant, and status remain traceable after each call.",
        points: ["Status ledger", "Actor history", "Tenant scope"],
      },
      {
        title: "Operator review",
        body: "Approval requests collect the exact payload and reason needed to decide safely.",
        points: ["Approval queue", "Reject flow", "Post-decision audit"],
      },
    ],
  },
  evaluations: {
    ...appNavItem("/app/evaluations"),
    eyebrow: "Evaluation System",
    headline: "Release decisions backed by signed evidence.",
    summary: "Run regression checks, tenant isolation probes, and release gates with signed reports and downloadable evidence.",
    metrics: [
      { label: "Release gates", value: "6" },
      { label: "Reports", value: "Signed" },
      { label: "Smoke", value: "CI" },
    ],
    architecture: [
      { label: "Run", detail: "case execution starts" },
      { label: "Measure", detail: "status and latency captured" },
      { label: "Sign", detail: "evidence hash generated" },
      { label: "Gate", detail: "release status computed" },
    ],
    signals: ["tenant isolation eval", "signed report", "release evidence JSON", "production smoke artifact"],
    sections: [
      {
        title: "Regression runs",
        body: "Evaluation cases verify security, workflow behavior, and release readiness.",
        points: ["Case runner", "Result ledger", "Latency capture"],
      },
      {
        title: "Release evidence",
        body: "Production release gates combine isolation, SLO, auth, signing, and deployment metadata.",
        points: ["Gate summary", "Warnings", "Blockers"],
      },
      {
        title: "Report integrity",
        body: "Report hashes and signing secrets make evaluation evidence harder to tamper with.",
        points: ["Evidence hash", "Signature", "Verifier endpoint"],
      },
    ],
  },
  observability: {
    ...appNavItem("/app/observability"),
    eyebrow: "Observability",
    headline: "Inspect runtime events, incidents, and recovery.",
    summary: "Track runtime events, route health, SLO policies, incidents, alerts, diagnostics, and recovery actions in one place.",
    metrics: [
      { label: "SLO", value: "Policy" },
      { label: "Incidents", value: "Live" },
      { label: "Alerts", value: "Routed" },
    ],
    architecture: [
      { label: "Capture", detail: "runtime event ledger" },
      { label: "Evaluate", detail: "SLO policies inspect windows" },
      { label: "Escalate", detail: "incidents and alerts route" },
      { label: "Resolve", detail: "diagnostics close the loop" },
    ],
    signals: ["correlation IDs", "SLO policy changes", "incident events", "alert deliveries"],
    sections: [
      {
        title: "Runtime timeline",
        body: "Every API, workflow, security, alert, and evaluation event can be filtered and audited.",
        points: ["Correlation IDs", "Routes", "Categories"],
      },
      {
        title: "SLO controls",
        body: "Availability, failure budget, latency, auth pressure, and connector failures are policy-driven.",
        points: ["Breach detection", "Advisory severity", "Break-glass review"],
      },
      {
        title: "Incident loop",
        body: "Diagnostics, incidents, playbooks, alert delivery, and resolution events stay connected.",
        points: ["Playbooks", "Alert targets", "Resolution evidence"],
      },
    ],
  },
  security: {
    ...appNavItem("/app/security"),
    eyebrow: "Security",
    headline: "Tenant isolation and policy controls built into the runtime.",
    summary: "Authentication, tenant-aware database context, row-level security, audit logs, and network controls protect every workflow boundary.",
    metrics: [
      { label: "Tenant RLS", value: "Forced" },
      { label: "Auth", value: "Enforced" },
      { label: "Audits", value: "Everywhere" },
    ],
    architecture: [
      { label: "Authenticate", detail: "session or internal smoke" },
      { label: "Authorize", detail: "resource and action policy" },
      { label: "Scope", detail: "tenant-aware database context" },
      { label: "Audit", detail: "decision and reason recorded" },
    ],
    signals: ["forced RLS", "tenant context", "security audit log", "network policy"],
    sections: [
      {
        title: "Tenant isolation",
        body: "Tenant context is enforced through scoped SQL clients, row-level policies, and release evidence checks.",
        points: ["RLS policies", "Isolation report", "Tenant smoke"],
      },
      {
        title: "Security audit",
        body: "Auth failures, policy blocks, trusted smoke events, and operator actions are recorded with context.",
        points: ["Actor ID", "Resource type", "Decision"],
      },
      {
        title: "Network guardrails",
        body: "Connectors and tools are checked before they can reach private targets or reference restricted secrets.",
        points: ["Private IP guard", "Secret deny-list", "Risk policy"],
      },
    ],
  },
  settings: {
    ...appNavItem("/app/settings"),
    eyebrow: "Settings",
    headline: "Configure the operating system behind every agent run.",
    summary: "Centralize environment posture, model configuration, tenant defaults, release metadata, and operator controls.",
    metrics: [
      { label: "Runtime", value: "Vercel" },
      { label: "Database", value: "Neon" },
      { label: "Models", value: "OpenAI" },
    ],
    architecture: [
      { label: "Runtime", detail: "Vercel functions and cron" },
      { label: "Storage", detail: "Neon Postgres plus pgvector" },
      { label: "Model", detail: "OpenAI generation and embeddings" },
      { label: "Evidence", detail: "release and eval signing" },
    ],
    signals: ["production env", "cron secret", "signing secret", "deployment metadata"],
    sections: [
      {
        title: "Environment posture",
        body: "Surface required env vars, production readiness, and deployment metadata without exposing secret values.",
        points: ["Env status", "Release URL", "Commit ref"],
      },
      {
        title: "Tenant defaults",
        body: "Keep tenant, actor, and auth behavior explicit for local, CI, and production environments.",
        points: ["Default tenant", "Session mode", "Internal smoke"],
      },
      {
        title: "Operator controls",
        body: "Give administrators a focused place for high-risk configuration and evidence review.",
        points: ["Signing", "Cron", "SLO policy"],
      },
    ],
  },
};

export const platformPillars = [
  {
    title: "Orchestrate anything",
    body: "Turn goals into plans, workflows, queue jobs, approvals, and verifiable outcomes.",
    icon: Workflow,
  },
  {
    title: "Remember precisely",
    body: "Persist long-lived memory, source-backed RAG, and graph context with provenance.",
    icon: Brain,
  },
  {
    title: "Connect safely",
    body: "Use MCP and OpenAPI connectors with risk policy, network controls, and secret redaction.",
    icon: Cable,
  },
  {
    title: "Inspect runtime state",
    body: "Monitor SLOs, incidents, diagnostics, release evidence, and signed evaluation reports.",
    icon: ShieldCheck,
  },
];

export const proofMetrics = [
  { label: "Core workspaces", value: "4" },
  { label: "Agent modes", value: "4" },
  { label: "Accessibility target", value: "AA" },
  { label: "Risk levels", value: "0-3" },
];


export const orchestrationJourney = [
  {
    title: "The operator submits a goal",
    body: "The operator submits a goal and OmniAgentOS routes it through policy, context retrieval, and planning before any side effect is possible.",
    signals: ["mode", "actor", "tenant"],
  },
  {
    title: "Context is assembled",
    body: "Memory, RAG chunks, graph nodes, run history, and tool catalogs are merged into a bounded context package for the model.",
    signals: ["RAG", "graph", "ledger"],
  },
  {
    title: "Work becomes durable",
    body: "Plans become workflow nodes and operation jobs, so long-running work can be ticked, approved, retried, or recovered.",
    signals: ["queue", "approval", "recovery"],
  },
  {
    title: "Evidence closes the loop",
    body: "Every result feeds observability, evaluation reports, release gates, and the long-term memory layer.",
    signals: ["SLO", "eval", "release"],
  },
];

export const capabilityMatrix = [
  ["Memory", "Long-lived facts, decisions, source context, and graph recall."],
  ["RAG", "Hybrid retrieval across chunks, embeddings, text search, and traces."],
  ["Workflows", "Durable plans, queue leases, approvals, retries, and operator ticks."],
  ["Connectors", "MCP and OpenAPI ingestion with policy and network controls."],
  ["Tools", "Risk-ranked execution with dry runs, approvals, and full audit trails."],
  ["Observability", "Runtime events, incidents, SLO policy, alerts, and diagnostics."],
  ["Evaluations", "Regression cases, signed reports, release gates, and CI smoke."],
  ["Security", "Auth, tenant-scoped database access, forced RLS, and audit evidence."],
];

export const operatingModes = [
  {
    label: "Builder",
    value: "Design agent workflows with memory, tools, and verification from one workspace.",
  },
  {
    label: "Operator",
    value: "Monitor active work, release gates, SLO pressure, approvals, and incidents.",
  },
  {
    label: "Governance",
    value: "Inspect tenant isolation, tool risk, eval reports, connector safety, and audit logs.",
  },
];

export const marketingPages = {
  platform: {
    eyebrow: "Platform",
    headline: "Give agents work and review what happens.",
    summary: "OmniAgentOS brings goals, context, tool activity, approvals, workflows, and result evidence into one operator workspace.",
    icon: Sparkles,
    sections: [
      "Plan and execute durable agent work.",
      "Retrieve context with source-backed memory.",
      "Govern tool calls before side effects happen.",
      "Prove release readiness with live evidence.",
    ],
  },
  solutions: {
    eyebrow: "Solutions",
    headline: "Run multi-step work with explicit review points.",
    summary: "Use OmniAgentOS for research, automation, support operations, security workflows, data analysis, and any multi-step AI process that needs memory and control.",
    icon: Globe2,
    sections: [
      "Research agents with durable source context.",
      "Operations agents with approvals and audit trails.",
      "Connector agents that safely reach external systems.",
      "Evaluation agents that prove behavior before release.",
    ],
  },
  security: {
    eyebrow: "Security",
    headline: "Set boundaries for agent actions.",
    summary: "Tenant isolation, governed tools, network restrictions, signed reports, and SLO-backed release evidence are built into the platform surface.",
    icon: LockKeyhole,
    sections: [
      "Forced row-level security for tenant-scoped data.",
      "Policy gates for risky tool execution.",
      "Private endpoint and platform secret protections.",
      "Audit trails across auth, tools, workflows, and releases.",
    ],
  },
  pricing: {
    eyebrow: "Private deployment",
    headline: "No public plans or registration.",
    summary:
      "This deployment is privately operated. Use the configured owner account to enter the workspace.",
    icon: Database,
    sections: [
      "One private operator workspace.",
      "Email and password entry through secure session auth.",
      "Tenant-scoped data and governed tools.",
      "No public registration or commercial checkout.",
    ],
  },
  docs: {
    eyebrow: "Docs",
    headline: "Operate agents with clear system boundaries.",
    summary: "Documentation should cover setup, environment variables, RAG ingestion, memory design, workflow execution, connector imports, release evidence, and production smoke.",
    icon: FileText,
    sections: [
      "Quickstart and production deployment.",
      "Memory, RAG, and context architecture.",
      "Connector and tool governance.",
      "Security, observability, and release gates.",
    ],
  },
  changelog: {
    eyebrow: "Changelog",
    headline: "A production system with visible progress.",
    summary: "Track shipped platform slices, operational hardening, UI updates, and release evidence as OmniAgentOS evolves.",
    icon: GitBranch,
    sections: [
      "Event-log stage 2: fold runs projection, GET /api/runs/:id?replay=true proves stored state matches event history.",
      "Dedicated Fly.io worker drains the operation queue every 5 s, replacing daily-only Vercel cron.",
      "Planner health fixed: reasoning effort set to minimal, 45 s timeout, route maxDuration = 60.",
      "Earned-autonomy trust engine and event-log substrate (stage 1) shipped with verifiable projection rebuild.",
    ],
  },
};
