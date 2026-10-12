# Asael

[Asael](https://asael.bennierichard.com) is a private personal AI partner for real work across life and projects. It combines an Assistant, durable work, source-backed memory, connected tools, and explicit decisions about consequential actions. The primary workspace has four destinations: **Today, Assistant, My work, and Library**. Built on Next.js, supported model providers, and PostgreSQL.

## Quickstart

Use Node.js 24.x and npm 11.x (the supported versions are enforced by `package.json`).

```bash
npm ci
cp .env.example .env.local
# For local tool execution:
# OMNIAGENT_DEFAULT_ROLE=operator
# Add OPENAI_API_KEY only when you want live model calls.
npm run dev
```

Open http://localhost:3000, go to **Assistant**, and give it a goal. The example config keeps local authentication disabled; production always enables it. Without `OPENAI_API_KEY` the app streams a clearly labeled simulated response; with it, the agent runs a real tool loop. Press **⌘K** or **Ctrl+K** to jump between workspaces.

## How it works

The interactive agent (`/api/agent`) exposes active governed tools to the model — memory and knowledge search, live web search, memory writes, knowledge ingest, run history, plus any discovered MCP/OpenAPI connector tools below risk level 3. Every call routes through risk policy and a persistent tool-execution record:

- **Risk 0–1** tools execute live.
- **Risk 2 / approval-gated** tools file an `approval_required` record; approving it in the **Inbox** executes the real call.
- **Risk 3** tools are never exposed to the model; executing one requires two distinct admin approvals (the requester cannot approve their own request).

Built-in tools include `http.request` — SSRF-guarded outbound HTTP for webhooks and REST APIs (risk 2, approval-gated, secrets referenced by env var name only).

Tool records are intentionally mutable while an approval moves from pending to approved, rejected, or executed. Security audit rows and domain events are insert-oriented, but the application does not provide database-level WORM storage or cryptographic immutability. Export signed evaluation evidence to retention-controlled storage when tamper resistance is required.

Agent turns use a full conversation array instead of OpenAI `previous_response_id`, which keeps the loop compatible with Zero Data Retention. When a tool needs approval, the conversation, pending call, instructions, and completed outputs are persisted; approval resumes that same run from the saved continuation.

### Follow-through and measured improvement

Responsibilities can follow one owned canonical work item through daily or weekly checks. A built-in routine checks status, deadlines, overdue state, priority, owners, readable dependencies and linked outputs. The first check establishes a quiet baseline. Later meaningful changes can produce owner inbox updates when separately enabled. Tracking is bounded by time and cumulative limits. A task marked done is not proof of a verified outcome.

Proposed agent guidance can be compared with current guidance on 3–10 owner-supplied text examples. Both variants use the same tasks, model, agent definition and literal scoring rules, without tools or retrieval. New activation requires an additional passing case, no case regressions, and unchanged current configuration. These examples provide bounded text evidence, not proof that an agent improves on every task. Comparisons use real model calls and may incur charges; a repeated request recovers the same stored attempt.

Trust history is useful evidence, but does not by itself authorize an action. Current runtime policies, explicit grants, tool approval and scoped execution remain decisive. See [the product direction](docs/vision/PRODUCT.md).

### Agent quality evals

`evals/golden-tasks.json` holds gradeable agent tasks; `npm run eval:agents` (against a running server) drives the real agent and prints a pass-rate scoreboard. The deterministic scorer is unit-tested in `src/lib/evals2/scorer.ts`.

Longer work runs as durable workflows: LLM-planned DAGs executed through a Postgres-backed queue with leases, retries, recovery, and operator signals. Everything feeds the observability ledger, SLO policies, incidents, alerts, and signed evaluation reports.

## Documentation

| Doc | Covers |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Local setup, identity, first task |
| [docs/deployment.md](docs/deployment.md) | Vercel + Neon, full env-var table, cron cadence, release gates |
| [docs/architecture.md](docs/architecture.md) | System map, agent loop, workflows, storage, security model |
| [docs/production-rollout.md](docs/production-rollout.md) | Concise rollout, rollback, and evidence checklist |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Auth, database, worker, connector, and smoke diagnosis |
| [docs/adr/](docs/adr/README.md) | Architecture decisions |
| [docs/AUDIT_REPORT.md](docs/AUDIT_REPORT.md) | Technical audit and roadmap |

## Development

```bash
npm run typecheck          # TypeScript, no emit
npm run lint               # ESLint, zero warnings
npm run test:unit          # deterministic unit suite
npm run test:coverage      # V8 text, JSON summary, and lcov reports
npm run test:integration   # skips unless an isolated DATABASE_URL is explicitly enabled
npm run build              # production build
npm run verify             # typecheck, lint, coverage/integration, scripts, build, production audit
npm run worker             # dedicated queue/SLO/alert worker
npm run db:backup          # encrypted pg_dump outside the checkout + manifest
npm run db:restore-drill   # destructive isolated restore + grant, RLS, RTO evidence
```

CI exposes the required checks `CI / quality`, `CI / build`, `CI / audit`, `CI / integration`, and `CI / worker`. The scheduled/manual production workflow requires an explicit target plus smoke credentials, runs each critical gate with a bounded timeout, and fails when release evidence is absent.

## Security notes

- Auth is always enforced in production and cannot be disabled there. Set `OMNIAGENT_BOOTSTRAP_EMAIL` / `OMNIAGENT_BOOTSTRAP_PASSWORD` before the first deploy.
- Production requires `DATABASE_URL`; hosted no-DB storage is blocked unless `OMNIAGENT_ALLOW_DEMO_STORAGE=true` is set for a disposable demo.
- Connectors store environment variable *names* only; platform secrets are blocked, non-system credentials require exact tenant-and-origin deployer bindings, connector URLs are SSRF-guarded, and sensitive metadata is redacted.
- Tenant data is isolated with forced row-level security; allow/deny decisions are audited with correlation IDs.
- The worker enforces configurable retention for terminal run/tool payloads and operational audit data; active execution is preserved and abandoned approvals expire with their raw payloads redacted.
