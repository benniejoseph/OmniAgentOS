export type Capability = {
  id: string;
  name: string;
  description: string;
  status: "active" | "planned";
};

export const agents: Capability[] = [
  {
    id: "planner",
    name: "Planner",
    description: "Breaks goals into ordered tasks, dependencies, risks, and verification gates.",
    status: "active",
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Builds evidence packs from memory, RAG, files, and connected sources.",
    status: "active",
  },
  {
    id: "executor",
    name: "Executor",
    description: "Chooses safe tools, prepares action inputs, and records outcomes.",
    status: "active",
  },
  {
    id: "verifier",
    name: "Verifier",
    description: "Checks outputs against acceptance criteria before a run is considered complete.",
    status: "active",
  },
  {
    id: "memory-curator",
    name: "Memory Curator",
    description: "Extracts durable preferences, facts, procedures, and reusable knowledge.",
    status: "active",
  },
];

export const tools: Capability[] = [
  {
    id: "memory.search",
    name: "Search Memory",
    description: "Hybrid retrieval over long-term memories and ingested knowledge chunks.",
    status: "active",
  },
  {
    id: "memory.write",
    name: "Write Memory",
    description: "Persists facts, preferences, procedures, and task episodes.",
    status: "active",
  },
  {
    id: "memory.graph",
    name: "Graph Memory",
    description: "Builds entity/concept communities from memories and retrieval traces for multi-hop context.",
    status: "active",
  },
  {
    id: "rag.ingest",
    name: "Ingest Knowledge",
    description: "Chunks documents, embeds when OpenAI is configured, and stores retrievable context.",
    status: "active",
  },
  {
    id: "web.search",
    name: "Live Web Search",
    description: "Searches the public web for current facts, breaking releases, pricing, schedules, and source-backed research.",
    status: "active",
  },
  {
    id: "tool.executor",
    name: "Governed Tool Executor",
    description: "Runs schema-validated tools through risk policy, dry-runs, approval gates, and audit logging.",
    status: "active",
  },
  {
    id: "connector.mcp",
    name: "MCP Connector",
    description: "Register remote MCP servers as governed tool providers.",
    status: "active",
  },
  {
    id: "connector.openapi",
    name: "OpenAPI Importer",
    description: "Generate typed tools from OpenAPI schemas with approval policies.",
    status: "active",
  },
  {
    id: "workflow.temporal",
    name: "Durable Workflow Runtime",
    description: "Run long jobs through queued leases, persisted steps, retries, approvals, signals, and resumes.",
    status: "active",
  },
  {
    id: "workflow.dynamic_planner",
    name: "Dynamic Workflow Planner",
    description: "Decompose goals into typed DAGs with tool selection, risk policy, verification, and memory feedback.",
    status: "active",
  },
  {
    id: "workflow.plan_executor",
    name: "Plan-Driven Workflow Executor",
    description: "Executes dynamic workflow DAG nodes through governed tool decisions, node ledgers, verification signals, and memory-ready artifacts.",
    status: "active",
  },
  {
    id: "workflow.webhook_trigger",
    name: "Webhook Workflow Trigger",
    description: "Accepts signed external events, persists trigger audits, creates workflow runs, and enqueues durable execution.",
    status: "active",
  },
  {
    id: "ops.self_healing",
    name: "Self-Healing Diagnostics",
    description: "Checks production health, records component incidents, repairs stale queue leases, and separates live workflow pressure from recovered history.",
    status: "active",
  },
  {
    id: "observability.health",
    name: "Health Observability",
    description: "Publishes health, diagnostics, incident, recovery, and SLO metrics for operator and deployment checks.",
    status: "active",
  },
  {
    id: "ops.incident_manager",
    name: "Incident Manager",
    description: "Tracks incident lifecycle, alert routing metadata, acknowledgements, resolutions, and remediation playbooks.",
    status: "active",
  },
  {
    id: "ops.alert_delivery",
    name: "Alert Delivery",
    description: "Dispatches incident alerts through dashboard, ops ledger, signed webhooks, Slack, and email with retry/backoff.",
    status: "active",
  },
  {
    id: "ops.alert_scheduler",
    name: "Alert Scheduler",
    description: "Runs scheduled alert queueing and dispatch from the secured production cron tick.",
    status: "active",
  },
  {
    id: "ops.alert_target_health",
    name: "Alert Target Health",
    description: "Probes alert target readiness without exposing secrets and requeues failed deliveries after configuration recovery.",
    status: "active",
  },
  {
    id: "ops.observability_console",
    name: "Observability Console",
    description: "Persists runtime events with correlation IDs, SLO summaries, route failures, and operator audit timelines.",
    status: "active",
  },
  {
    id: "ops.slo_alerting",
    name: "SLO Alerting",
    description: "Evaluates observability SLO policies, opens or resolves breach incidents, and routes alert deliveries.",
    status: "active",
  },
  {
    id: "ops.slo_policy_management",
    name: "SLO Policy Management",
    description: "Configures SLO thresholds, severities, alert routing targets, suppression windows, and policy enablement.",
    status: "active",
  },
  {
    id: "ops.slo_policy_change_control",
    name: "SLO Policy Change Control",
    description: "Tracks SLO policy change requests, approvals, immutable history, and rollback snapshots.",
    status: "active",
  },
  {
    id: "ops.slo_multi_party_approval",
    name: "SLO Multi-Party Approval",
    description: "Enforces high-risk SLO policy quorums, approver role requirements, requester separation, and signed evidence.",
    status: "active",
  },
  {
    id: "ops.slo_approval_policy_admin",
    name: "SLO Approval Policy Admin",
    description: "Configures versioned SLO approval quorum rules, break-glass policy, and policy audit history.",
    status: "active",
  },
  {
    id: "ops.queue_recovery",
    name: "Queue Recovery",
    description: "Inspects, reconciles, requeues, drains, safely fails stale workflow queue work, and exposes recovery history details.",
    status: "active",
  },
  {
    id: "retrieval.context_engine",
    name: "Adaptive Context Engine",
    description: "Route queries, grade evidence, diversify retrieval, pack context, and persist retrieval traces.",
    status: "active",
  },
  {
    id: "eval.harness",
    name: "Evaluation Harness",
    description: "Run governed regression suites for readiness, retrieval, tools, workflows, latency, and cost.",
    status: "active",
  },
  {
    id: "ops.eval_governance",
    name: "Evaluation Governance",
    description: "Classifies evaluation safety modes, gates production mutations, and exposes operator override evidence.",
    status: "active",
  },
  {
    id: "security.rbac",
    name: "RBAC Security Controls",
    description: "Tenant-aware roles, server-only secret references, sensitive metadata redaction, and audit trails.",
    status: "active",
  },
  {
    id: "auth.control_plane",
    name: "Identity Control Plane",
    description: "Session auth, tenant memberships, user roles, and admin identity management.",
    status: "active",
  },
];

export const connectorTypes: Capability[] = [
  {
    id: "mcp",
    name: "MCP Servers",
    description: "Universal tool/resource/prompt bridge for third-party systems.",
    status: "active",
  },
  {
    id: "rest",
    name: "REST/OpenAPI",
    description: "Import SaaS and internal APIs as approval-gated tools.",
    status: "active",
  },
  {
    id: "sql",
    name: "SQL/Vector Stores",
    description: "Query operational data and retrieve semantic knowledge.",
    status: "planned",
  },
  {
    id: "webhook",
    name: "Webhooks",
    description: "Trigger agent workflows from external events.",
    status: "active",
  },
];

export function getCapabilityRegistry() {
  return {
    agents,
    tools,
    connectorTypes,
  };
}
