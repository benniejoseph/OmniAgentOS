# Connector checkpoint and UI/ATLAS delivery priority — 5 October 2026

**Current execution status — 5 October 2026:** [UI and ATLAS delivery status](CURRENT_STATUS.md) records accepted PR72, the two bounded native UI corrections, the parked OpenAPI candidate, and release prerequisites. The dated sections below retain their original checkpoint evidence.

## Earlier checkpoint

The release baseline for this follow-up is **PR71**, preserving UI/ATLAS work through
PR69 and completing native MCP registration v44. All sixteen hosted checks passed
on `7920391138389f235988626c949d66e6a6f4ed89`, including **2,272 Flutter cases**,
and merged main is `f7a3157291af0d0d6c2c9964cfc9c165e58940b3`. Accepted and merged
full trees match. Fresh main Native and Secret Scan have passed. Main CI passed quality, build,
integration and the four browser-family jobs but failed the compact-dock
reserved-space assertion at 320px/200% text. The follow-up measures the dock
border box so wrapped labels reserve their actual height; final main provenance
remains pending a passing release revision.
The [acceptance receipt](</Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/pr71-acceptance.json>)
records the exact release boundary.

Private universal **Mac `1.23.28+64` / native44** is independently verified,
including strict nested private signatures and all 33 reviewed ATLAS files.
Package source `136ea7447824553b2052f638b43dbd220c0407d8` matches the accepted
head's 561 production Flutter files and 64 public inputs; the only Flutter
difference is the focused recovery-test scrolling correction. The
[package receipt](</Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/macos-native-mcp-registration-release/verification.json>)
does not claim Apple notarization, installation or application launch.

MCP registration supports all three existing auth modes and creates a disabled
local connection with zero discovered tools and no provider call. Private,
scope-bound preparation and receipt recovery remain exact; later discovery/review
uses the browser. Full Flutter analysis and 75 focused native cases pass, as do
131 focused TypeScript cases, changed-file lint and generated contract checks.
The disposable PostgreSQL run passes 160 cases, including 31 registration cases,
and verifies **241 migrations and 265 tenant tables**.

The final HELD01 component comparison passes **180 serial headless cases** across
neutral, poster and motion variants, both themes, 36/64/72/108/256px, DPR1/2 and
three repetitions. Its
[measurement receipt](</Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-held01-production-component/measurements-main71-r4/measurement.json>)
binds the main71 source plus the final lint-clean measurement harness. The
earlier main69/r3 result and its source-equivalence proof remain preserved.
These are observed load/DOM/control timings, not presented-frame, energy, physical
device or field-interaction certification.

The final code candidate `31a68aead25e5a310d6394f9140ce27224541dbb`
[route comparison](</Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-production-route-comparison-r2/comparison.json>)
passes all **42 unchanged route budgets** in both production-compiled variants.
Command first-load JavaScript is **912,874 bytes**, versus **907,198 bytes** for
the static-only player baseline: **5,676 additional uncompressed bytes**, within
the existing **920,000-byte** budget. Compile-mode evidence does not claim a full
release build, static generation, deployment or field performance. Capture is
799,931 bytes, within its unchanged 800,000-byte limit by 69 bytes. The dock
correction passes all 114 existing desktop/phone browser checks, including all
five keyboard destinations at 320px/200% with dock/reserved height both 144px.

UI/ATLAS delivery remains the priority. This follow-up adds the measurement harness, documentation and compact-dock
spacing fix. Local evidence passes; hosted acceptance is recorded in the external
release status. The web shell measures its actual dock
height on mount and resize, supports shrinking, and retains desktop zero reserve.
No native package/version or migration changes are introduced. Further connector expansion, including OpenAPI
registration/import, rediscovery and conditional GitHub upgrade, is parked.
Production promotion still requires the complete paired-release operator
environment; installation, physical device/power/energy, VoiceOver/audio and
broader pilot acceptance remain open. The installed app remains build42.
Unchecked whole-task and physical-device boxes retain their original criteria.

PR68 remains the accepted prior connector checkpoint: native43, migration240,
264 tenant tables and verified Mac62. The 81 catalog replay, 30 prior connector
and 18 credential-rotation serving-role cases passed at that checkpoint. The
accepted migration241 adds one isolated MCP registration-preparation table;
the fresh schema check verifies all 241 migrations and 265 tenant tables.

The detailed sections below retain their original implementation checkpoints.
The external [release status](</Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/ATLAS_RELEASE_STATUS.md>)
records current delivery evidence and operator dependencies.

## Historical resumption after accepted UI/ATLAS

PR63 passed all sixteen hosted checks and merged as `561de1e30af3d2407a11fec9bbbe2cc93499c360`. Its exact reviewed ATLAS assets and verified private Mac56 package complete the current UI/ATLAS implementation and build checkpoint. Production promotion remains dependent on the operator environment; the installed app is unchanged.

`codex/native-connector-release` starts from that accepted main and replays only checkpoint `ba468e7f9cdeb18da84ba8dc78fd4c05dbe5074f`. The original `codex/native-connector-controls` branch remains preserved. Two earlier branch commits were already patch-equivalent to accepted main and were not replayed.

The implementation reconciles the seven added operations into native v40 while freezing accepted Search v39, completes the native Google review/action/recovery flow and stabilizes the authored MCP/OpenAPI controls. Google controls review one exact account, authorization generation and permitted source set before sync/disconnect. Protected intent storage precedes dispatch; uncertain results recover by exact GET without repeating the provider action. Both controllers permanently close and clear private state on authority loss, fence replaced/hidden lifetimes and preserve a competing window’s pending intent during receipt save. OAuth changes remain an explicit browser handoff. App `1.23.22+57` preserves the greeting and all HELD01 asset registrations. Migrations 236–237 retain their existing identity; no migration 238 is introduced. The resumed source passes full Flutter analysis, fifty focused native cases, fifty-two contract/authorization/isolation cases, changed-TypeScript lint and native artifact generation/check. Three deferred-repaint assertions were corrected to pump the actual mounted panel while retaining notification and private-content-removal checks; the complete Google rerun passes. The original eight PostgreSQL cases remain historical checkpoint evidence, not a fresh candidate result. Private Mac57 is built and verified, with all 33 ATLAS assets exact. PR64 passed all sixteen hosted checks at `5a363991c103a122eee086247430f97da5b6b937`, including 2,113 Flutter cases, and merged as `b322fd5da7b2586650972f15213beff5125918c2`; accepted and merged full trees are identical. Application/native inputs equal the built source. Test-only corrections pass all 42 personal-sync cases, all 81 database integration cases and fresh verification of 237 migrations/263 tenant tables. Fresh main-revision hosted checks and paired-runner provenance passed on the exact merged revision.

## Historical exact native MCP credential removal — v41 stabilization

The next isolated slice adds review and explicit confirmation for removing one
configured app-managed MCP bearer credential. It reuses the existing exact
connector review, publishes only a dedicated submit and exact-receipt GET, and
keeps the v40 state-action schemas unchanged. Native v41 adds only the new
`connectors.credentials.remove` floor; v40 and v39 publications remain frozen.
App `1.23.23+58` retains the accepted UI and ATLAS assets.

Removal is local and atomic: disable the connector, clear its saved credential
and discovery metadata/tools, and record immutable acceptance, settlement and
events. The provider token remains valid until revoked with its provider.
Separate protected native intent storage and exact receipt recovery do not replay
an uncertain POST. Existing management, owner, review-generation and visibility
boundaries remain in force. Migration238 extends the existing receipt table;
credential entry/rotation, registration/import, rediscovery, GitHub upgrade and
Trash remain later work.

Normal restart recovery reopens the retained disabled connector and its dedicated
protected journal. The existing exact-connection ID entry also opens saved
recovery for a target deleted externally. There is no automatic inventory or
discovery of deleted target IDs in this slice; that recovery requires its known ID.

Artifact generation, its consistency check, 60 focused contract/authorization/route
cases and lint on all 19 changed TypeScript files pass. Fourteen disposable PostgreSQL
cases cover removal and legacy controls, including both event rollback paths,
exact-key retry, serving-role scope, cross-family identity and migration replay.
All 238 migrations and 263 tenant tables verify. Independent native and backend
source reviews found no actionable blocker. Full Flutter analysis and all 56
focused native cases pass across the focused runs, including existing connector
controls. The actual exact-ID entry exposed a shared PageStorage key collision;
the field now owns a controller/owner/kind-scoped key. Authority and missing-target
fixtures scroll lazy content into view while preserving their private-state and
GET-only recovery assertions. Private Mac58 was built from clean `632b867bfc25b8ef78886bb087d9352454e374ca`
and independently verified: universal executable, strict nested private signatures
and 33 exact ATLAS assets. DMG SHA256:
`975865e46db15c97a69edbc2046856d604f74499b725792d4dfd0c71e5c0c52a`.
The candidate is based on accepted PR64. Stabilization corrects the test transaction
adapter and identifies v208 constraint DDL by its own sentinel. All 81 database
integration cases and all 14 connector cases pass across the focused reruns;
the final 238-migration/263-table verification passes. The unpublished migration
uses a parser-safe multiline public checksum stamp; its replay fixture and registry
match. Exact public-fixture scanner exceptions preserve the existing scan rules.
Fresh exact-head hosted gates remain.
This is not production promotion.

At the UI/ATLAS priority checkpoint, this candidate was limited to stabilizing
the already implemented release and native Trash was parked separately. The
bounded Trash slice has since resumed on the accepted priority baseline as
described below. Credential rotation, registration/import, rediscovery and
GitHub upgrade remain separate unfinished work.

## Historical exact native MCP Trash — v42 candidate

The isolated Trash checkout is rebased onto the accepted priority baseline
`c0f495f1`. Source now declares native v42 with frozen v40/v41 archives and only
three new operations: manager-authorized exact Trash preview, confirmed MCP
submit and original-owner receipt GET. Capability `connectors.trash` starts at 42.
Migration 239 retains the shared immutable native ledger and prior family
validators, adding no tenant table. App `1.23.25+61` is the candidate package;
package verification, hosted acceptance and production promotion are not claimed
by this source checkpoint.

The move atomically retains the bounded private snapshot, removes the live
connector/tools and records Trash/native receipts. It never calls a provider.
The native family journal remains reachable without a live inventory row and
uses exact GET recovery after possible dispatch. Its receipt states the original
Trash ID and restore deadline without claiming current restore availability.
Vault-backed configuration restores disabled and unconfigured through a separate
browser review; a human must reconnect credentials.

The browser exact-ID selector reuses the authenticated item GET and existing
restore preview/confirmation, including an owned item beyond the first 100 list.
It binds owner, item digest, current read and preview selection independently of
list freshness. Hidden/replaced reads cannot authorize confirmation. Focused
source review rechecked archive pins and corrected a retained-render freshness
edge. The initial 67-case TypeScript run and the eight-case exact recovery rerun
passed, as did Flutter analysis and 90 focused native tests. All 16 Trash database
cases and migration 239 verification against 263 tables passed. Final lint for
all changed TypeScript/TSX files and generated-artifact verification passed. These focused checks do not
establish hosted acceptance, package verification, installation or production
promotion.

## Historical prepared MCP credential save/rotation — v43 implementation

The next isolated checkout starts from `9715812e`. Its five-operation native
publication covers existing-MCP credential preparation, exact preparation GET,
explicit original-owner abandonment, confirmed rotation and exact action GET.
The declaration keeps the reviewed endpoint/configuration unchanged; supported
targets include vault-backed and unconfigured `none` connectors, including a
configuration restored from Trash. Environment-auth conversion, registration,
import, discovery, enablement and provider revocation remain separate work.

Preparation carries a transient token only on its one-shot POST. The protected
journal holds safe intent/proof and separate preparation, abandonment and final
dispatch phases. Final dispatch uncertainty permits only original action GET
recovery. Null is not a terminal preparation result; explicit server abandonment
fences delayed preparation and supports active owners after management loss.
Consumed results carry the exact final action key. All mutations are v43-gated;
prior families retain their schemas and capability floors.

Migration 240 adds the staging table and bounded maintenance scrub. Fifteen
minutes bounds fresh consumption, not physical ciphertext cleanup during
outage/backlog. Local credential save remains disabled and requires subsequent
rediscovery/review. Source implementation and focused validation are in progress;
this checkpoint does not establish hosted, package or production acceptance.
The root validation checklist includes application-service coverage so the
architecture's 264-operation count follows the registry.

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
