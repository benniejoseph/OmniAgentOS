# Retired boundary review — 26 October 2026

The three registry entries that expired on 17 October remain intentionally
retained until 25 November. Their deletion criteria require 30 days without
requests. No such production request-count evidence was available during this
source review, and elapsed calendar time does not establish zero usage. The
registry's expiry enforcement and original exit metrics remain in place.

The reviewed files are unchanged from release `11079f42`. This decision does
not restore the retired browser or request-bound migrations.

| Entry | Current source evidence | Decision and required evidence |
| --- | --- | --- |
| `isolated-browser-retired-routes` | The seven takeover, activity, snapshot, frame and profile handlers still return a small explicit `410 isolated_browser_retired` response. There is no active browser implementation behind them. | Retain the retirement response until hosting request evidence covers every route for a complete 30-day interval with no callers. Then remove the handlers and their tests together. |
| `isolated-browser-retired-targets` | The agent input schema still recognizes `isolated_browser` specifically to reject it without retargeting to the user's Mac. Saved continuation handling in `src/lib/orchestration/agent-runner.ts` rejects that target, and `src/lib/runs/store.ts` refuses to revive it. Connector discovery/review also reject the retired connector. | Preserve these caller and saved-state boundaries. Before narrowing the request enum/connector kind, obtain the 30-day request evidence and inspect retained/resumable legacy records; retain any decoder needed to reject old state explicitly. |
| `request-bound-migrations-retired` | The migrations POST still authenticates/authorizes system callers before returning `410` with the dedicated release-migrator instruction. It contains no migration execution. The public native contract advertises a GET operation, which is not proof that no older caller sends POST. | Keep POST's explicit retirement behavior until a 30-day method-specific request report confirms no caller. Remove only the retired POST handler after that review; migration execution must remain confined to the release procedure. |

The next review must record the actual evidence interval and its coverage. A
missing report is not a successful exit metric. Any further retention needs a
new recorded decision; the existing test will fail again at the review deadline.

This review performed source inspection only. No production access, telemetry
changes, scheduled monitor, route removal or new release authority was added.
