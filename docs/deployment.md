# Deployment (Vercel + Supabase + Fly)

Production uses Node.js 24.x and npm 11.x across local metadata, CI, and the worker image. Vercel Functions run in Singapore (`sin1`) beside the existing Supabase Singapore Postgres project; the existing Fly application remains in US Ashburn (`iad`) and provides both the durable worker and bounded OpenAI US egress gateway. The remote Playwright product runtime is retired in source. Its separate Fly app may remain deployed only until the native-only release gate captures rollback evidence and explicitly decommissions it; do not treat a still-running legacy service as product authority. Static assets remain globally cached, and the daily Vercel cron remains only a backstop.

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
- `CRON_SECRET`: authenticates the scheduled `/api/workflows/tick` backstop.
- `OMNIAGENT_INTERNAL_AUTH_SECRET`: shared by the worker and production smoke runner. Generate an independent high-entropy value.
- `BLOB_READ_WRITE_TOKEN`: private Vercel Blob store credential for immutable Capture asset candidates. Link only a private store; never expose this token or a direct Blob URL to clients.
- `OMNIAGENT_ASSET_DELIVERY_SECRET`: optional independent 32+ byte HMAC key for five-minute, actor- and purpose-bound application delivery URLs. It falls back to a domain-separated key derived from `OMNIAGENT_INTERNAL_AUTH_SECRET` when unset.
- `OMNIAGENT_APP_BUILDER_PREVIEW_SECRET`: optional independent 32+ byte HMAC key for actor- and project-bound Vercel Sandbox preview access. App Builder falls back to the configured credential keyring as a domain-separated signing secret, and fails closed when neither is available.
- `OMNIAGENT_GITHUB_APP_ID`, `OMNIAGENT_GITHUB_APP_INSTALLATION_ID`, and `OMNIAGENT_GITHUB_APP_PRIVATE_KEY`: server-only credentials for the private App Builder GitHub App. Install it only on selected repositories and grant only Contents, Pull Requests, and Checks permissions required by the delivery broker. `OMNIAGENT_GITHUB_APP_REPOSITORY_IDS` is a required comma-separated allowlist of numeric repository IDs; it prevents unrelated public repositories enumerated read-only by GitHub from appearing as delivery targets. `OMNIAGENT_GITHUB_APP_SLUG` is optional display metadata. Do not substitute a general GitHub personal access token.
- `OMNIAGENT_VERCEL_ACCESS_TOKEN` and `OMNIAGENT_VERCEL_TEAM_ID`: server-only App Builder deployment broker authority. Use a durable account access token scoped to the owning project/team; do not use a short-lived Vercel CLI OAuth session token. Asael derives and configures a project-scoped Vercel automation bypass from `OMNIAGENT_APP_BUILDER_PREVIEW_SECRET` (or the credential keyring fallback) before collecting protected-preview evidence. `OMNIAGENT_VERCEL_PROTECTION_BYPASS_TOKEN` remains an optional 32-character alphanumeric operator override; it is never stored in an App Builder receipt or returned to the browser UI.
- `OMNIAGENT_CREDENTIAL_KEYRING`: independent versioned AES-256-GCM keyring for tenant-managed model and outbound MCP credentials, formatted as `{"activeKeyId":"v1","keys":{"v1":"<32-byte-base64url>"}}`. Without it, app-managed credential writes fail closed while deployment-environment provider keys remain available.
- `OMNIAGENT_FCM_SERVICE_ACCOUNT_JSON`: complete server-side Firebase service-account JSON for FCM HTTP v1. Leaving it unset keeps FCM registrations valid but delivery reports `configuration_required` and retries within the bounded outbox.
- `OMNIAGENT_APNS_TEAM_ID`, `OMNIAGENT_APNS_KEY_ID`, `OMNIAGENT_APNS_BUNDLE_ID`, and `OMNIAGENT_APNS_PRIVATE_KEY`: complete server-side direct APNs token-auth configuration. The private key is the `.p8` value. A partial group is treated as unconfigured, never as usable authority.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, and `AWS_BEDROCK_*_MODEL`: optional deployment fallback for Bedrock. Prefer Settings-managed, tenant-scoped Bedrock credentials and assignments; never expose either credential path to the browser.
- `OMNIAGENT_MCP_ALLOWED_HOSTS` and `OMNIAGENT_MCP_ALLOWED_ORIGINS`: optional comma-separated additions to the inbound MCP DNS-rebinding and browser-origin allowlists. The canonical `NEXT_PUBLIC_APP_URL` and Vercel deployment hosts are included automatically.
- `OMNIAGENT_BOOTSTRAP_EMAIL` and `OMNIAGENT_BOOTSTRAP_PASSWORD`: required before first auth-store access. Confirm the persisted admin, then rotate or remove bootstrap credentials.
- `OMNIAGENT_OWNER_EMAIL`, `GOOGLE_OAUTH_CLIENT_ID`, and `GOOGLE_OAUTH_CLIENT_SECRET`: the exact private owner and server-side Google OAuth web client. Register `${NEXT_PUBLIC_APP_URL}/api/oauth/google/callback`; Asael verifies the returned Google identity against the owner before sealing provider tokens with `OMNIAGENT_CREDENTIAL_KEYRING`.
- `OMNIAGENT_REPORT_SIGNING_SECRET`: production signing key for evaluation evidence. Set `OMNIAGENT_REPORT_SIGNING_KEY_ID`; use `OMNIAGENT_REPORT_SIGNING_KEYS` JSON during rotation.
- `OMNIAGENT_ACCESS_REQUEST_FILE`: optional durable fallback path for local/non-database deployments. With `DATABASE_URL`, access requests are tenant-scoped in Postgres and appear in the admin Inbox for review.
- `SALESFORCE_OAUTH_CLIENT_ID` and `SALESFORCE_OAUTH_CLIENT_SECRET`: server-only credentials for the read-only Salesforce Connected App. Register `${NEXT_PUBLIC_APP_URL}/api/oauth/salesforce/callback` and grant only `api` plus `refresh_token`; leaving either value unset keeps the Account 360 Salesforce health state at `configuration_required`.
- `SALESFORCE_WEBHOOK_SECRET`: independent server-only HMAC key for the optional Salesforce CDC relay. The relay signs `${unixSeconds}.${rawBody}` with SHA-256, sends `x-asael-salesforce-signature: sha256=<hex>` and `x-asael-salesforce-timestamp`, and must arrive within five minutes. Do not reuse the Connected App secret.
- `SALESFORCE_WRITE_ENABLED` and `SALESFORCE_WRITE_EXTERNAL_ID_FIELD`: independent fail-closed gate for P10.11 provider mutations. Leave the gate `false` until migration 139 is installed and the named `__c` field exists as a unique, createable, updateable External ID on Contact, Task, Case, and Opportunity. The application rechecks provider describe metadata before every create; setting these variables does not activate any Account 360 or bypass its separate owner approval.
- `NEXT_PUBLIC_APP_URL`: canonical HTTPS origin. Set it to exactly `https://asael.bennierichard.com`. It is public and build-inlined, not a secret.
- `OMNIAGENT_NATIVE_MIN_ANDROID_VERSION`, `OMNIAGENT_NATIVE_MIN_IOS_VERSION`, and `OMNIAGENT_NATIVE_MIN_MACOS_VERSION`: optional stable `major.minor.patch` minimums for native compatibility telemetry. An absent or empty value defaults to `1.0.0`; a malformed configured value invalidates the policy and holds adoption unavailable. These settings do not authorize Agent enrollment.

Native contract artifacts are committed immutable release inputs. Contract v14 is
canonical-current and v13 is the one supported previous version; older versions remain
historical archives and a published version is never regenerated in place. Run
`npm run check:native-contracts` before a native-contract release; the check
fails if the generated OpenAPI, event schema, fixtures, integrity manifests,
Dart SDK, or frozen v7-v13 document hashes drift. Removing an archived version
requires a separately reviewed adoption decision and is not implied by a
Vercel deployment.

### Licensed TradingView chart assets

TradingView Advanced Charts v32.2.0 is a restricted, non-redistributable client dependency. Its files must never be committed to the public OmniAgentOS repository. `npm run sync:tradingview` uses the operator's existing GitHub authorization to clone the exact `v32.2.0` tag, verifies commit `f936c921ba510ba20ac51a71b8b4c5c03c043dbc`, and stages only the required `charting_library` directory under the Git-ignored `public/vendor/tradingview` path. The release marker is also ignored. Do not put a GitHub token in the repository, Vercel environment, script arguments, or logs.

`npm run deploy:production` invokes that sync as its npm pre-script. A direct Vercel chart release must run the sync first and must upload the staged public directory; `.vercelignore` explicitly admits that otherwise Git-ignored path. Before promotion, require HTTP 200 from `/vendor/tradingview/charting_library/charting_library.standalone.js` on the staged deployment and load `/app/markets` in an authenticated browser. The page must show a ready `Financial Chart` iframe, provider-labelled bars, drawing controls, and no TradingView CSP or Datafeed errors. Git-based Vercel builds do not contain this private dependency and are not an approved chart release path unless a separately reviewed private-package installation is configured.

P12.2 requires migration `20260908093000_p12_2_mobile_device_lifecycle.sql`
(internal schema v145) before publishing the device lifecycle routes. The
migration validates predecessor v144, installs the constrained revocation/wipe
state and challenge index, and commits its schema marker atomically. Native
binary builds also require the `local_auth` platform setup committed under
`apps/flutter/android`, `apps/flutter/ios`, and `apps/flutter/macos`; Vercel
deploys the server routes and contract documents, not a native binary.

P12.4 is a Vercel route guard plus Flutter binary change and requires no schema
or Fly release. The native build adds `cryptography`, `path_provider`,
`image_picker`, and `connectivity_plus`; iOS declares camera and photo-library
purposes, while Android disables application backup and declares camera access.
Vercel must be promoted before distributing that binary because offline retries
require the owner-digest and stable-correlation checks. A Vercel deployment does
not publish the iOS, Android, or macOS binary.

P12.5 requires migration `20260908123000_p12_5_mobile_push_delivery.sql`
(internal schema v146) before publishing the push routes. It installs exact
actor/device registrations with encrypted token bundles and a leased,
deduplicating delivery outbox under forced RLS. FCM delivery requires
`OMNIAGENT_FCM_SERVICE_ACCOUNT_JSON`; direct APNs requires the complete APNs
group above. The Flutter build separately requires its real Firebase
`google-services.json` and per-target `GoogleService-Info.plist`, Firebase-console
APNs configuration, and normal Android/Apple signing. Those native application files
are not Vercel secrets; commit only the real registered-app configuration and
never a Firebase service-account key. Provider configuration is reported
truthfully to the registered device without exposing credentials. The existing
worker calls the Vercel workflow tick, so this change does not require a Fly
image release.

Production uses Firebase only as notification transport for the existing Asael
backend. Firebase is enabled on the existing `asael-private-ai` Google Cloud
project, and the Android and Apple apps retain the compatibility package/bundle identity
`app.omniagent.omniagent`. The FCM sender service account has only
`roles/firebasecloudmessaging.admin`; its JSON key is stored as the sensitive
Vercel production variable above and must never be copied into the repository
or native application. iOS delivery additionally requires an Apple APNs token
key to be configured in Firebase before a device receipt can pass.

The deterministic market-backtest foundation requires migration
`20260916120000_market_deterministic_backtests.sql` (internal schema version
177) before publishing `/api/market-research/backtests`. It installs
actor-private forced-RLS append-only result and event ledgers. The web route
only enqueues work; the Fly worker executes `market.backtest.run`, so web and
worker must be released as one compatible feature revision. Native contract v7
adds the native read/run operations and remains the frozen v8 rollback contract.
No market credential, raw provider payload, or trade-execution authority is
introduced by this migration.

P13.1 requires migration
`20260916143000_p13_1_macos_native_platform.sql` (internal schema version 178)
before a contract-v8 macOS client signs in. It widens only attested native
session and push-registration platform checks to include `macos`; direct APNs
registrations may originate from iOS or macOS. Contract v8 removes unenrolled
legacy mutation declarations from its generated surface and does not activate
new route capabilities. Contract v10 adds only the actor-scoped, exact-run
remote Computer Use frame read used by the native artifact rail.

The installed-Mac P13.3 slice additionally requires
`20260917110000_p13_3_local_computer_runtime.sql` (internal schema version 179)
before publishing the original native contract v11 or enabling **This Mac**. It installs
actor-scoped forced-RLS device, session, and command routing tables; it stores no
helper credential and grants no action-creation API to the native client. Migration
179 is installed in production. Migration
`20260917150000_p13_3_local_computer_run_binding.sql` (internal version 180) is
also installed and binds each local session to one exact run while indexing bounded
observation expiry. Contract v14 is canonical-current and retains published v13
byte-for-byte as the supported previous version. V13 added the approval-gated
`local.macos.open_url` command, exact run/execution screenshot presentation, and
snapshot-bound `screenshot_pixel` metadata; v14 removes the retired remote-frame read
while retaining those local capabilities. The four courier capabilities remain macOS-only
with their original v11 capability floor. The original owner-Mac production proof serves
exact revision `7a4bd41d0c42abad8f8da0911258ac341e2318f3` through Vercel
deployment `dpl_64Hw4o58FyC1hfB645oo2J6mXGeB`. Vercel does not distribute or
sign the binary. This historical proof predates v14 and does not prove the current
native-only release gate.

The data-plane retirement uses
`20260917170000_p13_3_retire_isolated_browser.sql` (internal schema version 181).
It revokes active browser profiles and takeovers, disables known Playwright and
Browser Use connectors, scrubs their sealed credential material, and retains the
profile/takeover tables as read-only audit for runtime roles. Production installed
migration 181 with checksum
`2d8bfc80ac843fe49ca79024022b873f5046a68822892ace7ff78d393025cf4d`;
the post-install authority aggregate reports zero active profiles, takeovers,
matching connectors, or remote-browser tools. Historical rows remain readable under
the intended runtime restrictions. The pre-cutover logical backup is 137,576,294
bytes with SHA-256
`b8d6768acbd85876d4f126b7dd5163cbd900997481b333c985ba066d729661ea`.

Ordered source migration
`20260917193000_p13_3_local_computer_open_url_action.sql` (internal schema version
182) repairs the validated local-command action constraint by adding only `open_url`.
Production installed it with checksum
`46a2975c9099d954bc7f7ff6aa537076f14f8dce274e53f33826a38471d1f5e4`; the
replacement constraint is validated and explicitly permits `open_url`. Its fresh
pre-change logical backup is 137,605,166 bytes with SHA-256
`a51ef0adf76a0cf50540991d27175746fc1a1ce6e778ed7e9c7dd28a669e81bd`.
The owner-Mac navigation canary and Fly browser-app/volume/secret decommission
remain pending. Do not delete the Fly app before the canary and historical-read
evidence are captured.

Canonical Vercel deployment `dpl_ADbmrbWVowwnqY7T1SsTGqVCKDM4` serves exact
revision `b2736075b1e799cb5b18e90515d5ef73e0d9c056`. Health reports database,
OpenAI, and cron configured; native discovery reports v14 current/v13 previous;
the retired profile route returns `410`; and the licensed TradingView asset returns
HTTP 200.

macOS development and private packaging require the full Xcode application, not
only Command Line Tools. Run `flutter run -d macos` for the signed development
build. For the owner's Mac, run
`apps/flutter/tool/install_macos_private_signing_identity.sh` once. It creates the
dedicated `Asael Private Code Signing` identity in the user-only keychain at
`~/Library/Application Support/Asael/signing/asael-private-signing.keychain-db`;
the adjacent password file is mode 600 and the directory is mode 700. Back up both
files together and never commit or print the password.

`apps/flutter/tool/build_macos_private_release.sh` auto-discovers that private
keychain, signs nested code before the application, verifies the result strictly,
creates `build/distribution/macos/Asael-<version>-macOS.dmg`, and prints its
SHA-256. The local self-signed mode is owner-Mac-only: it changes no system trust,
cannot be notarized, and omits Hardened Runtime because the certificate has no Apple
Team Identifier. It also uses `LocalRelease.entitlements`, which deliberately omits
`com.apple.security.app-sandbox`; the owner-only main application is not sandboxed.
The Apple-issued Release path still uses the sandboxed `Release.entitlements` file.
After a private signing update, the first launch may briefly show the securing state
while macOS reauthorizes existing ordinary-Keychain items; every credential operation
is bounded and later launches use the restored session normally. On macOS 27 the
packager uses `diskutil image create`, with `hdiutil` retained as the compatible
fallback.

The same packager compiles `AsaelComputerUseHelper.app` for every architecture in
the host, embeds it under `Contents/Helpers`, signs it separately with the host's
stable identity, then signs the host. The helper is a direct child process with a
stripped environment and no bearer, Keychain, App Group, connector, HTTP, shell,
filesystem, or Apple Events interface. Stable signing is required because changing
the helper's code identity can invalidate macOS TCC grants.

The owner-only package also embeds an independently signed, frozen
`AsaelCredentialBroker.app` to keep ordinary Keychain ownership stable across app
rebuilds. Provision it with `apps/flutter/tool/install_macos_credential_broker.sh`
and verify it before every package; do not rebuild it as an incidental part of an
app release. Broker v1.0.0 build 1 is universal and currently pins CDHash
`056b6bc5ce0709b430fd48dfb38f8d7d01b380e0` plus signing-certificate SHA-256
`ccf2035e163285b723bf1196cf57abc5a304d9580ab42d5f089ddd0dfbdd455e`.
The broker accepts only the bounded Asael credential contract over direct child
pipes and has no network, shell, general Keychain, Computer Use, or arbitrary-
storage interface. The explicit one-time legacy migration must write, read back,
and mark the broker copy before deleting only a verified source; ordinary startup
remains non-interactive and fails closed on conflict or an unknown key.

For each installed build, open Asael Settings → Local Computer Use, choose
**Grant macOS access**, complete the Accessibility and Screen Recording prompts,
then explicitly enable **This Mac**. Confirm the persistent menu-bar indicator and
its immediate stop action before running a local canary. Record the exact app build,
package digest, server revision, target, run identity, action scope, and durable-data
inspection; do not infer a consequential-action proof from a read-only canary.

The historical first-slice owner-Mac proof installed Asael `1.6.1` build `8` from
`apps/flutter/build/distribution/macos/Asael-1.6.1-8-macOS.dmg` (SHA-256
`f1df4fc12ee31ecf112df004fdddf0db700b9fadff3fcc1c66b419b6c09568dd`).
Accessibility and Screen Recording report granted and the command broker reports
online. Live run `bc9b0b06-4af3-4de0-b86f-481f724444dc` selected **This Mac**,
activated TextEdit, and read `ASAEL INSTALLED MAC CANARY 179` exactly without
editing it. Post-run inspection found no observation payload in durable rows. The
release keeps local observations within the assigned agent's one-turn evidence,
without evidence-blind sibling council rewriting, and exposes bounded non-secure
Accessibility text while retaining secure-field redaction and Secure Event Input
refusal.

The current signed install checkpoint is Asael `1.6.6` build `13` at
`/Applications/Asael.app`, packaged as
`apps/flutter/build/distribution/macos/Asael-1.6.6-13-macOS.dmg` with SHA-256
`bfe7eb3d8d5cce2125d927926bc45a97a1dce63a2d9d399e3491832c00d91a8b`.
Strict nested signing passes. The installed host CDHash is
`c8bfdca6ea87724596750f63aa39865a2020141e`; the embedded broker CDHash is the
frozen `056b6bc5ce0709b430fd48dfb38f8d7d01b380e0`, and both designated
requirements match. Installation alone does not prove the one-time credential
migration, a restart without a Keychain prompt, local readiness, or the requested
Chrome navigation/screenshot; those remain part of the pending live canary.

Distribution to another Mac sets `ASAEL_MACOS_SIGNING_IDENTITY` and
`ASAEL_MACOS_NOTARY_PROFILE`, which enables Hardened Runtime and makes Developer ID
signing, notarization, stapling, and verification mandatory. The Firebase Apple
configuration is bundled and matches the registered compatibility bundle ID. APNs
still requires an Apple signing identity, Push Notifications capability, and the
corresponding provider key; configuration alone is not treated as a delivery receipt.

Android release builds fail closed when a production signing identity is not
available. On the release Mac, `apps/flutter/tool/build_android_release.sh`
loads the dedicated upload-key password from the `Asael Android Upload
Keystore` macOS Keychain item and uses the keystore at
`~/Library/Application Support/Asael/signing/asael-upload-keystore.jks` by
default. Back up that keystore and Keychain secret before Play enrollment. CI
may instead provide `ASAEL_ANDROID_KEYSTORE_PATH`,
`ASAEL_ANDROID_KEYSTORE_PASSWORD`, `ASAEL_ANDROID_KEY_ALIAS`, and
`ASAEL_ANDROID_KEY_PASSWORD`. Debug signing is never a release fallback.

Keep `OPENAI_API_KEY` only on Vercel; the normal release shell does not need it, and it must never be stored on Fly. The paired release runs its paid verification through Asael, so the deployed server supplies the upstream OpenAI authorization while the gateway validates `x-asael-gateway-token` and forwards that header unchanged. Production always enables auth even when `OMNIAGENT_AUTH_ENABLED=false`. Vercel forwarding headers are trusted automatically; other reverse proxies must overwrite client forwarding headers before `OMNIAGENT_TRUST_PROXY_HEADERS=true` is enabled. Do not enable `OMNIAGENT_TRUST_UNSIGNED_IDENTITY_HEADERS`, `OMNIAGENT_CONNECTOR_ALLOW_HTTP`, or `OMNIAGENT_CONNECTOR_ALLOW_LEGACY_SYSTEM_SECRETS` in production.

## Supported configuration

`.env.example` is the complete copyable reference. Runtime groups are:

- Models and retrieval: `OPENAI_AGENT_MODEL`, `OPENAI_WEB_SEARCH_MODEL`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_EMBEDDING_DIMENSIONS`, `OMNIAGENT_OPENAI_GATEWAY_URL`, `OMNIAGENT_OPENAI_GATEWAY_TOKEN`, optional Fly-only `OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN`, Fly-only `OMNIAGENT_OPENAI_UPSTREAM_HOST`, `OMNIAGENT_OPENAI_GATEWAY_HEALTH_TIMEOUT_MS`, `OMNIAGENT_WEB_SEARCH_TIMEOUT_MS`, and the optional Bedrock fallback group (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_BEDROCK_MODEL`, `AWS_BEDROCK_FAST_MODEL`, `AWS_BEDROCK_REASONING_MODEL`).
- Database reads: `OMNIAGENT_DATABASE_POOL_MAX` bounds each process's runtime and maintenance pools. Durable production runtimes default to 4 so overlapping requests cannot be starved by a long workflow tick; size them against the upstream pooler's connection budget. Vercel is intentionally stricter: each runtime or maintenance pool inside a route bundle/isolate enforces a maximum of 1 connection even when the generic override is higher. Its postgres.js `idle_timeout` and `max_lifetime` timers are disabled: Vercel may freeze an isolate while a JavaScript connection timer is armed, then thaw it after the deadline while a new reservation is starting. Avoiding that timer race keeps the one-slot pool reusable; Vercel's isolate lifecycle and connection failures still retire sockets. Durable runtimes retain the 20-second idle timeout and postgres.js's randomized maximum-lifetime default. The single-slot Vercel pools prevent independent serverless functions from multiplying Supavisor frontends during burst traffic; work inside one warm pool is serialized through the existing admission queue, and bounded Workspace Summary reads are issued sequentially so a cold Today request cannot queue its own siblings past the acquisition deadline. Runtimes with a larger pool retain parallel summary reads. `OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS` bounds that cancellable application queue plus postgres.js pool-slot reservation for every tenant- and system-scoped query or callback transaction (20s by default, clamped to 0.5-30s). The 20s ceiling remains a rollback-safe bound from the former IAD-to-Singapore topology; warm requests do not wait for it. An independent `sin1` canary completed the security and tenant-scoped connector/workflow CRUD checks with a 15.7ms database `Server-Timing` sample, validating the regional direction while remaining too small a sample to justify lowering the rollback bound. Re-baseline it only after sustained production measurements prove a tighter safe value. Admission waiters that time out never enter postgres.js. If the sole Vercel reservation itself times out, Asael synchronously detaches that exact raw client and asks postgres.js to destroy it; queued reservations reject and release their existing admission permits, while the next request creates a fresh client and gate. This recovery is deliberately limited to Vercel's one-slot pools so one timeout never aborts valid concurrent work in a durable runtime. Every tenant- and system-scoped transaction applies `OMNIAGENT_DATABASE_STATEMENT_TIMEOUT_MS` (15s by default, clamped to 1-60s), `OMNIAGENT_DATABASE_LOCK_TIMEOUT_MS` (1s by default, clamped to 0.1-10s and never above the statement timeout), and `OMNIAGENT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS` (15s by default, clamped to 1-60s) on the database server. Together they bound statement execution, lock acquisition, and idle gaps between statements after a connection is leased; an abandoned transaction is terminated so its lease can be discarded and released. Request/platform deadlines remain responsible for other transport waits. `OMNIAGENT_SCHEMA_VERIFICATION_TIMEOUT_MS` is the production migration-marker verification watchdog and resets timed-out checks so later requests can retry. `OMNIAGENT_SETTINGS_CAPABILITY_TIMEOUT_MS` bounds the tenant-scoped Settings response and returns explicit unavailable fields when the database misses that deadline; `OMNIAGENT_SETTINGS_CAPABILITY_STATEMENT_TIMEOUT_MS` may lower the shared database deadline for the aggregate query. `OMNIAGENT_TODAY_SNAPSHOT_STATEMENT_TIMEOUT_MS` provides the same shorter override for the single owner-scoped Today projection query.
- Agent limits: `OMNIAGENT_AGENT_MAX_TOOL_STEPS`, the installed-Mac-only `OMNIAGENT_LOCAL_COMPUTER_MAX_TOOL_STEPS`, `OMNIAGENT_AGENT_MAX_MESSAGE_CHARS`, `OMNIAGENT_AGENT_MAX_MESSAGES`, `OMNIAGENT_AGENT_RUNS_PER_MINUTE`, `OMNIAGENT_AGENT_REASONING_EFFORT`, and `OMNIAGENT_AGENT_MAX_OUTPUT_TOKENS`. The installed-Mac default is 12 governed action/model rounds with 14 model turns (one additional semantic-plan reservation and one final-answer turn); ordinary runs remain at 6 rounds and 7 turns. Token, cost, wall-clock, approval, and other run limits are unchanged. Historical browser-action counters remain readable but grant no remote-browser execution authority.
- Workflow limits: `OMNIAGENT_QUEUE_LEASE_SECONDS`, `OMNIAGENT_WORKFLOW_DRAIN_LIMIT`, `OMNIAGENT_WORKFLOW_PLANNER_TIMEOUT_MS`, `OMNIAGENT_WORKFLOW_EXECUTOR_TIMEOUT_MS`, and the independent `OMNIAGENT_WORKFLOW_VERIFIER_TIMEOUT_MS`. Model-verifier transport failures retry the unchanged verification step within the run budget; they do not trigger a semantic replan or invalidate an existing approval.
- Identity and native delivery: `OMNIAGENT_DEFAULT_TENANT`, `OMNIAGENT_DEFAULT_ACTOR`, `OMNIAGENT_DEFAULT_ROLE`, `OMNIAGENT_SESSION_DAYS`, bounded mobile token lifetimes, native platform minimum versions, bootstrap name/tenant, auth mode, `OMNIAGENT_FCM_SERVICE_ACCOUNT_JSON`, and the direct APNs configuration group.
- Trust: `OMNIAGENT_GRADUATED_AUTONOMY` and `OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD`.
- Alerts: queue/dispatch limits, signed webhook URL/secret, Slack webhook, Resend key, and email addresses.
- Connectors: app-managed MCP bearer credentials use `OMNIAGENT_CREDENTIAL_KEYRING` and require no per-connector environment binding. Remote-browser MCP endpoints are retired and denied; do not restore a Playwright or Browser Use credential. Salesforce read synchronization uses `SALESFORCE_OAUTH_CLIENT_ID`, `SALESFORCE_OAUTH_CLIENT_SECRET`, and the independent optional `SALESFORCE_WEBHOOK_SECRET`; provider tokens remain sealed in the actor-owned OAuth grant. Guarded writes additionally require `SALESFORCE_WRITE_ENABLED=true` and the reviewed `SALESFORCE_WRITE_EXTERNAL_ID_FIELD`, while each Account 360 remains disabled until a separate owner activation. The legacy advanced `bearer_env` path uses `OMNIAGENT_CONNECTOR_SECRET_ALLOWLIST`, JSON `OMNIAGENT_CONNECTOR_SECRET_BINDINGS`, and referenced `OMNIAGENT_CONNECTOR_*` values; every such credential requires an exact tenant-and-origin deployer binding. Keep `OMNIAGENT_CONNECTOR_ALLOW_LEGACY_SYSTEM_SECRETS=false`.
- Model credentials and inbound MCP: `OMNIAGENT_CREDENTIAL_KEYRING`, `OMNIAGENT_MCP_ALLOWED_HOSTS`, and `OMNIAGENT_MCP_ALLOWED_ORIGINS`. MCP remains disabled per actor until enabled in Settings and requires a scoped, hash-only service key.
- Workflow triggers: use dedicated `OMNIAGENT_TRIGGER_*` HMAC keys. Put legacy server-only names in `OMNIAGENT_TRIGGER_SECRET_ALLOWLIST`; platform credentials are always rejected, and unauthenticated triggers remain disabled at dispatch time in production.
- Diagnostics/storage: `BLOB_READ_WRITE_TOKEN`, `OMNIAGENT_ASSET_DELIVERY_SECRET`, `OMNIAGENT_LOG_PGVECTOR_FAILURES`, `OMNIAGENT_DATA_DIR`, and the demo-storage switch.
- Market research: server-only `TWELVE_DATA_API_KEY` for XAU/USD bars and the entitlement-gated NDX cash index, plus `FRED_API_KEY` for official release dates and ALFRED vintages. The public BLS calendar needs no credential and supplies reviewed CPI, PPI, Employment Situation, and JOLTS release times. Never expose market credentials through `NEXT_PUBLIC_*`; NDX time-series availability is plan-dependent and must fail closed when the account lacks the required Twelve Data entitlement.

Platform-provided `VERCEL_*` values supply deployment metadata and are not copied into `.env.example`. See [api-reference.md](api-reference.md) for route authentication and response expectations.

### Private Google Workspace connection

Asael uses its native server-side OAuth/REST connector as the canonical Google
integration. The official Google Workspace remote MCP servers remain a
Developer Preview and do not cover this product's complete governed mutation
and Photos Picker requirements.

Configure one Web application OAuth client in the same Google Cloud project as
the enabled APIs. Its only production redirect URI is
`https://asael.bennierichard.com/api/oauth/google/callback`. Enable Gmail,
Calendar, Drive, Docs, Sheets, Slides, and Photos Picker APIs. The OAuth consent
configuration must declare the scopes requested by
`GOOGLE_WORKSPACE_OAUTH_SCOPES` in
`src/lib/connectors/google-workspace-capabilities.ts`: OpenID/email,
`gmail.modify`, `calendar.events`, `calendar.calendarlist.readonly`, `drive`,
and `photospicker.mediaitems.readonly`.

Keep the audience External and In production for this owner-only application.
An unverified sensitive/restricted-scope warning is expected for a private app;
do not repeatedly force consent or reset sync state merely to hide that warning.
After a scope expansion the owner must authorize once. Normal one-hour access
token expiry is refreshed with the retained refresh token and is not a broken
connection. Gmail and Drive deletion means recoverable Trash by default;
permanent Gmail deletion and unrestricted Photos-library background access are
not requested.

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

P8.6 A2A deployments also require `NEXT_PUBLIC_APP_URL` to be the canonical
credential-free HTTPS origin used in Agent Cards and delegated callback URLs,
plus `OMNIAGENT_CREDENTIAL_KEYRING` for endpoint-bound peer credentials and
delegated-token sealing. The runtime database role needs only the narrow grants
installed by migrations 117–119; never substitute the migration-owner URL.
Rollouts are actor-private and default inactive. Register and review a new peer
generation before activation; pause or revoke it to invalidate all exact-digest
delegated callbacks. Do not reuse service API keys or outbound bearer tokens
across peers.

Migration 119 adds the actor-private safety reservation and append-only
tool-call claim ledgers. The maintenance worker must keep its maintenance lane
enabled: it pages the same tenant inventory and closes active reservations when
their progress lease or hard task deadline expires. A stalled remote peer is
terminated locally without waiting for remote acknowledgement, so its token can
no longer reach the governed executor. Monitor non-zero reconciliation failures;
do not raise depth, fan-out, root-task, cost, or progress-timeout constants as an
availability workaround.

Migration 120 adds the actor-private Trash item and append-only effect-receipt
ledgers. Both tables force RLS through the exact request actor scope. Runtime and
maintenance roles may select and insert; only item state, revision, public item,
internal snapshot, and terminal time may be updated. Neither role may delete or
truncate, and receipts cannot be updated. The owner actor deliberately accepts
both the deployed email-form request identity and canonical `actor:<uuid>` form;
do not add an auth-user foreign key until all execution scopes have completed a
separately gated canonical-actor cutover.

Migration 121 adds actor-private approval grants and append-only consumption
claims. Both tables force exact-actor RLS. Runtime and maintenance roles may
select and insert; only grant payload, state, used-use count, last-used time,
lifecycle revision, and revoked time may be updated. Claims are immutable and
neither table grants serving roles delete or truncate. Grant issuance and
consumption remain web/database operations. At the historical P9.4 release this
did not change either Fly image; it is not an instruction to restore the retired
browser image.

Migration 122 adds actor-private browser profiles, immutable execution bindings,
and bounded takeover leases. Migration 123 corrects the policy kind on the 12
actor-owned A2A, Trash, approval, and browser tables created by migrations
117–122: each table has one permissive policy whose predicate remains the exact
tenant+actor or audited system scope, with forced RLS still enabled. A
restrictive policy without any permissive policy rejects every row; do not
reintroduce that standalone configuration. The migration asserts exactly one
policy on every repaired table. Migration 181 later preserves these browser rows
as read-only audit while revoking their active runtime authority.

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

P9.9 adds one exact gateway route: `POST /v1/realtime/client_secrets` with a
32 KiB JSON limit and a 30-second upstream deadline. The authenticated web tier
uses it only to mint a 60-second transcription-session credential configured
for `gpt-4o-mini-transcribe`, near-field noise reduction, and server VAD. The
ephemeral credential—not `OPENAI_API_KEY` or the gateway token—is returned to
the browser and used only against OpenAI's fixed WebRTC calls origin. Asael does
not proxy or retain microphone audio. The browser must show provider and
retention disclosure before every session, and only reviewed transcript text
may enter the existing Command API. Keep `/v1/realtime/calls` absent from the
Fly allowlist: browser audio goes directly to the provider after consent.

P9.10 adds the separate exact `POST /v1/audio/speech` gateway route with a
32 KiB JSON limit and a 120-second upstream deadline. Only the authenticated
web tier can call it. `/api/media/speech` accepts at most 4,000 characters per
request, requires the immutable `asael-voice:1` profile, verifies any supplied
conversation and Agent ownership, and streams 24 kHz `pcm_s16le` with the
profile version and digest in response headers. The browser must reject a
mismatched contract and cancel both the upstream body and scheduled audio on
interruption. Speech events and usage receipts contain metadata and byte counts,
never response text or audio.

P9.11 keeps voice-command authority in the web tier and requires no new Fly
route. Realtime transcription requests log probabilities, but Asael retains
only content-free numeric confidence summaries. Low-confidence, unavailable,
or edited drafts require explicit visible transcript review. Every
voice-originated tool above risk zero is forced through the existing durable
governed approval path, whose client projection shows redacted exact input,
risk, reversibility, and quorum. Spoken confirmation never approves an action;
only the authenticated visible Approve/Reject decision route can do so.

P9.14 adds governed Gmail delivery in the web tier and migration 124 in
Supabase; it requires no Fly image change. Existing Google grants must reconnect
once because the least-privilege authorization now also requests `gmail.send`.
Every outbound effect starts as an immutable actor-private draft, requires the
existing risk-two visible approval over its exact recipient, subject, body, and
digest, and is verified from Gmail's raw target state before a receipt is
committed. Unknown provider outcomes remain reconciliation-only to prevent a
blind duplicate send. Inbound sync treats message content as untrusted and
links replies only by an already recorded external Gmail thread.

## Retired remote browser runtime

The self-hosted Playwright MCP gateway, Browser Use product integration, proxy
route, connector presets, container definition, and Fly deployment definition
are removed from the source product path. Do not create a new remote browser
connector or restore its credential variables. Transition-compatible
`isolated_browser` requests return `410 computer_use_target_retired`, and saved
continuations fail closed without being redirected to **This Mac**.

Historical P9.5-P9.8 activity, frames, profiles, takeovers, and effect receipts
remain in their database audit/retention plane, while the corresponding product
delivery routes return `410`. Migration 181 revokes all active profile/takeover authority, disables
known remote-browser connectors, scrubs their sealed credentials and credential
metadata, and reduces the profile/takeover tables to read-only access for runtime
roles. The migration retains rows; it does not synthesize replacement authority
or erase audit history.

Migration 181 and canonical v14/v13 are now verified checkpoints. New remote
requests and retired product routes fail closed, database history remains under
read-only runtime authority, and source contains no Playwright development or
product runtime. The dedicated Fly browser app may still exist only until the
release operator performs the remaining decommission gate. Record its app and
machine identity, persistent-volume identity, rollback release, and secret
inventory without printing secret values; complete the owner-Mac canary; then
remove the browser app, its volume, and its secrets
explicitly. Recheck that the separate worker/OpenAI egress Fly app remains healthy.
This document does not claim the canary or Fly deletion completed.

App Builder no longer captures product browser evidence. Checkpoint readiness
requires deterministic lint and typecheck results. Preview and production
readiness require captured build logs and passing route smokes. The legacy
`browserEvidence` field stays readable on historical checkpoints/deployments and
is written as retired compatibility metadata for new records; it is not a gate.

The browser-automation development dependency, CI job, benchmark, and visual-smoke
scripts are removed. Use focused component/contract tests and the production build
for web changes, and the signed native canary plus governed receipts for installed-
Mac Computer Use.

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

The worker emits one JSON startup record and one record per lane tick. Fast workflow and continuation pickup begins with a five-second post-attempt pause and exponentially backs off to 30 seconds while idle; any activity immediately restores the five-second cadence. That fast pass also physically scrubs expired local-computer screenshot observations in bounded batches, independently of the general retention cadence. Durable consolidation/ingestion/evaluation begins at 15 seconds after a 7.5-second startup delay and backs off to five minutes while idle. The maintenance lane registers its revision heartbeat after 60 seconds, waits another 15 minutes before its first SLO/alert/recovery pass so a paired release can finish without competing heavy work, and then pauses for five minutes after each attempt. Each maintenance pass runs generation-fenced Loop v2 recovery before generic stale-run repair, which excludes active Loop v2 checkpoint chains, applies memory lifecycle policy v1 per tenant, and drains the actor-scoped temporal-relation projection queue while re-entering every persisted private owner scope. Relation repair uses the same deterministic reconciliation path as incremental projection and full rebuild; unsuccessful work remains durable for a later bounded retry. Database-backed worker heartbeats are refreshed at most every five minutes per lane while the local health file is still updated after every attempt. Idle polls authenticate and enforce RBAC but do not append redundant allow/observability rows; startup registration and consequential outcomes remain durable audit evidence. The bounded, all-tenant sensitive-data retention sweep starts ten minutes after a restart and then runs every six hours by default. These startup delays and idle backoff prevent a Fly restart or an empty queue from creating unnecessary Vercel CPU, Supabase egress, or telemetry growth. Alert on:

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

P11.2 Conversation progress is a web-only read projection. It requires no
database migration, Fly worker/gateway release, new environment variable, or
backfill. The trajectory service performs bounded sequential owner-scoped reads
of at most 2,000 thread events so a one-slot Vercel runtime does not fan out
database admission. Release it with the ordinary web deployment and verify the
canonical health revision plus an authenticated Results-to-Conversation run
deep-link. Historical runs may truthfully report an unbound Agent identity, no
context receipt, or no checkpoint recovery when those records predate capture.

P11.3 Conversation canvas is also a web-only read projection with no migration,
backfill, environment change, or Fly release. The exact-Conversation read is the
normal UI path; the workspace-wide path is capped at 24 Conversations, 200
runs, 300 delegations, and 200 shared artifacts, with explicit truncation. The
database request installs the caller's canonical/current-email actor scope
before reading every source authority. Verify both a workspace-wide map and an
exact Conversation map after the ordinary web release; the latter should open
an exact run's existing Activity record.

P11.4 Projects/Missions WorkItem unification is a web-only read and UI contract
change with no migration, environment change, backfill, or Fly release. Deploy
it as one complete Vercel feature. Verify one Project task and one Mission task
or root expose the same canonical status, assignment, artifact, workflow
progress, and exact-ledger cost semantics; also verify an existing
`/app/missions/:id` deep link. Historical rows without a canonical shadow may
render through `local_projection`, but new write paths must continue failing if
their canonical shadow cannot be verified.

P11.5 Agent Council is a web-only projection and UI release with no migration,
backfill, environment change, or Fly release. New delegation proposal events
carry an immutable, digest-verified authority receipt; historical delegations
without that receipt must show authority as unavailable rather than infer it.
The private Council read installs the authenticated user's canonical/current
actor scope and resolves exact AgentDefinition versions, run events, explicitly
shared Mission-channel content, and AI-usage receipts. Verify anonymous access
returns 401, an authenticated empty or populated Council projection renders in
Arsenal without client errors, and populated rows show only receipt-derived
context, capability, tool, scope, and budget authority.

P11.6 readable Memory is a web-only projection and UI release with no
migration, backfill, environment change, or Fly release. The first Memory load
must call only the private/no-store readable endpoint; exact claim content,
entity labels, conflict bodies, and relationship paths are fetched only after
an explicit selection. Verify anonymous access returns 401, the authenticated
projection validates as `p11.6-readable-memory:1`, its serialized aggregate
contains no claim bodies or receipt/query identifiers, and selecting one claim
still opens the existing provenance, lifecycle, correction, and reviewed
deletion controls.

P11.7 truthful Integrations is a web-only projection and UI release with no
migration, backfill, environment change, or Fly release. It reads the current
OAuth grants, MCP/OpenAPI contracts, Salesforce sync health, and usage receipts;
Salesforce still requires its existing external OAuth and relay configuration
before it can report working. Deploy it as one complete Vercel feature. Verify
anonymous access returns 401, an authenticated response validates as
`p11.7-truthful-integrations:1`, failed inventories remain unavailable, catalog
suggestions remain visibly not installed, and no raw cursor or credential value
is serialized. Confirm the browser shows the same installed, permission, sync,
freshness, failure, and cost states returned by the endpoint.

P11.8 functional Settings is a Vercel web/runtime release plus additive
migration `20260908080000_p11_8_functional_model_assignments.sql` (internal
schema version 143). Apply the migration before promotion. Old assignments are
deliberately invalidated to configuration-only and must be saved again against
an enabled tenant-vault provider and a current catalog model with the exact
role capability; do not reactivate them through a data backfill. Generic roles
may use fallback only where the runtime emits attempt receipts, while
embeddings, vision, and audio transcription accept one primary route.

Deploy the complete feature once. Verify the canonical health revision,
anonymous Settings rejection, the private/no-store
`p11.8-functional-model-routing:1` snapshot, and a real model call for each
activated route. A successful receipt must match the active assignment ID,
scope, revision, configuration digest, and `tenant_vault` credential source;
stale receipts and deployment-environment calls must not appear as assignment
proof. The Fly worker needs a release only if its protocol or worker-owned
model boundary changes.

P11.9 source coverage is a Vercel web/runtime release plus additive migration
`20260908090000_p11_9_source_coverage_projection.sql` (internal schema version
144). Apply the migration before the application release. It adds only the
validated safe per-source OAuth checkpoint projection; provider cursors and
credentials remain in their existing sealed fields and never enter the new
column or response.

Deploy the complete feature once its focused source-sync, projection,
application-service, route, registry, and client checks pass. Verify canonical
health at the exact release revision, anonymous `/api/source-coverage`
rejection, and an authenticated `p11.9-source-coverage:1` response. Today,
Memory, and Integrations must render the same connected domains, backfill,
freshness, last verification, index completeness, stale sources, and explicit
blind spots. A missing dependency or disagreeing inventory must remain unknown
and actionable rather than becoming an empty fact. No Fly release is required
unless the worker protocol changes.

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

Remote-browser MCP endpoints are denied by connector trust policy and the known
legacy endpoints are disabled and credential-scrubbed by migration 181. Retained
connector, tool, profile, takeover, and execution rows are historical evidence;
they must not be re-enabled, rediscovered, or treated as approval authority.
Local macOS actions instead use only the registered `local.macos.*` contracts
through the governed executor and their independent native-device/run binding.

## AP2 payment boundary

The deployed `p9.15-ap2-boundary:1` contract pins the official AP2 `v0.2.0`
release and reviewed commit, requires exact mandate `vct` values, keeps the
Trusted Surface deterministic and non-agentic, and requires separately
authenticated and digest-reviewed external adapters. P9.16 adds exact Checkout
and Payment Mandates under migration 125 plus user-only WebAuthn registration,
review, authorization, and proof-reverification routes. `GET
/api/payments/ap2/readiness` is authenticated and private/no-store; the same
projection is available to the Main Agent only through the governed
`app.payments.ap2.readiness` read tool.

Signer activation requires `OMNIAGENT_AP2_WEBAUTHN_TRUST_POLICY` containing an
operator-reviewed public policy for accepted hardware AAGUIDs and attestation
formats. The application verifies that policy's own digest and fails closed
when it is absent or malformed. Do not configure a permissive placeholder.
Never place raw payment credentials, WebAuthn private keys, credential-provider
secrets, or payment signing keys in Vercel environment variables, model
context, general application storage, events, logs, browser state, MCP output,
or memory.

P9.17 reuses `OMNIAGENT_CREDENTIAL_KEYRING` only to seal a provider-issued,
single-transaction scoped token. It never stores a card, account credential, or
private signing key. Grant metadata and provider proof contain digests and a
public signature but no token; the encrypted token is bound to actor, grant,
provider contract, scope, and token digest. Migration 126 creates the forced-RLS
grant and append-only claim ledgers. A successful one-time claim clears the
encrypted token before processor dispatch. Expiry or revocation also clears it.
Do not add provider tokens to environment variables, request logs, general
connector vault entries, APIs, or Agent tools.

P9.18 adds migration 127 with actor-private payment projections, raw signed
receipt evidence, append-only signed reconciliation observations, and bounded
idempotent reconciliation jobs. `GET /api/payments/ap2/transactions` and its
exact-ID child route are authenticated and private/no-store; the corresponding
Agent tools are read-only and return only the evidence-derived projection. Never
return the raw JWT, reconciliation signature, provider credential, or sealed
authorization from those surfaces. “Paid” requires accepted signed Checkout and
Payment Receipts plus the processor's independently signed exact-total
authorization and capture. Merchant UI state, browser success, and model output
are never payment authority; contradictions remain visible as discrepancies.

The readiness projection reports the human-present mandate, credential isolation,
and receipt/reconciliation code gates as implemented while retaining zero
payment-effect tools and `transactionsPermitted: false`. Payment remains disabled
until a reviewed credential provider, merchant, merchant payment processor, and
WebAuthn trust policy are independently configured and the direct flow is proven.
P9.19 human-not-present authority must remain disabled until that production gate
passes. This web-and-database slice does not require either Fly image to be rebuilt.

## Required checks and branch protection

Configure branch protection externally to require these exact checks:

- `CI / quality`
- `CI / build`
- `CI / audit`
- `CI / integration`
- `CI / worker`

Also require the scheduled/manual `Production Smoke / production-smoke` result in the deployment promotion system. Repository code cannot enforce GitHub branch protection by itself.

For common failures, see [troubleshooting.md](troubleshooting.md). Use [production-rollout.md](production-rollout.md) at promotion time.
