# OmniAgent OS

An AI agentic orchestration framework starter built with Next.js, OpenAI, durable Postgres memory, and a RAG v2 knowledge layer.

## Run Locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

The app runs in fallback mode until `OPENAI_API_KEY` is set in `.env.local`.
Embeddings default to `text-embedding-3-large` with `OPENAI_EMBEDDING_DIMENSIONS=1536`, which keeps pgvector HNSW indexes compatible with Neon/Postgres.

For durable production memory, run history, and RAG documents, attach a Postgres database and set:

```bash
DATABASE_URL=
```

For scheduled production workflow ticks on Vercel, set:

```bash
CRON_SECRET=
OMNIAGENT_QUEUE_LEASE_SECONDS=120
OMNIAGENT_WORKFLOW_DRAIN_LIMIT=2
```

Without `DATABASE_URL`, local development uses `.omniagent/` and Vercel uses ephemeral `/tmp/omniagent`.
When Postgres supports pgvector, the app adds vector columns and HNSW indexes for semantic retrieval. Keep `OPENAI_EMBEDDING_DIMENSIONS` at or below `2000` for HNSW indexing; larger JSON embeddings are normalized into the pgvector index dimension.
Workflow execution is backed by the durable `omni_operation_jobs` Postgres queue. User actions enqueue workflow tick jobs, lease them for bounded execution, retry failed jobs with backoff, and opportunistically drain work after responses with Next.js `after()`. The included `vercel.json` schedules `/api/workflows/tick` once daily as a Hobby-compatible safety net. Pro deployments can raise the cadence by changing the cron expression.

## What Is Included

- Command center UI for agent runs
- `/api/agent` streaming orchestration endpoint
- `/api/memory` long-term memory endpoint
- `/api/memory/graph` graph-memory search, stats, and rebuild endpoint
- `/api/ingest` text ingestion endpoint
- `/api/knowledge` document, chunk, and knowledge-search endpoint
- `/api/retrieval/plan` adaptive context-engine endpoint with evidence packing and retrieval traces
- `/api/capabilities` registry/status endpoint
- `/api/runs` run ledger endpoint
- `/api/tools` governed tool registry, policy, and audit endpoint
- `/api/tools/execute` schema-validated tool execution endpoint with dry-run defaults
- `/api/approvals` pending workflow/tool approval queue endpoint
- `/api/approvals/:id` durable approve/reject endpoint for workflows and tool execution records
- `/api/operations` production operations overview endpoint
- `/api/connection-catalog` connector template catalog for external app targets
- `/api/connectors` MCP connector registration and discovery endpoint
- `/api/connectors/:id/discover` MCP tool rediscovery endpoint
- `/api/openapi-connectors` OpenAPI connector registration and import endpoint
- `/api/openapi-connectors/:id/import` OpenAPI operation re-import endpoint
- `/api/workflows` durable workflow start/list endpoint
- `/api/workflows/plan` dynamic workflow DAG planner endpoint
- `/api/workflows/executions` dynamic plan-node execution ledger endpoint
- `/api/workflows/:id` durable workflow detail endpoint
- `/api/workflows/:id/tick` enqueue and lease one persisted workflow step
- `/api/workflows/:id/signal` pause, resume, approve, retry, or cancel a workflow
- `/api/workflows/tick` lease queued workflow jobs for cron or operator control
- `/api/evaluations` regression suite start/list endpoint
- `/api/evaluations/:id` evaluation run detail endpoint
- `/api/security/context` tenant, actor, role, RBAC, and secret-vault policy endpoint
- `/api/security/audits` RBAC allow/deny audit endpoint
- `/api/auth/session` current auth/session state endpoint
- `/api/auth/login` password session sign-in endpoint
- `/api/auth/logout` session revocation endpoint
- `/api/auth/control-plane` tenant, user, membership, and session admin endpoint
- Command center panels for knowledge ingest, memory browser, and knowledge library
- Command center panel for governed tool dry-runs, executions, and audit review
- Command center panel for MCP connector registration, discovery, and discovered tool review
- Command center panel for OpenAPI connector import, operation review, and governed REST execution
- Command center panel for durable workflow start, tick, approval, pause/resume, retry, and cancel controls
- Command center panel for regression suite runs, pass rate, latency, and cost estimates
- Command center panel for tenant context, RBAC rules, secret policy, and security audit trails
- Command center panel for auth mode, current identity, tenant users, and admin user creation
- Command center panel for pending approvals, failed work, active workflows, and connector errors
- Connection catalog for GitHub, Gmail, Slack, Notion, Google Drive, Supabase, Neon, Upstash, browser automation, custom MCP, and custom OpenAPI adapter setup
- Local memory and knowledge persisted under `.omniagent/`
- Postgres-backed memory, RAG documents/chunks, run history, tool audit history, MCP connectors, OpenAPI connectors, and discovered tool schemas when `DATABASE_URL` is configured
- Hybrid retrieval across durable memories and source chunks with semantic, keyword, recency, and importance signals
- Adaptive context engine with query routing, evidence confidence, source diversity, positional context packing, and persisted retrieval traces
- Graph memory over durable memories and retrieval traces, with concept/entity communities feeding multi-hop context back into the adaptive context engine
- Memory consolidation after completed runs into durable facts, preferences, procedures, decisions, and tasks
- Governed tool execution with risk levels, approval gates, durable approve/reject decisions, planned connector blocking, and immutable audit records
- MCP connector host for Streamable HTTP servers; discovered tools flow into the governed tool registry and inherit risk/audit policy
- OpenAPI connector importer for JSON/YAML specs; imported REST operations flow into the governed tool registry with env-var based auth, dry-runs, approval gates, and audit policy
- Durable workflow runtime for persisted step execution with Postgres queue leases, retries, approval waits, operator signals, event history, and final report persistence
- Dynamic workflow planner that decomposes goals into typed DAGs with tool selection, connector targets, risk policy, verification criteria, and memory feedback
- Plan-driven workflow executor that persists each dynamic DAG node, runs read-only governed tools, dry-runs side-effecting or approval-gated actions, and feeds execution summaries into verification and reports
- Vercel Cron integration for secured production workflow queue ticks with `CRON_SECRET`
- Evaluation harness for system readiness, RAG retrieval quality, governed tool policy, workflow lifecycle reliability, latency, and estimated cost
- Operations regression case for approval queue, operations overview, and connection catalog readiness
- Tenant-aware security controls with viewer/operator/admin/system roles, server-only secret env-var references, redacted audit metadata, and persisted RBAC allow/deny records
- First-party identity control plane with scrypt password hashes, HttpOnly opaque session cookies, hashed session tokens, tenants, users, memberships, and role-derived security context

## Connector Secrets

Connector records store environment variable names only. Put bearer tokens or API keys in local `.env.local` or Vercel environment variables, then reference the env var name from the connector form. Names must be uppercase server-only variables and cannot use `NEXT_PUBLIC_`.

## Security Context

Requests can pass `x-omni-tenant-id`, `x-omni-user-id`, and `x-omni-user-role` headers. Without headers, the app uses `OMNIAGENT_DEFAULT_TENANT`, `OMNIAGENT_DEFAULT_ACTOR`, and `OMNIAGENT_DEFAULT_ROLE`; the template keeps the dashboard operator-friendly with `admin`.

Set `OMNIAGENT_AUTH_ENABLED=true` to enforce authenticated sessions instead of trusting headers/defaults. Configure `OMNIAGENT_BOOTSTRAP_EMAIL` and `OMNIAGENT_BOOTSTRAP_PASSWORD` before enabling auth so the first admin can sign in and manage users.

## Implementation Roadmap

See `docs/IMPLEMENTATION_PLAN.md`.
