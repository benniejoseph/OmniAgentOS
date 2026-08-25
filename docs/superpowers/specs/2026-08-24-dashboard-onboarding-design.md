# Dashboard-Based Onboarding Redesign

**Date:** 2026-08-24  
**Status:** Approved for implementation  
**Product model:** Private single-owner workspace

## Context

OmniAgent currently sends every authenticated login to `/onboarding`. That page presents five activation checks, fetches broad capability statistics, includes the public header and demo CTA, and supports an unauthenticated sample state.

This behavior no longer matches the private-owner product:

- returning sessions are repeatedly sent through first-run content;
- memory, connectors, and evaluations are useful readiness steps, not prerequisites for opening the workspace;
- the dedicated page separates setup guidance from the surfaces where the work happens;
- the public framing and sample state conflict with private account access;
- the checklist is useful, but the route should not gate normal operation.

The authenticated dashboard already provides the stable workspace overview, a primary “Start task” action, run history, attention items, results, and empty states. It should become the post-login destination and host contextual setup guidance.

## Goals

1. Send successful and already-authenticated logins directly to `/app`.
2. Make setup guidance contextual to the authenticated dashboard rather than a mandatory page.
3. Preserve the useful identity, knowledge, connector, first-run, and evaluation checks.
4. Keep the setup card prominent until the first successful run, then reduce it to a compact reopen control.
5. Let the owner dismiss the expanded card early without permanently losing access to readiness details.
6. Avoid adding readiness work to the dashboard’s recurring live-refresh loop.
7. Remove public onboarding framing and links.

## Non-goals

- Changing authentication, cookies, roles, or session APIs.
- Making memory, connectors, or evaluations mandatory before agent work can begin.
- Adding a multi-step wizard, product tour, celebration flow, profile collection, or billing.
- Adding a database schema or server-persisted onboarding preference.
- Redesigning the rest of the authenticated dashboard.
- Changing the existing run, workflow, connector, memory, or evaluation data models.

## Product Decision

The dedicated onboarding page is not required.

`/app` becomes the stable destination for first-time and returning sessions. The onboarding checklist becomes a dashboard readiness card that:

- appears expanded while no successful run exists;
- may be dismissed for the current browser;
- automatically collapses after the first successful run;
- always retains a compact “Setup & readiness” control for reopening;
- never blocks dashboard content or actions.

The first value moment is a successfully completed agent run or workflow. Setup guidance exists to support that outcome, not delay it.

## User Journey

### Successful sign-in

1. The owner submits valid credentials.
2. Login replaces the route with `/app`.
3. The dashboard renders immediately using its existing session and workspace-summary behavior.
4. Readiness loads independently and does not block run data or the “Start task” action.

### First-use dashboard

When no agent run or workflow has completed:

- the readiness card appears expanded below the dashboard summary;
- it shows completed checks as a count and text status;
- the primary action is **Start first task**;
- each setup check links to the surface where it can be completed;
- **Dismiss for now** collapses the card for that browser.

### Returning dashboard

After at least one successful agent run or workflow:

- the expanded card no longer appears automatically;
- a compact **Setup & readiness** disclosure remains available;
- reopening it shows the latest check states and links.

### Partial or unavailable readiness

If readiness cannot load:

- the dashboard remains fully usable;
- the compact card reports that setup status is partially unavailable;
- a retry action refreshes readiness only;
- previously loaded readiness remains visible while refreshing.

## Readiness Checks

The card retains five checks with clearer action-oriented labels:

1. **Workspace identity**  
   Complete when an authenticated or configured local workspace context exists. Links to `/app/settings`.

2. **Knowledge or memory added**  
   Complete when tenant-scoped memory or knowledge contains at least one item. Links to `/app/memory`.

3. **Connector active**  
   Complete when at least one MCP or OpenAPI connector is active. Links to `/app/connectors`.

4. **First task completed**  
   Complete when an agent run or workflow has `completed` status. Links to `/app/command`.

5. **Readiness evaluation recorded**  
   Complete when at least one evaluation exists. Links to `/app/evaluations`.

The card reports both `completedCount / totalCount` and readable item states. Color and icons are supplementary, never the only signal.

## Information Architecture and Routing

- `src/components/onboarding/login-form.tsx`
  - Replace both authenticated redirects from `/onboarding` to `/app`.
- `src/app/onboarding/page.tsx`
  - Replace the page UI with `permanentRedirect("/app")`.
- `src/components/onboarding/onboarding-console.tsx`
  - Delete after its readiness logic has been replaced.
- `src/components/marketing/docs-guide.tsx`
  - Remove “Start onboarding” and public `/onboarding` links.
  - Point workspace-entry guidance to `/login` and authenticated operating guidance to `/app`.
- `/onboarding`
  - Remains as a compatibility URL returning a permanent redirect to `/app`.

No onboarding item appears in public navigation.

## Component Design

### `WorkspaceReadinessCard`

Create a focused authenticated component under `src/components/app-shell/`.

Responsibilities:

- render expanded, compact, loading, refreshing, partial-error, and ready states;
- accept readiness data rather than query unrelated dashboard resources itself;
- expose **Start first task**, item links, **Dismiss for now**, **Retry**, and reopen controls;
- persist only the browser-level compact preference;
- clear the temporary compact preference when the owner explicitly reopens the card.

It must not own session authentication or dashboard live polling.

### Dashboard integration

`DashboardOverview` places the readiness card after the summary/metrics section and before source notices and activity panels.

Readiness loads once after the workspace session becomes available. It refreshes only when:

- the component first becomes eligible;
- the owner chooses **Retry** or **Refresh setup**;
- the owner reopens a card whose state has not yet loaded.

It is not included in the existing 8-second active-run polling loop.

### Browser preference

Use one versioned local-storage key:

`omniagent.workspace-readiness.compact.v1`

The value records only whether the owner chose **Dismiss for now**. It contains no identity, tenant, capability, or operational data.

The server-derived first-successful-run state always takes precedence and collapses the card regardless of browser preference.

## Data Contract

Add a narrow authenticated endpoint:

`GET /api/workspace-readiness`

Response:

```json
{
  "generatedAt": "2026-08-24T00:00:00.000Z",
  "checks": {
    "identity": true,
    "knowledge": false,
    "connector": false,
    "firstRun": false,
    "evaluation": false
  },
  "completedCount": 1,
  "totalCount": 5,
  "firstSuccessfulRun": false
}
```

The endpoint:

- resolves the existing tenant-scoped security context;
- computes only the statistics required for these five checks;
- runs independent store reads concurrently;
- returns `private, no-store`;
- exposes booleans and aggregate counts only;
- does not return connector details, prompts, results, secrets, or cross-tenant data.

Extract readiness calculation into a pure library function so check semantics can be unit-tested without rendering or database access.

## Error Handling

- A failed readiness request does not change dashboard resource states.
- Abort in-flight readiness requests on unmount or replacement refresh.
- Preserve the last successful readiness payload during refresh.
- Use one inline `role="alert"` only for a terminal readiness-load failure.
- Retry does not refresh runs, incidents, approvals, or workflows.
- A missing optional setup item is an incomplete state, not an error.

## Accessibility

- The card uses an `h2` beneath the dashboard’s existing `h1`.
- Expanded and compact controls have explicit accessible names and at least 44 CSS pixel targets.
- Progress is announced as text, for example “2 of 5 readiness checks complete.”
- Check state uses visible text in addition to icon and color.
- Loading and refresh updates use restrained `aria-live` status messaging.
- Focus remains on the control used to expand, collapse, dismiss, or retry.
- Keyboard order follows the visual order.
- Existing light, dark, high-contrast, and reduced-motion behavior remains intact.

## Responsive Behavior

- At 320 CSS pixels, the card is single-column with full-width primary and secondary actions.
- Check labels wrap without horizontal scrolling.
- At tablet widths, checks may use two columns.
- Desktop may show progress summary beside actions, but DOM order remains summary, checks, actions.
- The compact state remains one readable row and wraps safely on narrow screens.

## Performance

- Do not reuse the broad `/api/capabilities` response.
- Fetch the narrow readiness resource once per dashboard visit, not on every live refresh.
- Keep the readiness component in the existing client boundary; add no dependency.
- Do not delay dashboard summary, activity, or primary action rendering on readiness.
- Preserve current dashboard and release performance budgets.

## Testing Strategy

### Unit tests

- Readiness calculation maps store aggregates to all five checks.
- A completed agent run or workflow sets `firstSuccessfulRun`.
- Incomplete optional setup remains a successful response.
- Tenant and authorization handling follow existing API patterns.
- Public-surface contracts contain no `/onboarding` account-entry links.

### Browser tests

- Valid login lands on `/app`.
- An already-authenticated `/login` visit replaces to `/app`.
- `/onboarding` returns a permanent redirect to `/app`.
- No completed run shows the expanded readiness card.
- A completed run shows the compact readiness control.
- Dismiss and reopen behavior persists for the current browser.
- Readiness failure leaves dashboard actions and run data usable.
- Expanded and compact states have no horizontal overflow at 320 CSS pixels.
- Keyboard focus, labels, and theme behavior remain valid.

### Release checks

- Run focused readiness unit and Playwright tests.
- Run `npm run verify`.
- Run the affected authenticated smoke path before deployment.

## Acceptance Criteria

1. Successful and existing-session login paths end at `/app`.
2. `/onboarding` permanently redirects to `/app`.
3. No public page presents onboarding as account entry.
4. The dashboard remains usable before readiness finishes loading.
5. The expanded card is prominent only before the first successful run unless manually reopened.
6. A compact readiness control remains available after completion or dismissal.
7. All five readiness checks are tenant-scoped and use aggregate data.
8. Readiness does not join the dashboard’s recurring live-refresh loop.
9. Failure, loading, retry, keyboard, theme, and 320px states meet existing quality standards.
10. No authentication, authorization, storage schema, or operational workflow contract changes.
