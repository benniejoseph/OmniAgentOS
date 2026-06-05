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
- Command center panels for knowledge ingest, memory browser, and knowledge library
- Command center panel for governed tool dry-runs, executions, and audit review
- Command center panel for MCP connector registration, discovery, and discovered tool review
- Local memory and knowledge persisted under `.omniagent/`
- Postgres-backed memory, RAG documents/chunks, run history, tool audit history, MCP connectors, and discovered MCP tool schemas when `DATABASE_URL` is configured
- Hybrid retrieval across durable memories and source chunks with semantic, keyword, recency, and importance signals
- Memory consolidation after completed runs into durable facts, preferences, procedures, decisions, and tasks
- Governed tool execution with risk levels, approval gates, planned connector blocking, and immutable audit records
- MCP connector host for Streamable HTTP servers; discovered tools flow into the governed tool registry and inherit risk/audit policy

## Implementation Roadmap

See `docs/IMPLEMENTATION_PLAN.md`.
