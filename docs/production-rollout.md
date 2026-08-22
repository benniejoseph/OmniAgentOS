# Production Rollout Checklist

## Before deployment

- [ ] Use Node 24.x/npm 11.x and a lockfile-clean `npm ci`.
- [ ] Require `CI / quality`, `CI / build`, `CI / audit`, `CI / integration`, `CI / e2e`, and `CI / worker`.
- [ ] Record the release commit, image digest, migration versions, owner, rollback decision-maker, RPO, and RTO.
- [ ] Run `npm run db:backup` and verify that the latest isolated `npm run db:restore-drill` evidence passed.
- [ ] Confirm `DATABASE_URL`, canonical app URL, OpenAI key, cron secret, internal secret, bootstrap/admin state, and report-signing key.
- [ ] Confirm `OMNIAGENT_MAINTENANCE_DATABASE_URL` uses a dedicated non-superuser `BYPASSRLS` role against the same logical database as `DATABASE_URL`.
- [ ] Confirm alert destinations, data-retention policy, connector allowlist, and worker capacity.
- [ ] Confirm the worker retention sweep is enabled and legal-hold/export needs are handled outside automatic deletion.
- [ ] Keep demo storage, unsigned identity headers, and connector HTTP disabled.
- [ ] Remove `OMNIAGENT_BOOTSTRAP_PASSWORD` and its email after the persisted administrator can sign in.

## Database migration sequence

Production request traffic never runs DDL. Keep workers, cron, and user traffic
stopped while a dedicated release job runs `npm run db:migrate` with
`MIGRATION_DATABASE_URL` and an explicit
`OMNIAGENT_MIGRATION_STATEMENT_TIMEOUT_MS`. Retain the job's JSON logs before
serving traffic. Migrations run under a transaction-scoped advisory lock:

1. `baseline_tables` reconciles existing tables and indexes.
2. `tenant_owned_operational_data` adds tenant ownership to legacy operational
   records and supporting indexes.
3. `fail_closed_tenant_rls` enables and forces tenant policies.
4. `platform_safety_controls` adds durable rate-limit and approval controls.
5. `sensitive_data_retention` adds retention indexes and reconciles newer
   tenant-policy tables.
6. `tenant_ownership_reconciliation` repairs child ownership and namespaces
   legacy tenant dedupe keys before reapplying RLS.
7. `durable_memory_graph_rebuilds` adds the rebuild outbox used by retention
   recovery.
8. `agent_run_cancellation_retention` updates terminal-run retention for
   operator-canceled agent runs.
9. `memory_graph_generation_leases` removes ambiguous legacy graph
   projections, queues clean tenant rebuilds, and adds generation-fenced
   rebuild leases.
10. `database_identity_and_maintenance_scope` gives the database a durable
    logical identity and routes audited all-tenant maintenance through a
    dedicated role.
11. `native_jsonb_parameter_storage` converts legacy double-encoded JSONB
    values back to native objects and arrays before the corrected writers
    begin serving traffic.

Before the canary, inventory rows that still use the legacy `default` tenant.
Assigning real ownership is an operator migration decision; do not expose a
second tenant until legacy rows have been reviewed. The runtime role must not
own application tables. It must not be a superuser or
have `BYPASSRLS`. Backups use a separate dedicated role through
`OMNIAGENT_BACKUP_DATABASE_URL`; that role must have `BYPASSRLS` so forced-RLS
tables cannot be silently omitted. After migration, verify every
version/name/checksum row in `schema-migrations.json`, forced RLS on every table
reported by the isolation endpoint, pgvector dimensions, and tenant-specific
row counts.

## Canary

- [ ] Deploy one web canary before scaling workers.
- [ ] Run `npm run db:migrate` from the dedicated release job, then confirm `/api/health` returns `healthy` at the expected release revision and inspect `omni_schema_version`. The public migration endpoint is intentionally disabled.
- [ ] Confirm pgvector dimensions/indexes and forced tenant RLS.
- [ ] Build/deploy one worker with `--build-arg OMNIAGENT_RELEASE_SHA=<release-commit>`; verify its startup revision exactly matches the web canary, then confirm successful ticks and no queue/auth errors.
- [ ] Run `Production Smoke` through its protected `production` environment; confirm its configured URL and expected revision identify this canary.
- [ ] Download the non-empty release-evidence artifact and confirm the gate is passed/approved.

## Promote

- [ ] Shift traffic gradually while watching health, auth failures, route failures, latency, connector failures, incidents, and queue depth.
- [ ] Increase worker replicas only after lease/requeue behavior is stable.
- [ ] Record deployment URL, commit, schema versions, smoke run, artifact location, and approver.

## Roll back when a gate fails

- [ ] Stop workers and disable cron to prevent new writes.
- [ ] Revert traffic/application to the previous compatible artifact.
- [ ] If the schema is not backward-compatible, restore the verified backup into a new database; never overwrite the only production copy.
- [ ] Run health, schema/RLS checks, and production smoke before restoring traffic.
- [ ] Restart one worker, verify queue state, then scale.
- [ ] Preserve failed and recovery evidence for the incident review.
