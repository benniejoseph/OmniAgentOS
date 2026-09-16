# Asael codebase review — current evidence

Date: 2026-09-15

Reconciled through: 2026-09-16

Reviewed baseline: `00c601c7e0416464ec621863b64e771e038fb975`

Latest reviewed feature revision: `e170412`

Branch: `performance-remediation`

This is the current review artifact. `docs/AUDIT_REPORT.md` and
`docs/DEEP_DIVE_REVIEW.md` remain historical snapshots from 2026-06-10 and do
not describe the present capability surface.

## Executive result

Asael is a working governed-agent platform. The bounded agent loop, governed
tools and approvals, durable workflows, typed events, source/RAG/memory planes,
Google Workspace access, media generation, Computer Use, Projects/App Builder,
market research, and private Android client are implemented. Phase 13 remains
intentionally excluded.

The original review's five recommended proof or implementation items are now
closed in code and, where applicable, on a physical device:

1. App Builder completed an authenticated Asael-repository iteration through
   verification, GitHub delivery, PR preview and route/log inspection.
2. The separate deterministic memory retrieval-rank probe is implemented. The
   human-reviewed activation sample remains deliberately open.
3. Command was profiled; the measured wait was sequential server hydration,
   not a browser long-task. Thread content now renders before latest-run
   hydration finishes.
4. Android received a real causal notification on a Samsung Android 16 device,
   opened its exact target, and persisted the delivery acknowledgement.
5. The private-app notification scope is now explicit: durable in-app delivery
   plus causal Android push are required; redundant background web push and
   notification email are excluded unless the owner later opts in.

The new trading backtest feature is implemented but remains research-only. The
current release batch must still install migration 177 and promote the paired
web/worker revision before it is production-complete.

## Inventory at the original review boundary

| Measure | Review snapshot |
|---|---:|
| Production TypeScript/TSX/Dart files | 1,683 |
| Production source lines | 560,916 |
| Test files | 683 |
| API route handlers | 233 |
| Client components | 57 |
| Database migrations | 72 |
| Git commits at review | 1,383 |
| Source TODO/FIXME/HACK/XXX markers | 0 |

These numbers are retained as the review baseline and were not recomputed as a
new broad audit. The owner explicitly requested focused implementation and
validation rather than repeated full-suite or inventory scans.

## Master-plan reconciliation

| Area | Built state | What remains |
|---|---|---|
| Phases 0–8 | Complete | No open implementation slice found in the task tables. |
| Phase 9 | P9.1–P9.18 complete for the selected private-app scope | P9.19 remains intentionally held for reviewed live adapters and human-present payment proof. |
| Phase 10 | Complete | Live Salesforce activation is external configuration, not a code gap. |
| Phase 11 | Complete | Continue operational freshness/convergence monitoring. |
| Phase 12 | Private Android scope complete | iOS and app-store publication are excluded by owner request. Install the v7 build when desired. |
| Phase 13 | Not started | Intentionally deferred/skipped. |

### P9.12 correction

Command voice is transcription-only and keeps an editable command draft. It
does not create Meeting media. Meeting capture has separate participant,
consent, recording, transcript and retention contracts. P9.12 is complete.

### P9.13 private-app scope decision

The original general-product wording requested in-app, web-push, email and
mobile delivery plus a broad preference matrix. Asael is a private application
for one owner. Its accepted scope is therefore:

- durable actor-private in-app notifications;
- quiet-hours deferral and exactly-once occurrence claims;
- read, snooze, dismiss and acted state;
- causal Android push with preview policy, exact deep links and delivery
  acknowledgement;
- global quiet-hours, lead-time and sensitive-preview preferences.

Background web push, notification email, and per-customer/source channel
matrices are explicitly deferred as redundant complexity for the current
private deployment. This is a documented scope choice, not a claim that those
unselected channels were built.

## Verified findings and remediation

### 1. Oversized server persistence boundary — remediation started

`src/lib/db/client.ts` remains an oversized maintenance boundary. The response
is incremental extraction behind exact tests, not a risky bulk rewrite. App
Builder repository persistence and the new market-backtest schema are now
separate modules. More domain extraction should happen only as those domains
are touched.

### 2. Command interaction wait — measured and repaired

The production interaction trace did not show a React long-task. Opening a
conversation waited for a sequential thread read and latest-run hydration.
Command now renders the selected thread as soon as its content arrives and
hydrates the run/trajectory independently. Stale responses are fenced, loading
states are independent, and the existing governed run/event contracts remain
unchanged. The earlier visibility-aware refresh coordinator continues to
serialize activity refresh and pause hidden tabs.

The 6,000-plus-line client boundary remains a maintenance risk. Future module
extraction should follow a new measured hotspot, not proceed mechanically.

### 3. App Builder end-to-end proof — complete

The CSP and authenticated sandbox proxy repair is complete. An exact
Asael-repository checkout was changed through Build Studio, passed fixed checks
and independent verification, produced GitHub PR #2, created a READY preview,
and exposed provider logs and route evidence. Desktop and mobile preview routes
were inspected. The repository and preview stay bound to exact revisions; the
governed production-release gate is unchanged.

### 4. Android causal notification proof — complete

A physical Samsung Android 16 device registered through the current native
session, received the real FCM message, opened the exact causal destination,
and wrote the acknowledgement receipt against the matching registration and
delivery. Quiet hours and hidden-preview policy were restored after the canary.
This closes the former P12 operational gate. iOS remains outside scope.

### 5. Semantic memory evaluation — mechanism complete, human gate open

Memory Reviews can collect actor-private sealed episodes and adjudicate exact
source, deterministic baseline, semantic output and quote support. A separate
deterministic rank probe now measures recall and first-relevant-rank deltas
without model calls, clock access, retrieval mutation or serving authority.
Probe inputs and outputs are content-free and digest bound.

What remains is human evaluation, not missing code: review at least 24 cases
across six conversations and all ten declared dimensions, attach genuine rank
observations, and run the existing fail-closed activation scorer. Until that
sample passes, deterministic summaries remain authoritative and semantic
enrichments cannot enter prompts or durable truth.

### 6. Deterministic asynchronous market backtesting — implemented

The reviewed foundation strategy is
`foundation.liquidity_sweep_reversal.v1`: trade beyond the exact prior 20-bar
boundary, close back inside, and enter on the next bar. The engine is bound to
an immutable price snapshot and applies explicit spread, slippage and
commission, fixed-fraction risk, stop-first same-bar collision, one-position
overlap policy, and chronological 60/20/20 train/validation/test slices. It
makes no model, network or future-data call inside replay.

Migration 177 adds forced-RLS actor-private append-only backtests and typed
completion events. Runs queue through the governed operation worker, publish
bounded progress, and save immutable result hashes. Web and Android expose the
same practical lab and ledger; Android uses native contract v7 while frozen v6
remains the supported compatibility version.

This is hypothetical retrospective research, not a trading recommendation or
execution path. Advanced OB, MSS, Turtle Soup, Unicorn and Judas Swing rules
remain excluded until transcript-authoritative definitions pass review.

### 7. Earlier high-severity findings — closed

- Retention migration 175 repaired the exact expired-approval redaction case.
- App Builder source reads are bounded, exclusion-aware and provenance labelled.
- Private authenticated API responses enforce `private, no-store` through the
  common database request wrapper and reviewed unwrapped routes.
- Live refresh is visibility-aware and non-overlapping.
- Phase and delivery-log contradictions were corrected rather than papered over.

## Focused validation performed for the reconciliation batch

- Semantic retrieval-rank probe and activation contracts: 20 focused checks,
  affected lint and TypeScript passed.
- Deterministic backtest engine: three focused engine cases passed.
- Backtest migration/store/client manifest: 36 focused checks passed.
- Governed backtest queue, routes, tools and worker dispatch: 35 focused checks
  passed.
- Android native v7 compatibility and mutation boundary: 10 focused web checks,
  native artifact drift check, Flutter analyzer and three generated-contract
  checks passed.
- Affected TypeScript and diff validation passed for each committed feature
  slice. No broad audit or full test suite was run.

## Honest remaining work

1. **Human memory activation sample:** collect and adjudicate 24 real cases over
   six conversations and ten dimensions, then run the rank and activation gates.
2. **Transcript-authoritative trading knowledge:** ingest the owner's lawful ICT
   transcripts, review ontology definitions and timecodes, and promote only
   measured detectors with false-positive evidence.
3. **Market evidence depth:** add a reviewed consensus/surprise source, regime
   conditioning and enough resolved forward-shadow observations for defensible
   calibration. Backfill deeper XAU/USD history within provider limits. The
   current Twelve Data entitlement still blocks exact NDX time series; never
   substitute QQQ, NQ or a broker CFD and call it NDX.
4. **Maintenance extraction:** continue moving touched domain repositories out
   of `db/client.ts`; split Command only after another trace identifies a real
   hot boundary.
5. **Payments:** keep P9.19 disabled until live adapters and a human-present
   signed mandate/receipt flow are reviewed and proven.

## Recommended next order

1. Finish the real human memory sample and activation decision.
2. Ingest and review ICT transcripts before expanding strategy rules.
3. Add consensus/regime market evidence and grow the forward-shadow dataset.
4. Continue incremental persistence and measured Command maintenance work.
5. Leave P9.19 disabled and Phase 13 skipped.
