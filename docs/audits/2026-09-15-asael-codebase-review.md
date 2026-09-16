# Asael codebase review — current evidence

Date: 2026-09-15

Reviewed baseline: `00c601c7e0416464ec621863b64e771e038fb975`

Latest review remediation: `ec6f605abe89ed7eb65b6c9e4a2e3b9bafba3dbe`
Branch: `performance-remediation`

This is the current review artifact. `docs/AUDIT_REPORT.md` and
`docs/DEEP_DIVE_REVIEW.md` remain useful historical snapshots from 2026-06-10,
but their capability and risk conclusions do not describe the current system.

## Executive result

Asael is a large, working governed-agent platform rather than the non-agentic
prototype described by the June audit. The bounded agent loop, governed tools,
approvals, durable workflows, typed events, source/RAG/memory planes, Google
Workspace access, media generation, Computer Use, Projects/App Builder, market
research, and Android client are implemented. The current production web,
database, worker/OpenAI gateway, and Playwright/Computer Use gateway were healthy
at the reviewed revision. Phase 13 remains intentionally excluded.

The strongest remaining risks are not missing foundations. They are completion
gates, oversized maintenance boundaries, a blocked embedded App Builder preview,
and a few plan claims that had drifted ahead of the code.

## Current inventory

| Measure | Current evidence |
|---|---:|
| Production TypeScript/TSX/Dart files | 1,683 |
| Production source lines | 560,916 |
| Test files | 683 |
| API route handlers | 233 |
| Client components | 57 |
| Database migrations | 72 |
| Git commits at review | 1,383 |
| Source TODO/FIXME/HACK/XXX markers | 0 |

The CI workflow runs strict TypeScript, lint, coverage, production build,
Postgres/RLS integration, Playwright, dependency audit, worker syntax, and
operations script checks. The scheduled production smoke additionally exercises
preflight, security, tenant isolation, evaluation, and release-evidence gates.

## Master-plan reconciliation

| Area | Built state | What remains |
|---|---|---|
| Phases 0–8 | Complete | No open implementation slice found in the task tables. |
| Phase 9 | P9.1–P9.12 and P9.14–P9.18 complete | P9.13 is partial; P9.19 is intentionally held for live human-present payment proof. |
| Phase 10 | Complete | Live Salesforce activation is external configuration, not a code gap. |
| Phase 11 | Complete | Continue operational freshness/convergence monitoring. |
| Phase 12 | Web/server, Android code, signing, Firebase transport, and device registration are built | One observed notification delivery, causal deep link, and acknowledgement receipt remains. iOS is excluded by owner request. |
| Phase 13 | Not started | Intentionally deferred/skipped. |

### P9.12 correction

Command voice is transcription-only and keeps an editable command draft; it does
not create Meeting media. Meeting capture has separate participant, consent,
recording, transcript, and retention contracts. The focused voice and Meeting
contract checks pass, so P9.12 is implemented and should not remain labelled
deferred.

### P9.13 partial implementation

The existing personal outbox provides durable in-app reminders, quiet hours,
read/snooze/dismiss/acted state, exactly-once occurrence claims, mobile push
registrations, causal delivery records, and acknowledgement. The master slice also
requires web push, email delivery, and preferences by urgency, workspace, project,
customer, source, and channel. Those broader channels and preference dimensions
are not present, so the phase cannot be marked complete.

## Verified findings

### 1. Oversized server persistence boundary — high maintenance risk

`src/lib/db/client.ts` is 63,293 lines with 34 exports and roughly 745
function-like bodies. It combines schema versions, migrations, storage behavior,
and many domain persistence paths. This is not proof of a live latency defect, but
it materially increases review blast radius and makes safe ownership difficult.

Recommended change: keep the shared transaction/scope primitives, then extract
domain repositories incrementally behind exact contract tests. Do not perform a
single large rewrite.

### 2. Command workspace remains a client-side hotspot — high performance risk

`src/components/agent-runs-workspace.tsx` is 6,797 lines with 92 state hooks and
19 effects. It includes independent three-second and four-second polling paths and
multiple large subviews in one client boundary. Every change in this component has
a broad render and regression surface.

Recommended change: measure the current Command interaction trace, then split the
conversation composer, live run timeline, trace viewer, media result surface, and
context drawers into memoized route-local modules. Replace independent polling
with one visibility-aware activity subscription/fallback coordinator. Preserve
the existing governed run/event contracts.

### 3. Other large client workspaces — medium performance/maintenance risk

The next largest client boundaries are `domain-console.tsx` (3,005 lines),
`mission-workspace.tsx` (2,057), `mcp-connections.tsx` (1,860),
`customer-accounts-workspace.tsx` (1,592), `memory-intelligence-workspace.tsx`
(1,480), and `market-research-workspace.tsx` (1,423). Twenty-four React lint
suppressions exist, primarily exhaustive-dependency and manual-memoization
exceptions. These should be reviewed while extracting modules, not removed
mechanically.

### 4. App Builder embedded preview — repaired; authenticated visual proof pending

The project workspace can produce and open an authenticated sandbox preview, but
the embedded iframe was rejected before the sandbox request. The root cause was
Asael's own top-level CSP: `frame-src` allowed only `'self'` and `blob:` while
Build Studio embeds an HMAC-authenticated `sb-*.vercel.run` preview.

The production CSP now admits only the reviewed Vercel Sandbox host family. The
sandbox proxy validates and binds the exact Asael parent origin, removes a
conflicting upstream `X-Frame-Options`, preserves other upstream CSP directives
while replacing only `frame-ancestors`, applies `no-referrer` and `nosniff`, and
is rewritten on every preview restart so existing sandboxes receive the fix. Five
focused CSP/proxy checks and the production build pass. Canonical headers expose
the exact sandbox frame source at revision
`ec6f605abe89ed7eb65b6c9e4a2e3b9bafba3dbe`. The workstation locked before the
authenticated visual restart, so the browser click-through remains an explicit
proof item rather than a claimed canary.

### 9. Client live-refresh pressure — first repair deployed

The Command progress and trace projections used fixed `setInterval` refreshes.
Those intervals continued firing while the tab was hidden and could start a new
request before a slow trajectory read finished. A shared visibility-aware
scheduler now serializes refreshes, schedules the next request only after the
previous one settles, stops timers while hidden, wakes immediately on focus or
visibility restoration, and does not reschedule after cleanup. The same contract
now governs Today, Dashboard, Approvals, and Results refreshes.

Five focused scheduler and conversation-progress checks pass with changed-file
lint, TypeScript, diff validation, and the production build. Canonical production
is healthy at exact web revision
`bae9643f971af48e5589376e212c9cbfc4c65a48` under deployment
`dpl_BukULfvcBktDbuHa9VJV4wGSVNCQ`.

### 5. Plan and delivery log drift — corrected in the master checklist

The checklist previously left Phase 9 unchecked while saying P9.1–P9.19 were all
complete, and left Phase 13 unchecked while saying its slices were complete. The
detailed status said the opposite. The checklist now states the actual split:
P9.13 partial, P9.19 held, and P13 not started.

### 6. Retention failure — resolved and deployed

An expired approval with legitimate pre-approval output could not be redacted
because migration 92 required `OLD.output IS NULL`. Migration 175 now permits only
the exact approval-required to rejected/expired retention transition, preserves
identity and approval evidence, and still requires input, output, effect, and
reason redaction. The production sweep now returns 200 with no expired pending
approval left.

### 7. App Builder bounded source feedback — resolved and deployed

Indexed search sizes are preserved, excluded files cannot leak into search,
ranged reads are capped at 24,000 characters with truncation provenance, missing
sizes are not represented as zero, and model output-budget errors are actionable.

### 8. Private API cache boundary — resolved and deployed

The review found that `/api/auth/session` returned the authenticated actor/session
projection under Vercel's default `Cache-Control: public, max-age=0,
must-revalidate` response. The route now explicitly returns `private, no-store`
for every session state. The follow-up scan found that the common database request
wrapper also preserved any route's default or accidental public policy. The
wrapper now enforces the same private boundary for all 229 database-scoped API
route files, including errors and streams. The unwrapped Google login/callback and
managed browser transport receive the same protection; the intentionally public
versioned mobile-contract route remains cacheable.

Thirty-four focused database-wrapper, session, and unwrapped-route checks pass
with changed-file lint, TypeScript, diff validation, and the Vercel production
build. Canonical production returns the private policy for both session and
approval responses at exact web revision
`1608c2e650aeb1dc69b1129789fdb6a8c78cf41e`; the compatible protocol-1 worker and
Computer Use gateway remain healthy and required no rebuild.

## Pending product work already recorded by the implementation plan

1. Memory: the fail-closed offline activation scorer now exists, but a qualifying
   human-reviewed production-shadow sample must still pass before semantic prompt
   serving; outcome-weighted ranking, paraphrase/conflict classification, and
   automatic Mnemosyne execution remain separately gated. Memory Reviews now has
   a bounded actor-scoped collector plus a content-safe human review bench for
   sealed episode enrichments. The remaining operation is to collect and review
   24 cases across six conversations and all ten dimensions, add the separate
   retrieval-rank probe, and produce a qualifying gate result.
2. Trading: transcript-authoritative ICT ontology and promotions, false-positive
   review, asynchronous deterministic backtesting, consensus/surprise and regime
   conditioning, statistically defensible calibration, deeper XAU/USD history,
   and NDX time-series entitlement.
3. App Builder: complete the authenticated embedded-preview click-through, then
   prove a full Asael-repository change through verification, GitHub delivery,
   preview, and governed release.
4. Notifications/mobile: complete the real Android push/deep-link/ack receipt;
   decide whether the broader P9.13 web/email channels are still valuable for this
   private app before implementing them.
5. Payments: keep P9.19 disabled until reviewed live adapters and human-present
   evidence exist. No payment effect should be enabled merely to close the plan.

## Focused validation performed

- Voice realtime route, Meeting contracts, Today notifications, and mobile push
  store: 19/19 focused tests passed.
- App Builder source-feedback slice: 14 focused tests passed before deployment.
- Retention repair: 40 focused tests passed before deployment.
- Private API cache boundary: 34 focused wrapper and route checks passed before
  deployment.
- Embedded preview CSP/proxy: 5 focused checks passed before deployment; the
  authenticated visual restart remains pending because the workstation locked.
- Visibility-aware refresh: 5 focused scheduler and conversation-progress checks
  passed before deployment.
- Semantic memory activation gate: 4 focused scoring, undersampling, quality,
  leakage, latency, replay, and tamper checks passed; this operator-only harness
  does not change production runtime policy and was not deployed separately.
- Semantic shadow observability: 20 focused store, overview, and activation-gate
  checks passed before deployment; anonymous production access remains 401 with
  private/no-store caching.
- Semantic shadow collection: 27 focused collector, scheduler, thread-route, and
  job-projection checks passed with affected lint, TypeScript, diff validation,
  and the Vercel production build; canonical production serves exact revision
  `b73591b574060dec8a4fcd8801f38bc3d9a44667`.
- Semantic shadow adjudication: 39 focused gate, review, route, form, store, and
  job-projection checks passed with affected lint, TypeScript, diff validation,
  and the Vercel production build. Canonical web and the release-active Fly
  worker serve exact revision `74e4c05b875737a9050bd32c78c0adbad5019736`;
  anonymous review access is 401 with private/no-store caching.
- Changed-file lint, TypeScript, and diff validation passed for the deployed
  retention, App Builder, and session-cache changes; no full suite or broad audit
  was run.

## Recommended implementation order

1. Complete the authenticated App Builder preview click-through and prove one
   end-to-end Asael repo iteration in Build Studio.
2. Collect and adjudicate the bounded semantic episode sample in Memory Reviews,
   then run the separate retrieval-rank probe required by the activation gate.
3. Profile the next Command interaction after the deployed live-refresh repair,
   then extract only the measured hot boundary.
4. Close the Android notification receipt while a device is connected.
5. Decide P9.13 scope for a private app; implement only the selected web/email
   channels and preferences.
6. Continue memory evaluation gates, then the transcript-authoritative trading
   ontology and deterministic backtesting.
7. Incrementally extract domain repositories from `db/client.ts` as touched by
   feature work.

Phase 13 remains skipped.
