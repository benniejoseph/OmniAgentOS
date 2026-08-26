# Deployment (Vercel + Neon)

Production uses Node.js 24.x and npm 11.x across local metadata, CI, and the worker image. The expected topology is a Next.js web deployment, TLS-enabled Postgres with pgvector, and one or more dedicated workers. The daily Vercel cron remains only a backstop.

## Required production configuration

Set these through the platform secret/configuration store, never in source control:

- `DATABASE_URL`: durable TLS Postgres. Production without it is blocked unless `OMNIAGENT_ALLOW_DEMO_STORAGE=true`; that override is only for disposable demos.
- `OMNIAGENT_MAINTENANCE_DATABASE_URL`: the same logical database through a dedicated non-superuser role with `BYPASSRLS`. All-tenant worker and retention operations fail closed without it.
- `OMNIAGENT_BACKUP_DATABASE_URL`: the same logical database through a separate non-superuser `BYPASSRLS` backup role.
- `OPENAI_API_KEY`: required for live agent, embedding, and web-search calls. Without it, responses are simulated.
- `CRON_SECRET`: authenticates the scheduled `/api/workflows/tick` backstop.
- `OMNIAGENT_INTERNAL_AUTH_SECRET`: shared by the worker and production smoke runner. Generate an independent high-entropy value.
- `OMNIAGENT_BOOTSTRAP_EMAIL` and `OMNIAGENT_BOOTSTRAP_PASSWORD`: required before first auth-store access. Confirm the persisted admin, then rotate or remove bootstrap credentials.
- `OMNIAGENT_REPORT_SIGNING_SECRET`: production signing key for evaluation evidence. Set `OMNIAGENT_REPORT_SIGNING_KEY_ID`; use `OMNIAGENT_REPORT_SIGNING_KEYS` JSON during rotation.
- `OMNIAGENT_ACCESS_REQUEST_FILE`: optional durable fallback path for local/non-database deployments. With `DATABASE_URL`, access requests are tenant-scoped in Postgres and appear in the admin Inbox for review.
- `NEXT_PUBLIC_APP_URL`: canonical HTTPS origin. It is public and build-inlined, not a secret.

Production always enables auth even when `OMNIAGENT_AUTH_ENABLED=false`. Vercel forwarding headers are trusted automatically; other reverse proxies must overwrite client forwarding headers before `OMNIAGENT_TRUST_PROXY_HEADERS=true` is enabled. Do not enable `OMNIAGENT_TRUST_UNSIGNED_IDENTITY_HEADERS`, `OMNIAGENT_CONNECTOR_ALLOW_HTTP`, or `OMNIAGENT_CONNECTOR_ALLOW_LEGACY_SYSTEM_SECRETS` in production.

## Supported configuration

`.env.example` is the complete copyable reference. Runtime groups are:

- Models and retrieval: `OPENAI_AGENT_MODEL`, `OPENAI_WEB_SEARCH_MODEL`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_EMBEDDING_DIMENSIONS`, and `OMNIAGENT_WEB_SEARCH_TIMEOUT_MS`.
- Database reads: `OMNIAGENT_DATABASE_POOL_MAX` bounds each process's runtime and maintenance pools. Production defaults to 4 so overlapping requests cannot be starved by a long workflow tick; size it against the upstream pooler's connection budget. `OMNIAGENT_SCHEMA_VERIFICATION_TIMEOUT_MS` is the production migration-marker verification watchdog and resets timed-out checks so later requests can retry. `OMNIAGENT_SETTINGS_CAPABILITY_TIMEOUT_MS` bounds the tenant-scoped Settings response and returns explicit unavailable fields when the database misses that deadline; `OMNIAGENT_SETTINGS_CAPABILITY_STATEMENT_TIMEOUT_MS` cancels the underlying aggregate query afterward so it cannot retain a pool slot indefinitely.
- Agent limits: `OMNIAGENT_AGENT_MAX_TOOL_STEPS`, `OMNIAGENT_AGENT_MAX_MESSAGE_CHARS`, `OMNIAGENT_AGENT_MAX_MESSAGES`, `OMNIAGENT_AGENT_RUNS_PER_MINUTE`, `OMNIAGENT_AGENT_REASONING_EFFORT`, and `OMNIAGENT_AGENT_MAX_OUTPUT_TOKENS`.
- Workflow limits: `OMNIAGENT_QUEUE_LEASE_SECONDS`, `OMNIAGENT_WORKFLOW_DRAIN_LIMIT`, `OMNIAGENT_WORKFLOW_PLANNER_TIMEOUT_MS`, and `OMNIAGENT_WORKFLOW_EXECUTOR_TIMEOUT_MS`.
- Identity: `OMNIAGENT_DEFAULT_TENANT`, `OMNIAGENT_DEFAULT_ACTOR`, `OMNIAGENT_DEFAULT_ROLE`, `OMNIAGENT_SESSION_DAYS`, bootstrap name/tenant, and auth mode.
- Trust: `OMNIAGENT_GRADUATED_AUTONOMY` and `OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD`.
- Alerts: queue/dispatch limits, signed webhook URL/secret, Slack webhook, Resend key, and email addresses.
- Connectors: `OMNIAGENT_CONNECTOR_SECRET_ALLOWLIST`, JSON `OMNIAGENT_CONNECTOR_SECRET_BINDINGS`, plus referenced `OMNIAGENT_CONNECTOR_*` values. Every connector credential requires an exact tenant-and-origin deployer binding; a name prefix or system role alone does not grant access. Keep `OMNIAGENT_CONNECTOR_ALLOW_LEGACY_SYSTEM_SECRETS=false`.
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

The Fly worker image is pinned to Node 24.13.0, contains only the worker script, and runs as the non-root `node` user. Every successful queue tick updates an owner-only heartbeat; the container health check fails when that heartbeat is stale, so a healthy web app cannot mask a wedged worker. `fly.toml` contains only non-secret settings; configure `OMNIAGENT_INTERNAL_AUTH_SECRET` with `fly secrets`.

Worker routes fence mutations by `OMNIAGENT_WORKER_PROTOCOL_VERSION`. The Git revision remains in heartbeat and request metadata for diagnostics, but compatible worker and web revisions can deploy independently. Use the paired deployment command from a completely clean working tree. Before changing either platform, it validates the production URL and smoke credentials and captures the current Fly image and Vercel deployment for rollback. It verifies the release, creates an unpromoted production-target Vercel deployment, points the newly deployed Fly worker at that exact canary, runs production smoke plus API and browser dashboard budgets, and only then promotes the canary. This ordering also provides a safe first cutover from revision-fenced workers to protocol-fenced workers. A failed gate restores the previous worker image; a failed post-promotion check restores both releases.

```bash
npm run deploy:production
```

Set `BASE_URL` to the canonical production HTTPS origin and provide the smoke
credentials, internal secret, and `RELEASE_EVIDENCE_OUTPUT` described below.
When the platform exposes `CRON_SECRET` to the release runner, preflight probes
that credential directly; for write-only platform secrets it verifies the
promoted deployment's `cron_auth` release gate instead. When deployment
protection applies to staged production deployments, set
`VERCEL_AUTOMATION_BYPASS_SECRET` for the release runner and configure the same
name as a Fly secret so worker requests can reach the canary.

The worker emits one JSON startup record and one record per lane tick. Fast workflow and continuation pickup runs every five seconds, durable consolidation/ingestion/evaluation jobs run on an independent background lane, and SLO/alert/recovery maintenance runs every minute. It also runs a bounded, all-tenant sensitive-data retention sweep every six hours by default. Alert on:

- no successful tick for more than twice `OMNIAGENT_WORKER_INTERVAL_MS`;
- repeated non-2xx tick responses or thrown fetches;
- queue `failed`/`requeued` growth;
- container health failures or restart loops;
- authentication failures after secret rotation.
- failed retention sweeps or a sweep that has not succeeded within twice `OMNIAGENT_WORKER_RETENTION_INTERVAL_MS`.

The fast and background lane defaults are 5 seconds, while maintenance defaults to 60 seconds. `OMNIAGENT_WORKER_LIMIT` is capped at 3 so one tick cannot create unbounded fan-out. Coordinate lane cadence, lease duration, database capacity, and worker replica count before scaling.

`vercel.json` schedules a daily tick as a recovery backstop. A daily-only deployment can leave unattended work waiting up to 24 hours.

## Production smoke state

The `Production Smoke` workflow supports schedule and manual dispatch. Configure:

- repository variable `PRODUCTION_SMOKE_BASE_URL`;
- secrets `SMOKE_ADMIN_EMAIL`, `SMOKE_ADMIN_PASSWORD`, and `SMOKE_INTERNAL_AUTH_SECRET`.

The workflow has no fallback URL and never treats a missing credential as a pass. Preflight requires a healthy HTTPS target. Critical requests have bounded timeouts, gates run as separate diagnostic steps, release evidence is size-limited, and a missing artifact or failed upload fails the job.

Expected production state is:

- `/api/health` returns 200;
- protected APIs reject anonymous access;
- the smoke administrator can authenticate and receives secure cookie attributes;
- internal smoke auth is configured;
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

The restore drill is destructive only to `RESTORE_DATABASE_URL`. It requires the production URL for comparison, rejects a target with the production database name even when provider host aliases differ, requires target-specific confirmation, verifies the backup manifest checksum before restore, validates the exact OmniAgent table, row-count, migration-marker, database-identity, and forced-RLS inventories, and writes a restore-evidence artifact. Run it on a schedule in isolated infrastructure and retain the evidence.

Restore procedure:

1. Stop workers and disable cron so no new writes arrive.
2. Create a new isolated database from the selected point-in-time or logical backup.
3. Validate schema versions, pgvector, row-level policies, tenant counts, and auth records.
4. Point a canary deployment at the restored database and run smoke.
5. Switch production only after evidence passes; then restart one worker and watch queue behavior.

For an application rollback, stop workers, redeploy the previous known-good artifact, and run smoke before restoring traffic. Do not run an older build against a schema it cannot understand. For a destructive database change, restore to a new database rather than overwriting the only production copy.

## Data retention and audit limits

Production defaults remove expired authentication sessions, expire undecided tool approvals after 7 days, redact unreviewed access requests after 30 days, delete reviewed access requests after 365 days, remove raw episode memory and retrieval traces after 30 days and consolidated memory after 365 days, remove terminal run content after 30 days, and remove completed workflows, webhook events, queue jobs, terminal tool payloads, and domain events after 90 days. Observability events default to 30 days and security audits to 365 days. Affected memory graphs are rebuilt from retained evidence through generation-fenced leases. Expiring an approval redacts its raw arguments and closes the paused agent run; executing work is never deleted. Configure the `OMNIAGENT_RETENTION_*_DAYS` values to meet organizational and legal requirements and `OMNIAGENT_RETENTION_BATCH_SIZE` to bound each data-class mutation. When a batch is full, the dedicated worker schedules another pass after one minute instead of waiting for the normal retention interval. The worker runs the sweep; system automation can also call `POST /api/security/retention` with `{"scope":"all_tenants"}`. Admins can inspect the policy and sweep their tenant.

Local JSON mode is bounded and mutable: domain events retain up to 5,000 records, security audits up to 1,000, and tool executions up to 250. It is disposable demo storage rather than a retention-compliant backend. Signed reports establish integrity evidence but are not WORM storage; use object lock or an equivalent external control when required.

## Connector risk controls

Connector endpoints are SSRF-checked and secret references are restricted, but operators still control a powerful outbound boundary:

- approve only HTTPS endpoints and expected DNS ownership;
- use per-connector, least-privilege credentials with rotation and revocation;
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
