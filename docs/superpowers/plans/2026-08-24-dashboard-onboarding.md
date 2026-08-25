# Dashboard-Based Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mandatory onboarding with a non-blocking authenticated dashboard readiness card, send login to `/app`, preserve `/onboarding` as a permanent compatibility redirect, and deploy the verified release.

**Architecture:** A narrow tenant-scoped `/api/workspace-readiness` endpoint computes five aggregate checks through a pure readiness library. A focused client hook loads readiness once outside the dashboard’s live-refresh loop, while a dedicated card owns presentation and the browser-only compact preference. Existing login and onboarding routes become direct workspace entry paths.

**Tech Stack:** Next.js 16.3.1 App Router, React 19.2, TypeScript 5, Tailwind CSS 4, Vitest 3.2, Playwright 1.62, Vercel, Fly.io.

## Global Constraints

- `/app` is the stable destination for successful and already-authenticated login.
- `/onboarding` returns a 308 permanent redirect to `/app`.
- Readiness is advisory and never blocks dashboard actions or content.
- The expanded card collapses after the first completed agent run or workflow.
- Manual dismissal persists only in `omniagent.workspace-readiness.compact.v1`.
- A compact reopen control always remains.
- Readiness is tenant-scoped, returns aggregate booleans/counts only, and uses `private, no-store`.
- Readiness must not join the dashboard’s recurring 8-second live-refresh loop.
- No database schema, auth contract, role model, or new dependency.
- All interactive targets are at least 44 CSS pixels; 320px layouts have no horizontal overflow.
- Use `permanentRedirect` according to `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/permanentRedirect.md`.
- Use dynamic route handlers according to `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`.

---

### Task 1: Add the tenant-scoped readiness contract

**Files:**
- Create: `src/lib/workspace/readiness.ts`
- Create: `src/lib/workspace/readiness.test.ts`
- Create: `src/app/api/workspace-readiness/route.ts`

**Interfaces:**
- Produces: `WorkspaceReadiness`, `WorkspaceReadinessChecks`, `calculateWorkspaceReadiness(input)`, and `loadWorkspaceReadiness({ tenantId, identityReady })`.
- API: `GET /api/workspace-readiness` returns the exact `WorkspaceReadiness` JSON contract with `cache-control: private, no-store`.
- Consumes existing tenant-scoped stat functions from memory, knowledge, connectors, runs, workflows, and evaluations.

- [ ] **Step 1: Write the readiness calculation tests**

Create tests that prove each check and the first-successful-run rule:

```ts
import { describe, expect, it } from "vitest";
import {
  calculateWorkspaceReadiness,
  loadWorkspaceReadiness,
} from "@/lib/workspace/readiness";

describe("workspace readiness", () => {
  it("maps aggregate tenant stats to five readiness checks", () => {
    expect(calculateWorkspaceReadiness({
      identityReady: true,
      memoryTotal: 1,
      knowledgeTotal: 0,
      activeMcpConnectors: 0,
      activeOpenApiConnectors: 1,
      completedAgentRuns: 0,
      completedWorkflows: 1,
      evaluationTotal: 1,
    })).toMatchObject({
      checks: {
        identity: true,
        knowledge: true,
        connector: true,
        firstRun: true,
        evaluation: true,
      },
      completedCount: 5,
      totalCount: 5,
      firstSuccessfulRun: true,
    });
  });

  it("treats optional missing setup as incomplete rather than an error", () => {
    expect(calculateWorkspaceReadiness({
      identityReady: true,
      memoryTotal: 0,
      knowledgeTotal: 0,
      activeMcpConnectors: 0,
      activeOpenApiConnectors: 0,
      completedAgentRuns: 0,
      completedWorkflows: 0,
      evaluationTotal: 0,
    })).toMatchObject({
      completedCount: 1,
      firstSuccessfulRun: false,
    });
  });

  it("loads every aggregate for the requested tenant", async () => {
    const calls: string[] = [];
    const aggregate = async (tenantId: string) => {
      calls.push(tenantId);
      return 0;
    };
    const readiness = await loadWorkspaceReadiness(
      { tenantId: "tenant-a", identityReady: true },
      {
        memoryTotal: aggregate,
        knowledgeTotal: aggregate,
        activeMcpConnectors: aggregate,
        activeOpenApiConnectors: aggregate,
        completedAgentRuns: aggregate,
        completedWorkflows: aggregate,
        evaluationTotal: aggregate,
      },
    );
    expect(calls).toEqual(Array(7).fill("tenant-a"));
    expect(readiness.checks.identity).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test:unit -- src/lib/workspace/readiness.test.ts
```

Expected: FAIL because `@/lib/workspace/readiness` does not exist.

- [ ] **Step 3: Implement the pure contract and tenant loader**

Define the public shape and calculation:

```ts
export type WorkspaceReadinessChecks = {
  identity: boolean;
  knowledge: boolean;
  connector: boolean;
  firstRun: boolean;
  evaluation: boolean;
};

export type WorkspaceReadiness = {
  generatedAt: string;
  checks: WorkspaceReadinessChecks;
  completedCount: number;
  totalCount: 5;
  firstSuccessfulRun: boolean;
};

export function calculateWorkspaceReadiness(input: WorkspaceReadinessInput): WorkspaceReadiness {
  const checks = {
    identity: input.identityReady,
    knowledge: input.memoryTotal + input.knowledgeTotal > 0,
    connector: input.activeMcpConnectors + input.activeOpenApiConnectors > 0,
    firstRun: input.completedAgentRuns + input.completedWorkflows > 0,
    evaluation: input.evaluationTotal > 0,
  };
  return {
    generatedAt: new Date().toISOString(),
    checks,
    completedCount: Object.values(checks).filter(Boolean).length,
    totalCount: 5,
    firstSuccessfulRun: checks.firstRun,
  };
}
```

Implement `loadWorkspaceReadiness` with `Promise.all` over existing tenant-scoped stat functions. Read completed counts from `runs.byStatus.completed` and `workflows.byStatus.completed`; read active connector counts from each connector stat result. Keep dependency injection available to unit-test tenant propagation without database access.

Normalize the default store adapters behind this exact dependency boundary:

```ts
export type WorkspaceReadinessDependencies = {
  memoryTotal: (tenantId: string) => Promise<number>;
  knowledgeTotal: (tenantId: string) => Promise<number>;
  activeMcpConnectors: (tenantId: string) => Promise<number>;
  activeOpenApiConnectors: (tenantId: string) => Promise<number>;
  completedAgentRuns: (tenantId: string) => Promise<number>;
  completedWorkflows: (tenantId: string) => Promise<number>;
  evaluationTotal: (tenantId: string) => Promise<number>;
};
```

- [ ] **Step 4: Add the authenticated route handler**

Use the existing security and database-scope patterns:

```ts
import { withDatabaseRequestScope } from "@/lib/db/client";
import { loadWorkspaceReadiness } from "@/lib/workspace/readiness";
import {
  resolveSecurityContext,
  securityErrorResponse,
} from "@/lib/security/context";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  try {
    const context = await resolveSecurityContext(request);
    const readiness = await loadWorkspaceReadiness({
      tenantId: context.tenantId,
      identityReady: true,
    });
    return Response.json(readiness, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return securityErrorResponse(error);
  }
}
```

- [ ] **Step 5: Run focused and related tests**

Run:

```bash
npm run test:unit -- src/lib/workspace/readiness.test.ts src/lib/workspace/summary.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

Stage only the three Task 1 files and commit with:

```text
Add workspace readiness contract
```

---

### Task 2: Add the dashboard readiness experience

**Files:**
- Create: `src/components/app-shell/use-workspace-readiness.ts`
- Create: `src/components/app-shell/workspace-readiness-card.tsx`
- Modify: `src/components/app-shell/dashboard-overview.tsx`
- Modify: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: `WorkspaceReadiness` from Task 1 and `useWorkspaceSession()` from the existing app shell.
- Produces: `useWorkspaceReadiness({ enabled })` with `{ state, refresh }`.
- Produces: `<WorkspaceReadinessCard state={state} onRefresh={refresh} />`.

- [ ] **Step 1: Add failing dashboard browser coverage**

Add a Playwright test that mocks `/api/workspace-readiness` before `/app` loads:

```ts
test("dashboard presents dismissible first-run readiness without blocking work", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/workspace-readiness", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        checks: {
          identity: true,
          knowledge: false,
          connector: false,
          firstRun: false,
          evaluation: false,
        },
        completedCount: 1,
        totalCount: 5,
        firstSuccessfulRun: false,
      }),
    }),
  );
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Get your workspace ready" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start first task" })).toHaveAttribute("href", "/app/command");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.getByRole("button", { name: "Dismiss setup for now" }).click();
  await expect(page.getByRole("button", { name: "Open setup and readiness" })).toBeVisible();
});
```

Add a second test where `firstSuccessfulRun: true` starts compact, and a failed readiness response leaves the existing **Start task** action usable.

- [ ] **Step 2: Run the focused E2E and verify RED**

Run:

```bash
npm run test:e2e -- --grep "dashboard presents dismissible first-run readiness|dashboard keeps readiness compact after first success|readiness failure leaves dashboard usable"
```

Expected: FAIL because the endpoint consumer and card do not exist.

- [ ] **Step 3: Implement the isolated readiness hook**

The hook must:

- load only when `enabled` becomes true;
- abort replaced or unmounted requests;
- preserve prior data during refresh;
- expose `idle`, `loading`, `ready`, `refreshing`, and `error` states;
- fetch only `/api/workspace-readiness` with `cache: "no-store"`;
- never register with `useLiveRefresh`.

Use an exported discriminated union:

```ts
export type WorkspaceReadinessState =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: WorkspaceReadiness }
  | { status: "refreshing"; data: WorkspaceReadiness }
  | { status: "error"; error: string; data?: WorkspaceReadiness };
```

- [ ] **Step 4: Implement `WorkspaceReadinessCard`**

Use the five fixed item definitions:

```ts
const readinessItems = [
  { key: "identity", label: "Workspace identity", href: "/app/settings" },
  { key: "knowledge", label: "Knowledge or memory added", href: "/app/memory" },
  { key: "connector", label: "Connector active", href: "/app/connectors" },
  { key: "firstRun", label: "First task completed", href: "/app/command" },
  { key: "evaluation", label: "Readiness evaluation recorded", href: "/app/evaluations" },
] as const;
```

Behavior:

- initialize the manual compact preference after mount from `omniagent.workspace-readiness.compact.v1`;
- expand by default only when `firstSuccessfulRun` is false and the preference is absent;
- **Dismiss for now** writes `"1"` and focuses the compact reopen button;
- reopening removes the key, expands, and keeps focus on the disclosure control;
- completed or manually dismissed states retain the compact reopen control;
- error state uses one inline alert plus **Retry**;
- loading never hides or disables dashboard actions;
- controls use existing `primary-button`, `action-button`, and `action-link` styles where appropriate.

- [ ] **Step 5: Integrate below dashboard metrics**

In `DashboardOverview`:

```ts
const readiness = useWorkspaceReadiness({ enabled: workspaceAvailable });
```

Render the card after the summary section and before session/source notices. Do not add readiness to `load()`, `useLiveRefresh`, `isLoading`, `resources`, or the workspace summary request.

- [ ] **Step 6: Run focused E2E, typecheck, lint, and React review**

Run:

```bash
npm run test:e2e -- --grep "dashboard presents dismissible first-run readiness|dashboard keeps readiness compact after first success|readiness failure leaves dashboard usable"
npm run typecheck
npm run lint
```

Expected: PASS with no warnings.

Read and apply the React best-practices checklist before approval because this task changes multiple TSX/client-hook files.

- [ ] **Step 7: Commit Task 2**

Stage only the Task 2 files and commit with:

```text
Move onboarding readiness into dashboard
```

---

### Task 3: Retire mandatory onboarding and public entry links

**Files:**
- Modify: `src/components/onboarding/login-form.tsx`
- Modify: `src/app/onboarding/page.tsx`
- Delete: `src/components/onboarding/onboarding-console.tsx`
- Modify: `src/components/marketing/docs-guide.tsx`
- Modify: `src/components/marketing/public-surface.test.ts`
- Modify: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Successful and existing-session login navigation becomes `router.replace("/app")`.
- `GET /onboarding` returns 308 with `Location: /app`.
- Public source contracts prohibit `/onboarding` account-entry links.

- [ ] **Step 1: Update tests first**

Change the login expectation:

```ts
await page.getByRole("button", { name: "Sign in" }).click();
await expect(page).toHaveURL(/\/app$/);
```

Add redirect coverage:

```ts
const response = await request.get("/onboarding", { maxRedirects: 0 });
expect(response.status()).toBe(308);
expect(response.headers().location).toBe("/app");
await page.goto("/onboarding");
await expect(page).toHaveURL(/\/app$/);
```

Extend `public-surface.test.ts`:

```ts
expect(source).not.toContain('href="/onboarding"');
expect(source).not.toContain("Start onboarding");
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run test:unit -- src/components/marketing/public-surface.test.ts
npm run test:e2e -- --grep "local bootstrap authentication|retired onboarding redirects"
```

Expected: FAIL on the old `/onboarding` login destination and public docs links.

- [ ] **Step 3: Implement routing and copy cleanup**

Use the documented server redirect:

```ts
import { permanentRedirect } from "next/navigation";

export default function OnboardingPage() {
  permanentRedirect("/app");
}
```

Replace both login redirects with `/app`, remove public onboarding links/copy from Docs, and delete the unused `OnboardingConsole`.

- [ ] **Step 4: Refresh generated Next route types**

Run:

```bash
npx next typegen
```

Expected: route types regenerate without errors.

- [ ] **Step 5: Run focused and broad checks**

Run:

```bash
npm run test:unit -- src/components/marketing/public-surface.test.ts src/lib/workspace/readiness.test.ts
npm run test:e2e -- --grep "local bootstrap authentication|retired onboarding redirects|dashboard presents dismissible first-run readiness|dashboard keeps readiness compact after first success|readiness failure leaves dashboard usable"
npm run typecheck
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Stage only the Task 3 files and commit with:

```text
Retire mandatory onboarding route
```

---

### Task 4: Stamp local CLI releases with immutable revision metadata

**Files:**
- Modify: `scripts/deploy-production.mjs`
- Modify: `src/lib/release/deploy-production-script.test.ts`

**Interfaces:**
- Local `vercel deploy` receives the same `OMNIAGENT_RELEASE_SHA` used by Fly and smoke verification at build and runtime.
- Promotion and rollback ordering remain unchanged.

- [ ] **Step 1: Strengthen the dry-run regression test**

Require the Vercel deploy command to contain:

```ts
expect(commands[2]).toContain(
  "--env OMNIAGENT_RELEASE_SHA=test-release",
);
expect(commands[2]).toContain(
  "--build-env OMNIAGENT_RELEASE_SHA=test-release",
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test:unit -- src/lib/release/deploy-production-script.test.ts
```

Expected: FAIL because the Vercel command does not stamp revision metadata.

- [ ] **Step 3: Add per-deployment revision flags**

Change the deploy arguments only:

```ts
[
  "deploy",
  "--prod",
  "--skip-domain",
  "--yes",
  "--scope",
  VERCEL_SCOPE,
  "--env",
  `OMNIAGENT_RELEASE_SHA=${revision}`,
  "--build-env",
  `OMNIAGENT_RELEASE_SHA=${revision}`,
]
```

Do not change smoke, worker, promotion, or rollback behavior.

- [ ] **Step 4: Run focused tests and dry-run inspection**

Run:

```bash
npm run test:unit -- src/lib/release/deploy-production-script.test.ts
OMNIAGENT_RELEASE_SHA=test-release npm run deploy:production -- --dry-run
```

Expected: PASS; dry-run prints matching web, worker, and smoke revisions.

- [ ] **Step 5: Commit Task 4**

Stage only the two release files and commit with:

```text
Stamp local production release revisions
```

---

### Task 5: Integrated acceptance and guarded production deployment

**Files:**
- Verify all implementation files.
- Update: `docs/superpowers/specs/2026-08-24-dashboard-onboarding-design.md`
- Add: `docs/superpowers/plans/2026-08-24-dashboard-onboarding.md`

**Interfaces:**
- Verifies login → dashboard, dashboard readiness, compatibility redirect, release metadata, and production gates.

- [ ] **Step 1: Scan retired public onboarding references**

Run:

```bash
! rg 'href="/onboarding"|Start onboarding' src/components/marketing src/components/onboarding --glob '!**/*.test.ts'
```

Expected: exit 0 with no matches.

- [ ] **Step 2: Run focused unit and browser acceptance**

Run:

```bash
npm run test:unit -- src/lib/workspace/readiness.test.ts src/components/marketing/public-surface.test.ts src/lib/release/deploy-production-script.test.ts
npm run test:e2e -- --grep "local bootstrap authentication|retired onboarding redirects|dashboard presents dismissible first-run readiness|dashboard keeps readiness compact after first success|readiness failure leaves dashboard usable"
```

Expected: PASS.

- [ ] **Step 3: Run release-quality verification**

Run:

```bash
npm run verify
```

Expected: typecheck, lint, coverage, integration process, worker checks, operations checks, production build, and dependency audit exit 0. Report any skipped database integration tests explicitly.

- [ ] **Step 4: Confirm a clean immutable release**

Run:

```bash
git status --short
git rev-parse HEAD
```

Expected: no tracked or untracked release files remain outside pre-existing runtime artifacts; deployment source is committed at one exact SHA.

- [ ] **Step 5: Prepare a clean immutable deployment checkout**

The repository contains intentionally untracked planning/runtime artifacts, while the release script rejects every dirty source tree. Create an isolated clean checkout at the exact committed release SHA, install with the required Node 24/npm 11 runtime, and verify `git status --porcelain` is empty. Do not stash, delete, or deploy the owner’s untracked workspace artifacts.

- [ ] **Step 6: Run guarded production deployment**

Using the existing temporary secret-injection files and canonical URL:

```bash
set -a
source /tmp/omniagent-production.env
source /tmp/omniagent-vercel-bypass.env
set +a
BASE_URL=https://omniagent-os.vercel.app \
RELEASE_EVIDENCE_OUTPUT=/tmp/omniagent-release-evidence.json \
npm run deploy:production
```

Expected:

- existing release evidence passes;
- local verification passes;
- Vercel canary is built with the exact revision;
- Fly worker deploys with the same revision;
- staged security, tenant, evaluation, release-evidence, and performance checks pass;
- Vercel canary is promoted;
- canonical production preflight passes.

- [ ] **Step 7: Post-deploy verification**

Run canonical preflight and release evidence again, verify `/onboarding` returns 308 to `/app`, confirm the homepage and login remain public, inspect Vercel status, Fly worker health, and Vercel error logs from the last hour.

Expected: production reports the exact release SHA, all release gates pass, no new runtime errors appear, and the worker heartbeat/revision gate is healthy.
