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

The checked-in suite does not claim that Asael currently produces the expected
observations. Observation envelopes bind to the exact domain-separated suite
digest and declared scorer version. Scoring-code changes must bump that version;
the digest does not hash source code. Category adapters and a digest-bound
observed baseline will be added in
later narrow batches. Until that baseline is explicitly recorded,
P0.5 remains open. Normative expectations must never be copied into the
observed baseline merely to make it pass.
