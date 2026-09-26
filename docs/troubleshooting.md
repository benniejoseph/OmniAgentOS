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

If system diagnostics reports OpenAI as degraded with
`failureKind=authentication`, the environment contains a key but the
authenticated model-readiness probe failed. Rotate or correct the deployment
credential; a nonempty environment variable is not provider health. Provider
error text and credential material are not persisted in the health record.

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

## Capture file extraction fails

Files are parsed by the contained document parser described in the [security model](architecture.md#security-model). The API response, or for background processing the asset's failed extraction receipt, carries the code:

- `413 archive_too_large`: a DOCX, spreadsheet, presentation, OpenDocument, or EPUB file expands past 12 MB or holds more than 1,000 entries. The file is the problem; export a smaller document.
- `413 extraction_resource_limit`: the parse reached its time, heap, or process-memory limit. The log line `Document parser stopped at a resource limit.` names which one (`timeout`, `heap`, or `rss`). Do not raise a limit for one file; the limits bound what a hostile file can cost.
- `503 extraction_unavailable` with `PDF extraction is temporarily unavailable.` while other formats still work: the deployment lacks the `@napi-rs/canvas` native binding pdf.js needs. See [deployment.md](deployment.md#capture-document-extraction).
- `503 extraction_unavailable` for every format, logged as `Document parser worker could not start.`: the function could not start a worker thread.
- `503 ocr_not_configured`: a scanned PDF or an image needs OCR and no vision runtime is configured.
- `400 extraction_failed`: the parser rejected the file. `Document parser could not read this document.` logs only the error name: `PasswordException` is an encrypted PDF and `InvalidPDFException` or `FormatError` a damaged one, while a `ReferenceError` or `TypeError` points at the deployment or a parser defect rather than the file.

Background processing (`capture.asset.process`) makes three attempts with backoff and records the failed extraction receipt only after the last one, so even a deterministic 413 appears only after the third attempt.

## Connector discovery or execution is blocked

- Use an HTTPS hostname with public DNS; private, loopback, link-local, metadata, embedded-credential, and unsafe redirect targets are rejected.
- Store a connector credential in an `OMNIAGENT_CONNECTOR_*` variable and reference its name. Do not paste the value into connector metadata.
- Platform secrets remain blocked even if a connector attempts to reference them. Keep the explicit allowlist narrow.
- Re-import or rediscover only after reviewing vendor schema/tool changes and their risk levels.
- A successful import does not bypass approvals for side effects.

## Production smoke fails

- Preflight: set an explicit HTTPS `BASE_URL`, all three smoke credentials, and `RELEASE_EVIDENCE_OUTPUT`.
- Revision: scheduled GitHub runs resolve the currently served exact SHA from `/api/health`; manual canary checks must pass the intended `expected_revision`. A supplied mismatch is a deployment failure and is never replaced by discovery.
- Timeout: inspect the failing method/path and `SMOKE_REQUEST_TIMEOUT_MS`; fix the slow dependency before increasing the bound.
- Security: confirm anonymous protected routes return 401 and the admin cookie is secure.
- Tenant/eval: confirm the internal secret is deployed and database RLS/evaluation state is current.
- Release: inspect gate reasons and warnings in the bounded JSON artifact.
- Artifact: the release step must create a non-empty file below `RELEASE_EVIDENCE_MAX_BYTES`; skipped or missing evidence is a failure.

Synthetic smoke requests carry correlation IDs and are marked SLO-excluded. Search those IDs in observability when diagnosing a gate.

## Web presentation regression

Run the focused component or contract test for the changed surface, followed by
`npm run build`. For installed-Mac Computer Use, use the signed native canary and
verify the governed command receipt rather than adding a browser-automation test
runtime back to the repository.
