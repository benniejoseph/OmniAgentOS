# API and Configuration Reference

All routes are under `/api`. JSON is the default request/response format; `/api/agent` returns server-sent events. Dynamic IDs are opaque strings and callers must not infer tenancy from them.

## Authentication

- Browser sessions use the `omniagent_session` cookie. Login sets `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in production.
- `GET /api/auth/session` is safe to call anonymously and reports whether auth is enabled and whether the request is authenticated.
- Internal automation sends `x-omni-internal-auth` with `OMNIAGENT_INTERNAL_AUTH_SECRET` plus explicit tenant, user, and role headers. Never accept those identity headers without the secret in production.
- Vercel cron uses `Authorization: Bearer <CRON_SECRET>` with `GET /api/workflows/tick`.
- The dedicated worker uses internal authentication with `POST /api/workflows/tick`.

Viewer permissions cover protected reads. Operator permissions cover agent runs, workflows, evaluations, and routine tool actions. Admin permissions cover identity, connectors, security controls, and other high-risk configuration. Each route performs its own action-level authorization; a valid session alone does not guarantee access.

## Public and authentication routes

- `GET /api/health`: public liveness/readiness summary. Returns 200 for healthy or local degraded storage and 503 when a configured database is unhealthy.
- Public registration and access-request intake are disabled. `/signup` permanently redirects to `/login`.
- `GET|POST /api/onboarding/access-requests`: admin-only list and approve/decline workflow for historical requests in the Inbox.
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`.
- `GET|POST /api/auth/control-plane`: admin-only tenant/user/membership administration. `POST` creates a workspace user and returns a generated initial password when one is not supplied.

## Agent, memory, and retrieval

- `POST /api/agent`: bounded message array and mode (`orchestrate`, `research`, `execute`, or `learn`); streams SSE events.
- `/api/runs` and `/api/runs/:id`: run history, events, and replay/continuation state.
- `/api/memory`, `/api/memory/graph`, `/api/knowledge`, `/api/ingest`, and `/api/retrieval/plan`.

## Workflows and operations

- `/api/workflows`, `/api/workflows/:id`, `/api/workflows/plan`, and `/api/workflows/executions`.
- `POST /api/workflows` accepts a reviewed `planId`; retries with that plan return the already-bound run instead of creating or canceling duplicate work. Callers that start without a plan may send an `Idempotency-Key` header using up to 200 letters, numbers, dots, underscores, colons, or hyphens.
- `/api/workflows/:id/tick` and `/api/workflows/:id/signal` for controlled progression.
- `/api/triggers` and `/api/triggers/:id/dispatch`.
- `/api/operations`, `/api/approvals`, `/api/approvals/:id`, and `/api/workflows/tick`.

## Tools and connectors

- `/api/tools` and `/api/tools/execute`.
- The built-in `http.request` tool never accepts pasted authorization, cookie, token, or API-key headers. Reference a deployer-bound `authEnv`; use the default Bearer authorization mode, Basic authorization mode, or raw `x-api-key`, `x-auth-token`, or `api-key` mode.
- `/api/connectors`, `/api/connectors/:id`, and `/api/connectors/:id/discover` for MCP.
- `/api/openapi-connectors`, `/api/openapi-connectors/:id`, and `/api/openapi-connectors/:id/import`.
- `/api/connection-catalog` and `/api/capabilities`.

Connector records reference environment-variable names, not secret values. Registration does not make an endpoint safe by itself; discovery/import and execution remain subject to network, role, risk, and approval policy.

## Evaluation, security, and operations evidence

- `/api/evaluations`, `/api/evaluations/:id`, `/api/evaluations/:id/report`, and `/api/evaluations/:id/report/verify`.
- `/api/release/evidence`.
- `/api/security/context`, `/api/security/audits`, and `/api/security/isolation-report`.
- `GET|POST /api/security/retention`: inspect retention policy or run an admin tenant sweep; trusted system automation may sweep all tenants.
- `/api/trust` and `/api/events`.
- `/api/observability`, `/api/observability/slo`, `/api/observability/slo/policies`, `/api/diagnostics`, `/api/incidents`, `/api/incidents/:id/actions`, and `/api/alerts`.

## Common status codes

- `400`: body/schema validation failed.
- `401`: authentication is required or invalid.
- `403`: authenticated identity lacks the required action/role.
- `404`: resource is absent or intentionally hidden across tenant boundaries.
- `409`: state transition conflict.
- `413`: request body exceeds the configured limit.
- `429`: a shared Postgres-backed safety limit was reached (single-process fallback is used only outside durable deployments).
- `503`: production storage, cron, or a required dependency is unavailable.

## Configuration precedence and safety

Application configuration comes from process environment variables. `NEXT_PUBLIC_*` values are embedded into browser bundles at build time; everything else must remain server-only. Vercel supplies deployment metadata through `VERCEL_*`. The worker reads `OMNIAGENT_WORKER_BASE_URL`, then `NEXT_PUBLIC_APP_URL`, then `BASE_URL`.

Use `.env.example` for the full supported list and defaults. Production-required values and operational smoke credentials are separated there. Smoke-only `SMOKE_*` values belong in the CI secret store, not in the web deployment. See [deployment.md](deployment.md) for rollout and rotation guidance.
