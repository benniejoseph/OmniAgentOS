# Asael 1.39.1 (114): principal reliability repair

This repair closes gaps found in the October 21 architecture review across the shared web/server and Flutter clients. The main user-facing requirement is that accepted work remains saved and observable across network failures, window changes and delayed notifications.

## Release scope

- Pending native prompt operations use a separate encrypted durable document, outside the evictable read cache. Existing saved operations migrate before use; no claim is made that previously evicted data can be recovered. Concurrent engines must serialize each document mutation and retain stable request keys.
- Prompt queue admission, replay and offline fallback keep the account and session that admitted the operation. A sign-in replacement cannot dispatch or acknowledge old work under new credentials; a late refresh response cannot overwrite replacement tokens. Ordinary refresh retains the same idempotency key and request bytes.
- Mac session protection is shared across engines. Lock state and session incarnation invalidate old caches, credential operations and window state. A new window receives current protection state before releasing private data.
- Shared Mac files remain staged until each file has a durable encrypted-outbox receipt. Full queues pause intake and resume on a meaningful capacity change. Watch clicks remain owner-bound until the destination acknowledges navigation.
- Routine disabled Mac control stops renewing device leases. Enabling the control retains its existing governed execution and readiness checks.
- Android local notification display is separated from best-effort receipt networking; registration reconciles after reconnect. Remote wipe must erase the native Listen store before acknowledgement, and recording status reads leave the main thread.
- Web partial uploads retain successful file receipts and retry an unconfirmed upload using the same key. Attachment readiness reads the exact Library asset instead of repeatedly loading the complete command catalog.
- Specialist status follows saved child and parent-continuation state, pauses while the page is hidden, and reconnects with backoff. A shorter UI timer no longer abandons a valid admitted execution.
- Watch expiry respects the requested last showtime. Existing watches derive this limit without rewriting immutable config digests. Delivery requires a future matching show; provider acceptance remains distinct from device receipt and opening.
- Watch delivery projections are batched under the exact owner and watch/opening pair. The 40-watch opening-bearing list uses three projection queries instead of 81, excluding unchanged authorization and transaction setup.
- Six unreachable UI components and their exclusive dependencies are removed. Results and Workflows import a standalone message/report renderer instead of the full Assistant workspace.

## Compatibility and verification

No database migration or native API version change is planned; schema 260 and contract 61 remain in use, with previous contract 60 retained. Bootstrap and compatibility-response schemas now validate the same exact supported-version list as discovery, including the already-advertised versions 59 and 58. Use the paired release procedure for web and worker, retain the prior signed Mac app and Android signer, and update Android with a data-preserving install. Do not uninstall the user's app to overcome an installation failure.

Before promotion, retain focused behavioral checks and real isolated PostgreSQL evidence. Verify pending work persistence, cross-engine session invalidation, Share-capacity retention, delayed alert rejection and status following. Native package verification and device-level notification/navigation checks are separate evidence; unit checks do not prove OS delivery. Keep the Release Timeline stopped and the user's keep-awake process running.

The compatibility test database is loopback-only, uses a non-superuser/non-BYPASSRLS role, and must not be substituted with a production URL. Existing production watches and fictional Continuity records must not be reset or forced to generate validation evidence.

## Separate credential migration

The frozen Mac credential broker v2 is deliberately unchanged. Its exact signature owns existing Keychain ACLs, so enabling hardened runtime by re-signing it is not a compatible repair. A v3 transition requires an owner-bound migration, verified secret copy, revocation-safe rollback and removal of the old credential access path. The [migration design](../macos-credential-broker-v3-migration.md) tracks that work; this release must not be described as fixing that broker hardening finding.

## Release evidence

Root-owned evidence is retained under `/Volumes/Extreme Pro/Asael-agent-reviews/2026-10-21-principal-repairs`. Focused evidence includes 36 backend regressions, three real isolated PostgreSQL scenarios under forced tenant RLS, 47 web regressions, and 55 Android/shared storage and notification checks. Platform-specific reports record the exact commands, additional Mac checks and verification limits.

The headless Chrome composer scenario in `tests/browser/command_uploads.py` uses real isolated authentication and intercepted synthetic uploads. A successful first file remains attached when the second returns 503; retry submits only the second with its original key. Both become ready through exact Library reads, with no extra command-catalog request or browser error. Evidence and screenshots are in `evidence/browser-uploads`.

Fill the exact release revision, live URL and package/device results after successful paired deployment. Preparation or a successful local build is not production verification. Historical release-admission failures remain recorded separately and must not be hidden by changing counters or creating successful runs to dilute them.

## Dependency repairs and release guard

The runtime dependency audit now reports zero vulnerabilities. MCP SDK 1.32.0 also receives the required explicit 256-element raw tool-input limit, while the existing 1 MB HTTP body cap, tenant authorization and governed execution remain intact. Hono is patched to 4.13.11. Mammoth stays at 1.12.1; a scoped argparse 2.0.1 override removes vulnerable sprintf-js and passes real DOCX library and CLI checks.

Compatible development-tool patches and a verified Tinypool 2.1.2 override remove the two critical findings without changing Vitest 3.2.7. The final full audit still reports eight development-only entries: five high entries from unpatched braces 3.0.3, and three moderate entries from the Vitest mocker advisory whose first fix requires Vitest 4.1.11. No unsupported Next ESLint downgrade or test-framework migration is included. The [dependency repair record](../dependency-security-2026-10-21.md) documents reachability, exact versions and remaining limits.

Focused dependency evidence includes 63 affected regressions, nine Mammoth compatibility checks, isolated Tinypool checks for both runtimes, and final Vitest fork/thread checks after the development patches. The existing route-JavaScript budget now runs as `postbuild` against the same assets, with duplicate explicit checks removed. It adds no extra Next build and retains the current budgets.

## Baseline checks and final session cases

The initial hosted quality run's 39 failed assertions and two import/mock failures reproduce on unchanged baseline `58646362` when only those failing cases run. Historical integration replay fixtures remove ledger entries only through schema 258 while the current schema is 260; their predecessor failures are retained separately. These are not passing checks and are not concealed by this release. The confirmed native rollout-schema mismatch and four missing watch diagnostic bindings are repaired here.

The final prompt-queue/session repair passes 58 focused document, authority, refresh and repository cases, including actual Dio interceptor races. On Android the incarnation fence is local to the foreground store; the current additional FCM engine reads credentials but never refreshes or persists them. Adding another authenticated writer engine will require a shared incarnation or credential compare-and-swap. Mac protection continues to use its shared native process fence.
