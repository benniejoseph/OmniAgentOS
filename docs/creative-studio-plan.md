# Visual Studio implementation plan

Deliver an authenticated `/app/studio` workspace for saved image/video DAGs. Reuse the existing shell and semantic tokens, Capture assets/private downloads, owner-scoped model assignments and encrypted credentials, durable operation queue, actor-scoped database transactions and event/usage ledgers.

1. Shared versioned graph contracts, typed ports, central validation, deterministic prompt resolution, execution scope/dependency planning and semantic freshness. Cosmetic graph edits are excluded from execution identity.
2. Additive migration 261 stores owner/workspace/project flows, immutable run snapshots, attempts and recoverable provider output descriptors. Optimistic revisions prevent cross-tab overwrites. Queue admission and run persistence are atomic.
3. Provider adapters split submit, poll, cancel and normalization from asset ingestion. Reuse existing Google model routes; supply clearly labelled deterministic image/video fixtures using the same execution/storage path. Unknown submission outcomes never auto-submit again. Provider completion and cancellation intent remain separate.
4. React Flow canvas, keyboard/list alternative, graph-only undo/redo, conflict-aware autosave, capability inspector, explicit variation selection, templates, bound quote/limits, persistent activity/history and authorized original downloads. Existing Capture quick tools remain available.
5. Focused unit/contract tests, isolated durable database/worker scenarios, actual browser desktop/narrow/light/dark verification, and a coordinated live generation trial capped at the owner's authorized US$5. Unknown or unbounded pricing is not treated as a hard budget guarantee. Prepare one consolidated paired release with required health/auth/provenance/rollback checks.

Deferred: multiplayer editing, loops/arbitrary code, timeline compositor, voice cloning, scraping and social publishing. The Release Timeline remains stopped; existing unrelated watches are untouched.
