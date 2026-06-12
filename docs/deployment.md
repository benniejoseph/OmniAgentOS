# Deployment (Vercel + Neon)

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | Yes (for real runs) | Model + embeddings + live web search |
| `OPENAI_AGENT_MODEL` | No (default `gpt-5`) | Generation model |
| `OPENAI_EMBEDDING_MODEL` | No (default `text-embedding-3-large`) | Embedding model |
| `OPENAI_EMBEDDING_DIMENSIONS` | No (default `1536`) | Keep ≤ 2000 for pgvector HNSW |
| `DATABASE_URL` | Yes (production) | Neon/Postgres; required for autonomous execution state, approvals, workflows, memory, and audit evidence |
| `OMNIAGENT_ALLOW_DEMO_STORAGE` | No (default `false`) | Explicitly allows hosted no-DB demo mode. Do not set on production deployments. |
| `CRON_SECRET` | Yes (production) | Secures `/api/workflows/tick` for Vercel Cron |
| `OMNIAGENT_BOOTSTRAP_EMAIL` / `OMNIAGENT_BOOTSTRAP_PASSWORD` | Yes (first deploy) | First admin sign-in |
| `OMNIAGENT_INTERNAL_AUTH_SECRET` | Yes (if using smoke tests) | Trusted internal identity headers (timing-safe compared) |
| `OMNIAGENT_REPORT_SIGNING_SECRET` / `..._KEY_ID` / `..._KEYS` | Recommended | Signed evaluation reports + rotation keys |
| `NEXT_PUBLIC_APP_URL` | No | Public base URL; falls back to `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL`, then localhost |
| `OMNIAGENT_QUEUE_LEASE_SECONDS` | No (120) | Operation job lease duration |
| `OMNIAGENT_WORKFLOW_DRAIN_LIMIT` | No (2) | Jobs drained per tick |
| `OMNIAGENT_ALERT_QUEUE_LIMIT` / `OMNIAGENT_ALERT_DISPATCH_LIMIT` | No (10/10) | Scheduled alert batch sizes |
| `OMNIAGENT_ALERT_WEBHOOK_URL` / `_SECRET`, `SLACK_WEBHOOK_URL`, `RESEND_API_KEY`, `OMNIAGENT_ALERT_EMAIL_TO/FROM` | No | External alert delivery targets |
| `OMNIAGENT_AGENT_MAX_TOOL_STEPS` | No (6) | Tool-loop step budget per run |
| `OMNIAGENT_AGENT_MAX_MESSAGE_CHARS` | No (32000) | Per-message content cap |
| `OMNIAGENT_AGENT_MAX_MESSAGES` | No (40) | Conversation length cap |
| `OMNIAGENT_AGENT_RUNS_PER_MINUTE` | No (10) | Per tenant+actor rate limit (instance-local) |
| `OMNIAGENT_GRADUATED_AUTONOMY` | No (false) | Opt-in: let action classes that earned trust auto-execute reversible risk<3 tools with alerting |
| `OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD` | No (25) | Consecutive clean executions required before an action class graduates |
| `OMNIAGENT_CONNECTOR_SECRET_ALLOWLIST` | No | Extra env names connectors may reference (`OMNIAGENT_CONNECTOR_*` always allowed) |
| `OMNIAGENT_WORKER_BASE_URL` | Yes (worker) | Web origin the dedicated worker should tick |
| `OMNIAGENT_WORKER_INTERVAL_MS` | No (5000) | Delay between worker drain attempts |
| `OMNIAGENT_WORKER_LIMIT` | No (5) | Workflow jobs to lease per worker tick, max 10 |
| `OMNIAGENT_WORKER_SLO` / `OMNIAGENT_WORKER_ALERTS` | No (true/true) | Whether the worker also evaluates SLOs and dispatches alerts |

Auth is always enforced in production runtimes and cannot be disabled there.

Production requests are blocked when `DATABASE_URL` is missing unless `OMNIAGENT_ALLOW_DEMO_STORAGE=true` is set. That override is for disposable demos only.

## Dedicated worker

Run the web app and worker as separate processes:

```bash
npm run start
npm run worker
```

The worker authenticates with `OMNIAGENT_INTERNAL_AUTH_SECRET` and trusted system identity headers, then continuously drains `/api/workflows/tick`. This is the preferred production path for autonomous execution because it does not depend on user traffic.

## Cron cadence

`vercel.json` still schedules `/api/workflows/tick` **once daily** as a backstop. The dedicated worker should be the primary queue driver. User actions also drain opportunistically via `after()`.

A daily tick means an unattended workflow can wait up to 24h. Options:

- **Vercel Pro**: raise the cron expression (e.g. `*/5 * * * *`).
- **External pinger**: GitHub Actions schedule or QStash hitting `POST /api/workflows/tick` with `Authorization: Bearer $CRON_SECRET`.
- **Manual**: the "Tick queue" button in the Run workspace.

## Release gates

Before promoting a release:

```bash
npm run lint && npm run test:unit && npm run build
BASE_URL=<deployment-url> npm run test:production-smoke
```

CI runs lint + unit tests + build on every push/PR (`.github/workflows/ci.yml`); the nightly production smoke (`production-smoke.yml`) verifies the deployed instance and uploads release evidence.
