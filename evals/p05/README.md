# P0.5 offline truth-regression lane

This directory defines a bounded, synthetic-only regression contract for the
truth and safety properties in master-plan row P0.5. It is deliberately
separate from both live model evaluation and the governed operational suite.
Loading or scoring this lane must not call a model, network, database, tool,
connector, filesystem ledger, clock, locale, or environment-derived input.
The schema requires the `synthetic` classification, `none` side-effect policy,
`synthetic:` execution-scope namespace, and `evaluation.p0_5.*` purpose. Those
declarations do not automatically detect private data hidden in free text, so
new fixture content still requires review before acceptance.

`suite.v1.json` is normative. Its 16 initial cases establish exact structural
expectations for all ten required categories:

| Category | Initial contract cases |
|---|---|
| Scope | `scope.boundary-matrix`, `scope.mismatch-fails-closed` |
| Pagination | `pagination.mid-page-failure-retry` |
| Update/delete | `update-delete.tombstone-blocks-stale-resurrection` |
| Retry | `retry.ack-lost-exactly-once` |
| Intent routing | `intent-routing.portfolio-blog-automation`, `intent-routing.ambiguous-delete-clarifies` |
| Context selection | `context-selection.explicit-empty-wins`, `context-selection.explicit-allowlist-wins` |
| Citations | `citations.valid-id-wrong-claim`, `citations.full-material-support` |
| Temporal questions | `temporal.as-of-selects-valid-interval` |
| Approvals | `approvals.material-change-invalidates`, `approvals.exact-binding-permits-governed-effect` |
| False completion | `false-completion.legacy-completed-is-unverified`, `false-completion.verified-live-positive-control` |

Every case carries an explicit synthetic tenant, initiating actor, executing
principal, purpose, correlation ID, and grants. Assertions are ANDed exact
checks over safe RFC 6901 JSON pointers. A missing case, extra case, failed
assertion, scope leak, duplicate/lost item, duplicate/unapproved effect, stale
resurrection, or false success is a failure; this lane has no warning state.

`baseline.v1.json` is the first digest-bound current-system observation. Run
`npm run check:p05-baseline` to reproduce it from the side-effect-free adapters
in `src/lib/evals2/p05-observer.ts`. The initial result is intentionally red:
3 of 16 cases pass (1,875 basis points). Tenant mismatch, canonical source
ordering, and legacy false-completion behavior are directly observable. The
remaining unsupported probes fail closed as `not_observable_offline`; the
scope boundary probe also records the current tenant-only compatibility read,
including its actor-isolation gap. This is evidence of the present system, not
a release pass.

Observation envelopes bind to the exact domain-separated suite digest and
declared scorer version. Scoring-code changes must bump that version; the digest
does not hash source code. Each remaining category must gain a real
side-effect-free system adapter in a later narrow batch. P0.5 remains open
until those adapters and the per-phase regression gates exist. Normative
expectations must never be copied into the observed baseline merely to make it
pass.
