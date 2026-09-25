# Deployment (Vercel + Supabase + Fly)

Production uses Node.js 24.x and npm 11.x across local metadata, CI, and the worker image. Vercel Functions run in Singapore (`sin1`) beside the existing Supabase Singapore Postgres project; the sole remaining Asael Fly application is `omniagent-os-worker` in US Ashburn (`iad`), providing the durable worker and bounded OpenAI US egress gateway. The former remote Playwright product runtime and its separate Fly application were decommissioned on 2026-09-17 after the native-only release gate passed. Static assets remain globally cached, and the daily Vercel cron remains only a backstop.

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
- `OMNIAGENT_PRIVATE_ACCOUNT_ALLOWLIST_JSON`, `GOOGLE_OAUTH_CLIENT_ID`, and `GOOGLE_OAUTH_CLIENT_SECRET`: the server-owned private account admission policy and Google OAuth web client. Each allowlisted email maps to one distinct immutable tenant and must set `tenantMode` to `existing` only when intentionally adopting a known legacy tenant, or `new` when the tenant must not already exist at first provisioning. Register both `${NEXT_PUBLIC_APP_URL}/api/auth/google/callback` for Asael sign-in and `${NEXT_PUBLIC_APP_URL}/api/oauth/google/callback` for the signed-in account's Workspace connection. `OMNIAGENT_OWNER_EMAIL` remains a single-account compatibility fallback only when the JSON allowlist is unset.
- `OMNIAGENT_REPORT_SIGNING_SECRET`: production signing key for evaluation evidence. Set `OMNIAGENT_REPORT_SIGNING_KEY_ID`; use `OMNIAGENT_REPORT_SIGNING_KEYS` JSON during rotation.
- `OMNIAGENT_ACCESS_REQUEST_FILE`: optional durable fallback path for local/non-database deployments. With `DATABASE_URL`, access requests are tenant-scoped in Postgres and appear in the admin Inbox for review.
- `SALESFORCE_OAUTH_CLIENT_ID` and `SALESFORCE_OAUTH_CLIENT_SECRET`: server-only credentials for the read-only Salesforce Connected App. Register `${NEXT_PUBLIC_APP_URL}/api/oauth/salesforce/callback` and grant only `api` plus `refresh_token`; leaving either value unset keeps the Account 360 Salesforce health state at `configuration_required`.
- `SALESFORCE_WEBHOOK_SECRET`: independent server-only HMAC key for the optional Salesforce CDC relay. The relay signs `${unixSeconds}.${rawBody}` with SHA-256, sends `x-asael-salesforce-signature: sha256=<hex>` and `x-asael-salesforce-timestamp`, and must arrive within five minutes. Do not reuse the Connected App secret.
- `SALESFORCE_WRITE_ENABLED` and `SALESFORCE_WRITE_EXTERNAL_ID_FIELD`: independent fail-closed gate for P10.11 provider mutations. Leave the gate `false` until migration 139 is installed and the named `__c` field exists as a unique, createable, updateable External ID on Contact, Task, Case, and Opportunity. The application rechecks provider describe metadata before every create; setting these variables does not activate any Account 360 or bypass its separate owner approval.
- `NEXT_PUBLIC_APP_URL`: canonical HTTPS origin. Set it to exactly `https://asael.bennierichard.com`. It is public and build-inlined, not a secret.
- `OMNIAGENT_NATIVE_MIN_ANDROID_VERSION`, `OMNIAGENT_NATIVE_MIN_IOS_VERSION`, and `OMNIAGENT_NATIVE_MIN_MACOS_VERSION`: optional stable `major.minor.patch` minimums for native compatibility telemetry. An absent or empty value defaults to `1.0.0`; a malformed configured value invalidates the policy and holds adoption unavailable. These settings do not authorize Agent enrollment.

Native contract artifacts are committed immutable release inputs. Production
advertises v29 as current and deliberately retains v28 as the one
rollback-compatible previous version. V20-v27 remain immutable historical
artifacts and are not advertised by current discovery. Do not retire v28 until
the v29 rollback window closes. A published version is never regenerated in
place. Run
`npm run check:native-contracts` before a native-contract release; the check
fails if the generated OpenAPI, event schema, fixtures, integrity manifests,
Dart SDK, or frozen v7-v28 document hashes drift. Removing an archived version
requires a separately reviewed adoption decision and is not implied by a
Vercel deployment. V25/v20 remains the historical 2026-09-22 adaptive-runtime
compatibility pair; v27/v26 is the historical governed local-command release
pair; v28/v27 is the historical scoped model-selection release pair; v29/v28
is the current native Ambient Command voice release pair.

### Web Command durable structured-context release

Web Command defaults a new conversation to `session` scope. Attached Agents,
Skills, files, Extensions, Projects, and Connections are separate exact
references that the server resolves again for the authenticated tenant and actor;
they do not grant connector, tool, delegation, membership, or mutation authority.
Choosing `explicit_selection` still requires the exact reviewed selection lock.
Reviewed planning now carries the exact references and an optional explicit
Model/Thinking choice through plan review, workflow start, retrieval, and every
replan. The public plan stores only content-free counts and digests. The private
run binding stores the exact reference pins plus the canonical actor binding;
document bodies are resolved again only at the retrieval boundary and are never
persisted in the plan, run metadata, event stream, or step output. The selected
model is revalidated at planning and execution, while verifier routing remains
independent. File revalidation resolves the exact Library authority and source
ID instead of scanning a recent-item page, requires canonical/exact actor
readability, and fails closed on duplicate or mismatched projections.

For a ready Capture asset, the direct path verifies the current content digest
and extraction receipt before disclosing at most 7,000 characters across the
attached references. It prefers ranked immutable evidence units, redacts
sensitive patterns, and falls back to verified UTF-8 text only for safe text
media. An actor-private connected source may contribute bounded indexed knowledge
only when its current item, revision, document, cognition purpose, retention,
content hash, chunk lineage, evidence digests, and locators agree. Shared,
metadata-only, unlinked, binary, and integrity-ineligible sources never insert a
body into the text prompt. Typed run evidence records content mode, disclosure and
receipt digests, evidence counts, and truncation state, never the disclosed
document text.

The persistent prompt queue applies the same boundary. Migration
`20260924130000_prompt_queue_context_pins.sql` installs schema v206
(`prompt_queue_context_pins_v1`): exact references are sealed separately from
the prompt, while only selection/context/receipt digests and a bounded reference
count remain queryable. Create, edit, claim, dispatch, and the final Agent-route
admission all re-resolve the current reference authority and explicit model pin.
Version, digest, actor, or model-route drift closes the item with a terminal
receipt instead of silently changing context. Queueing clears the ephemeral
composer pins only after persistence succeeds; queue cards and reviewed plans
show the content-free context count and pinned model/Thinking choice.

The production release is commit
`07ecaaadce88b58c785f8d8f8a189baff6ecca1d`, Vercel deployment
`dpl_44qWvXTcxUqLaD9ZtSSWYtmyqKHz`. Canonical health reported that exact
revision and the licensed TradingView artifact returned HTTP 200. The linked
Supabase migration ledger is aligned through `20260924130000`. A live installed
Asael Command run attached exact `@Atlas`, pinned `gpt-6-astra` with Low
Thinking, and rendered `PLAN_CONTEXT_OK`. A production internal canary attached
exact Skill `core.critic` version 1, created reviewed plan
`09609f80-d94a-47eb-ad9a-cb7a008f946f` with one content-free reference pin,
started workflow `wf_b54eaf45de29ce33e61acdc6f9332525929eb17f`, observed three completed
steps, and canceled it at its harmless approval boundary. No private command
binding appeared in the public response. The real-session queue admission also
rejected the service-only canary as designed; authenticated Web queue dispatch
remains a live-UI check because both browser controllers were unavailable, and
must not be bypassed by relaxing session authority. No full suite or audit was
run. This release changes no native contract, Fly protocol, or worker image.

### Governed local command runner release

Migration `20260924110000_governed_local_command_runner.sql` installs internal
schema v205 (`governed_local_command_runner_v1`) before the v27 command courier
is advertised. Native v27 retains frozen v26. Owner-only Asael `1.19.0+30`
embeds two different signed, credential-free helpers: the existing visual
Computer Use helper keeps its closed UI-action allowlist and no shell; the new
`AsaelCommandRunnerHelper.app` accepts only an approved direct executable plus
argument vector, opaque owner-selected starting-folder grant, bounded relative
directory, and timeout of at most 30 seconds. Folder grants constrain the
starting directory and are not an operating-system filesystem sandbox.

Every command requires a fresh persisted approval. Shells and security-sensitive
launchers are denied before dispatch; the helper uses a minimal environment and
isolated temporary home, bounds and sanitizes output, and terminates the process
group on Stop or timeout. Raw stdout/stderr are one-turn untrusted evidence and a
short-lived local artifact only. Durable approval, event, continuation, and tool
stores retain metadata and digests rather than terminal content.

The code deployment used for the authenticated live canaries was
`dpl_3Mq43NNkse6aFonhfJEfEoZuhDpJ`. A natural-language Git-status request returned
the exact current branch and dirty state through the approval/resume boundary;
`sudo whoami` failed closed before approval or execution. The installed package
is `Asael-1.19.0-30-macOS.dmg`, SHA-256
`da3919c3c87de5bb6d9fae8f9952ae3d290443164714a6af0317a7f987a96ebd`; the prior
1.18.0+29 app remains recoverable in Trash. The worker protocol is unchanged,
so this release does not require a Fly deployment.

### Rich native Command response release

Owner-only Asael `1.20.0+31` replaces plain assistant text with a bounded native
rich-response renderer for headings, emphasis, inline code, lists, quotes,
rules, simple tables, and fenced code with an explicit copy action. Links are
interactive only for `http` and `https`; raw HTML, scripts, custom schemes, and
remote image embedding remain inert. Completed answers expose **Copy answer**,
and the current answer exposes **View work** on both wide and narrow layouts.
The work surface projects observable plans, tools, approvals, evidence, agents,
context, and results. It does not expose or store private model reasoning.

The installed package is `Asael-1.20.0-31-macOS.dmg`, SHA-256
`5c3c81e93c9d73bfaf5d50264199a3ac4ce6aa1ed22a8c7ac842f63ddfaad83e`,
with installed host CDHash `a99a5e9ba136b70ed848a88bc6c9074e6803ee1e`.
The prior 1.19.0+30 app is recoverable in Trash. A live authenticated Command
request visibly rendered the requested heading, bold and italic spans, inline
code, two bullets, a copyable Bash block, and a two-column table. **View work**
then showed the result, agent, memory context, and evidence projection with the
private-reasoning disclosure. No native contract, database, Vercel, Fly, or
worker release changes are required for this native-only presentation slice.

### Stateful mascot and voice-feedback release

Owner-only Asael `1.21.0+32` adds one original, raster-free Lottie companion
with ready, listening, transcribing, working, success, and attention states.
It is used only as activity feedback; the Asael product mark remains the app
identity. The widget has bounded sizing, repaint isolation, semantic live-region
labels, and reduced-motion poster frames. Voice capture now exposes microphone
startup and recorder finalization rather than briefly appearing idle, displays
real recorder amplitude while listening, and disables prompt submission for the
entire capture/transcription boundary. Transcription still creates editable text
and does not itself grant authority to run a command.

The installed package is `Asael-1.21.0-32-macOS.dmg`, SHA-256
`2d7f80c11b59dad633db1adb99ea4ccf4baae17899ce7668f7d1961906330a33`,
with installed host CDHash `4ca36fd3f7ab27e1debadf4706236b8b9e8415c3`.
The prior 1.20.0+31 app is recoverable in Trash. Live validation in the installed
app covered the ready and working transitions, a completed Command response,
opening/listening with live levels, the no-clear-speech attention/retry path, and
a successful spoken transcription. The user's concurrent UI action then sent the
visible transcript through ordinary Command handling. No native contract,
database, Vercel, Fly, or worker release changes are required for this
native-only experience slice.

### Native Command model/thinking evidence patch

Owner-only Asael `1.21.1+33` preserves underscores inside identifiers in rich
answers and includes the effective server-emitted Thinking intensity in the
observable model receipt. It does not display private reasoning. A true cold
launch started with Automatic routing; the owner then selected the validated
OpenAI `gpt-6-astra` route and Ultra. The live answer rendered
`MODEL_ULTRA_LIVE_OK` exactly, and **View work** showed
`openai · gpt-6-astra · Ultra thinking · 9726 tokens · 4207ms`.

The installed package is `Asael-1.21.1-33-macOS.dmg`, SHA-256
`c3fbf35f61b3361e8d1c287056c738ab3a7e93fba62575fe4194b677c1e58245`,
with installed host CDHash `9f5a757f44abcba280526f83954a0b3b9d764656`.
The prior 1.21.0+32 app is recoverable in Trash. This canary covers the direct
`main_agent` Command path; specialized-Agent and This Mac scope parity,
durable-route conflict handling, and native-contract publication are separate
follow-up work. No database, Vercel, Fly, or worker release is required for
this native-only patch.

### Scoped native Command model-selection release

Native v28 retains frozen v27 and publishes one strict optional
`modelSelection` envelope plus the provider/model/effective-Thinking fields used
by the content-free observable model receipt. An explicit Model or Thinking
choice forces direct execution and disables team fan-out. Combining an explicit
selection with durable execution returns a private/no-store `409`; an explicit
built-in or custom Agent remains authoritative rather than being silently
replaced. The server revalidates the exact Settings assignment, revision,
configuration digest, provider connection, model lifecycle/capabilities, and
reasoning intensity before the model call.

`GET /api/settings/models?commandScope=...` is now the only Command picker
catalog. The required scope is one of `main_agent`, `council`, `code_builder`,
`verifier`, `market_research`, `memory`, or `computer_use`. The native client
reloads that exact scope when the Agent or **This Mac** target changes and clears
the old Model/Thinking selection before exposing the new choices.

Vercel deployment `dpl_6ayXL7trkpGDUcYk76GL8k3UGVcG` is canonical and healthy
at exact revision `5155ca23f35517815966d7e356a30d0c7586d60c`. Native discovery
reports v28 current/v27 previous, the v28 manifest is reachable, and the licensed
TradingView asset returns HTTP 200. No schema or worker protocol changed, so no
database migration or Fly release was required.

Owner-only Asael `1.22.0+34` is installed from
`Asael-1.22.0-34-macOS.dmg`, SHA-256
`14cfef27f044521933c84d0183cd8049759d82937ae07d60a07ffb8aa36d42f0`,
with installed host CDHash `0277d3ea418ffcba9305867c22bbaacdb19788e0` after
strict nested-signature verification. The prior 1.21.1+33 app is recoverable at
`/Users/benniejoseph/.Trash/Asael-1.21.1-33-pre-1.22.0-34.app`. The live
authenticated canary rendered `SCOPE_V28_ULTRA_OK` exactly and **View work**
showed `openai · gpt-6-astra · Ultra thinking · 12613 tokens · 3781ms` while
explicitly keeping private model reasoning hidden. Switching to **This Mac**
cleared the old selection and loaded its validated catalog; selecting Forge
preserved the specialist and loaded its validated catalog with Automatic
selection before any command was sent. No test suite or audit was run for this
release.

### Native Ambient Command release

Commits `7c5784f7` and `52775277` ship the first owner-only macOS Ambient
Command edge. Native contract v29 retains frozen v28 and exposes the bounded
realtime transcription and speech operations. The compact native surface opens
from the Asael menu, the configured global shortcut, or `asael://ambient-voice`;
the URL is suitable for an owner-created Apple Vocal Shortcut. Activated audio
uses an ephemeral WebRTC credential, recognized speech is shown read-only only
after capture, temporary speech audio is deleted after playback, and neither
voice nor the native bridge can approve an action or grant local-computer
authority. Ambient Voice does not expose an editor or full command form;
Quick Entry remains the separate text-entry surface.

Vercel deployment `dpl_omUXE7N5pHWhRXZk3AVZnKq8Uide` is promoted to
`https://asael.bennierichard.com` at exact server revision
`7c5784f73ef9e9d15e6f7ab22269230b461ffccb`. Focused production checks returned
HTTP 200 for `/api/health`, native discovery, both advertised v29/v28 manifests,
and the licensed TradingView standalone asset. No schema, Fly protocol, or
worker image changed.

Owner-only Asael `1.23.2+37` is installed from
`apps/flutter/build/distribution/macos/Asael-1.23.2-37-macOS.dmg`, SHA-256
`6875652875db7afe1c32fa416a7c4e6f53f31bd6bb49b5edb09248a4b6ac9a61`,
with installed host CDHash `ee0c53b0568ea1b6a96c6776cef2abd7c2dd3132` after
strict host, helper, extension, broker, and framework signature verification.
It supersedes the owner-only 1.23.1+36 Ambient release.

The `1.23.2+37` native refinement removes the editor and full form in favor of
a dedicated `600x126` rounded voice HUD anchored at the bottom-right. The HUD
shows a recognized request read-only and only after capture; partial provider
text stays hidden while listening, and the complete final request remains
scrollable and expandable before sending. Silent input truthfully returns to a
retry state. Quick Entry is unchanged. Live validation in the installed
application covered HUD entry, microphone listening, hidden partial text,
silent-input recovery and retry, and normal window restoration. Focused
implementation review covered full-request disclosure. The earlier governed
dispatch canary rendered `AMBIENT_LIVE_OK` exactly.
The **Use this Mac** destination
truthfully remained disabled because the independent local-computer kill switch
was off, despite Accessibility, Screen Recording, and the signed helper being
ready. The client now publishes an immediate heartbeat and requires fresh server
readiness before local dispatch; a deterministic HTTP failure is shown directly
instead of entering ambiguous-transport recovery. A full local-navigation
canary therefore requires the owner to enable that switch first. The HUD
refinement was native-only: no server, schema, database, or Fly deployment was
required. No test suite or audit was run; review was limited to implementation
review, package/signature verification, and live installed-app behavior. The
owner-only self-signed package deliberately lacks production APNs entitlement,
and this release does not install a passive custom wake-word listener.

### Continuous native Computer Use release

Commits `cce4b821`, `80bbed6a`, `36df30de`, `7a71803f`, `3223e0bb`, and
`0c9c4fe0` make an explicitly selected **This Mac** request one bounded visual
task rather than a sequence of unrelated approval prompts. The governed
executor independently binds the grant to the initiating actor, exact Agent
run, executing principal, tool, and declared interaction purpose. Safe
navigation, selection, non-sensitive text entry, scrolling, and media control
may continue within that task. Every action remains serialized and returns a
fresh screenshot and Accessibility observation for the next model turn; stale
observations fail quickly and require a fresh observe before retry.

Task-scoped keyboard authority is intentionally narrow. It covers ordinary
unmodified navigation keys, media Space/arrows, Shift+Tab, and the exact
Command+Home page-navigation shortcut. Return, Delete, every other modified
shortcut, submission or sending, file transfer, destructive, financial,
account/security, permission-changing, and unknown effects still create a fresh
approval. `local.macos.command.run` remains outside task authority and requires
one exact approval every time.

Vercel deployment `dpl_GWtwwNMwaroDcX8ixTGe18FY2Vj5` is promoted to
`https://asael.bennierichard.com` at exact server revision
`0c9c4fe0b93dbd216c496d0579f6af7b63c0162b`; canonical health reported that
revision with the database and OpenAI configured. Owner-only Asael `1.23.4+39`
is installed from
`apps/flutter/build/distribution/macos/Asael-1.23.4-39-macOS.dmg`, SHA-256
`d058a2ffbdfe857588d62ce5af4b914741ad9869c77d65a6547135e59391eb3e`,
with installed host CDHash `d23513f87785b0e9eb0468eb0985a7c3a1922dc5`.
The prior 1.23.3+38 app is recoverable at
`/Users/benniejoseph/.Trash/Asael-1.23.3-38-pre-1.23.4-39.app`.

The installed-app production canary used the natural request “In Chrome,
Netflix tab, play the first item from Continue Watching for Bennie.” Governed
run `e1d403dc-127c-49de-b510-4377def68e1b` completed with zero approval pauses
and zero human approval records. It listed applications, activated the existing
Chrome/Netflix tab, navigated with bounded scrolls, recovered one rejected
stale-observation click through a fresh observe, selected the first Continue
Watching item, and visually verified the Netflix `/watch/` player for **The
King: Eternal Monarch — Episode 3** with advancing progress and the pause
control visible, which is the playing state. Every successful visual mutation
returned fresh observation evidence and no native command remained queued or
claimed after completion. No full test suite or audit was run; release
validation was limited to the production build, canonical health, governed
trace inspection, and live installed-app behavior. No database migration, Fly
release, worker image, or additional native package was required for the final
server policy refinement.

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

Native contract v15-or-later receipt canaries require ordered migration
`20260918140000_mobile_push_receipt_canary.sql` (internal schema version 185)
after the exact v184 Jev shadow predecessor. It adds immutable, actor-scoped
`received`, `opened`, and `action` observations plus explicit provider-acceptance
timestamps. The workflow tick also scans pending approvals, upcoming meetings,
at-risk customer revisions, and terminal Agent runs into the existing durable
mobile-push outbox. These producers honor Today notification enablement, quiet
hours, and meeting lead time; repeated ticks deduplicate by the source occurrence.
They intentionally do not insert those domain events into the Today-only in-app
reminder table, whose Complete action is bound to a Today item. A unified in-app
attention-center expansion requires its own source/action/deep-link contract.
Run the live canary only after the server migration and a v15-or-later native build are both
installed. An APNs/FCM success is `providerState: accepted`, not proof of device
delivery; only the native app receipt advances `appState`, and its absence must be
reported as `timed_out`.

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
observation expiry. At that P13.3 cutover, contract v14 was canonical-current and
retained published v13 byte-for-byte as the supported previous version. V13 added the approval-gated
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
The owner-Mac navigation and screenshot canaries completed as governed runs
`122ff0d5-b208-4152-a0f6-3b4be6c99e0a` and
`1a105c0c-d1b2-42be-8ba5-2c2de599d499`. The latter opened the exact allowlisted
TradingView URL in Chrome, presented the fresh post-navigation screenshot as a
private temporary Asael preview, and completed with no screenshot bytes,
Accessibility snapshot, or other private observation in the durable command,
tool, event, answer, or conversation records.

Canonical Vercel deployment `dpl_4fwASuVj564h5rLdipRWWT3kkwWN` serves exact
revision `590b213a5d869273476c3aeee89ddf7e8493c23f`. Canonical health reports healthy,
and the retired profile route continues to return `410`.

macOS development and private packaging require the full Xcode application, not
only Command Line Tools. Run `flutter run -d macos` for the signed development
build. The current owner-Mac signing generation is stored under
`~/Library/Application Support/Asael/signing-v2` and uses identity
`Asael Private Code Signing 2026`. Because
`apps/flutter/tool/install_macos_private_signing_identity.sh` still defaults to
the historical v1 names, provision or verify this generation with explicit
`ASAEL_MACOS_LOCAL_SIGNING_DIR` and `ASAEL_MACOS_LOCAL_SIGNING_IDENTITY`
overrides, then run
`apps/flutter/tool/install_macos_credential_broker_v2.sh`. The signing directory
is mode 700 and its keychain/password files are mode 600. The password is also
recoverable through Keychain Access under service
`app.omniagent.omniagent.private-signing-keychain.v2`, account
`Asael Private Code Signing 2026`; never print or commit it. Preserve the v1
signing directory and identity together as rollback evidence.

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

Before creating the DMG, the packager compares the designated requirement of
`/Applications/Asael.app` with the signed replacement host. An unchanged
requirement proceeds without operator output. A mismatch fails closed unless the
operator explicitly reruns with
`ASAEL_MACOS_ACKNOWLEDGE_SIGNING_ROTATION=1`. That acknowledgement does not alter
TCC state; it prints the required post-install sequence to fully quit Asael, reset
only `Accessibility` and `ScreenCapture` for bundle ID
`app.omniagent.omniagent`, relaunch, and choose **Grant macOS access**.

The same packager compiles `AsaelComputerUseHelper.app` for every architecture in
the host, embeds it under `Contents/Helpers`, signs it separately with the host's
stable identity, then signs the host. The helper is a direct child process with a
stripped environment and no bearer, Keychain, App Group, connector, HTTP, shell,
filesystem, or Apple Events interface. Stable signing is required because changing
the helper's code identity can invalidate macOS TCC grants.

The current private package embeds independently signed, immutable credential
broker v2 `2.0.0+2` from `signing-v2/credential-broker-v2`. Its manifest pins
service `app.omniagent.omniagent.credential-broker.v2`, initialization marker
`asael.credential_broker_initialization_v2`, signing-certificate SHA-256
`357f74d16b4c3570d46c16a510ca6f0c51fc5e2ea31f12a693ffeddadb3bdee6`, and
CDHash `a765ad119e8f5904b0909d961bb8da8120662aba`. V2 never reads,
enumerates, migrates, changes, or deletes v1/file-keychain credentials and
requires its own completed sign-in marker before reads. It accepts only the
bounded Asael credential contract over direct child pipes and has no network,
shell, general Keychain, Computer Use, or arbitrary-storage interface. Never
overwrite or re-sign v2; introduce a new service and broker generation for a
later rotation. The v1 identity and frozen broker remain rollback evidence only.

For each installed build, open Asael Settings → This Mac, choose
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

The later signed install checkpoint at that stage was Asael `1.7.1` build `17` at
`/Applications/Asael.app`, packaged as
`apps/flutter/build/distribution/macos/Asael-1.7.1-17-macOS.dmg` with SHA-256
`0c694a5293a30f039ef1b282391678cc8c006a77c6351004828f89ccf7258ca4`.
Strict nested signing passes. The installed host CDHash is
`e07f1f503dec25103af2f33abe1c00bcbc9f9780`; the embedded broker CDHash remains
the frozen `056b6bc5ce0709b430fd48dfb38f8d7d01b380e0`, and both designated
requirements match. The prior `1.6.8` build `15` remains the credential-restart
and natural-language Chrome screenshot canary checkpoint; the 1.7.1 update is a
presentation-only responsive/accessibility patch over the same native v14
courier and server runtime. The prior 1.7.0+16 application bundle is retained in
Trash for rollback.

The subsequent packaged checkpoint was Asael `1.9.0` build `19` at
`apps/flutter/build/distribution/macos/Asael-1.9.0-19-macOS.dmg`, with SHA-256
`cf8f9bcc79d2ababe057d8237ea6deaca155e3e1b6bb5338849a80d51e93b555`.
Strict nested signing passes, native discovery is production-live at current
v16 with frozen v15, and the canonical server reports exact revision
`52f3e5bbf38b7c5ef9cdd0aefabdcb54c0a6822a`. This package has not replaced the
recorded installed checkpoint. It uses the owner-only local identity, so it
deliberately contains no production APNs entitlement and is not evidence of an
APNs delivery canary.

The subsequent recorded installed checkpoint was Asael `1.10.0` build `20` at
`/Applications/Asael.app`, packaged as
`apps/flutter/build/distribution/macos/Asael-1.10.0-20-macOS.dmg` with SHA-256
`4cce04a64e0392d0fb3a116fc73786c4433fde729fd3656a7a6dcec200a9829b`.
Strict nested signing passes and the installed host CDHash is
`3b37c910c60da364cf3f87bc2cacfe0fffb1e854`. The old 1.8.0+18 bundle is retained
in Trash for rollback. Native discovery is production-live at current v17 with
frozen v16. The installed binary still provides the native six-section
Automation Studio and governed Plugin lifecycle, while its live server-backed
Skill catalog is now served by Vercel deployment
`dpl_31wUhFtP8pxP5GEc8q46Kq3p2Ms9`, exact revision
`ed615fe3b0a3a894628b28905a13865f05cd7d8a`. The owner-only identity still
deliberately contains no production APNs entitlement.

Those package records remain historical release evidence. The current owner-Mac
checkpoint is Asael `1.16.1` build `27` at `/Applications/Asael.app`, installed
from `apps/flutter/build/distribution/macos/Asael-1.16.1-27-macOS.dmg` with
SHA-256
`4b5e0797e333809d47e5e984d7055fd9726a48bedca030e8955d9abce5acbb2e`.
The mounted image has exactly one root entry, `Asael.app`; strict nested signing
passes and the installed host CDHash is
`b79f0defe3bb3c84f9fc49a85ed46f670c417852`. The preceding `1.16.0+26`
application remains intact at
`/Users/benniejoseph/Library/Application Support/Asael/rollback/2026-09-22-signing-rotation/Asael-1.16.0-26.app`.
Accessibility and Screen Recording are intentionally ungranted for the rotated
identity pending owner confirmation, so **This Mac** and a new local Computer
Use canary are not yet claimed. This private owner-only package has no Apple Team
Identifier, notarization, APNs entitlement, or provider-delivered APNs receipt.

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
- Agent limits: `OMNIAGENT_AGENT_MAX_TOOL_STEPS`, the independent ordinary-run `OMNIAGENT_AGENT_MAX_MODEL_TURNS`, the installed-Mac-only `OMNIAGENT_LOCAL_COMPUTER_MAX_TOOL_STEPS`, `OMNIAGENT_AGENT_MAX_MESSAGE_CHARS`, `OMNIAGENT_AGENT_MAX_MESSAGES`, `OMNIAGENT_AGENT_RUNS_PER_MINUTE`, `OMNIAGENT_AGENT_REASONING_EFFORT`, and `OMNIAGENT_AGENT_MAX_OUTPUT_TOKENS`. Ordinary runs default to 6 governed tool rounds, 30 total tool calls, and 14 model turns (two delegated child/Sentinel lifecycles pre-reserve ten, leaving four parent turns); raising the model-turn limit does not widen either tool limit, and request or delegation budgets may only narrow the server-configured authority. A parked legacy continuation without an exact persisted budget remains capped at the lower of its former 7-turn ceiling and the current deployment ceiling, so a release cannot silently widen resume authority. Dynamic delegation is a live, risk-one internal control action: an approval profile that forces it to pause fails closed before an approval record is created because its request-bound parent reservation cannot safely cross that boundary. The installed-Mac default remains 12 governed action/model rounds with 14 model turns (one additional semantic-plan reservation and one final-answer turn). Token, cost, wall-clock, approval, and other run limits are unchanged. Historical browser-action counters remain readable but grant no remote-browser execution authority.
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

### Private Google Workspace accounts

Asael uses its native server-side OAuth/REST connector as the canonical Google
integration. The official Google Workspace remote MCP servers remain a
Developer Preview and do not cover this product's complete governed mutation
and Photos Picker requirements.

Configure one Web application OAuth client in the same Google Cloud project as
the enabled APIs. Its production redirect URIs are
`https://asael.bennierichard.com/api/auth/google/callback` and
`https://asael.bennierichard.com/api/oauth/google/callback`. Enable Gmail,
Calendar, Drive, Docs, Sheets, Slides, and Photos Picker APIs. The OAuth consent
configuration must declare the scopes requested by
`GOOGLE_WORKSPACE_OAUTH_SCOPES` in
`src/lib/connectors/google-workspace-capabilities.ts`: OpenID/email,
`gmail.modify`, `calendar.events`, `calendar.calendarlist.readonly`, `drive`,
and `photospicker.mediaitems.readonly`.

Keep the audience External and In production for this private application.
An unverified sensitive/restricted-scope warning is expected for a private app;
do not repeatedly force consent or reset sync state merely to hide that warning.
After a scope expansion the owner must authorize once. Normal one-hour access
token expiry is refreshed with the retained refresh token and is not a broken
connection. Gmail and Drive deletion means recoverable Trash by default;
permanent Gmail deletion and unrestricted Photos-library background access are
not requested. Google login accepts only an exact active allowlist entry. Each
signed-in account sees one Google Workspace connection verified against its own
email; Personal and Work are separate tenants rather than side-by-side grants.

## Schema and migration rollout

Production request traffic verifies the schema and fails closed when a migration
is missing; it never runs DDL. Ordered migrations are recorded in
`omni_schema_version` and execute in one transaction under a Postgres advisory
lock. The path also upgrades the legacy timestamp-only marker. Migrations are
idempotent, but there is no automatic down-migration.

For each rollout:

1. Take and verify a restorable database backup.
2. Run `npm run verify` and the Postgres integration job against an isolated database.
   When `apps/flutter/**` changed, the Native workflow must also be green: it
   runs Flutter analyze and test, the macOS helper policy suites
   (`apps/flutter/tool/run_macos_policy_tests.sh`), and type-checks every
   helper's production entry point.
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

### Installed adaptive-runtime migration chain

The adaptive-runtime migrations below are registered in `schema-migrations.json`
and installed in production. Each migration takes the schema advisory lock,
checks the exact immediately preceding version/name/checksum, installs or extends
forced actor RLS, verifies its privilege/trigger boundary, and writes its own
marker in the same transaction.

| Version | Migration name | SHA-256 checksum | Additive boundary |
| --- | --- | --- | --- |
| 196 | `delegation_execution_runtime_v1` | `0113edbdab2a99f32d4e318c8407a5b66fb8fd7bcbbf839d4d199ded0d2ad6ac` | V2 delegation execution and root-budget ledgers |
| 197 | `scheduled_workflow_trigger_shadow_v1` | `64953184d937e9b07591a8dc0aaf97fc696f00a1317ed872d8b58764eca35a16` | actor-owned schedule configuration and no-execution shadow receipts |
| 198 | `scheduled_workflow_read_only_canary_v1` | `75358f70c27be2ce0bd8f2048dd399a649d8cbd27cca9ff1a30ab5343324089f` | immutable reviewed read-only occurrences, receipts, replacements, and circuit state |
| 199 | `scheduled_workflow_policy_lease_v1` | `56d69404165e70123c590cf1637985db06de55889e4de64e28523b92885ca093` | single-use exact-effect PolicyLease and consumption ledgers |
| 200 | `notification_disposition_runtime_v1` | `99af5ab52a824c435e19e46f918755bfa549a1fecda22f9061940f9030c97c2b` | content-free disposition, digest, and watermark ledgers plus generic notification push cause |
| 201 | `prompt_queue_runtime_v1` | `e9cd14ec6c526fbd0fbed097cbc8a535e92b60cfd6bae0785a0a0a6c3b584567` | sealed actor-private prompt queue and revision-fenced dispatch lifecycle |
| 202 | `delegation_execution_rls_composition_repair_v1` | `3d6b28bd2fdb00cc57360506baea3ef120a4ae13e0050be57ba6d266310a3d63` | permissive tenant admission composed with the existing restrictive delegation actor boundary |
| 203 | `agent_daily_learning_v1` | `88fa0dd240ba1920d2bb66395bb2b268dc98bd682282fbe3633d1df4b1d01f96` | actor-private daily learning observations and reviewed adaptation proposals |
| 204 | `google_multi_account_connections_v1` | `8c7ae456bdbcc92f00adb2f24728cf03dc2b082cae7880e0f87ce71d15314cd8` | actor-owned Google account connection separation and scope-safe identity binding |
| 205 | `governed_local_command_runner_v1` | `a9c301b4ef3030962b2ae9f69b8df9c2cb2914e90b0d9c8a3c6032f91691015a` | exact command workspace grants, approval/courier binding, and metadata-only execution receipts |
| 206 | `prompt_queue_context_pins_v1` | `5de8d38921e0d4d0f7e79bcfe4745f780ce973b009c874a519d09bfd8f3ff777` | sealed exact Command references plus content-free digests/counts for reviewed and queued work |

Version 196 requires the exact predecessor marker v195
`moltbook_autonomy_privilege_repair_v1` with checksum
`c02b2ca195cbb00c206320eb2074fed7981c282c356f1d4320c6c1ac866adf94`;
each following row requires the marker immediately above it. Apply only in the
listed order after a verified backup. The 2026-09-22 release retained the custom
dump at `/Volumes/Extreme Pro/Projects/OmniAgent/backups/omniagent-2026-09-22T07-06-12-772Z.dump`
(140,002,352 bytes),
SHA-256 `40dd780827cc9b8b80598ae736c3b1ddc1970b2f720e1bd7709565a1f78fec42`.
A partial application intentionally makes newer code fail schema verification
rather than silently skipping a boundary.

The chain remains expand-only across the historical v20 bridge and current v27
rollback client: older clients do not receive the new routes or authority, and
existing queue, notification, workflow, and Agent records keep their prior
meanings. The first v197 attempt failed its
boundary assertion and rolled back atomically because production default table
privileges had supplied broader grants than the migration allowed. V197-v201 now
explicitly revoke serving-role table privileges before granting the narrow
operations they require. The successful retry installed exact v196-v201 markers,
verified forced RLS on all 12 affected tables, and found zero broad mutation
grants on those tables. Subsequent ordered releases installed exact v202-v205
markers; production schema discovery now terminates at v205.

The compatible web release is Vercel deployment
`dpl_6mjgZgpMm8QxdEzejY2opB5vodpY`, built from exact source revision
`8fb659220b2a57842e04402be057bdb3375b2369` and staged at
`https://omniagent-707g2gfoy-benniejosephs-projects.vercel.app` before promotion
to `https://asael.bennierichard.com`. Canonical health, v25/v20 discovery, and
the licensed TradingView asset passed. The Fly worker entrypoint, image contract,
and protocol stayed unchanged; the existing protocol-1 worker and OpenAI gateway
remained healthy, so no worker rebuild was required. V20 stays advertised and
accepted for rollback, while v21-v24 remain immutable archives rather than
rollback candidates.

The follow-up canonical queue-ownership repair began at Vercel deployment
`dpl_G8QQ7oQScNKDowj11DXMnx47Mex9`, revision
`9239df88a84f280a62e978a0eb366c87cde25317`, and required no schema, native
contract, or Fly image change. Subsequent release candidates deliberately
remained failed evidence: `dpl_95zuzoK6s4wwWw1iGyaxWcd8CBeU` exposed the
nested in-process request boundary, `dpl_HePRzBsKtUdAyEhcD1R2pNR9FdPb`
exposed Vercel Authentication on unique deployment URLs, and
`dpl_Hpbnzx1dWBfhwv8mY7Ty3PHpCkxy` proved canonical revision-fenced transport
before canary M exposed PostgreSQL `42P18` in the nullable lifecycle receipt.
None is counted as a successful queue canary.

The completed queue-lifecycle release is Vercel deployment
`dpl_8GrWic9jwQsvNTBLK8Rg6jKVj3Sw` at exact revision
`cf642c61ff17bdf434efb537356c7a232be1ae9c`, canonical at
`https://asael.bennierichard.com`. Canonical health reports healthy with the
exact revision and database/OpenAI/cron configured; the licensed TradingView
artifact returns HTTP 200 with 65,505 bytes; anonymous prompt-queue access
returns 401. The unchanged Fly worker machine `89590dc6671498` remains started
with a passing service check at release 336. Authenticated macOS canary N closed
queue item `9193ea36-31cd-4545-a9c5-76aeb7b7bf3f` as `completed` revision 4,
linked run `65c0f813-2771-4123-b788-c31343e82b34` and thread
`34cea67a-e3df-468e-bceb-b1a6221032aa`, cleared its dispatch token and lease,
and returned exact `LIVE_QUEUE_GATE_N`. Both outer dispatch and `/api/agent`
were HTTP 200 with no relevant 5xx or projection-persistence error.

The adaptation proposer reuses the existing v115 ledger and therefore has no
new migration in this chain. That does not make it independently deployable:
its worker code, verifier assignment, exact target/Sentinel pins, content-free
outcomes, and management UI must travel with the compatible release. Do not
interpret a passed Sentinel proposal review as lifecycle evaluation or
activation.

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
and bounded takeover leases. Historical migration 123 repaired the 12
actor-owned A2A, Trash, approval, and browser tables created by migrations
117–122, but its standalone and embedded paths composed policies differently.
Migration 183 is the append-only convergence boundary for already-upgraded and
fresh databases: every repaired table must have exactly one permissive
`omni_tenant_isolation` policy and one restrictive exact-actor policy, both for
all commands and `PUBLIC`, with forced RLS enabled. PostgreSQL therefore requires
both tenant visibility and exact actor scope (or audited system scope). Never
make both policies permissive, because their predicates would be ORed and expose
other actors in the tenant; a restrictive actor policy without the permissive
tenant entry policy rejects every row. Migration 181 preserves the browser rows
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

Migration 181 and canonical v14/v13 are verified checkpoints. New remote requests
and retired product routes fail closed, database history remains under read-only
runtime authority, and source contains no Playwright development or product
runtime. After the owner-Mac canary passed on 2026-09-17, the release operator
stopped and destroyed Fly machine `287920db963048`, destroyed encrypted profile
volume `vol_vz8x9p55j9876djv`, removed secrets
`OMNIAGENT_PLAYWRIGHT_MCP_TOKEN` and
`OMNIAGENT_PLAYWRIGHT_PROFILE_KEY`, and destroyed app
`omniagent-os-browser`. The volume and its profile snapshot lineage are not
recoverable; retained database audit history was not deleted. The separate
`omniagent-os-worker` app remains started and healthy at release v335, and its
public health endpoint reports service `asael-openai-egress`, region `iad`, and
protocol 1.

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

After the worker registration window, each release phase runs one successful logical paid agent turn through the exact staged or canonical Asael origin. The verifier creates a unique synthetic tenant and tool-free session-memory agent pinned to `openai_fast`, checks a description/accent update, submits the direct `hello` turn once at the application layer, and requires the exact `ASAEL_LIVE_OK` response. It then proves one OpenAI model receipt with positive token usage, no fallback, delegation, tools, council, or consolidation; verifies replay and trajectory integrity against the release revision; and physically deletes the temporary agent. The isolated run and bounded trajectory receipt remain as release evidence. Staged and canonical verification therefore produce two successful logical paid turns per release. The OpenAI SDK transport may still perform its own retry before a logical turn completes; the release runner never retries the `/api/agent` POST. Only after the staged verifier passes does it run production smoke plus API and authenticated server-rendered dashboard document budgets and expose the web release. The dashboard gate measures response start, bounded body completion, ready SSR markup, cold recovery, hot percentiles, and `Server-Timing` without restoring a Playwright runtime; sampled Web Vitals remain the real-browser LCP, INP, CLS, and FCP signal. `BENCHMARK_DASHBOARD_SAMPLES` and `BENCHMARK_DASHBOARD_WARMUPS` are the explicit dashboard controls, with the former browser-prefixed names accepted only for release-runner compatibility. After Vercel promotion it sends the worker a targeted `SIGHUP`; the worker verifies canonical health/revision and moves every lane in place without restarting the co-hosted gateway. The canonical target is also recovered revision-safely after a later process restart. Gateway authentication and the paid agent verifier repeat after that rebind; rollback repeats the token-pair check without spending on another model call. A failed staged gate restores the previous worker image and primary token without exposing the web release; a failed post-promotion check restores both releases and verifies the restored gateway pairing.

```bash
npm run deploy:production
```

Before `npm run verify` or any platform change, the runner proves release
provenance against GitHub rather than the local clone. `OMNIAGENT_RELEASE_SHA`,
when set, must equal the checked-out `HEAD`. GitHub's comparison of
`benniejoseph/OmniAgentOS` `main` with that commit must report it as identical
or behind, so an unpushed, branch-only, or rewritten commit cannot be released.
The latest GitHub Actions run of each required job on that exact commit
(`quality`, `build`, `audit`, `integration`, `worker`, and `gitleaks`) must have
succeeded. Any other job that ran on it, such as the path-filtered Native
`flutter` and `macos-policy` jobs, must be green, skipped, or neutral. A queued,
running, failed, or missing job stops the release, as does a check-run list
GitHub truncates. Only GitHub Actions runs count, so another app cannot satisfy
a required job name. The runner reads GitHub through `gh api`, so the release
shell needs `gh auth login` or a `GH_TOKEN` with read access to the repository.
`node scripts/deploy-production.mjs --provenance-probe` runs only the clean-tree
and provenance checks. There is no web-only release path: the `dedicated_worker`
release gate requires the worker heartbeat revision to equal the web revision,
so web-only changes also use the paired runner. The scheduled `Production Smoke`
repeats the provenance check for the served revision, and its `provenance` gate
turns red when production serves a commit that did not come through this path.

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

## Declarative Plugin v1

Plugin lifecycle routes require ordered migration
`20260918150000_declarative_plugins.sql` (internal schema version 186) after
the exact mobile-push receipt v185 predecessor. It installs actor-private,
forced-RLS preview, installation, and immutable mutation-receipt records plus
the Plugin source binding on existing custom Skills. Apply the migration before
deploying the Plugin API. This release is a Vercel and database change; it adds
no worker task and requires no Fly release or new environment secret.

An installed, enabled Plugin materializes only its declared Skills through the
existing actor-owned Skill store. Stable Skill identity includes the exact
tenant/actor installation, so two users installing the same manifest cannot
collide. Disable and uninstall make those Skills unavailable to new assignment,
Agent execution, and fork recovery without deleting durable Agent or Plugin
history. MCP entries remain setup templates: a human must separately supply a
credential, discover contracts, review them, and activate the connector through
the existing governed connector routes. Workflow entries remain metadata-only
and cannot plan, approve, enqueue, or execute work. Plugin manifests and database
snapshots must never contain tokens, private keys, passwords, or executable
entrypoints.

## Built-in Skill catalog v2

The curated built-in Skill library requires ordered migration
`20260919120000_builtin_skill_catalog_v2.sql` (internal schema version 187)
after the exact declarative-Plugin v186 predecessor. The migration pins all 18
released built-in IDs, reserves them against custom Skill insertion, and
rebuilds the exact-owner Agent reference guards. It also enforces a maximum of
eight assigned Skills so prompt instructions and the governed-tool allowlist
cannot diverge. Existing over-limit assignments make the migration fail
closed; the migration never truncates user configuration.

Production installed v187 on 2026-09-19 and promoted Vercel deployment
`dpl_31wUhFtP8pxP5GEc8q46Kq3p2Ms9` at exact revision
`ed615fe3b0a3a894628b28905a13865f05cd7d8a`. Canonical health reported healthy,
and an authenticated private/no-store catalog read returned 18 selectable,
non-manageable built-ins with the productivity, design, engineering, writing,
automation, and learning entries present. The catalog and assignment boundary
are Vercel/database changes; they add no worker protocol or task. The existing
worker remains compatible because the database rejects profiles above the same
eight-Skill bound, while the runtime's additional defensive cap will ship in
the next paired worker release.

## Document Studio and generated artifacts

The Document Studio release requires ordered migrations
`20260919143000_builtin_skill_catalog_v3.sql` (internal schema version 188)
and `20260919150000_generated_artifact_persistence.sql` (internal schema
version 189). Version 188 adds the built-in `creation.document-studio` Skill
and keeps the exact-owner Agent assignment guards. Version 189 creates the
actor-private artifact head, immutable version, and mutation-receipt ledgers,
plus private content locators for generated files. Apply both migrations before
deploying native contract v18 or exposing generated-file projections.

`app.artifacts.presentations.create` renders editable PowerPoint files inside
Asael without an external write approval. `google.docs.create`,
`google.sheets.create`, and `google.slides.create` are consequential Drive
writes and must remain risk-two, approval-gated governed tools. Their recovery
markers, provider revision fences, readback digests, and exact execution scope
must not be bypassed by direct connector calls. Generated content responses are
private, `no-store`, attachment-only, and owner scoped; specs, hashes, storage
locators, and execution authority are never part of the public projection.

Production installed schema versions 188 and 189 on 2026-09-19. Version 188
has checksum `4c206314533b7812aff807d551f1b1514987582b64c21e1c17378ac0c592deb1`;
version 189 has checksum
`4065c615c77bf4baf5921d5dcd468359ed8113bc49ba5291908bdfc3b9f36ebf`.
Vercel deployment `dpl_GN9qpGAuoqrveQrXMSwKtKeLLFTq` and Fly worker machine
`89590dc6671498` are paired at exact revision
`5c0a13b2b78d4ed6345e73a6b48e18e79c30fbbb`; canonical web and gateway health
both report that revision and the worker release hold was explicitly activated.
The matching owner-only macOS package is `Asael-1.11.0-21-macOS.dmg`, SHA-256
`b7a5ee77b8d6a32c4c72afe40570ba1a6bf842f47be780ddf0b7896af4894d2b`.
It is installed at `/Applications/Asael.app`, self-signed for the owner's Mac,
and is neither notarized nor APNs-enabled. An authenticated native-session
canary created the editable presentation `How to Create Documents with Asael`
and exposed it in **Results → Created files**. The stored 20,423-byte OOXML
payload has matching persisted and independently observed SHA-256
`05d9331c6c789981ec62200c63123fe5ed5ea12444dfd5314476b9078f1d5a49`.

## Moltbook Agent boundary

The Moltbook integration is a dedicated public-social identity boundary, not a
general connector. A linked custom Agent must keep either the exact legacy
nine-tool boundary or the exact current thirteen-tool boundary, no Skills,
session-only memory, governed autonomy, and an `always` or `risk_based`
approval policy. The current boundary adds only bounded community discovery
and subscription operations. Database guards reject subsets, supersets, mixed
boundaries, or later Agent-policy edits that would broaden that authority. A
linked Agent cannot be retired or moved to Trash; pause the connection instead
so its credential, public identity, and append-only activity evidence remain
reconcilable.

Registration is an explicit authenticated owner control-plane action. It must
record acceptance of the versioned public-activity disclosure before sending
the single exact registration request to
`https://www.moltbook.com/api/v1/agents/register`. Store the returned opaque API
key only in the existing encrypted credential vault, bound to the tenant,
owner, Agent, connection, provider, and credential version. Never put that key
in model context, Agent memory, logs, events, client responses, screenshots,
environment variables, or a second connector. Asael never retries registration
after dispatch: a provider error, transport interruption, or ambiguous response
is held for operator reconciliation so a second public identity cannot be
created accidentally. Moltbook ownership claiming remains a separate human
action at the exact provider claim URL; Asael must not automate email, X, or
other proof-of-ownership steps.

The maintenance lane performs the connection heartbeat and, only for an
explicitly owner-enrolled autonomy mandate, may claim one leased social cycle
at the stored four-hour cadence. Feed, thread, and community reads still pass
through the governed tool executor. The mandate is versioned and revocable,
requires a live operator/admin membership plus the exact current Agent
definition, principal, policy, connection, and lease at action time, and allows
at most one total public mutation per cycle within the displayed rolling daily
budgets. It covers only text posts without links, comments without links,
votes, follow changes, and community subscription changes. Direct messages,
verification, deletion, moderation, external links, private Asael data, and Mac
control remain excluded. Without an active mandate, every public mutation
continues to wait for human approval. Provider content and verification text
remain untrusted data, never instructions.

Every autonomy action atomically consumes a digest-bound action claim before
provider dispatch. Idempotent reuse revalidates the live cycle and authority;
an expired lease cannot authorize or complete work. Expired cycles produce a
typed digest-only completion event, and three consecutive failed cycles pause
the enrollment. The owner can pause, resume, revoke, or request one immediate
cycle from the Agent inspector; revocation requires a new explicit enrollment
and never restores itself.

Every approved public mutation persists its effect intent before network
dispatch and binds the tenant, physical owner, Agent principal, tool execution,
exact input digest, target, and idempotency digest. A validated provider
acknowledgement is retained privately before the public activity projection is
updated. Definite provider rejection may close as failed; a transport timeout,
network interruption, or other ambiguous outcome stays uncertain and must not
be blindly retried. A same-key replay reconciles from the durable receipt and
never calls Moltbook again.

The Agent inspector and native v19 console expose claim/health state, bounded
activity, refresh, pause, and resume without exposing the API key or untrusted
provider instructions. macOS v19 admits only `agents.create`, `agents.update`,
and `agents.moltbook.manage` for this lifecycle; it intentionally provides no
native Agent-delete capability. Native v20 keeps that operation surface and adds
only the optional bounded `agentId` field to the strict Conversation request.
The macOS Agent inspector can therefore start a clean direct Command run pinned
to the exact actor-owned custom Agent; queued prompts and retries retain that
selection, and clearing it returns to ordinary supervisor routing. Apply
`20260921120000_moltbook_agent_connections.sql` and then
`20260921170000_moltbook_autonomy.sql` before promoting the web/native release.
Their ordered/runtime schema identities are respectively version 190 checksum
`e0b8c00ca8f4fce6139735623366cacfa97675419a57c1666b4bf0fe4bbe8e46`
and version 194 checksum
`66a868eed1a0fef0eb61d8f69d0d2351605edf39711c007d5c58f1febb5cafef`.
Run the focused Moltbook, Agent-route, native-contract, Flutter Agent,
TypeScript, and changed-file lint checks. Paired web/Fly promotion remains the
default for releases that touch the worker protocol or worker-owned sources.
This Moltbook release changes neither, so its reviewed release path is a
production-target Vercel canary followed by explicit promotion; keep the
existing Fly worker release in place and verify its health separately.

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
