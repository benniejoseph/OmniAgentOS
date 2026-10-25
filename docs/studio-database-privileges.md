# Creative Studio database privileges

Studio stores immutable run inputs and provider receipts in `omni_studio_records`,
ordered progress in `omni_studio_run_events`, and tenant cost reservations in
`omni_studio_budget_reservations`. All three tables enable and force row security.
The runtime is neither an owner nor a member of the owner role, and has neither
superuser nor `BYPASSRLS` privileges.

The declared direct permissions are:

| Object | Runtime and maintenance | Backup |
| --- | --- | --- |
| `omni_studio_records` | SELECT, INSERT, UPDATE | SELECT |
| `omni_studio_run_events` | SELECT, INSERT | SELECT |
| `omni_studio_budget_reservations` | SELECT, INSERT | SELECT |
| `omni_studio_run_events_seq_seq` | SELECT, USAGE | SELECT |
| `omni_protect_studio_record_v1()` | No direct EXECUTE grant needed for its existing trigger | None |

The two separate `SECURITY DEFINER` entry points, `omni_studio_authority_v1` and
`omni_studio_budget_totals_v1`, grant EXECUTE only to `omni_runtime`, without a
grant option. Migration 261 already normalizes their ACLs. Their bodies,
ownership and caller contract do not change in migration 262.

No Studio object grants access to `PUBLIC`, provider roles such as `anon`,
`authenticated` or `service_role`, or arbitrary named roles. The object owner
retains its PostgreSQL ownership rights. These rules describe Studio objects;
they do not change a role's privileges on unrelated application objects.

## Why migration 262 exists

PostgreSQL applies the creating role's default privileges before a migration's
explicit GRANT statements. Revoking `PUBLIC` does not remove named default
grants. On an installation with broad named defaults, migration 261 therefore
created Studio tables with DELETE/TRUNCATE and other excess permissions, a
sequence with UPDATE, and an invoker trigger function with named EXECUTE grants.
Its final catalog check caught this drift before the Studio candidate served
traffic. Tenant RLS alone cannot protect against table privileges such as
TRUNCATE.

Migration 262 is the durable forward repair. It requires the exact unchanged
261 ledger checksum, the expected protected objects, their shared owner and
the original trigger contract. It locks the three tables and normalizes only
their ACLs, the owned event sequence and the invoker trigger function. It also
removes independent column grants and delegated grant-option chains. CASCADE
applies only to these objects' privileges; it does not drop dependent objects.
The migration checks the resulting exact ACLs before committing its ledger row.

The repair preserves saved flows, runs, events, reservation amounts, sequence
position, object identifiers, function bodies, indexes, constraints, RLS policies
and global default privileges. It accepts both a clean 261 installation and one
already reconciled to the tested 261 contract. Do not amend 261, remove its ledger
row or change global defaults to make this repair pass.

## Focused verification

`tests/integration/studio-object-acl.integration.test.ts` executes the unchanged
261 file and the actual 262 file through the normal SQL migration parser. It
recreates the inherited production overgrants, including grant options, provider
and maintenance roles, the sequence, trigger and independent column privileges.
It then checks exact permissions, data and structure preservation, unchanged
global defaults and unrelated object permissions. Actual `omni_runtime` calls
prove scoped reads/updates and event appends succeed while deletion, append-only
updates, TRUNCATE, sequence resets and foreign-tenant reads are denied. Invalid
predecessors and changed trigger/RLS contracts must fail atomically.

Run against a disposable PostgreSQL database on `127.0.0.1` whose name starts
`asael_studio_acl_`. Provision it through migration 261 or 262 with no Studio rows,
or restore schema-only metadata from an existing **synthetic** candidate database.
A schema-only fixture may have an empty ledger; the test seeds only the trusted
migration ledger through 261. Every test fixture, role/default-privilege change
and synthetic application row rolls back. The test never drops a schema or
contacts production.

```sh
ASAEL_STUDIO_ACL_DATABASE=1 \
ASAEL_STUDIO_ACL_DATABASE_URL='postgres://LOCAL_OWNER@127.0.0.1:PORT/asael_studio_acl_candidate?sslmode=disable' \
NODE_ENV=test VERCEL= VERCEL_ENV= \
node node_modules/vitest/vitest.mjs run \
  --config vitest.integration.config.ts \
  tests/integration/studio-object-acl.integration.test.ts --maxWorkers=1
```

Without the opt-in environment, only the migration registration and unchanged
261 checksum test runs; the database cases are explicitly skipped. Passing the
local test does not establish that migration 262 has run in production.

## Applying the follow-up

Use the repository's ordinary dedicated migration job and paired release process
for a future candidate that includes 262. Keep traffic, workers and scheduled
writers quiescent under the established maintenance procedure; retain backup and
isolated restore evidence. Validate the exact predecessor and actual catalog
before mutation, then run `db:migrate`, `db:verify` and the focused catalog/runtime
checks before restoring writers. A prior exact ACL restoration is compatible
with 262 and does not authorize skipping these checks.

An altered owner, trigger body, security mode, predecessor checksum or unexpected
role membership is a hold for investigation, not permission to rewrite the
migration. The existing release and any frozen release helper remain pinned to
their original revision; this follow-up needs its own reviewed candidate.
