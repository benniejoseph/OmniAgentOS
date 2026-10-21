# Asael 1.39.1 (114): principal reliability repair

This repair closes gaps found in the October 21 architecture review across the shared web/server and Flutter clients. The main user-facing requirement is that accepted work remains saved and observable across network failures, window changes and delayed notifications.

## Release scope

- Pending native prompt operations use a separate encrypted durable document, outside the evictable read cache. Existing saved operations migrate before use; no claim is made that previously evicted data can be recovered. Concurrent engines must serialize each document mutation and retain stable request keys.
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

No database migration or native API contract change is planned; schema 260 and contract 60 remain in use. Use the paired release procedure for web and worker, retain the prior signed Mac app and Android signer, and update Android with a data-preserving install. Do not uninstall the user's app to overcome an installation failure.

Before promotion, retain focused behavioral checks and real isolated PostgreSQL evidence. Verify pending work persistence, cross-engine session invalidation, Share-capacity retention, delayed alert rejection and status following. Native package verification and device-level notification/navigation checks are separate evidence; unit checks do not prove OS delivery. Keep the Release Timeline stopped and the user's keep-awake process running.

The compatibility test database is loopback-only, uses a non-superuser/non-BYPASSRLS role, and must not be substituted with a production URL. Existing production watches and fictional Continuity records must not be reset or forced to generate validation evidence.

## Separate credential migration

The frozen Mac credential broker v2 is deliberately unchanged. Its exact signature owns existing Keychain ACLs, so enabling hardened runtime by re-signing it is not a compatible repair. A v3 transition requires an owner-bound migration, verified secret copy, revocation-safe rollback and removal of the old credential access path. The [migration design](../macos-credential-broker-v3-migration.md) tracks that work; this release must not be described as fixing that broker hardening finding.

## Release evidence

Root-owned evidence is retained under `/Volumes/Extreme Pro/Asael-agent-reviews/2026-10-21-principal-repairs`. Focused evidence includes 36 backend regressions, three real isolated PostgreSQL scenarios under forced tenant RLS, 47 web regressions, and 55 Android/shared storage and notification checks. Platform-specific reports record the exact commands, additional Mac checks and verification limits.

The headless Chrome composer scenario in `tests/browser/command_uploads.py` uses real isolated authentication and intercepted synthetic uploads. A successful first file remains attached when the second returns 503; retry submits only the second with its original key. Both become ready through exact Library reads, with no extra command-catalog request or browser error. Evidence and screenshots are in `evidence/browser-uploads`.

Fill the exact release revision, live URL and package/device results after successful paired deployment. Preparation or a successful local build is not production verification. Historical release-admission failures remain recorded separately and must not be hidden by changing counters or creating successful runs to dilute them.
