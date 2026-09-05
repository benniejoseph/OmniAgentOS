# API and Configuration Reference

All routes are under `/api`. The canonical production origin is
`https://asael.bennierichard.com`. JSON is the default request/response format;
`/api/agent` returns server-sent events. Dynamic IDs are opaque strings and
callers must not infer tenancy from them.

## Authentication

- Browser sessions use the `__Host-asael_session` cookie in production and `asael_session` locally. Login sets `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in production.
- `GET /api/auth/session` is safe to call anonymously and reports whether auth is enabled and whether the request is authenticated.
- Internal automation sends `x-omni-internal-auth` with `OMNIAGENT_INTERNAL_AUTH_SECRET` plus explicit tenant, user, and role headers. Never accept those identity headers without the secret in production.
- Inbound MCP uses one-time-visible `asael_sk_...` service API keys created in Settings. Only a SHA-256 digest is stored. Existing `omni_sk_...` keys remain verifiable during the compatibility window. The verified key scope is intersected with the actor's enabled MCP export policy; neither layer can grant access by itself.
- Vercel cron uses `Authorization: Bearer <CRON_SECRET>` with `GET /api/workflows/tick`.
- The dedicated worker uses internal authentication with `POST /api/workflows/tick`.

Existing `OMNIAGENT_*`, `x-omni-*`, `x-omniagent-*`, and `omni_sk_...` names
remain stable wire and deployment compatibility contracts; they are not
product display names.

Viewer permissions cover protected reads. Operator permissions cover agent runs, workflows, evaluations, and routine tool actions. Admin permissions cover identity, connectors, security controls, and other high-risk configuration. Each route performs its own action-level authorization; a valid session alone does not guarantee access.

## Public and authentication routes

- `GET /api/health`: public liveness/readiness summary. Returns 200 for healthy or local degraded storage and 503 when a configured database is unhealthy.
- Public registration and access-request intake are disabled. `/signup` permanently redirects to `/login`.
- `GET|POST /api/onboarding/access-requests`: admin-only list and approve/decline workflow for historical requests in the Inbox.
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`.
- `POST /api/mobile/auth/login`, `POST /api/mobile/auth/refresh`, `POST /api/mobile/auth/logout`, and `GET /api/mobile/bootstrap` provide the native opaque-token contract. Current clients attest normalized platform/version/build/contract metadata; legacy clients remain accepted but compatibility-unknown. All responses are private and no-store.
- `GET /api/mobile/adoption` is admin/system (`read.identity`) only and returns tenant-aggregate, PostgreSQL-authoritative native compatibility evidence. It never returns per-device or per-session identifiers and always reports Agent catalog enrollment as held.
- `GET|POST /api/auth/control-plane`: admin-only tenant/user/membership administration. `POST` creates a workspace user and returns a generated initial password when one is not supplied.

## Agent, memory, and retrieval

- `POST /api/agent`: bounded message array and mode (`orchestrate`, `research`, `execute`, or `learn`); streams SSE events.
- `GET|POST /api/agents` and `GET|PATCH|DELETE /api/agents/:id` manage custom Agent definitions. Bare list GET remains exact-owner and marks its custom rows actionable; `GET /api/agents?ownerScope=readable` is the request-bound compatibility list used by Arsenal and the web Mission workspace. Detail GET and the compatibility list add `selectable` and `manageable`: exact-owner rows are actionable, while canonical compatibility rows are read-only and cannot enter Command, Mission assignment, or native mutation controls. Agent creation and updates return `409` when any selected custom Skill is unavailable to the Agent's exact persisted tenant/actor owner.
- `GET|POST /api/skills` and `GET|PATCH|DELETE /api/skills/:id` manage the Skill catalog. Request reads add `selectable` and `manageable` capability flags: built-ins are selectable but not manageable, exact-owner custom Skills are both, and canonical compatibility rows are read-only and cannot be assigned.
- `/api/runs` and `/api/runs/:id`: run history, events, and replay/continuation state.
- `/api/memory`, `/api/memory/graph`, `/api/knowledge`, `/api/ingest`, and `/api/retrieval/plan`.
- `GET|POST /api/capture` lists or ingests Capture assets. Collection rows add `contentAvailable`, `indexable`, and `manageable`; exact-owner rows are actionable and canonical compatibility rows may be downloaded when their persisted content descriptor is valid, but cannot be indexed, changed, or deleted.
- `GET|POST|DELETE /api/capture/assets/:id` reads metadata or content, queues indexing, and deletes an asset. Public metadata and `content=1` GETs may read the validated canonical/current-email pair; PostgreSQL content is returned only after its persisted byte count and SHA-256 are verified in the same database read. Canonical compatibility rows remain read-only, while indexing, deletion, status changes, and linked knowledge cleanup stay exact-owner operations.
- `GET|POST /api/capture/recordings` keeps bare GET and creation exact-owner. `GET /api/capture/recordings?ownerScope=readable` is the web recording-history compatibility catalog: it returns summary fields only, marks every verified row `metadataDetailAvailable`, marks exact rows `detailAvailable` and `manageable`, and acknowledges `requestReadContracts.captureRecordings=readable_v1`. `GET /api/capture/recordings/:id?ownerScope=readable` returns a strictly validated public recording/segment metadata snapshot and acknowledges `requestReadContracts.captureRecordingDetail=readable_v1`; canonical history remains read-only and reports transcript, audio, and mutation capabilities as unavailable. Bare detail GET returns the full exact-owner recording and acknowledges `exact_v1`. Audio bytes, transcripts, completion, indexing, updates, deletion, and all other segment routes remain exact-owner.

## Workflows and operations

- `GET|POST /api/missions` keeps bare GET and creation exact-owner. `GET /api/missions?ownerScope=readable` returns only validated public mission summaries from the request-bound canonical/current-email pair and acknowledges `requestReadContracts.missions=readable_v1`; bare GET acknowledges `exact_v1`. `GET /api/missions/:id?ownerScope=readable&view=summary` re-proves one deep-linked public summary outside that bounded collection and acknowledges `requestReadContracts.missionSummary=readable_v1`; an exact summary may then use the unchanged bare detail route, while a retained canonical summary remains read-only. Exact-owner summaries advertise detail, management, and Command handoff capabilities. Full Mission detail, events, cancellation/archive, task creation/update/comments/review, attempts, artifacts, and runtime execution remain exact-owner.
- `/api/workflows`, `/api/workflows/:id`, `/api/workflows/plan`, and `/api/workflows/executions`.
- Workflow run responses preserve the legacy `status` field for polling and mutation controls. Full and list projections also add a display-only `canonicalStatus` plus `outcome`; `outcome` is either a schema-validated, metadata-only outcome contract and terminal receipt or `null`. `outcome.outcomeContractBindingState` is `posthoc` in this first slice because the contract is derived from the persisted pre-execution plan but was not itself bound before execution. A missing or malformed shadow receipt never upgrades legacy `completed` beyond canonical `unverified`. The compact `?view=status` response intentionally returns `outcome: null` because it does not load the result record.
- The first P1.4 canary adds the full `effectReceipt` only to the tool record for live `memory.write` performed as a single-tool node in an approved workflow with explicit tenant and initiating-actor scope. It exposes opaque IDs, SHA-256 bindings, and acknowledgement/read-after-write enums only. A strictly bound verified receipt ID may also appear in workflow evidence, but P1.3 remains `posthoc` and cannot report canonical `succeeded`.
- `POST /api/workflows` accepts a reviewed `planId`; retries with that plan return the already-bound run instead of creating or canceling duplicate work. Callers that start without a plan may send an `Idempotency-Key` header using up to 200 letters, numbers, dots, underscores, colons, or hyphens.
- `/api/workflows/:id/tick` and `/api/workflows/:id/signal` for controlled progression.
- `/api/triggers` and `/api/triggers/:id/dispatch`.
- `/api/operations`, `/api/approvals`, `/api/approvals/:id`, and `/api/workflows/tick`.

## Tools and connectors

- `/api/tools` and `/api/tools/execute`.
- `GET /api/oauth` keeps its legacy connection list exact-owner. `GET /api/oauth?ownerScope=readable` returns only validated public metadata from the request-bound canonical/current-email pair and acknowledges `requestReadContracts.oauthGrants=readable_v1`. Each row includes physical-owner-derived `manageable`; canonical continuity rows are read-only, and sealed tokens plus sync cursors are never selected. Authorization, callback, token opening/refresh, sync, Photos, and disconnect routes remain exact-owner.
- Tool execution records validate a present canary `effectReceipt` against the execution, tenant, actor, and `memory.write` tool bindings before returning it. Legacy records, dry runs, direct tool calls, and other tools omit the field and keep their existing response behavior. The canary covers the first-party memory-store commit acknowledgement and tenant-scoped read-after-write only; it is not full P1.4 external-effect support.
- `POST /api/mcp` is the stateless Streamable HTTP MCP endpoint. It accepts service-key Bearer authentication only, requires MCP to be enabled in Settings, rate-limits by tenant and key, and initially exports read-only memory, knowledge, mission, and run tools. Every call still uses the governed tool executor and durable tool audit. `GET` and `DELETE` return `405`.
- `/api/settings/providers`, `/api/settings/models`, `/api/settings/assignments`, `/api/settings/api-keys`, and `/api/settings/mcp` manage redacted provider connections, lifecycle-aware model selection, service keys, and the actor-owned MCP export boundary. Credential plaintext is accepted only on create/rotation and is never returned after storage. `GET /api/settings/providers?ownerScope=readable`, `GET /api/settings/assignments?ownerScope=readable`, `GET /api/settings/mcp?ownerScope=readable`, and `GET /api/settings?ownerScope=readable` opt their public metadata into strictly bound canonical/current-email reads; bare GETs stay exact. Successful provider, assignment, and MCP metadata responses acknowledge independent `requestReadContracts` entries as `readable_v1` or `exact_v1`; clients must require the matching readable contract before exposing writes. Provider rows include `manageable`; canonical connections are configuration-only and read-only, deployment fallbacks remain externally managed, and credential ciphertext/key IDs are never selected by the request reader. Assignment rows include `manageable` plus render-safe model identifiers; canonical routes are configuration-only, occupy their scope as a read-only continuity record, and never seed editable provider, fallback, or consent state. Authenticated model-catalog GETs may merge the same owners; `selectable` is true only for exact-owner identifiers accepted by the assignment API, while `displayModelId` is the safe UI projection of the persisted identifier. Authenticated service-key GETs select redacted columns and expose physical-owner-derived `manageable`. Request-readable MCP metadata selects only the public policy allowlist; a retained canonical policy is visible but cannot seed or authorize a save. Provider credential opening, validation, rotation, updates/revocation, catalog refresh, runtime model resolution, assignment PUT/pre-read, MCP PUT/pre-read and runtime policy resolution, key creation/revocation, Bearer verification, and last-used updates remain exact-owner operations.
- The built-in `http.request` tool never accepts pasted authorization, cookie, token, or API-key headers. Reference a deployer-bound `authEnv`; use the default Bearer authorization mode, Basic authorization mode, or raw `x-api-key`, `x-auth-token`, or `api-key` mode.
- `/api/connectors`, `/api/connectors/:id`, and `/api/connectors/:id/discover` for outbound MCP. `bearer_vault` accepts a write-only `bearerToken`, seals it with the tenant credential keyring, and returns only configured/version/fingerprint/rotation/origin-match metadata. `bearer_env` remains available for advanced deployer-managed integrations.
- `POST|DELETE /api/connectors/:id/credential` rotates or removes an app-managed MCP bearer token as a risk-2 admin operation. Rotation disables the connector and invalidates its discovered contracts until rediscovery and review. Removal scrubs the ciphertext and disables the connector, but does not revoke the external provider token.
- `/api/openapi-connectors`, `/api/openapi-connectors/:id`, and `/api/openapi-connectors/:id/import`.
- `/api/connection-catalog` and `/api/capabilities`.
- `GET|POST /api/capabilities/rollouts` exposes the tenant-bound capability rollout control plane. Authorized security readers may inspect a current generation by capability ID; trusted system automation may register or compare-and-swap a generation transition as a risk-3 operation. Responses expose opaque identifiers and hashes, never private capability payloads.

Connector API records never contain credential plaintext or sealed payloads. App-managed bearer credentials are decrypted only immediately before the exact-origin MCP request; deployer-managed connector records reference environment-variable names instead of values. Registration does not make an endpoint safe by itself; discovery/import and execution remain subject to network, role, risk, and approval policy.

## Evaluation, security, and operations evidence

- `GET /api/usage/summary`: tenant-scoped daily, weekly, and monthly AI consumption. `sourceStreams` and `providerCalls` cover model, embedding, search, media, and browser operations; provider/model breakdowns attribute retry and fallback receipts per actual provider call. `runs` and `modelCalls` remain compatibility counters for agent conversations. Unknown prices remain explicitly unpriced.
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

Application configuration comes from process environment variables. `NEXT_PUBLIC_*` values are embedded into browser bundles at build time; everything else must remain server-only. Set the production `NEXT_PUBLIC_APP_URL` to exactly `https://asael.bennierichard.com`. Vercel supplies deployment metadata through `VERCEL_*`. The worker reads `OMNIAGENT_WORKER_BASE_URL`, then `NEXT_PUBLIC_APP_URL`, then `BASE_URL`.

Use `.env.example` for the full supported list and defaults. Production-required values and operational smoke credentials are separated there. Smoke-only `SMOKE_*` values belong in the CI secret store, not in the web deployment. See [deployment.md](deployment.md) for rollout and rotation guidance.
