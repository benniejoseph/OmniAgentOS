# Asael codebase review — current evidence

Date: 2026-09-15  
Reviewed revision: `00c601c7e0416464ec621863b64e771e038fb975`  
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

### 4. App Builder embedded preview — P2 functional defect

The project workspace can produce and open an authenticated sandbox preview, but
the embedded iframe is currently rejected by the browser. The UI therefore shows
a blocked-content panel even though the preview itself is available. The current
preview proxy forwards upstream response headers unchanged, while Build Studio
embeds the provider domain cross-origin.

Recommended change: capture the exact live `frame-ancestors`/`X-Frame-Options`
response first. If the provider edge forbids embedding, serve the preview through
a narrowly authenticated same-origin streaming bridge that strips only the
conflicting frame headers, applies Asael's own exact frame policy, bounds content
and redirects, and never exposes the preview token to the model or logs. Keep
Open preview as a fallback.

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

## Pending product work already recorded by the implementation plan

1. Memory: representative offline evaluation before semantic prompt serving;
   outcome-weighted ranking; paraphrase/conflict classification; automatic
   Mnemosyne execution remains gated.
2. Trading: transcript-authoritative ICT ontology and promotions, false-positive
   review, asynchronous deterministic backtesting, consensus/surprise and regime
   conditioning, statistically defensible calibration, deeper XAU/USD history,
   and NDX time-series entitlement.
3. App Builder: repair the embedded preview and complete a full Asael-repository
   change through verification, GitHub delivery, preview, and governed release.
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
- Changed-file lint, TypeScript, and diff validation passed for the deployed
  retention/App Builder changes; no full suite or broad audit was run.

## Recommended implementation order

1. Repair the embedded App Builder preview and prove one end-to-end Asael repo
   iteration in Build Studio.
2. Profile and split Command's client boundary around its hottest interaction,
   consolidating live polling/subscription behavior.
3. Close the Android notification receipt while a device is connected.
4. Decide P9.13 scope for a private app; implement only the selected web/email
   channels and preferences.
5. Continue memory evaluation gates, then the transcript-authoritative trading
   ontology and deterministic backtesting.
6. Incrementally extract domain repositories from `db/client.ts` as touched by
   feature work.

Phase 13 remains skipped.
