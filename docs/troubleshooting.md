# Troubleshooting

## Runtime or install fails

- Confirm `node --version` is 24.x and `npm --version` is 11.x. The repository intentionally rejects other major lines through `engines`.
- Run `npm ci` from a clean checkout. If the lockfile and manifest disagree, do not hand-edit the lockfile; run `npm install` with the reviewed package versions.
- `npm run audit:production` gates high/critical production advisories. A development-only advisory must still be reported, but it does not represent the deployed dependency graph.

## Production shows “database required”

`DATABASE_URL` is missing or blank. Set a TLS Postgres URL and redeploy. `OMNIAGENT_ALLOW_DEMO_STORAGE=true` bypasses the guard only for disposable demos and must not be used as a production recovery measure.

If `/api/health` returns 503, inspect server logs for TLS, credentials, extension privileges, migration, or RLS errors. Verify connectivity from the deployment network before rotating credentials.

## Schema startup fails

- Inspect `omni_schema_version` and compare it with the versions in `databaseSchemaMigrations`.
- Ensure only one application identity owns migrations and that it can create/alter tables, functions, policies, and indexes.
- The advisory lock serializes migrations; a long wait can mean another deployment is migrating or a transaction is stuck.
- Restore into an isolated database before repairing a failed migration. Do not delete version rows to force a rerun without reviewing the idempotency of that migration.

If pgvector is unavailable, set `OMNIAGENT_LOG_PGVECTOR_FAILURES=true` temporarily. The app can use JSON embeddings, but vector-index status remains not ready until the extension, columns, dimensions, and HNSW indexes match.

## Login does not work

- Call `GET /api/auth/session` and inspect `authEnabled`, `bootstrapConfigured`, and `authenticated`.
- For first boot, set both bootstrap email and password before the first auth-store request.
- Production auth cannot be disabled. Local auth follows `OMNIAGENT_AUTH_ENABLED`.
- A 429 response means the in-process IP or account login limit was reached; honor `Retry-After`.
- After a successful login, verify the `__Host-asael_session` cookie is present in production (`asael_session` locally) and that HTTPS deployments receive the `Secure` attribute.

## Protected API returns 401 or 403

401 means no valid browser session or internal secret was supplied. 403 means the identity is valid but its role lacks the requested action. Confirm tenant membership and role instead of weakening the route policy.

For internal calls, the secret and identity headers must be sent together. Never enable unsigned identity headers in production.

## Worker is running but jobs do not advance

- Check the startup JSON record for base URL, interval, limit, SLO, and alert settings.
- Check tick records for HTTP status, duration, leased/completed/failed/requeued counts, and errors.
- Confirm the worker and web deployment share `OMNIAGENT_INTERNAL_AUTH_SECRET`.
- Probe the configured web `/api/health` from the worker network.
- Compare the interval with queue lease duration; too many replicas or a short interval can increase contention.
- On Fly, inspect machine health and restart count. The container health probe uses only the public health endpoint and never sends the internal secret.

## Connector discovery or execution is blocked

- Use an HTTPS hostname with public DNS; private, loopback, link-local, metadata, embedded-credential, and unsafe redirect targets are rejected.
- Store a connector credential in an `OMNIAGENT_CONNECTOR_*` variable and reference its name. Do not paste the value into connector metadata.
- Platform secrets remain blocked even if a connector attempts to reference them. Keep the explicit allowlist narrow.
- Re-import or rediscover only after reviewing vendor schema/tool changes and their risk levels.
- A successful import does not bypass approvals for side effects.

## Production smoke fails

- Preflight: set an explicit HTTPS `BASE_URL`, all three smoke credentials, and `RELEASE_EVIDENCE_OUTPUT`.
- Timeout: inspect the failing method/path and `SMOKE_REQUEST_TIMEOUT_MS`; fix the slow dependency before increasing the bound.
- Security: confirm anonymous protected routes return 401 and the admin cookie is secure.
- Tenant/eval: confirm the internal secret is deployed and database RLS/evaluation state is current.
- Release: inspect gate reasons and warnings in the bounded JSON artifact.
- Artifact: the release step must create a non-empty file below `RELEASE_EVIDENCE_MAX_BYTES`; skipped or missing evidence is a failure.

Synthetic smoke requests carry correlation IDs and are marked SLO-excluded. Search those IDs in observability when diagnosing a gate.

## Playwright fails locally

Run `npx playwright install chromium`, then `npm run test:e2e`. The managed server uses port 3100; stop another process on that port or set `PLAYWRIGHT_PORT`. Set `PLAYWRIGHT_BASE_URL` only when intentionally testing an already-running compatible instance.

`npm run test:e2e:list` must list only files under `tests/e2e`; Vitest files are excluded by both the Playwright test directory and filename rules.
