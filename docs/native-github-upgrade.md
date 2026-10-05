# Native official GitHub MCP upgrade v1

This is the separate native contract v47 candidate. It does not change the
v46 MCP rediscovery contract or its release records. The server must not be
merged or promoted until the v46 server is in production and Mac68 is installed
and verified against it. Migration 244 follows 243 only as part of that later
v47 rollout. Its new owner-private table raises the expected tenant inventory
from 267 to 268 tables and from 88 to 89 restrictive actor policies.

An eligible connector has one of the two **raw stored** endpoints
`https://api.githubcopilot.com/mcp` or
`https://api.githubcopilot.com/mcp/`, uses Streamable HTTP, and has a currently
reviewed native MCP pin. The v47-only `github-upgrade-review` GET computes
eligibility from that raw endpoint and the private configuration pin. A
normalized public review URL alone is not proof of eligibility. A connector
may currently be active, in error, or disabled. Successful upgrade pauses it:
the endpoint becomes `https://api.githubcopilot.com/mcp/x/all`, risk level 2,
`approvalRequired=false`, status `disabled`, and **every** discovered tool
is `pending_review`. The saved credential generation is retained. Separate
contract review and activation are required before any tool can be used.

All four responses use `contract:"asael-connector-control-read:1"`, the exact
owner scope, a content-free app-service receipt, and `Cache-Control: private,
no-store`. They do not expose the bearer credential, provider body or private
publication token.

| Route | Service operation | Authorization |
|---|---|---|
| `GET /api/connectors/native/mcp/{id}/github-upgrade-review` | `app.connectors.native.githubUpgrades.review` | current `manage.connector`; read only |
| `POST /api/connectors/native/github-upgrades` | `app.connectors.native.githubUpgrades.submit` | current `manage.connector`, risk 2, v47 capability |
| `GET /api/connectors/native/github-upgrades/{keySha256}` | `app.connectors.native.githubUpgrades.read` | exact active owner; read only |
| `POST /api/connectors/native/github-upgrades/{keySha256}/close` | `app.connectors.native.githubUpgrades.close` | exact active owner, risk 0, v47 capability; remains available after management loss |

The capability is `connectors.github.upgrade` with floor 47. Service receipts
use resource type `connector_native_upgrade`. Submit and close carry
`connector-native-github-upgrade-events.v1` and distinct execution purposes
`api.connectors.native.github_upgrade` and
`api.connectors.native.github_upgrade_close`, respectively; reads have no
mutation event. POSTs require the original bounded `Idempotency-Key`.

The strict submit request is
`{contract:"asael-connector-lifecycle-action:1",kind:"mcp",connectorId,
action:"upgrade_github",review:<current pin>,preview:null}` (8,192-byte
limit). The close request is
`{contract:"asael-github-upgrade-close:1",intent:<original safe intent>}`
(16,384-byte limit), with the **same original key** and its SHA-256 in the
path. The key digest is `connectorNativeKeySha256(scope,key)` and the attempt
ID suffix is `canonicalJsonSha256({family:"github-upgrade-attempt:1",scope,
keySha256})`. A submit returns `{contract,scope,upgrade,replayed,
serviceReceipt}`; recovery returns `{contract,scope,upgrade:null|read,
serviceReceipt}`. An upgrade read is `pending`, `expired`, `settled`, or
`closed`. Close returns only the existing `settled` branch or `closed` with
`replayed`. A new admission returns 201; exact replay returns 200.

Submit first reserves a database-clock 45-second attempt and immutable
original-owner intent. It then performs bounded MCP initialize/list discovery
against `/mcp/x/all` outside database locks. This contacts the provider but
never executes a tool. Within the deadline it rechecks the original owner,
review, raw endpoint, policy and credential, and atomically publishes the
complete 1–200-tool catalog with the connector disabled and all tools held for
review. Any known discovery, catalog, drift or deadline failure settles with a
static code and leaves the original connector/catalog unchanged. A process or
authority failure may leave a pending row; `expired` is only a read projection
and cannot publish after its deadline.

The client persists the original safe intent/key before possible dispatch.
After uncertain dispatch it uses **GET only** to recover; null or expiry is
not proof that a delayed POST cannot arrive. Exact close can create an
absent-key tombstone or terminally close an admitted pending attempt. A
settled result wins the close race and is never undone. Any pending row,
including expired, blocks another key for the same tenant/connector until it
settles or closes. Each ledger's unique pending-target index fences concurrent
attempts in that family across owners. V244 adds a boolean-only,
exact-manager checked `SECURITY DEFINER` pending lookup and ordered
`BEFORE INSERT` triggers on both ledgers to fence **cross-family** attempts.
The triggers take the same advisory target lock before either ledger's connector
parent lock, so different owners cannot overlap discovery and upgrade.
Migration 244 refuses a definer owner without `BYPASSRLS` or superuser rights;
the helper sets `row_security=off` so a later privilege loss fails closed. A
new attempt requires a fresh visible confirmation, pin and key. No background
retry or silent cleanup substitutes for owner closure.
