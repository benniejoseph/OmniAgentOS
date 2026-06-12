# OmniAgent OS

An enterprise AI agent platform: a governed tool-calling agent with durable workflows, long-term memory and RAG, MCP/OpenAPI connectors, approvals, observability, and signed release evidence — built on Next.js, OpenAI, and Neon Postgres.

## Quickstart

```bash
npm install
cp .env.example .env.local   # set OMNIAGENT_DEFAULT_ROLE=operator and OPENAI_API_KEY
npm run dev                  # Node >= 20.9
```

Open http://localhost:3000, go to **Run Agent**, and give it a goal. Without `OPENAI_API_KEY` the app streams a clearly labeled simulated response; with it, the agent runs a real tool loop. Press **⌘K** to jump between workspaces.

## How it works

The interactive agent (`/api/agent`) exposes active governed tools to the model — memory and knowledge search, live web search, memory writes, knowledge ingest, run history, plus any discovered MCP/OpenAPI connector tools below risk level 3. Every call routes through risk policy and the immutable tool audit ledger:

- **Risk 0–1** tools execute live.
- **Risk 2 / approval-gated** tools file an `approval_required` record; approving it in the **Approvals** workspace executes the real call.
- **Risk 3** tools are never exposed to the model; executing one requires two distinct admin approvals (the requester cannot approve their own request).

Built-in tools include `http.request` — SSRF-guarded outbound HTTP for webhooks and REST APIs (risk 2, approval-gated, secrets referenced by env var name only).

### Earned autonomy (Tenure)

Approvals get cheaper as the agent proves itself. Every gateable action class accrues a trust profile; once it reaches a clean-streak threshold, reversible risk&lt;3 actions can graduate from "approve each" to "auto with alert" (opt-in via `OMNIAGENT_GRADUATED_AUTONOMY=true`). Any failure or rejection resets the streak; irreversible and risk-3 actions never graduate. See [docs/vision/PRODUCT.md](docs/vision/PRODUCT.md). Trust profiles are visible at `/api/trust` and on each approval card.

### Agent quality evals

`evals/golden-tasks.json` holds gradeable agent tasks; `npm run eval:agents` (against a running server) drives the real agent and prints a pass-rate scoreboard. The deterministic scorer is unit-tested in `src/lib/evals2/scorer.ts`.

Longer work runs as durable workflows: LLM-planned DAGs executed through a Postgres-backed queue with leases, retries, recovery, and operator signals. Everything feeds the observability ledger, SLO policies, incidents, alerts, and signed evaluation reports.

## Documentation

| Doc | Covers |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Local setup, identity, first task |
| [docs/deployment.md](docs/deployment.md) | Vercel + Neon, full env-var table, cron cadence, release gates |
| [docs/architecture.md](docs/architecture.md) | System map, agent loop, workflows, storage, security model |
| [docs/adr/](docs/adr/README.md) | Architecture decisions |
| [docs/AUDIT_REPORT.md](docs/AUDIT_REPORT.md) | Technical audit and roadmap |

## Development

```bash
npm test                    # lint + unit tests (vitest)
npm run build               # production build
npm run worker              # dedicated queue/SLO/alert worker
BASE_URL=<url> npm run test:production-smoke   # deployed-instance smoke gates
```

CI runs lint, unit tests, and build on every push and PR; a nightly workflow smokes the production deployment and uploads release evidence.

## Security notes

- Auth is always enforced in production and cannot be disabled there. Set `OMNIAGENT_BOOTSTRAP_EMAIL` / `OMNIAGENT_BOOTSTRAP_PASSWORD` before the first deploy.
- Production requires `DATABASE_URL`; hosted no-DB storage is blocked unless `OMNIAGENT_ALLOW_DEMO_STORAGE=true` is set for a disposable demo.
- Connectors store environment variable *names* only (prefix `OMNIAGENT_CONNECTOR_` or allowlisted); platform secrets are blocked, connector URLs are SSRF-guarded, and sensitive metadata is redacted.
- Tenant data is isolated with forced row-level security; allow/deny decisions are audited with correlation IDs.
