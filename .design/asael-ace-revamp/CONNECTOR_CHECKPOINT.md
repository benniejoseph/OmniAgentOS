# Connector checkpoint and resumed delivery — 5 October 2026

## Resumed after accepted UI/ATLAS

PR63 passed all sixteen hosted checks and merged as `561de1e30af3d2407a11fec9bbbe2cc93499c360`. Its exact reviewed ATLAS assets and verified private Mac56 package complete the current UI/ATLAS implementation and build checkpoint. Production promotion remains dependent on the operator environment; the installed app is unchanged.

`codex/native-connector-release` starts from that accepted main and replays only checkpoint `ba468e7f9cdeb18da84ba8dc78fd4c05dbe5074f`. The original `codex/native-connector-controls` branch remains preserved. Two earlier branch commits were already patch-equivalent to accepted main and were not replayed.

The implementation reconciles the seven added operations into native v40 while freezing accepted Search v39, completes the native Google review/action/recovery flow and stabilizes the authored MCP/OpenAPI controls. Google controls review one exact account, authorization generation and permitted source set before sync/disconnect. Protected intent storage precedes dispatch; uncertain results recover by exact GET without repeating the provider action. Both controllers permanently close and clear private state on authority loss, fence replaced/hidden lifetimes and preserve a competing window’s pending intent during receipt save. OAuth changes remain an explicit browser handoff. App `1.23.22+57` preserves the greeting and all HELD01 asset registrations. Migrations 236–237 retain their existing identity; no migration 238 is introduced. The resumed source passes full Flutter analysis, fifty focused native cases, fifty-two contract/authorization/isolation cases, changed-TypeScript lint and native artifact generation/check. Three deferred-repaint assertions were corrected to pump the actual mounted panel while retaining notification and private-content-removal checks; the complete Google rerun passes. The original eight PostgreSQL cases remain historical checkpoint evidence, not a fresh candidate result. Private build and exact-head hosted release gates remain next.

## Historical 4 October checkpoint

The owner prioritized the UI revamp and ATLAS at this point. Connector expansion was deferred and preserved in `codex/native-connector-controls`; the following evidence describes that historical source, not acceptance of the resumed release.

## Implemented at this checkpoint

- Google personal action review, exact full-source sync and disconnect admission, immutable acceptance and GET-only recovery: backend/API authored. Native strict parsing is authored; repository, controller, protected store, providers and view remain pending. The incomplete native Google entry is unwired.
- MCP/OpenAPI listing, exact contract review, contract approval and MCP enable/disable: backend/API and first native screen/controller/recovery authored. Native source has not yet passed a complete analyzer/build gate.
- Initial native contract39 publishes seven operations and two capability floors; app version1.23.13+48. Previous38 and archived37 are byte-frozen.
- Migrations236–237 are stamped and registered. All8 focused serving-role PostgreSQL cases passed; all237 migrations and263 tenant tables verified on a disposable database.

## Preserved unfinished work

Connector lifecycle, registration/import, credential preparation and extended settlement prototypes use explicit Future schema exports only. There is no238 migration, persistence, provider execution or published route for those prototypes. Credential rotation/removal, registration/import, rediscovery, conditional GitHub upgrade and exact Trash remain pending. No external credentials or live provider effects were used in validation.

Next route generation and the complete TypeScript check pass after narrow control-flow/fixture typing corrections. Native formatting, analysis/build and further validation remain before resuming publication. This is a recoverable development checkpoint, not a completed release.
