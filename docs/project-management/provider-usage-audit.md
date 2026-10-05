# Provider operations review

Reviewed 6 October 2026 (IST). Account billing, detailed provider diagnostics and
access-control findings are private operator records outside this public
repository. The local task canvas and operator report hold the observed totals
and evidence. This document describes the repeatable review and follow-up scope.

## Measure before changing

- Verify the web and worker revision and health separately from individual user
  journeys. Filter error queries by deployment and time window; a capped log
  sample is not a complete error rate.
- Use authenticated billing exports and distinguish billed, effective and
  unallocated costs. Preserve the actual returned billing period and project
  scope. Do not present project-attributed usage as the full invoice.
- Compare automatic Git builds with explicit previews/releases. The prepared
  [build-on-demand control](build-cost-controls.md) removes redundant Git builds
  while preserving the governed CLI release path. Measure savings after adoption.
- Inspect database size, filesystem space, connection pressure and query counters
  with their reset times. A quiet snapshot is not a peak-load baseline.
- Take interval query deltas before tuning. Advisor notices about unused indexes
  and foreign keys are review inputs, not instructions to bulk-drop/create indexes.
- Trace stale scheduled callers before changing polling or credentials. Keep
  authorization and the existing worker backoff/retention boundaries intact.

[inspect-database-usage.sql](../../scripts/sql/inspect-database-usage.sql) performs
bounded, read-only catalog diagnostics. It qualifies Supabase statistics with
`extensions` because an operator search path may omit that schema. It returns no
SQL text, query parameters, tenant identifiers or customer rows and never resets
statistics. It requires the existing statistics extension and an authorized
operator role.

## Prioritized operational follow-up

1. Review whether the project needs Supabase's Data API. The application's own
   storage uses postgres.js, but repository inspection cannot rule out external
   consumers. Verify owner configuration before changing that service.
2. Review application-object ACLs and creating-role defaults. Intentional global
   tables are not automatically public tables; preserve pre-login lookup and
   explicit runtime/maintenance/backup permissions. Use a reviewed forward
   migration and isolated restore verification for changes.
3. Adopt build-on-demand and reconcile the remaining legacy callers. Keep one
   integration/release owner and verify required GitHub checks are enforced by
   platform rules, separately from the presence of CI workflow files.
4. Reassess storage retention and query performance after measuring a comparable
   interval. Preserve rollback artifacts, compatibility archives and audit history.

See the [current task queue](README.md) for owners and bounded estimates. This
review did not change production grants, Data API settings, billing plans,
indexes or retention policies. Application error-budget gates are separate from
provider quotas and billing limits.

## Official references

- [Vercel FOCUS billing export](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges)
- [Supabase billing scope](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Supabase usage summary](https://supabase.com/docs/guides/troubleshooting/understanding-the-usage-summary-on-the-dashboard-D7Gnle)
- [Supabase Data API and grant guidance](https://supabase.com/docs/guides/api/securing-your-api)
