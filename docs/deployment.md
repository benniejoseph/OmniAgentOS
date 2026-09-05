# Deployment (Vercel + Supabase + Fly)

Production uses Node.js 24.x and npm 11.x across local metadata, CI, and the worker image. Vercel Functions run in Singapore (`sin1`) beside the existing Supabase Singapore Postgres project; the existing Fly application remains in US Ashburn (`iad`) and provides both the durable worker and bounded OpenAI US egress gateway. The optional Playwright MCP browser service runs as a separate, isolated Fly application in Singapore so Chromium never shares the 256 MB worker machine. Its pinned Microsoft image is the sole vendor-runtime exception to the Node 24 policy. Static assets remain globally cached, and the daily Vercel cron remains only a backstop.

## Required production configuration

Set these through the platform secret/configuration store, never in source control:

- `DATABASE_URL`: durable TLS Postgres. Production without it is blocked unless `OMNIAGENT_ALLOW_DEMO_STORAGE=true`; that override is only for disposable demos.
- `OMNIAGENT_MAINTENANCE_DATABASE_URL`: the same logical database through a dedicated non-superuser role with `BYPASSRLS`. All-tenant worker and retention operations fail closed without it.
- `OMNIAGENT_BACKUP_DATABASE_URL`: the same logical database through a separate non-superuser `BYPASSRLS` backup role.
- `OPENAI_API_KEY`: required for live agent, embedding, and web-search calls. Without it, responses are simulated.
- `OMNIAGENT_OPENAI_GATEWAY_URL`: required for the `sin1` topology and pinned to `https://omniagent-os-worker.fly.dev/v1`. An explicit `:443` and one trailing slash canonicalize to that value; alternate hosts, ports, paths, credentials, query strings, and fragments fail closed.
- `OMNIAGENT_OPENAI_GATEWAY_TOKEN`: an independent URL-safe 32-256 character secret stored with the same value in Vercel and Fly. Proxy routes require it; it is never returned in release evidence.
- `OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN`: optional Fly-only overlap secret during a token rotation. When present it must independently be URL-safe, 32-256 characters, and different from the primary token. Never set it on Vercel.
- `OMNIAGENT_OPENAI_UPSTREAM_HOST`: Fly-only OpenAI API origin. It accepts exactly `api.openai.com` or `us.api.openai.com`; production uses `us.api.openai.com` for the regional API key. Arbitrary origins, URLs, paths, and ports fail before the gateway binds.
- `OMNIAGENT_PLAYWRIGHT_MCP_TOKEN`: independent URL-safe 32-256 character secret stored on the dedicated browser Fly app and, for each authorized workspace, in Asael's encrypted Playwright connector credential. It is not a Vercel environment variable.
- `OMNIAGENT_PLAYWRIGHT_MCP_PREVIOUS_TOKEN`: optional Fly-only overlap secret during browser-service token rotation.
- `CRON_SECRET`: authenticates the scheduled `/api/workflows/tick` backstop.
- `OMNIAGENT_INTERNAL_AUTH_SECRET`: shared by the worker and production smoke runner. Generate an independent high-entropy value.
- `OMNIAGENT_CREDENTIAL_KEYRING`: independent versioned AES-256-GCM keyring for tenant-managed model and outbound MCP credentials, formatted as `{"activeKeyId":"v1","keys":{"v1":"<32-byte-base64url>"}}`. Without it, app-managed credential writes fail closed while deployment-environment provider keys remain available.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, and `AWS_BEDROCK_*_MODEL`: optional deployment fallback for Bedrock. Prefer Settings-managed, tenant-scoped Bedrock credentials and assignments; never expose either credential path to the browser.
- `OMNIAGENT_MCP_ALLOWED_HOSTS` and `OMNIAGENT_MCP_ALLOWED_ORIGINS`: optional comma-separated additions to the inbound MCP DNS-rebinding and browser-origin allowlists. The canonical `NEXT_PUBLIC_APP_URL` and Vercel deployment hosts are included automatically.
- `OMNIAGENT_BOOTSTRAP_EMAIL` and `OMNIAGENT_BOOTSTRAP_PASSWORD`: required before first auth-store access. Confirm the persisted admin, then rotate or remove bootstrap credentials.
- `OMNIAGENT_REPORT_SIGNING_SECRET`: production signing key for evaluation evidence. Set `OMNIAGENT_REPORT_SIGNING_KEY_ID`; use `OMNIAGENT_REPORT_SIGNING_KEYS` JSON during rotation.
- `OMNIAGENT_ACCESS_REQUEST_FILE`: optional durable fallback path for local/non-database deployments. With `DATABASE_URL`, access requests are tenant-scoped in Postgres and appear in the admin Inbox for review.
- `NEXT_PUBLIC_APP_URL`: canonical HTTPS origin. Set it to exactly `https://asael.bennierichard.com`. It is public and build-inlined, not a secret.
- `OMNIAGENT_NATIVE_MIN_ANDROID_VERSION` and `OMNIAGENT_NATIVE_MIN_IOS_VERSION`: optional stable `major.minor.patch` minimums for native compatibility telemetry. An absent or empty value defaults to `1.0.0`; a malformed configured value invalidates the policy and holds adoption unavailable. These settings do not authorize Agent enrollment.

Keep `OPENAI_API_KEY` only on Vercel; the normal release shell does not need it, and it must never be stored on Fly. The paired release runs its paid verification through Asael, so the deployed server supplies the upstream OpenAI authorization while the gateway validates `x-asael-gateway-token` and forwards that header unchanged. Production always enables auth even when `OMNIAGENT_AUTH_ENABLED=false`. Vercel forwarding headers are trusted automatically; other reverse proxies must overwrite client forwarding headers before `OMNIAGENT_TRUST_PROXY_HEADERS=true` is enabled. Do not enable `OMNIAGENT_TRUST_UNSIGNED_IDENTITY_HEADERS`, `OMNIAGENT_CONNECTOR_ALLOW_HTTP`, or `OMNIAGENT_CONNECTOR_ALLOW_LEGACY_SYSTEM_SECRETS` in production.

## Supported configuration

`.env.example` is the complete copyable reference. Runtime groups are:

- Models and retrieval: `OPENAI_AGENT_MODEL`, `OPENAI_WEB_SEARCH_MODEL`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_EMBEDDING_DIMENSIONS`, `OMNIAGENT_OPENAI_GATEWAY_URL`, `OMNIAGENT_OPENAI_GATEWAY_TOKEN`, optional Fly-only `OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN`, Fly-only `OMNIAGENT_OPENAI_UPSTREAM_HOST`, `OMNIAGENT_OPENAI_GATEWAY_HEALTH_TIMEOUT_MS`, `OMNIAGENT_WEB_SEARCH_TIMEOUT_MS`, and the optional Bedrock fallback group (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_BEDROCK_MODEL`, `AWS_BEDROCK_FAST_MODEL`, `AWS_BEDROCK_REASONING_MODEL`).
- Database reads: `OMNIAGENT_DATABASE_POOL_MAX` bounds each process's runtime and maintenance pools. Durable production runtimes default to 4 so overlapping requests cannot be starved by a long workflow tick; size them against the upstream pooler's connection budget. Vercel is intentionally stricter: each runtime or maintenance pool inside a route bundle/isolate enforces a maximum of 1 connection even when the generic override is higher. Its postgres.js `idle_timeout` and `max_lifetime` timers are disabled: Vercel may freeze an isolate while a JavaScript connection timer is armed, then thaw it after the deadline while a new reservation is starting. Avoiding that timer race keeps the one-slot pool reusable; Vercel's isolate lifecycle and connection failures still retire sockets. Durable runtimes retain the 20-second idle timeout and postgres.js's randomized maximum-lifetime default. The single-slot Vercel pools prevent independent serverless functions from multiplying Supavisor frontends during burst traffic; work inside one warm pool is serialized through the existing admission queue. `OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS` bounds that cancellable application queue plus postgres.js pool-slot reservation for every tenant- and system-scoped query or callback transaction (20s by default, clamped to 0.5-30s). The 20s ceiling remains a rollback-safe bound from the former IAD-to-Singapore topology; warm requests do not wait for it. An independent `sin1` canary completed the security and tenant-scoped connector/workflow CRUD checks with a 15.7ms database `Server-Timing` sample, validating the regional direction while remaining too small a sample to justify lowering the rollback bound. Re-baseline it only after sustained production measurements prove a tighter safe value. Admission waiters that time out never enter postgres.js. If the sole Vercel reservation itself times out, Asael synchronously detaches that exact raw client and asks postgres.js to destroy it; queued reservations reject and release their existing admission permits, while the next request creates a fresh client and gate. This recovery is deliberately limited to Vercel's one-slot pools so one timeout never aborts valid concurrent work in a durable runtime. Every tenant- and system-scoped transaction applies `OMNIAGENT_DATABASE_STATEMENT_TIMEOUT_MS` (15s by default, clamped to 1-60s), `OMNIAGENT_DATABASE_LOCK_TIMEOUT_MS` (1s by default, clamped to 0.1-10s and never above the statement timeout), and `OMNIAGENT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS` (15s by default, clamped to 1-60s) on the database server. Together they bound statement execution, lock acquisition, and idle gaps between statements after a connection is leased; an abandoned transaction is terminated so its lease can be discarded and released. Request/platform deadlines remain responsible for other transport waits. `OMNIAGENT_SCHEMA_VERIFICATION_TIMEOUT_MS` is the production migration-marker verification watchdog and resets timed-out checks so later requests can retry. `OMNIAGENT_SETTINGS_CAPABILITY_TIMEOUT_MS` bounds the tenant-scoped Settings response and returns explicit unavailable fields when the database misses that deadline; `OMNIAGENT_SETTINGS_CAPABILITY_STATEMENT_TIMEOUT_MS` may lower the shared database deadline for the aggregate query. `OMNIAGENT_TODAY_SNAPSHOT_STATEMENT_TIMEOUT_MS` provides the same shorter override for the single owner-scoped Today projection query.
- Agent limits: `OMNIAGENT_AGENT_MAX_TOOL_STEPS`, `OMNIAGENT_AGENT_MAX_MESSAGE_CHARS`, `OMNIAGENT_AGENT_MAX_MESSAGES`, `OMNIAGENT_AGENT_RUNS_PER_MINUTE`, `OMNIAGENT_AGENT_REASONING_EFFORT`, and `OMNIAGENT_AGENT_MAX_OUTPUT_TOKENS`.
- Workflow limits: `OMNIAGENT_QUEUE_LEASE_SECONDS`, `OMNIAGENT_WORKFLOW_DRAIN_LIMIT`, `OMNIAGENT_WORKFLOW_PLANNER_TIMEOUT_MS`, and `OMNIAGENT_WORKFLOW_EXECUTOR_TIMEOUT_MS`.
- Identity: `OMNIAGENT_DEFAULT_TENANT`, `OMNIAGENT_DEFAULT_ACTOR`, `OMNIAGENT_DEFAULT_ROLE`, `OMNIAGENT_SESSION_DAYS`, bounded mobile token lifetimes, native platform minimum versions, bootstrap name/tenant, and auth mode.
- Trust: `OMNIAGENT_GRADUATED_AUTONOMY` and `OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD`.
- Alerts: queue/dispatch limits, signed webhook URL/secret, Slack webhook, Resend key, and email addresses.
- Connectors: app-managed MCP bearer credentials use `OMNIAGENT_CREDENTIAL_KEYRING` and require no per-connector environment binding. The Playwright service token uses this vault path and is scoped again with an opaque tenant+actor+run HMAC on every request. The legacy advanced `bearer_env` path uses `OMNIAGENT_CONNECTOR_SECRET_ALLOWLIST`, JSON `OMNIAGENT_CONNECTOR_SECRET_BINDINGS`, and referenced `OMNIAGENT_CONNECTOR_*` values; every such credential requires an exact tenant-and-origin deployer binding. Keep `OMNIAGENT_CONNECTOR_ALLOW_LEGACY_SYSTEM_SECRETS=false`.
- Model credentials and inbound MCP: `OMNIAGENT_CREDENTIAL_KEYRING`, `OMNIAGENT_MCP_ALLOWED_HOSTS`, and `OMNIAGENT_MCP_ALLOWED_ORIGINS`. MCP remains disabled per actor until enabled in Settings and requires a scoped, hash-only service key.
- Workflow triggers: use dedicated `OMNIAGENT_TRIGGER_*` HMAC keys. Put legacy server-only names in `OMNIAGENT_TRIGGER_SECRET_ALLOWLIST`; platform credentials are always rejected, and unauthenticated triggers remain disabled at dispatch time in production.
- Diagnostics/storage: `OMNIAGENT_LOG_PGVECTOR_FAILURES`, `OMNIAGENT_DATA_DIR`, and the demo-storage switch.

Platform-provided `VERCEL_*` values supply deployment metadata and are not copied into `.env.example`. See [api-reference.md](api-reference.md) for route authentication and response expectations.

## Schema and migration rollout

Production request traffic verifies the schema and fails closed when a migration
is missing; it never runs DDL. Ordered migrations are recorded in
`omni_schema_version` and execute in one transaction under a Postgres advisory
lock. The path also upgrades the legacy timestamp-only marker. Migrations are
idempotent, but there is no automatic down-migration.

For each rollout:

1. Take and verify a restorable database backup.
2. Run `npm run verify` and the Postgres integration job against an isolated database.
3. From a dedicated release job, set `MIGRATION_DATABASE_URL` to the
   migration-owner connection and run `npm run db:migrate`. Set
   `OMNIAGENT_MIGRATION_STATEMENT_TIMEOUT_MS` explicitly for large backfills and
   retain the JSON job logs.
4. Deploy the serving canary with a separate non-owner, non-superuser runtime
   `DATABASE_URL`, then trigger `/api/health`.
5. Inspect `omni_schema_version`, pgvector status, forced RLS, and worker logs.
6. Confirm all expected migration versions before increasing traffic or worker count.
7. Run production smoke against the exact canary revision.

The migration role needs permission to create/alter application tables,
policies, functions, indexes, and the `vector` extension. The serving runtime
role must not own the schema, be a superuser, or have `BYPASSRLS`. If extension
creation is denied, the app continues with JSON embeddings; treat that as a
capacity/performance warning and install pgvector out of band.

The maintenance and backup URLs must not reuse the serving runtime role. The
application verifies the maintenance role and durable database identity before
system-scope work. The backup wrapper verifies the backup role and database
identity (or, before the identity migration exists, an exact configured
host/port/database match).

Keep migrations backward-compatible for at least one application rollback. If a future migration removes or rewrites data, use a staged expand/backfill/contract release rather than relying on a code rollback.

## Dedicated worker and monitoring

Run web and worker separately:

```bash
npm run start
npm run worker
```

The Fly image is pinned to Node 24.13.0 and runs as the non-root `node` user. It hosts the worker and the small OpenAI egress gateway in the existing 256 MB machine. Every successful queue tick updates an owner-only heartbeat; the container health check fails when that heartbeat is stale, so a healthy gateway cannot mask a wedged worker. `fly.toml` pins the allowlisted `us.api.openai.com` origin required by the production regional key and contains only non-secret settings; configure `OMNIAGENT_INTERNAL_AUTH_SECRET` and gateway tokens with Fly secrets.

Perform the gateway secret setup once. Generate a fresh token in memory, stage it on Fly through stdin, send the identical value to Vercel through stdin as a sensitive production variable, and then unset it. Do not configure a previous token for the initial release. The commands themselves contain no secret value:

```bash
gateway_token="$(openssl rand -hex 32)"
printf 'OMNIAGENT_OPENAI_GATEWAY_TOKEN=%s\n' "$gateway_token" |
  fly secrets import --app omniagent-os-worker --stage
printf '%s' "$gateway_token" |
  vercel env add OMNIAGENT_OPENAI_GATEWAY_TOKEN production --sensitive --force --scope benniejosephs-projects
# Save gateway_token in the owner's password manager before this line.
unset gateway_token

printf '%s\n' 'https://omniagent-os-worker.fly.dev/v1' |
  vercel env add OMNIAGENT_OPENAI_GATEWAY_URL production --force --scope benniejosephs-projects
```

Store that generated token in the owner's password manager at the marked line before unsetting it. Vercel intentionally does not return `--sensitive` values through `vercel env pull` or `vercel env run`, while the paired release runner needs the token locally to validate the complete `sin1` configuration and send the shared header without printing it. For a normal release, load only the active token. `OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN` must be absent; the release runner stages removal of any obsolete Fly overlap secret. Always unset the variables afterward:

```bash
printf 'Gateway token: '
IFS= read -r -s gateway_token
printf '\n'
export OMNIAGENT_OPENAI_GATEWAY_TOKEN="$gateway_token"
export OMNIAGENT_OPENAI_GATEWAY_URL='https://omniagent-os-worker.fly.dev/v1'
unset OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN
npm run deploy:production
unset OMNIAGENT_OPENAI_GATEWAY_TOKEN OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN OMNIAGENT_OPENAI_GATEWAY_URL gateway_token
```

For the first gateway rollout only, also export
`OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER=CONFIRMED`. This explicit flag skips
the impossible prior-gateway check because the currently promoted release still
uses direct OpenAI access. If that rollout fails, the runner uses
`fly.initial-cutover-rollback.toml` to restore the previous service-free worker
image after restoring the previous Vercel release. The flag is rejected during
a token rotation and must be unset immediately after the first successful
rollout. It must never be configured as a persistent Vercel or Fly variable.

Do not place either gateway token in `.env`, a command argument, shell history, CI output, or `BASE_URL`. The release runner sends Fly secret values only over suppressed stdin; values are never put in a subprocess argument or diagnostic. `OPENAI_API_KEY` remains a non-exportable Vercel secret and is deliberately absent from normal release configuration.

Do not set `OPENAI_API_KEY` on Fly. `/healthz` is the intentionally minimal, non-sensitive Fly liveness route and returns only status, service, Fly region, release revision, and gateway protocol. `/v1/*` proxy requests require `x-asael-gateway-token` plus the OpenAI `Authorization` header supplied by Vercel. Gateway readiness also calls the allowlisted model-readiness path without an OpenAI Authorization header: HTTP 400 proves that the supplied gateway token reached the authorization boundary without making an upstream or paid request.

## Self-hosted Playwright browser service

The Playwright option uses the Apache-2.0 [Microsoft Playwright MCP server](https://github.com/microsoft/playwright-mcp), not a paid browser API. `Dockerfile.playwright-mcp` pins the official browser image by version and digest, while `fly.playwright-mcp.toml` keeps Chromium in a separate 1 GB Singapore machine. The gateway accepts only its bearer token, converts Asael's opaque tenant+actor+run scope into one private browser process, and removes the bearer secret before starting Playwright. A DNS-validating outbound proxy permits public web ports only and blocks loopback, private, link-local, metadata, and internal Fly destinations.

Each scoped process has its own temporary profile and a private keeper connection so Asael's short MCP calls retain the same tabs and page state. Connector discovery retires immediately; execution scopes expire after 30 minutes without activity. The service deliberately allows at most two simultaneous browser scopes on the default machine. Page output remains untrusted tool data, and Playwright's arbitrary-code and file-transfer tools remain risk level 3.

Create the app and token once, save the token in the owner's password manager, and deploy the dedicated image. The token value never belongs in Vercel:

```bash
playwright_token="$(openssl rand -hex 32)"
printf 'OMNIAGENT_PLAYWRIGHT_MCP_TOKEN=%s\n' "$playwright_token" |
  fly secrets import --app omniagent-os-browser --stage
fly deploy --config fly.playwright-mcp.toml --remote-only
# Save playwright_token in the owner's password manager before this line.
unset playwright_token
```

In Asael, open Settings → Tools & integrations → MCP connections, apply the Playwright preset, and store that same token in the encrypted app vault. Clients use the canonical endpoint `https://asael.bennierichard.com/api/integrations/playwright/mcp`; Asael proxies that bounded MCP stream to the pinned browser service without exposing the internal host as the product domain. Existing connectors that still hold the former direct endpoint remain supported during rotation. If Fly requires another globally unique app name, update the internal Fly host, proxy upstream, connector trust rule, and deployment configuration together. The software has no provider subscription, but the separate Fly compute resource can still incur hosting charges.

### Two-phase gateway token rotation

Use an overlap release; never replace the Fly primary token before the new Vercel deployment exists:

1. Retrieve the token embedded in the currently promoted Vercel deployment from the owner's password manager and keep it as the rollback token.
2. Generate and save a distinct candidate token. Update only Vercel's sensitive production `OMNIAGENT_OPENAI_GATEWAY_TOKEN`; existing deployments retain their original environment snapshot.
3. In the release shell, set the candidate as primary and the currently promoted token as previous:

   ```bash
   export OMNIAGENT_OPENAI_GATEWAY_TOKEN="$candidate_gateway_token"
   export OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN="$rollback_gateway_token"
   export OMNIAGENT_OPENAI_GATEWAY_URL='https://omniagent-os-worker.fly.dev/v1'
   npm run deploy:production
   unset OMNIAGENT_OPENAI_GATEWAY_TOKEN OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN OMNIAGENT_OPENAI_GATEWAY_URL candidate_gateway_token rollback_gateway_token
   ```

4. The release runner stages both Fly secrets via stdin, deploys the candidate worker, and authenticates both tokens before staged smoke, promotion, and canonical smoke. The prior Vercel deployment therefore remains usable throughout promotion.
5. If rollback is required, the runner first promotes the prior Vercel deployment while Fly still accepts its token, swaps the Fly secrets so that rollback becomes primary and candidate becomes previous, restores the prior worker image, and authenticates the restored web/gateway revision pair before smoke preflight.
6. Retain both password-manager entries through the rollback window. On the next successful non-rotation release, omit `OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN`; the runner stages its removal before deploying. Do not retire it manually between the paired release stages.

Worker routes fence mutations by `OMNIAGENT_WORKER_PROTOCOL_VERSION`. The Git revision remains in heartbeat and request metadata for diagnostics, but compatible worker and web revisions can deploy independently. Use the paired deployment command from a completely clean working tree. Before changing either platform, it validates the production URL, smoke credentials, pinned gateway origin, token formats, and current rollback-token reachability; it also captures the current Fly image and Vercel deployment for rollback. It verifies the release, creates an unpromoted production-target Vercel deployment, stages the primary/previous Fly token set, and uses Fly's blue/green strategy plus the `/healthz` service check so the existing gateway stays routable until the candidate is healthy. The candidate worker targets the exact web canary while retaining the canonical URL for a revision-gated switch. The runner polls `/healthz` until service `asael-openai-egress`, Fly region `iad`, the exact release revision, and protocol `1` all match, then separately authenticates each configured token without an OpenAI request.

After the worker registration window, each release phase runs one successful logical paid agent turn through the exact staged or canonical Asael origin. The verifier creates a unique synthetic tenant and tool-free session-memory agent pinned to `openai_fast`, checks a description/accent update, submits the direct `hello` turn once at the application layer, and requires the exact `ASAEL_LIVE_OK` response. It then proves one OpenAI model receipt with positive token usage, no fallback, delegation, tools, council, or consolidation; verifies replay and trajectory integrity against the release revision; and physically deletes the temporary agent. The isolated run and bounded trajectory receipt remain as release evidence. Staged and canonical verification therefore produce two successful logical paid turns per release. The OpenAI SDK transport may still perform its own retry before a logical turn completes; the release runner never retries the `/api/agent` POST. Only after the staged verifier passes does it run production smoke plus API and browser dashboard budgets and expose the web release. After Vercel promotion it sends the worker a targeted `SIGHUP`; the worker verifies canonical health/revision and moves every lane in place without restarting the co-hosted gateway. The canonical target is also recovered revision-safely after a later process restart. Gateway authentication and the paid agent verifier repeat after that rebind; rollback repeats the token-pair check without spending on another model call. A failed staged gate restores the previous worker image and primary token without exposing the web release; a failed post-promotion check restores both releases and verifies the restored gateway pairing.

```bash
npm run deploy:production
```

Set `BASE_URL` to the canonical production HTTPS origin and provide the smoke
credentials, internal secret, pinned gateway URL, active token, optional
rotation-only previous token, and `RELEASE_EVIDENCE_OUTPUT`
described below. `vercel.json` is authoritative for the `sin1` function region;
the release preflight fails closed when that topology lacks either gateway value.
Gateway readiness defaults to a 120-second total deadline, one-second polling,
and five-second request deadline; the bounded overrides are
`OMNIAGENT_DEPLOY_GATEWAY_READINESS_TIMEOUT_MS`,
`OMNIAGENT_DEPLOY_GATEWAY_READINESS_POLL_MS`, and
`OMNIAGENT_DEPLOY_GATEWAY_READINESS_REQUEST_TIMEOUT_MS`.
The optional isolated `--gateway-paid-probe` diagnostic still calls the gateway
directly and therefore requires a temporary local `OPENAI_API_KEY`. Its model
and deadline can be overridden with `OMNIAGENT_DEPLOY_OPENAI_SMOKE_MODEL` and
`OMNIAGENT_DEPLOY_PAID_INFERENCE_TIMEOUT_MS`. It is not part of the normal
paired release; prefer the application-level verifier for release evidence.
The paired deployment waits 75 seconds after the staged Fly replacement and
again after the in-place canonical target switch by default
(`OMNIAGENT_DEPLOY_WORKER_STARTUP_SETTLE_MS`) so the staggered fast,
background, and maintenance startup registrations are visible before the
target-specific release gate runs.
When the platform exposes `CRON_SECRET` to the release runner, preflight probes
that credential directly; for write-only platform secrets it verifies the
promoted deployment's `cron_auth` release gate instead. When deployment
protection applies to staged production deployments, set
`VERCEL_AUTOMATION_BYPASS_SECRET` for the release runner and configure the same
name as a Fly secret so worker requests can reach the canary.

The worker emits one JSON startup record and one record per lane tick. Fast workflow and continuation pickup begins with a five-second post-attempt pause and exponentially backs off to 30 seconds while idle; any activity immediately restores the five-second cadence. Durable consolidation/ingestion/evaluation begins at 15 seconds after a 7.5-second startup delay and backs off to five minutes while idle. The maintenance lane registers its revision heartbeat after 60 seconds, waits another 15 minutes before its first SLO/alert/recovery pass so a paired release can finish without competing heavy work, and then pauses for five minutes after each attempt. Database-backed worker heartbeats are refreshed at most every five minutes per lane while the local health file is still updated after every attempt. Idle polls authenticate and enforce RBAC but do not append redundant allow/observability rows; startup registration and consequential outcomes remain durable audit evidence. The bounded, all-tenant sensitive-data retention sweep starts ten minutes after a restart and then runs every six hours by default. These startup delays and idle backoff prevent a Fly restart or an empty queue from creating unnecessary Vercel CPU, Supabase egress, or telemetry growth. Alert on:

The production release runner also starts the candidate Fly image with `OMNIAGENT_WORKER_RELEASE_HOLD=true`. While held, the co-hosted OpenAI gateway remains healthy and the fast, background, and maintenance lanes each send one `startup: true` revision/target registration, then stay silent until the target changes or work is explicitly activated; failed registrations retry after 30 seconds, and retention does not execute. Promotion sends `SIGHUP` to verify and rebind the same process to the exact canonical revision without releasing work. Only after canonical paid inference, smoke, preview, and dashboard checks pass does the runner send `SIGUSR1`; the worker then writes an exact-revision activation marker and enables canonical work. The release command waits for active worker traffic and repeats security and release-evidence checks before declaring success. A same-machine process restart honors only an exact matching marker and still requires the canonical target; if canonical health is transiently unavailable, the fast lane retries that exact-revision rebind no more than every 30 seconds without enabling staged work. A normal held canary never performs that automatic switch. Rollback explicitly disables the hold for compatibility with older worker images.

- no successful fast-lane tick for more than twice `OMNIAGENT_WORKER_IDLE_MAX_INTERVAL_MS`;
- no successful serialized heavy-lane tick within `OMNIAGENT_WORKER_HEARTBEAT_MAX_AGE_MS`;
- repeated non-2xx tick responses or thrown fetches;
- queue `failed`/`requeued` growth;
- container health failures or restart loops;
- authentication failures after secret rotation.
- failed retention sweeps or a sweep that has not succeeded within twice `OMNIAGENT_WORKER_RETENTION_INTERVAL_MS`.

The fast, background, and maintenance cadence values are delays after a completed attempt, rather than start-to-start intervals, so a slow lane cannot busy-loop. Background, maintenance, and retention also share one FIFO in-process gate: only one database-heavy HTTP job runs at a time, while the latency-sensitive fast lane remains independent. `OMNIAGENT_WORKER_HEARTBEAT_MAX_AGE_MS` defaults to 35 minutes so a lane can sleep, wait behind the other two bounded heavy jobs, and complete its own request without being declared stale. This deliberately trades heavy-lane throughput for predictable database pressure; the gate is process-local, so keep a single worker replica unless cross-replica concurrency is separately coordinated. `OMNIAGENT_WORKER_LIMIT` is capped at 3 so one tick cannot create unbounded fan-out. Coordinate lane cadence, startup delays, lease duration, database capacity, and worker replica count before scaling.

`vercel.json` schedules a daily tick as a recovery backstop. A daily-only deployment can leave unattended work waiting up to 24 hours.

## Production smoke state

The `Production Smoke` workflow supports schedule and manual dispatch. Configure:

- repository variable `PRODUCTION_SMOKE_BASE_URL`;
- secrets `SMOKE_ADMIN_EMAIL`, `SMOKE_ADMIN_PASSWORD`, and `SMOKE_INTERNAL_AUTH_SECRET`.

Scheduled runs resolve the exact revision from the healthy production
`/api/health` response before any authenticated gate and publish that immutable
SHA to the remaining steps. A manual dispatch may instead supply
`expected_revision` to pin a canary or release candidate explicitly. Revision
discovery accepts only a healthy response and an exact 40-character Git SHA;
it is not a fallback for a supplied mismatch.

The workflow has no fallback URL and never treats a missing credential as a pass. Preflight requires a healthy HTTPS target. Critical requests have bounded timeouts, gates run as separate diagnostic steps, release evidence is size-limited, and a missing artifact or failed upload fails the job.

Expected production state is:

- `/api/health` returns 200;
- protected APIs reject anonymous access;
- the smoke administrator can authenticate and receives secure cookie attributes;
- internal smoke auth is configured;
- the OpenAI egress gateway is safely configured, reachable in `iad`, and matches the web release revision and gateway protocol;
- database tenant isolation and the latest tenant-isolation evaluation pass;
- observability SLO and report-signing gates pass;
- the release gate reports `passed` and `approved: true`.

Run the same chain manually with explicit, temporary environment variables:

```bash
BASE_URL=https://deployment.example \
SMOKE_ADMIN_EMAIL=... \
SMOKE_ADMIN_PASSWORD=... \
SMOKE_INTERNAL_AUTH_SECRET=... \
RELEASE_EVIDENCE_OUTPUT=artifacts/release-evidence.json \
npm run test:production-smoke
```

Never place smoke credentials in command history on shared systems; prefer a secret-injecting runner.

## Backup, restore, and rollback

Define an owner, RPO, RTO, retention period, and restore-test cadence before launch.

- Use provider point-in-time recovery plus periodic logical backups (`pg_dump --format=custom`) encrypted outside the application account.
- Back up the database before migration and retain signed release-evidence artifacts with deployment SHA and schema versions.
- Test restore into an isolated database, run schema/RLS integration tests, and verify a representative tenant before calling a backup valid.
- File/demo storage is not a production backup source.

The repository includes operator-safe wrappers that keep database passwords out of command arguments and write checksum/evidence files with owner-only permissions:

```bash
DATABASE_URL=... \
OMNIAGENT_BACKUP_DATABASE_URL=... \
OMNIAGENT_BACKUP_OUTPUT=/secure/omniagent.dump \
npm run db:backup

OMNIAGENT_BACKUP_INPUT=/secure/omniagent.dump \
DATABASE_URL=postgres://.../production \
RESTORE_DATABASE_URL=postgres://.../isolated_restore \
RESTORE_CONFIRM=restore-into-isolated-database:isolated_restore \
npm run db:restore-drill
```

The restore drill is destructive only to `RESTORE_DATABASE_URL`. It requires the production URL for comparison, rejects a target with the production database name even when provider host aliases differ, requires target-specific confirmation, verifies the backup manifest checksum before restore, validates the exact Asael table, row-count, migration-marker, database-identity, and forced-RLS inventories, and writes a restore-evidence artifact. Run it on a schedule in isolated infrastructure and retain the evidence.

Restore procedure:

1. Stop workers and disable cron so no new writes arrive.
2. Create a new isolated database from the selected point-in-time or logical backup.
3. Validate schema versions, pgvector, row-level policies, tenant counts, and auth records.
4. Point a canary deployment at the restored database and run smoke.
5. Switch production only after evidence passes; then restart one worker and watch queue behavior.

For an application rollback, stop workers, redeploy the previous known-good artifact, and run smoke before restoring traffic. Do not run an older build against a schema it cannot understand. For a destructive database change, restore to a new database rather than overwriting the only production copy.

## Data retention and audit limits

Production defaults remove expired authentication sessions, expire undecided tool approvals after 7 days, redact unreviewed access requests after 30 days, delete reviewed access requests after 365 days, remove raw episode memory and retrieval traces after 30 days and consolidated memory after 365 days, remove terminal run content after 30 days, and remove completed workflows, webhook events, queue jobs, terminal tool payloads, AI usage receipts, and domain events after 90 days. AI usage retention also removes its typed receipt and redacts granular model metrics from longer-lived run and observability compatibility events. Observability events default to 30 days and security audits to 365 days. Affected memory graphs are rebuilt from retained evidence through generation-fenced leases. The maintenance lane also physically scrubs descendants already hidden by immutable memory-deletion receipts in bounded batches; the receipt is the durable retry manifest and `OMNIAGENT_MEMORY_DELETION_SCRUB_SLA_HOURS` sets the reported completion SLA (24 hours by default). Expiring an approval redacts its raw arguments and closes the paused agent run; executing work is never deleted. Configure the `OMNIAGENT_RETENTION_*_DAYS` values—including `OMNIAGENT_RETENTION_AI_USAGE_DAYS`—to meet organizational and legal requirements and `OMNIAGENT_RETENTION_BATCH_SIZE` to bound each data-class mutation. When a batch is full, the dedicated worker schedules another pass after one minute instead of waiting for the normal retention interval. The worker runs the sweep; system automation can also call `POST /api/security/retention` with `{"scope":"all_tenants"}`. Admins can inspect the policy and sweep their tenant.

Local JSON mode is bounded and mutable: domain events retain up to 5,000 records, security audits up to 1,000, and tool executions up to 250. It is disposable demo storage rather than a retention-compliant backend. Signed reports establish integrity evidence but are not WORM storage; use object lock or an equivalent external control when required.

## Connector risk controls

Connector endpoints are SSRF-checked and secret references are restricted, but operators still control a powerful outbound boundary:

- approve only HTTPS endpoints and expected DNS ownership;
- use per-connector, least-privilege credentials with rotation and revocation;
- prefer app-managed MCP credentials for tenant administration; removing one from Asael scrubs local ciphertext but does not revoke it at the provider;
- never add platform credentials such as `OPENAI_API_KEY` or `DATABASE_URL` to the connector allowlist;
- review imported OpenAPI operations and MCP tool changes before activation;
- keep risky or side-effecting operations approval-gated;
- monitor redirects, DNS changes, response size/latency, vendor outages, and unexpected tool catalog drift.

## Required checks and branch protection

Configure branch protection externally to require these exact checks:

- `CI / quality`
- `CI / build`
- `CI / audit`
- `CI / integration`
- `CI / e2e`
- `CI / worker`

Also require the scheduled/manual `Production Smoke / production-smoke` result in the deployment promotion system. Repository code cannot enforce GitHub branch protection by itself.

For common failures, see [troubleshooting.md](troubleshooting.md). Use [production-rollout.md](production-rollout.md) at promotion time.
