# Page-by-page revamp scope

**Coverage:** all 38 current web page routes: 24 private app routes and 14 public/access/offline routes. API-wired means connected to code contracts, not a production readiness claim. Every migrated page must use the shared theme, navigation, typography and resource states. Phase references match [the task plan](TASKS.md).

**Decision and baseline, 3 October 2026:** ATLAS is the selected original eagle. The first shared-web, Today and Command slice is in progress; see [implementation evidence](IMPLEMENTATION.md). All 38 web page routes and native route definitions in this inventory remain unchanged at the implementation baseline `origin/main` `dc1cfe6e`. ATLAS production assets are not yet available.

## Private workspace: all 24 routes

| Route | Current functions to retain | Proposed experience and specific work | Phase |
|---|---|---|---|
| /app | Today brief, tasks/reminders, agenda, approvals, customers, active work, memory, conversations and usage | Curated Today view with urgent decisions, brief and agenda first. Move usage/source diagnostics into disclosure. Preserve brief scheduling and partial/stale data | 2 |
| /app/command | Threads, streaming runs, queue, context, plans, work/computer progress, artifacts, evidence, feedback, voice | Primary Assistant. Compact ATLAS, comfortable transcript, persistent composer, inline decisions/results and expandable activity. Preserve queued/running/clarification/approval/interrupted/failed/partial states | 2 |
| /app/capture | Note, recording, batch upload, processing, originals, reindex, Library, offline notes | Elegant intake with modality tabs, drop/paste, per-item progress and retry. Show transfer/extraction/indexing separately. Keep offline queue limits and recording consent | 3 |
| /app/projects | Projects/tasks, templates, budgets/parallelism, execution, artifacts, feedback, Library, App Builder | Outcome-focused Work hub with overview/execution/build views, next action and blockers. Refined list/detail and task progression; preserve planning, pause/resume/retry/archive/reopen and delivery verification | 3 |
| /app/meetings | Calendar sync, search, library and create/select | Upcoming/recent list with source freshness, preparation and follow-up entry points. Honest disconnected/reauthorization/sync states | 4 |
| /app/meetings/[id] | Participants/consent, source revisions, media/transcript, decisions, commitments, governed follow-ups and account links | Readable summary/transcript with cited decisions and exact follow-up review. Preserve missing/inaccessible, unknown consent, processing failure and stale revision states | 4 |
| /app/accounts | Customer portfolio/health/risks/actions, Salesforce sync and creation | Customer Accounts attention list and explainable health. Distinguish CRM account from a connection/login account; show sync/conflict/freshness | 4 |
| /app/accounts/[id] | Lifecycle, domain facts/disagreements, intelligence, health, success workflows, scope and history | Focused account dossier: overview, facts/evidence, activity/workflows. Preserve read/write distinctions and CRM restrictions | 4 |
| /app/markets | Instruments/charts/ingestion, events/news, technical structure, replay/backtest and forecast journal | Specialist analytics layout with aligned controls, usable charts and evidence. Retain density and date/instrument context; show missing/stale data, running jobs and uncertainty | 4 |
| /app/agents | Live work, roster, persona/charter, Skills, outcomes/learning, releases and grants | Clear specialist roster and inspector. ATLAS provides product continuity; executing Agent/version remains visible. Preserve immutable identity, permissions and release readiness | 4 |
| /app/approvals | Workspace access requests and exact agent/workflow decisions, trust and return links | Shared decision pattern in Inbox and Activity: proposed action, scope, target, effect and explicit choices. Handle stale/already-decided/expired/error and restore origin | 2 |
| /app/payments | Purchase mandates, signer registry, WebAuthn registration/removal and authorization | Focused mandate review with exact merchant/items/amount/constraints and challenge state. Keep sensitive flows plain and precise; preserve supported authenticator and cancellation behavior | 4 |
| /app/results | Run/workflow outputs, plan/approval/verification/evidence context | Results ledger linked from Work/Activity. Output first, verification/provenance on demand. Distinguish unverified, partial, blocked, canceled and unavailable evidence | 3 |
| /app/automation | Capabilities, automations/schedules, Skills, connections, Extensions, advanced tools/operations | Plain-language capability hub with readiness and attention first; consistent configuration/detail patterns. Retain reviewed activation, exact versions and technical audit views | 4 |
| /app/connectors | Personal OAuth, MCP, OpenAPI, discovery, contract review, sync/knowledge coverage | Provider-centric connection list and guided setup/detail. Distinct installed/connected/reviewed/indexed states, reconnect/revoke/rotation and retained read-only records | 4 |
| /app/workflows | Plans/runs/triggers, preview/start/control, quarantine and recovery/queue inspection | Readable procedure/run timeline with operator mechanics on demand. Preserve queued/waiting/retry/quarantine/failed and control semantics | 4 |
| /app/memory | Memories, knowledge, reviews, graph, consent, maintenance and forgetting | Understandable memory browser with provenance, scope and correction. Sources/Library and advanced graph/review remain discoverable; preserve contradiction and exact forget-impact review | 3 |
| /app/evaluations | Cases/runs, recurring failures, harness proposals, release evidence and governed replay | Quality list/report detail, clear measured results and limits. Preserve safe-suite restrictions, running/unknown/unavailable states and proposal review | 4 |
| /app/observability | Runtime timeline, SLOs, incidents, alerts and markers | System Health with actionable incidents first, then filters and diagnostic details. Keep unknown/stale distinct from healthy | 4 |
| /app/security | Access/RBAC, audit, isolation, retention, release gate, signed export and retention execution | Security and audit workspace with authority/impact clear before actions. Retain role-limited views, preview/confirmation and exact audit evidence | 4 |
| /app/settings | Workspace readiness, providers, routing, agent grants/releases, API/MCP, privacy/recovery | Organize into general appearance/ATLAS, voice/notifications, connections and existing advanced sections. Preserve dirty/saving/error, validation and one-time secret-display flows | 2 + 4 |
| /app/tools | Redirect to Capabilities | Preserve alias; no duplicate tool dashboard | 4 |
| /app/missions | Redirect to Projects execution, or read-only library with legacy=1 | Preserve history under Work archive. Do not revive a competing active work model | 3 |
| /app/missions/[id] | Historical tasks/events/evidence/decisions; inaccessible record falls back to Projects | Restyle historical detail and mark it read-only. Retain supported bookmarks and evidence access | 3 |

## Public, access and fallback: all 14 routes

| Route | Plan | Phase |
|---|---|---|
| / | Elegant private-product landing page with restrained ATLAS introduction, clear sign-in and deliberately labelled demo | 4 |
| /platform | Shared public template explaining capabilities accurately; no implication that a design sample is a shipped feature | 4 |
| /solutions | Consistent use-case pages using safe sample content and current availability | 4 |
| /pricing | Restyle current content and preserve URL. Treat any commercial repositioning as a separate decision; invent no plans or checkout | 4 |
| /security | Public trust explanation, clearly distinct from private live security administration | 4 |
| /docs | Readable documentation hierarchy and updated navigation/feature labels; maintain useful API/operating references | 4 |
| /changelog | Clear chronological release notes, typography and links | 4 |
| /privacy | Shared legal reading template, accessible typography; preserve legal meaning/text | 4 |
| /terms | Same legal template and constraint | 4 |
| /login | Restrained ATLAS welcome and accessible form; session check, submitting, credentials/rate-limit/provider/local/error states | 4 |
| /signup | Preserve redirect to login and private-access behavior | 4 |
| /onboarding | Preserve redirect to app; proposed companion setup lives inside authenticated UI | 4 |
| /demo | Rebuild clearly labelled simulated ATLAS interaction preview. No private execution, real authorization or false verification claims | 4 |
| /offline | Calm recovery, static fallback, retry and supported queued-capture explanation. Do not promise a complete offline workspace | 4 |

## Subviews are part of completion

| Family | Views and interactions that must be covered |
|---|---|
| Shell | Expanded/collapsed rail, mobile drawer/dock, switch account/sign out, command palette, badge counts, notifications/preferences/history, theme, focus/skip link, storage warning |
| Conversation | Thread rail/mobile history, Chat/Map, queue edit/reorder/pause/dispatch, agent/model/target/context pickers, file version chips, voice, Memory/Context/Plan/Activity/Evidence detail, computer progress, checkpoint/fork, media/citations/feedback |
| Work | Overview/Execution/Build, selected project/task/artifact, templates and version/instantiate review, task budgets/parallelism, library and feedback. Current project detail is embedded at /app/projects, not a separate web detail route |
| App Builder | Preview/Code; Files/Restore/Activity; sandbox lifecycle, edits/command output, verification, repository selection, PR handoff, preview deployment and release/rollback controls |
| Capture/Library | Note/Record/Upload, batch processing and originals, list/grid/filter/search, selected asset/version/citation and supported retry/reindex |
| Memory | Memory/Knowledge/Reviews/Universe, type/tier/state filters and paging, inspector, pin/archive/restore/forget impact, new memory/fact, conflict/promotion/source-map proposals, consent and maintenance |
| Specialist domains | Meeting consent/transcript/commitments; account facts/conflicts/health/workflows; market Overview/Events/Technicals/Backtests/Journal and job states; agent Live/Roster/Skills/Outcomes and identity/release inspectors |
| Capabilities | Overview/Automations/Skills/Connections/Extensions/Advanced, schedule preview/edit/review, policy leases, extension/plugin manifest review/install/remove, connection contracts and source coverage |
| Settings | Workspace/AI providers/Model routing/Agent control/API & MCP/Data & privacy, provider rotation, one-time token display, export/recovery/push/grants; new appearance/personality/voice settings |
| Recovery | Root global error, app error/loading, command error, mission loading; new branded recoverable 404 is an explicit gap rather than an existing page |

Every family includes idle, hover/focus/pressed/disabled, initial loading, empty, partial/stale, error/retry, forbidden, offline where supported, saving/conflict, and success states appropriate to that feature. Complex charts, builders and large histories get performance-specific states. Apply the same design review to sheets, menus and overlays as to the default page.

## Native/mobile/macOS parity

The actual router and destination definitions take precedence over older speculative design docs. Native has real detail routes where web uses query-selected embedded detail.

| Native path/surface family | Revamp requirement |
|---|---|
| /today, /talk, /capture | Same briefing/companion/intake semantics; native controls, keyboard, capture permissions and offline limits. Bind /talk to actual thread/run/context controller state |
| /projects, /projects/:id | Outcome list/detail and Build Studio, task focus through workItemId, supported actions and evidence parity |
| /knowledge | Memory, source/library and graph/review presentation with the same scope and terminology |
| /meetings, /meetings/:id | Agenda/library, consent, processing, transcript and follow-up detail |
| /accounts, /accounts/:id, /customers/:id | Customer portfolio/detail and compatible alternate customer entry |
| /markets, /agents | Specialist views and context/assignment continuity; keep pending-conversation guards |
| /inbox, /inbox/approvals/:id, /payments | Exact focused decision, return behavior and platform authorization/signing support |
| /results, /results/:key | Outputs, typed detail and preserved encoded canonical result keys |
| /automation, /workflows, /integrations | Capability studio plus compatibility routes and section selection. Preserve existing platform-dependent redirect behavior |
| /quality, /monitoring, /security, /settings | Operational/admin parity with native list/detail controls and secure secret handling |
| /login, /bootstrap | Native session/bootstrap states and secure storage compatibility; first-use ATLAS is optional and non-blocking |
| /devices | Signed-installation device/security ledger, enrollment/revocation, OS permission and local execution readiness |
| /quick-entry | Fast menu-bar/global-shortcut intake with compact ATLAS or static portrait; preserve pending work, handoff and main-window return |
| /ambient-voice | Native focused voice window using the shared conversation, actual mic/playback/interrupt states and controls |
| /administration | Preserve current macOS redirect to Monitoring and non-macOS admin presentation |
| /missions, /missions/:id | Preserve current redirects to Projects; do not infer native mission-detail parity from an old design brief |
| Auxiliary windows and OS surfaces | Menubar, notification deep links, share/camera/microphone/file intake, window reopening, touch/keyboard focus, text scaling, motion preference and low-power/static fallback |

Native implementation belongs to Phase 5 by family, with a Phase 0 renderer proof and compatible shared contracts throughout. No new 3D renderer is assumed to exist in Flutter.

New features also need native entries: proposed `/activity` in Phase 5 maps to web `/app/activity`; proposed `/responsibilities` and `/responsibilities/:id` in Phase 6 map to web `/app/responsibilities` and its detail route. Their links appear only when authorized routes and contracts exist. These additions do not change the count of 38 existing web routes above.

## Inventory evidence

Page files under src/app establish the 38-route inventory. Major subviews are defined in agent-runs-workspace.tsx, projects-workspace.tsx, app-builder-studio.tsx, capture-workspace.tsx, workspace-library.tsx, memory-intelligence-workspace.tsx, agent-arsenal-workspace.tsx, meetings-workspace.tsx, customer-accounts-workspace.tsx, market-research/market-research-workspace.tsx, automation/automation-studio.tsx and settings/settings-workspace.tsx. Native scope comes from apps/flutter/lib/app/router/app_router.dart and app/navigation/app_destination.dart. Navigation-only search is currently implemented in app-shell/command-palette.tsx; universal content search is planned new work.
