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

For durable production memory, run history, and RAG documents, attach a Postgres database and set:

```bash
DATABASE_URL=
```

Without `DATABASE_URL`, local development uses `.omniagent/` and Vercel uses ephemeral `/tmp/omniagent`.
When Postgres supports pgvector, the app adds vector columns and indexes for semantic retrieval.

## What Is Included

- Command center UI for agent runs
- `/api/agent` streaming orchestration endpoint
- `/api/memory` long-term memory endpoint
- `/api/ingest` text ingestion endpoint
- `/api/knowledge` document, chunk, and knowledge-search endpoint
- `/api/capabilities` registry/status endpoint
- `/api/runs` run ledger endpoint
- `/api/tools` governed tool registry, policy, and audit endpoint
- `/api/tools/execute` schema-validated tool execution endpoint with dry-run defaults
- `/api/connectors` MCP connector registration and discovery endpoint
- `/api/connectors/:id/discover` MCP tool rediscovery endpoint
- `/api/openapi-connectors` OpenAPI connector registration and import endpoint
- `/api/openapi-connectors/:id/import` OpenAPI operation re-import endpoint
- `/api/workflows` durable workflow start/list endpoint
- `/api/workflows/:id` durable workflow detail endpoint
- `/api/workflows/:id/tick` advance one persisted workflow step
- `/api/workflows/:id/signal` pause, resume, approve, retry, or cancel a workflow
- `/api/workflows/tick` advance queued workflows for cron or operator control
- `/api/evaluations` regression suite start/list endpoint
- `/api/evaluations/:id` evaluation run detail endpoint
- `/api/security/context` tenant, actor, role, RBAC, and secret-vault policy endpoint
- `/api/security/audits` RBAC allow/deny audit endpoint
- Command center panels for knowledge ingest, memory browser, and knowledge library
- Command center panel for governed tool dry-runs, executions, and audit review
- Command center panel for MCP connector registration, discovery, and discovered tool review
- Command center panel for OpenAPI connector import, operation review, and governed REST execution
- Command center panel for durable workflow start, tick, approval, pause/resume, retry, and cancel controls
- Command center panel for regression suite runs, pass rate, latency, and cost estimates
- Command center panel for tenant context, RBAC rules, secret policy, and security audit trails
- Local memory and knowledge persisted under `.omniagent/`
- Postgres-backed memory, RAG documents/chunks, run history, tool audit history, MCP connectors, OpenAPI connectors, and discovered tool schemas when `DATABASE_URL` is configured
- Hybrid retrieval across durable memories and source chunks with semantic, keyword, recency, and importance signals
- Memory consolidation after completed runs into durable facts, preferences, procedures, decisions, and tasks
- Governed tool execution with risk levels, approval gates, planned connector blocking, and immutable audit records
- MCP connector host for Streamable HTTP servers; discovered tools flow into the governed tool registry and inherit risk/audit policy
- OpenAPI connector importer for JSON/YAML specs; imported REST operations flow into the governed tool registry with env-var based auth, dry-runs, approval gates, and audit policy
- Durable workflow runtime for persisted step execution with retries, approval waits, operator signals, event history, and final report persistence
- Evaluation harness for system readiness, RAG retrieval quality, governed tool policy, workflow lifecycle reliability, latency, and estimated cost
- Tenant-aware security controls with viewer/operator/admin/system roles, server-only secret env-var references, redacted audit metadata, and persisted RBAC allow/deny records

## Connector Secrets

Connector records store environment variable names only. Put bearer tokens or API keys in local `.env.local` or Vercel environment variables, then reference the env var name from the connector form. Names must be uppercase server-only variables and cannot use `NEXT_PUBLIC_`.

## Security Context

Requests can pass `x-omni-tenant-id`, `x-omni-user-id`, and `x-omni-user-role` headers. Without headers, the app uses `OMNIAGENT_DEFAULT_TENANT`, `OMNIAGENT_DEFAULT_ACTOR`, and `OMNIAGENT_DEFAULT_ROLE`; the template keeps the dashboard operator-friendly with `admin`.

## Implementation Roadmap

See `docs/IMPLEMENTATION_PLAN.md`.
