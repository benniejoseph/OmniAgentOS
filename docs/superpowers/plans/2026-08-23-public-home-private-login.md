# Public Home and Private Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OmniAgent’s public acquisition flow with the approved Omni adaptive marketing homepage and a single private-owner email/password login.

**Architecture:** Keep the public homepage and login shell server-rendered, with client boundaries limited to the existing navigation menu, theme control, health badge, and login state machine. Move homepage copy into a typed static content module, compose the page from focused marketing sections, permanently redirect `/signup`, and remove the unauthenticated access-request handler while preserving authenticated historical-request administration.

**Tech Stack:** Next.js 16.3 App Router, React 19 Server and Client Components, TypeScript 5, Tailwind CSS 4 semantic tokens, Lucide React, Vitest, and Playwright.

## Global Constraints

- Read `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`, `node_modules/next/dist/docs/01-app/03-api-reference/02-components/image.md`, and `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/permanentRedirect.md` before implementation.
- Keep email/password authentication, secure HttpOnly sessions, local-auth behavior, authorization, and the `/onboarding` handoff unchanged.
- Do not add registration, invitations, password recovery, social login, billing, public pricing, or a new authentication provider.
- Use existing semantic theme tokens; do not add hard-coded light-only colors.
- Green is the primary action and health color. Amber is reserved for attention, approval, and caution.
- Keep static marketing sections as Server Components. Add no client runtime for static content.
- Reuse `public/omniagent-command-center.webp`; it must remain at or below 204,800 bytes.
- Add no font, carousel, video, animation, or design-system dependency.
- Preserve budgets: LCP at or below 2,500 ms, INP at or below 200 ms, CLS at or below 0.1, and landing p95 at or below 1,500 ms.
- Maintain WCAG 2.2 AA contrast, visible focus, semantic landmarks, explicit labels, reduced-motion behavior, and interaction targets of at least 44 by 44 CSS pixels.
- Support 320 CSS pixels without page-level horizontal scrolling.
- Do not redesign authenticated application pages or secondary marketing pages beyond owner-only link and copy cleanup.
- Do not deploy as part of this plan.

## File Structure

### Create

- `src/lib/marketing-content.ts` — typed owner-only navigation, homepage facts, operating steps, capabilities, walkthrough, trust, FAQ, and CTA content.
- `src/lib/marketing-content.test.ts` — content-shape and owner-only action contracts.
- `src/components/marketing/public-surface.test.ts` — source-level regression contract preventing reintroduction of public signup links and intake references.
- `src/components/marketing/landing-hero.tsx` — outcome-led hero, CTAs, health, and optimized product frame.
- `src/components/marketing/landing-operating-story.tsx` — product facts, four-step operating loop, and capabilities.
- `src/components/marketing/landing-proof.tsx` — static walkthrough, trust controls, and native FAQ disclosures.
- `src/components/marketing/landing-cta.tsx` — private sign-in and demo close.

### Modify

- `src/app/page.tsx` — homepage metadata.
- `src/app/login/page.tsx` — private login metadata and simplified shell API.
- `src/app/signup/page.tsx` — permanent server redirect.
- `src/app/globals.css` — remove homepage-only scrim and rise animation styles no longer used.
- `src/lib/navigation.ts` — remove public pricing navigation data, replace sales-oriented pricing copy, and retire homepage content moved to the focused marketing module.
- `src/components/marketing/landing-page.tsx` — server composition of focused sections.
- `src/components/marketing/public-header.tsx` — one owner login CTA on desktop and mobile.
- `src/components/marketing/public-health-badge.tsx` — semantic light/dark styling and neutral failure copy.
- `src/components/marketing/docs-guide.tsx` — remove public intake references and point owner entry to login.
- `src/components/onboarding/demo-workspace.tsx` — replace request-access CTA with sign-in.
- `src/components/onboarding/auth-shell.tsx` — approved desktop split and mobile form-first layout.
- `src/components/onboarding/login-form.tsx` — private copy, direct authenticated redirect, and explicit 429 handling.
- `src/lib/performance/budgets.test.ts` — follow the relocated hero implementation and server-component contract.
- `tests/e2e/smoke.spec.ts` — signup closure, owner-only navigation, homepage, login, theme, mobile, accessibility, and performance assertions.
- `docs/api-reference.md` — remove the deleted public intake endpoint.

### Delete

- `src/components/onboarding/signup-form.tsx` — public intake UI.
- `src/app/api/onboarding/request-access/route.ts` — unauthenticated access-request persistence.

### Explicitly retain

- `src/app/api/onboarding/access-requests/route.ts`
- `src/lib/onboarding/access-request-store.ts`
- `src/components/approvals-workspace.tsx`

These retain authenticated review of historical records.

---

### Task 1: Close public signup and request intake

**Files:**
- Modify: `tests/e2e/smoke.spec.ts:350-439`
- Modify: `src/app/signup/page.tsx:1-19`
- Delete: `src/components/onboarding/signup-form.tsx`
- Delete: `src/app/api/onboarding/request-access/route.ts`
- Modify: `docs/api-reference.md:15-21`

**Interfaces:**
- Produces: `GET /signup` responds with a Next.js 308 redirect to `/login`.
- Produces: `POST /api/onboarding/request-access` resolves through the framework as 404 because no route handler exists.
- Preserves: authenticated `GET|POST /api/onboarding/access-requests`.

- [ ] **Step 1: Replace obsolete access-request E2E coverage with the closed-entry contract**

Replace both access-request tests in `tests/e2e/smoke.spec.ts` with:

```ts
test("public signup redirects to private login and intake is closed", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/onboarding/request-access", {
    data: {
      name: "Ada Operator",
      email: "ada@example.com",
      company: "Private Workspace",
      role: "engineering",
      timeline: "now",
      useCase: "Operate a governed private agent workspace.",
    },
  });
  expect(response.status()).toBe(404);

  await page.goto("/signup");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
```

- [ ] **Step 2: Run the new E2E contract and verify it fails**

Run:

```bash
npm run test:e2e -- --grep "public signup redirects"
```

Expected: FAIL because the POST currently returns 201 and `/signup` currently renders the access-request form.

- [ ] **Step 3: Replace the signup page with a permanent server redirect**

Replace `src/app/signup/page.tsx` with:

```tsx
import { permanentRedirect } from "next/navigation";

export default function SignupPage(): never {
  permanentRedirect("/login");
}
```

- [ ] **Step 4: Remove the public form and unauthenticated handler**

Run:

```bash
git rm "src/components/onboarding/signup-form.tsx" "src/app/api/onboarding/request-access/route.ts"
```

Expected: both files are staged as deleted. Do not delete the authenticated administrative route or access-request store.

- [ ] **Step 5: Correct the API reference**

Replace the public/authentication route bullets in `docs/api-reference.md` with:

```md
- `GET /api/health`: public liveness/readiness summary. Returns 200 for healthy or local degraded storage and 503 when a configured database is unhealthy.
- Public registration and access-request intake are disabled. `/signup` permanently redirects to `/login`.
- `GET|POST /api/onboarding/access-requests`: admin-only list and approve/decline workflow for historical requests in the Inbox.
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`.
- `GET|POST /api/auth/control-plane`: admin-only tenant/user/membership administration. `POST` creates a workspace user and returns a generated initial password when one is not supplied.
```

- [ ] **Step 6: Run the focused route checks**

Run:

```bash
npm run test:e2e -- --grep "public signup redirects"
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 7: Commit the closed public intake**

```bash
git add "tests/e2e/smoke.spec.ts" "src/app/signup/page.tsx" "docs/api-reference.md"
git commit -m "Close public signup intake"
```

---

### Task 2: Establish owner-only marketing content and entry points

**Files:**
- Create: `src/lib/marketing-content.ts`
- Create: `src/lib/marketing-content.test.ts`
- Create: `src/components/marketing/public-surface.test.ts`
- Modify: `src/lib/navigation.ts:47-54,579-589`
- Modify: `src/components/marketing/public-header.tsx:1-126`
- Modify: `src/components/marketing/docs-guide.tsx:33-62,83-105,140-151,556-575`
- Modify: `src/components/onboarding/demo-workspace.tsx:83-100`
- Modify: `src/components/onboarding/login-form.tsx:126-134,216-222`
- Modify: `tests/e2e/smoke.spec.ts:133-157`

**Interfaces:**
- Produces: `marketingNav: readonly { href: string; label: string }[]`.
- Produces: `marketingActions.signIn` and `marketingActions.demo`.
- Produces: `productFacts`, `operatingLoop`, `homepageCapabilities`, `walkthroughSteps`, `trustControls`, and `marketingFaq`.
- Preserves: existing `appNav`, `marketingPages`, and product-page data consumers.

- [ ] **Step 1: Write failing owner-only content contracts**

Create `src/lib/marketing-content.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  homepageCapabilities,
  marketingActions,
  marketingFaq,
  marketingNav,
  operatingLoop,
  productFacts,
  trustControls,
  walkthroughSteps,
} from "@/lib/marketing-content";

describe("owner-only marketing content", () => {
  it("offers login as the only account-entry action", () => {
    expect(marketingNav.map((item) => item.label)).toEqual([
      "Platform",
      "Solutions",
      "Security",
      "Demo",
      "Docs",
    ]);
    expect(marketingActions).toEqual({
      signIn: { href: "/login", label: "Sign in" },
      demo: { href: "/demo", label: "Explore sample workspace" },
    });
  });

  it("describes the approved factual operating story", () => {
    expect(productFacts).toHaveLength(4);
    expect(operatingLoop.map((step) => step.title)).toEqual([
      "Define",
      "Execute",
      "Approve",
      "Verify",
    ]);
    expect(homepageCapabilities).toHaveLength(6);
    expect(walkthroughSteps.map((step) => step.label)).toEqual([
      "Command",
      "Workflow",
      "Approval",
      "Evidence",
    ]);
    expect(trustControls).toHaveLength(5);
    expect(marketingFaq).toHaveLength(4);
  });
});
```

Create `src/components/marketing/public-surface.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const publicEntryFiles = [
  "src/components/marketing/public-header.tsx",
  "src/components/marketing/docs-guide.tsx",
  "src/components/onboarding/demo-workspace.tsx",
  "src/components/onboarding/login-form.tsx",
];

describe("private public entry surface", () => {
  it("does not render public signup links or intake requests", async () => {
    const sources = await Promise.all(
      publicEntryFiles.map((file) => readFile(path.resolve(file), "utf8")),
    );
    const source = sources.join("\n");

    expect(source).not.toContain('href="/signup"');
    expect(source).not.toContain("/api/onboarding/request-access");
    expect(source).not.toContain("Get access");
    expect(source).not.toContain("Request workspace");
  });
});
```

- [ ] **Step 2: Extend the navigation E2E contract**

Replace the public portion of `test("public and mobile application navigation stay usable")` before `await signIn(page)` with:

```ts
  await page.goto("/");
  const publicNavigation = page.getByRole("navigation", {
    name: "Public navigation",
  });
  await expect(publicNavigation).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Sign in" }).first(),
  ).toHaveAttribute("href", "/login");
  await expect(page.getByRole("link", { name: "Get access" })).toHaveCount(0);
  await expect(
    publicNavigation.getByRole("link", { name: "Pricing" }),
  ).toHaveCount(0);
  await publicNavigation.getByRole("link", { name: "Docs" }).click();
  await expect(page).toHaveURL(/\/docs$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open public navigation" })
    .click();
  const publicMobileMenu = page.getByRole("navigation", {
    name: "Public navigation",
  });
  await expect(publicMobileMenu).toBeVisible();
  await expect(
    publicMobileMenu.getByRole("link", { name: "Sign in" }),
  ).toHaveAttribute("href", "/login");
  await expect(
    publicMobileMenu.getByRole("link", { name: "Pricing" }),
  ).toHaveCount(0);
  await publicMobileMenu.getByRole("link", { name: "Demo" }).click();
  await expect(page).toHaveURL(/\/demo$/);
```

- [ ] **Step 3: Run the contracts and verify they fail**

Run:

```bash
npm run test:unit -- src/lib/marketing-content.test.ts src/components/marketing/public-surface.test.ts
npm run test:e2e -- --grep "public and mobile application navigation"
```

Expected: the unit run fails because `marketing-content.ts` does not exist; the E2E run fails because Pricing and Get access are still rendered.

- [ ] **Step 4: Add the typed marketing content module**

Create `src/lib/marketing-content.ts`:

```ts
export type MarketingIconName =
  | "command"
  | "workflow"
  | "shield"
  | "memory"
  | "monitor"
  | "evidence";

export const marketingNav = [
  { href: "/platform", label: "Platform" },
  { href: "/solutions", label: "Solutions" },
  { href: "/security", label: "Security" },
  { href: "/demo", label: "Demo" },
  { href: "/docs", label: "Docs" },
] as const;

export const marketingActions = {
  signIn: { href: "/login", label: "Sign in" },
  demo: { href: "/demo", label: "Explore sample workspace" },
} as const;

export const productFacts = [
  { value: "7", label: "Recorded workflow stages" },
  { value: "3", label: "Independent worker lanes" },
  { value: "Scoped", label: "Tenant-aware operations" },
  { value: "Live", label: "Evidence-backed health" },
] as const;

export const operatingLoop = [
  {
    step: "01",
    title: "Define",
    body: "Set the goal, operating mode, and boundaries for the run.",
  },
  {
    step: "02",
    title: "Execute",
    body: "Follow the plan, retrieved context, and governed tool activity.",
  },
  {
    step: "03",
    title: "Approve",
    body: "Pause sensitive actions for an explicit human decision.",
  },
  {
    step: "04",
    title: "Verify",
    body: "Review the result, evidence, and durable memory produced.",
  },
] as const;

export const homepageCapabilities = [
  {
    icon: "command",
    title: "Agent command center",
    body: "Start work, inspect progress, and understand the current step.",
  },
  {
    icon: "workflow",
    title: "Durable workflows",
    body: "Resume long-running work across retries, approvals, and recovery.",
  },
  {
    icon: "shield",
    title: "Governed tools",
    body: "Route risky side effects through policy and explicit approval.",
  },
  {
    icon: "memory",
    title: "Memory and knowledge",
    body: "Retrieve source-backed context and retain useful outcomes with provenance.",
  },
  {
    icon: "monitor",
    title: "Observability",
    body: "Trace runtime events, performance, incidents, and worker health.",
  },
  {
    icon: "evidence",
    title: "Release evidence",
    body: "Verify isolation, security, worker readiness, and evaluation quality.",
  },
] as const satisfies readonly {
  icon: MarketingIconName;
  title: string;
  body: string;
}[];

export const walkthroughSteps = [
  {
    step: "01",
    label: "Command",
    body: "Describe a bounded outcome and choose how the agent should operate.",
  },
  {
    step: "02",
    label: "Workflow",
    body: "Inspect durable stages, dependencies, tool calls, and progress.",
  },
  {
    step: "03",
    label: "Approval",
    body: "Resolve sensitive actions with the payload and reason visible.",
  },
  {
    step: "04",
    label: "Evidence",
    body: "Review the completed result with verification and provenance.",
  },
] as const;

export const trustControls = [
  "Tenant-scoped database access",
  "Connector credentials kept server-side",
  "Risk-based tool approval",
  "Auditable run and decision history",
  "Evaluation-backed release gates",
] as const;

export const marketingFaq = [
  {
    question: "What can OmniAgent do?",
    answer:
      "It turns a goal into planned, observable work using durable workflows, governed tools, memory, approvals, and stored result evidence.",
  },
  {
    question: "When does work pause for approval?",
    answer:
      "Policy pauses actions whose risk requires a human decision before a side effect can reach a connected system.",
  },
  {
    question: "What information is retained?",
    answer:
      "Tenant-scoped run events, approvals, results, evidence, and selected memories are retained under the configured policies. Connector secrets remain server-side.",
  },
  {
    question: "How is release readiness verified?",
    answer:
      "Evaluation, authentication, tenant-isolation, worker, SLO, and evidence-signing gates are collected into the release report.",
  },
] as const;
```

- [ ] **Step 5: Make the shared public header owner-only**

Move `marketingNav` to the new module, remove its old export from `src/lib/navigation.ts`, and update the import in `public-header.tsx`:

```ts
import { marketingActions, marketingNav } from "@/lib/marketing-content";
```

Replace the two desktop account links with:

```tsx
          <Link
            href={marketingActions.signIn.href}
            className="hidden min-h-11 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105 sm:inline-flex"
          >
            {marketingActions.signIn.label}
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
```

Replace the mobile two-column account block with:

```tsx
            <div className="mt-3 border-t border-line pt-3">
              <Link
                href={marketingActions.signIn.href}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-ink"
              >
                {marketingActions.signIn.label}
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </div>
```

- [ ] **Step 6: Remove sales and signup copy from directly affected public surfaces**

Replace the `pricing` entry in `src/lib/navigation.ts` with:

```ts
  pricing: {
    eyebrow: "Private deployment",
    headline: "No public plans or registration.",
    summary:
      "This deployment is privately operated. Use the configured owner account to enter the workspace.",
    icon: Database,
    sections: [
      "One private operator workspace.",
      "Email and password entry through secure session auth.",
      "Tenant-scoped data and governed tools.",
      "No public registration or commercial checkout.",
    ],
  },
```

Replace the second `quickStart` item in `docs-guide.tsx` with:

```ts
  {
    title: "Enter the private workspace",
    href: "/login",
    action: "Sign in",
    body: "Use the configured owner account to continue into onboarding and the operating workspace.",
    icon: KeyRound,
  },
```

Remove the `["/signup", "Workspace access request"]` row and remove `"/api/onboarding/request-access"` from the API map.

Replace the docs footer’s request link with:

```tsx
            <Link
              href="/login"
              className="inline-flex h-12 items-center justify-center rounded-md border border-background/20 px-5 text-sm font-semibold transition hover:bg-background/10"
            >
              Sign in
            </Link>
```

Replace the demo CTA with:

```tsx
              <Link
                href="/login"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-line bg-surface px-5 text-sm font-semibold transition hover:bg-surface-raised"
              >
                Sign in to workspace
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
```

Replace the login introduction and footer copy with:

```tsx
        <p className="mt-3 text-sm leading-6 text-muted">
          Use the owner account configured for this private deployment.
        </p>
```

```tsx
      <p className="text-center text-xs leading-5 text-muted">
        Private workspace · No public registration
      </p>
```

- [ ] **Step 7: Run owner-only public-surface tests**

Run:

```bash
npm run test:unit -- src/lib/marketing-content.test.ts src/components/marketing/public-surface.test.ts
npm run test:e2e -- --grep "public and mobile application navigation"
npm run typecheck
```

Expected: all commands PASS.

- [ ] **Step 8: Commit owner-only public entry**

```bash
git add "src/lib/marketing-content.ts" "src/lib/marketing-content.test.ts" "src/components/marketing/public-surface.test.ts" "src/lib/navigation.ts" "src/components/marketing/public-header.tsx" "src/components/marketing/docs-guide.tsx" "src/components/onboarding/demo-workspace.tsx" "src/components/onboarding/login-form.tsx" "tests/e2e/smoke.spec.ts"
git commit -m "Make public entry owner-only"
```

---

### Task 3: Build the Omni adaptive homepage

**Files:**
- Create: `src/components/marketing/landing-hero.tsx`
- Create: `src/components/marketing/landing-operating-story.tsx`
- Create: `src/components/marketing/landing-proof.tsx`
- Create: `src/components/marketing/landing-cta.tsx`
- Modify: `src/components/marketing/landing-page.tsx`
- Modify: `src/components/marketing/public-health-badge.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/globals.css:106-117,196-213`
- Modify: `src/lib/navigation.ts:462-540`
- Modify: `src/lib/performance/budgets.test.ts:6-29`
- Modify: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Produces: server components `LandingHero`, `ProductFacts`, `OperatingLoop`, `CapabilityGrid`, `ProductWalkthrough`, `TrustControls`, `MarketingFaq`, and `PrivateWorkspaceCta`.
- Consumes: all typed exports from `src/lib/marketing-content.ts`.
- Preserves: `PublicHealthBadge` as the only homepage-specific asynchronous client island.

- [ ] **Step 1: Point performance tests at the planned hero boundary**

Replace the first test in `src/lib/performance/budgets.test.ts` with:

```ts
  it("keeps the LCP hero compact, modern, and server-rendered", async () => {
    const root = path.resolve(".");
    const heroAsset = path.join(
      root,
      "public",
      "omniagent-command-center.webp",
    );
    const [metadata, hero, landing] = await Promise.all([
      stat(heroAsset),
      readFile(
        path.join(
          root,
          "src",
          "components",
          "marketing",
          "landing-hero.tsx",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          root,
          "src",
          "components",
          "marketing",
          "landing-page.tsx",
        ),
        "utf8",
      ),
    ]);

    expect(metadata.size).toBeLessThanOrEqual(budgets.heroImageMaxBytes);
    expect(hero).toContain('src="/omniagent-command-center.webp"');
    expect(hero).toContain("preload");
    expect(hero).toContain("sizes=");
    expect(hero).not.toContain("animate-drift");
    expect(landing).not.toContain('"use client"');
    await expect(
      stat(path.join(root, "public", "omniagent-command-center.png")),
    ).rejects.toThrow();
  });
```

- [ ] **Step 2: Add a failing responsive homepage E2E test**

Add after the Web Vitals landing test in `tests/e2e/smoke.spec.ts`:

```ts
test("homepage presents the private owner operating story responsively", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    if (viewport.width === 1440) {
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    }

    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Give agents goals. Keep the controls.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "From goal to evidence, one connected flow.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Designed like an operations desk, not a chatbot.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Private by design. Observable by default.",
      }),
    ).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  for (const preference of ["light", "dark"] as const) {
    await page.evaluate((theme) => {
      window.localStorage.setItem("omniagent-theme", theme);
    }, preference);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", preference);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Give agents goals. Keep the controls.",
      }),
    ).toBeVisible();
  }

  const firstQuestion = page
    .locator("summary")
    .filter({ hasText: "What can OmniAgent do?" });
  await firstQuestion.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("It turns a goal into planned, observable work"),
  ).toBeVisible();
});
```

- [ ] **Step 3: Run the homepage contracts and verify they fail**

Run:

```bash
npm run test:unit -- src/lib/performance/budgets.test.ts
npm run test:e2e -- --grep "homepage presents"
```

Expected: the unit test fails because `landing-hero.tsx` does not exist; the E2E test fails because the approved headings are absent.

- [ ] **Step 4: Implement the hero**

Create `src/components/marketing/landing-hero.tsx`:

```tsx
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Play, Sparkles } from "lucide-react";
import { PublicHealthBadge } from "@/components/marketing/public-health-badge";
import { marketingActions } from "@/lib/marketing-content";

export function LandingHero() {
  return (
    <section className="border-b border-line pt-16" aria-labelledby="landing-title">
      <div className="mx-auto grid min-h-[calc(100svh-4rem)] max-w-7xl items-center gap-14 px-4 py-16 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-sm font-semibold text-primary">
            <Sparkles size={15} aria-hidden="true" />
            Your governed agent operating layer
          </p>
          <h1
            id="landing-title"
            className="mt-7 max-w-3xl text-5xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-6xl lg:text-7xl"
          >
            Give agents goals. Keep the controls.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted sm:text-xl">
            Plan, supervise, approve, and verify AI work in one focused
            workspace—with durable memory and evidence at every step.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href={marketingActions.signIn.href}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-ink transition hover:brightness-105"
            >
              {marketingActions.signIn.label}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
            <Link
              href={marketingActions.demo.href}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-line bg-surface px-5 text-sm font-semibold transition hover:bg-surface-raised"
            >
              {marketingActions.demo.label}
              <Play size={16} aria-hidden="true" />
            </Link>
          </div>
          <PublicHealthBadge />
        </div>

        <div className="overflow-hidden rounded-xl border border-line bg-foreground text-background shadow-2xl shadow-primary/10">
          <div className="flex min-h-12 items-center justify-between border-b border-background/15 px-4 text-xs">
            <span className="font-semibold">Workspace overview</span>
            <span className="font-mono opacity-70">Operational</span>
          </div>
          <figure className="relative aspect-video">
            <Image
              src="/omniagent-command-center.webp"
              alt="OmniAgent workspace showing task progress, approvals, and result evidence."
              fill
              preload
              sizes="(max-width: 1024px) calc(100vw - 2rem), 55vw"
              className="object-cover object-center"
            />
          </figure>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Implement facts, operating loop, and capabilities**

Create `src/components/marketing/landing-operating-story.tsx`:

```tsx
import {
  Activity,
  Brain,
  CheckCircle2,
  ShieldCheck,
  TerminalSquare,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  homepageCapabilities,
  operatingLoop,
  productFacts,
  type MarketingIconName,
} from "@/lib/marketing-content";

const capabilityIcons: Record<MarketingIconName, LucideIcon> = {
  command: TerminalSquare,
  workflow: Workflow,
  shield: ShieldCheck,
  memory: Brain,
  monitor: Activity,
  evidence: CheckCircle2,
};

export function ProductFacts() {
  return (
    <section aria-label="Product facts" className="border-b border-line bg-surface">
      <div className="mx-auto grid max-w-7xl grid-cols-2 divide-x divide-y divide-line border-x border-line sm:grid-cols-4 sm:divide-y-0">
        {productFacts.map((fact) => (
          <div key={fact.label} className="px-4 py-6 sm:px-6">
            <p className="font-mono text-2xl font-semibold">{fact.value}</p>
            <p className="mt-1 text-sm text-muted">{fact.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function OperatingLoop() {
  return (
    <section id="workflow" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
        Operating loop
      </p>
      <h2 className="mt-4 max-w-3xl text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
        From goal to evidence, one connected flow.
      </h2>
      <p className="mt-5 max-w-2xl text-base leading-7 text-muted">
        Follow the same four stages every time you give the agent meaningful
        work.
      </p>
      <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {operatingLoop.map((item) => (
          <article
            key={item.title}
            className="min-h-56 rounded-lg border border-line bg-surface p-6"
          >
            <p className="font-mono text-sm text-primary">{item.step}</p>
            <h3 className="mt-12 text-2xl font-semibold">{item.title}</h3>
            <p className="mt-3 text-sm leading-6 text-muted">{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function CapabilityGrid() {
  return (
    <section id="platform" className="border-y border-line bg-surface">
      <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
          Platform capabilities
        </p>
        <h2 className="mt-4 max-w-3xl text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
          Designed like an operations desk, not a chatbot.
        </h2>
        <div className="mt-12 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {homepageCapabilities.map((capability) => {
            const Icon = capabilityIcons[capability.icon];
            return (
              <article
                key={capability.title}
                className="rounded-lg border border-line bg-background p-6"
              >
                <div className="grid size-11 place-items-center rounded-md bg-primary/12 text-primary">
                  <Icon size={20} aria-hidden="true" />
                </div>
                <h3 className="mt-8 text-xl font-semibold">
                  {capability.title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-muted">
                  {capability.body}
                </p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Implement walkthrough, trust, and FAQ**

Create `src/components/marketing/landing-proof.tsx`:

```tsx
import { CheckCircle2, LockKeyhole, ShieldCheck } from "lucide-react";
import {
  marketingFaq,
  trustControls,
  walkthroughSteps,
} from "@/lib/marketing-content";

export function ProductWalkthrough() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <div className="grid gap-12 lg:grid-cols-[0.78fr_1.22fr] lg:items-center">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
            Product walkthrough
          </p>
          <h2 className="mt-4 text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
            One workspace, shown as one operating story.
          </h2>
          <div className="mt-8">
            {walkthroughSteps.map((item) => (
              <div
                key={item.label}
                className="grid grid-cols-[2.5rem_1fr] gap-4 border-b border-line py-5"
              >
                <span className="font-mono text-sm text-primary">
                  {item.step}
                </span>
                <div>
                  <h3 className="font-semibold">{item.label}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted">
                    {item.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-line bg-foreground p-5 text-background sm:p-7">
          <div className="flex items-center justify-between border-b border-background/15 pb-5">
            <div>
              <p className="text-sm opacity-70">Governed run</p>
              <p className="mt-1 text-2xl font-semibold">Release review</p>
            </div>
            <ShieldCheck size={28} aria-hidden="true" />
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              ["Workflow", "7 stages"],
              ["Approval", "Resolved"],
              ["Evidence", "Verified"],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-md border border-background/15 bg-background/10 p-4"
              >
                <p className="text-xs opacity-70">{label}</p>
                <p className="mt-3 font-mono text-sm">{value}</p>
              </div>
            ))}
          </div>
          <div className="subtle-grid mt-4 min-h-48 rounded-md border border-background/15 bg-background/5" />
        </div>
      </div>
    </section>
  );
}

export function TrustControls() {
  return (
    <section id="security" className="border-y border-line bg-surface">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[0.85fr_1.15fr] lg:px-8">
        <div>
          <LockKeyhole size={24} className="text-primary" aria-hidden="true" />
          <p className="mt-8 text-sm font-semibold uppercase tracking-[0.2em] text-primary">
            Trust and control
          </p>
          <h2 className="mt-4 text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
            Private by design. Observable by default.
          </h2>
          <p className="mt-5 max-w-xl text-base leading-7 text-muted">
            Agent work can reach real data and systems, so identity, policy,
            evidence, and operator decisions remain visible.
          </p>
        </div>
        <div className="rounded-lg border border-line bg-background p-5 sm:p-7">
          {trustControls.map((control) => (
            <div
              key={control}
              className="flex min-h-16 items-center gap-3 border-b border-line last:border-b-0"
            >
              <CheckCircle2
                size={18}
                className="shrink-0 text-primary"
                aria-hidden="true"
              />
              <span className="text-sm font-medium">{control}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function MarketingFaq() {
  return (
    <section id="faq" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <div className="grid gap-12 lg:grid-cols-[0.7fr_1.3fr]">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
            Frequently asked
          </p>
          <h2 className="mt-4 text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
            Clear answers before entering the workspace.
          </h2>
        </div>
        <div className="divide-y divide-line border-y border-line">
          {marketingFaq.map((item) => (
            <details key={item.question} className="group py-5">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-semibold">
                {item.question}
                <span className="text-primary transition group-open:rotate-45" aria-hidden="true">
                  +
                </span>
              </summary>
              <p className="max-w-2xl pb-2 pr-10 text-sm leading-6 text-muted">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 7: Implement the final CTA and page composition**

Create `src/components/marketing/landing-cta.tsx`:

```tsx
import Link from "next/link";
import { ArrowRight, Play } from "lucide-react";
import { marketingActions } from "@/lib/marketing-content";

export function PrivateWorkspaceCta() {
  return (
    <section className="border-t border-line bg-foreground text-background">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-16 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div>
          <h2 className="text-3xl font-semibold tracking-[-0.04em]">
            Open the operating workspace.
          </h2>
          <p className="mt-3 text-sm opacity-70">
            Private owner access · Email/password authentication · No public
            registration
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href={marketingActions.signIn.href}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-background px-5 text-sm font-semibold text-foreground"
          >
            {marketingActions.signIn.label}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
          <Link
            href={marketingActions.demo.href}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-background/20 px-5 text-sm font-semibold"
          >
            Open demo
            <Play size={16} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
```

Replace `src/components/marketing/landing-page.tsx` with:

```tsx
import { LandingHero } from "@/components/marketing/landing-hero";
import {
  CapabilityGrid,
  OperatingLoop,
  ProductFacts,
} from "@/components/marketing/landing-operating-story";
import {
  MarketingFaq,
  ProductWalkthrough,
  TrustControls,
} from "@/components/marketing/landing-proof";
import { PrivateWorkspaceCta } from "@/components/marketing/landing-cta";
import { PublicHeader } from "@/components/marketing/public-header";

export function LandingPage() {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only fixed left-4 top-4 z-50 rounded-md bg-primary px-4 py-3 font-semibold text-primary-ink focus:not-sr-only"
      >
        Skip to content
      </a>
      <PublicHeader />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen overflow-hidden bg-background text-foreground"
      >
        <LandingHero />
        <ProductFacts />
        <OperatingLoop />
        <CapabilityGrid />
        <ProductWalkthrough />
        <TrustControls />
        <MarketingFaq />
        <PrivateWorkspaceCta />
      </main>
    </>
  );
}
```

- [ ] **Step 8: Make health status theme-adaptive**

Replace the returned status container in `public-health-badge.tsx` with:

```tsx
    <div
      className="mt-6 inline-flex min-h-12 max-w-full items-center gap-3 rounded-md border border-line bg-surface px-4 text-sm text-muted"
      role="status"
      aria-live="polite"
    >
      <Icon
        size={17}
        className={
          status === "healthy"
            ? "text-success"
            : status === "checking"
              ? "animate-spin text-muted"
              : status === "degraded"
                ? "text-warning"
                : status === "unhealthy"
                  ? "text-danger"
                  : "text-muted"
        }
        aria-hidden="true"
      />
      <span>System health:</span>
      <strong className="font-mono text-foreground">{status}</strong>
    </div>
```

- [ ] **Step 9: Update metadata and remove obsolete homepage CSS**

Set the homepage metadata in `src/app/page.tsx` to:

```ts
export const metadata: Metadata = {
  title: "Governed AI Agent Operations",
  description:
    "Plan, supervise, approve, and verify private AI agent work with durable workflows, memory, and evidence.",
};
```

Delete `.hero-scrim`, `.animate-rise`, `.animate-rise-delay`, and `@keyframes rise-in` from `src/app/globals.css`. Keep `.subtle-grid` and the existing reduced-motion media query.

Delete the now-unused `platformPillars`, `orchestrationJourney`, `capabilityMatrix`, and `operatingModes` exports from `src/lib/navigation.ts`. Keep `proofMetrics`, which remains consumed by secondary `MarketingPage` routes.

- [ ] **Step 10: Run homepage verification**

Run:

```bash
npm run test:unit -- src/lib/marketing-content.test.ts src/lib/performance/budgets.test.ts
npm run test:e2e -- --grep "landing stays|homepage presents|public and mobile application navigation"
npm run typecheck
npm run lint
```

Expected: all commands PASS, including 320-pixel overflow and Web Vitals assertions.

- [ ] **Step 11: Commit the adaptive homepage**

```bash
git add "src/components/marketing/landing-hero.tsx" "src/components/marketing/landing-operating-story.tsx" "src/components/marketing/landing-proof.tsx" "src/components/marketing/landing-cta.tsx" "src/components/marketing/landing-page.tsx" "src/components/marketing/public-health-badge.tsx" "src/app/page.tsx" "src/app/globals.css" "src/lib/navigation.ts" "src/lib/performance/budgets.test.ts" "tests/e2e/smoke.spec.ts"
git commit -m "Build the adaptive owner homepage"
```

---

### Task 4: Build the private form-first login

**Files:**
- Modify: `src/components/onboarding/auth-shell.tsx`
- Modify: `src/components/onboarding/login-form.tsx`
- Modify: `src/app/login/page.tsx`
- Modify: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- `AuthShell({ children }: { children: React.ReactNode }): React.ReactElement`.
- `LoginForm()` continues to call `GET /api/auth/session` and `POST /api/auth/login`.
- Authenticated sessions and successful login use `router.replace("/onboarding")`.
- A 429 response maps to `Too many sign-in attempts. Try again shortly.`

- [ ] **Step 1: Add failing private-login E2E coverage**

Add after the existing authentication test:

```ts
test("private login is form-first, theme-aware, and rate-limit safe", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Too Many Requests",
        message: "Too many login attempts. Try again later.",
      }),
    });
  });
  await page.goto("/login");

  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(page.getByTestId("auth-story")).toBeHidden();
  await expect(page.getByTestId("login-form")).toBeVisible();
  await expect(
    page.getByText("Private workspace · No public registration"),
  ).toBeVisible();

  const initialPreference = await page
    .locator("html")
    .getAttribute("data-theme-preference");
  await page.getByRole("button", { name: /^Theme:/ }).click();
  const changedPreference = await page
    .locator("html")
    .getAttribute("data-theme-preference");
  expect(changedPreference).not.toBe(initialPreference);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-preference",
    changedPreference || "system",
  );

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  await page.getByLabel("Email address").fill(adminEmail);
  await page
    .getByLabel("Password", { exact: true })
    .fill("rate-limited-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Too many sign-in attempts. Try again shortly.",
  );
});
```

Add these assertions immediately after `await page.goto("/login")` in the existing desktop authentication test:

```ts
  await expect(page.getByTestId("auth-story")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
```

- [ ] **Step 2: Run the private-login test and verify it fails**

Run:

```bash
npm run test:e2e -- --grep "private login is form-first"
```

Expected: FAIL because the new heading and test IDs do not exist and the old public header is still rendered.

- [ ] **Step 3: Replace the authentication shell**

Replace `src/components/onboarding/auth-shell.tsx` with:

```tsx
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";

const proofPoints = [
  {
    icon: Activity,
    title: "Operational clarity",
    body: "See current work, blockers, and what happens next.",
  },
  {
    icon: ShieldCheck,
    title: "Risk-first controls",
    body: "Pause sensitive tools for an explicit decision.",
  },
  {
    icon: CheckCircle2,
    title: "Durable evidence",
    body: "Keep results, memory, approvals, and release proof.",
  },
] as const;

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only fixed left-4 top-4 z-50 rounded-md bg-primary px-4 py-3 font-semibold text-primary-ink focus:not-sr-only"
      >
        Skip to sign in
      </a>
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-svh bg-background text-foreground"
      >
        <div className="grid min-h-svh lg:grid-cols-[0.95fr_1.05fr]">
          <aside
            data-testid="auth-story"
            aria-label="Private workspace benefits"
            className="hidden flex-col justify-between border-r border-line bg-primary/10 p-10 lg:flex xl:p-14"
          >
            <div>
              <Link
                href="/"
                className="inline-flex items-center gap-3 font-semibold tracking-tight"
                aria-label="OmniAgentOS home"
              >
                <span className="grid size-10 place-items-center rounded-md bg-primary text-primary-ink">
                  <Sparkles size={18} aria-hidden="true" />
                </span>
                <span className="text-lg">OmniAgentOS</span>
              </Link>
              <p className="mt-16 inline-flex rounded-full border border-primary/25 bg-background/60 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
                Private agent workspace
              </p>
              <p className="mt-5 max-w-xl text-5xl font-semibold leading-[1.02] tracking-[-0.05em] xl:text-6xl">
                Run faster. Keep every action governed.
              </p>
              <p className="mt-6 max-w-lg text-base leading-7 text-muted">
                One focused command center for plans, approvals, memory, and
                release evidence.
              </p>
              <div className="mt-10 grid gap-3">
                {proofPoints.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.title}
                      className="grid grid-cols-[2.75rem_1fr] gap-4 rounded-lg border border-line bg-background/60 p-4"
                    >
                      <div className="grid size-11 place-items-center rounded-md bg-primary/12 text-primary">
                        <Icon size={18} aria-hidden="true" />
                      </div>
                      <div>
                        <p className="font-semibold">{item.title}</p>
                        <p className="mt-1 text-sm leading-6 text-muted">
                          {item.body}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mt-12 flex items-center justify-between rounded-lg border border-primary/20 bg-background/60 px-4 py-3 text-sm">
              <span className="text-muted">Owner access</span>
              <strong className="text-primary">Single account</strong>
            </div>
          </aside>

          <section aria-label="Sign in" className="flex min-h-svh flex-col p-4 sm:p-8 lg:p-10">
            <div className="flex min-h-11 items-center justify-between gap-4">
              <Link
                href="/"
                className="inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-semibold lg:hidden"
              >
                <span className="grid size-9 place-items-center rounded-md bg-primary text-primary-ink">
                  <Sparkles size={16} aria-hidden="true" />
                </span>
                OmniAgentOS
              </Link>
              <span className="hidden lg:block" />
              <ThemeToggle />
            </div>

            <div className="flex flex-1 items-center justify-center py-8">
              <div className="w-full max-w-md">{children}</div>
            </div>

            <Link
              href="/"
              className="inline-flex min-h-11 items-center gap-2 self-center rounded-md px-3 text-sm font-medium text-muted transition hover:text-foreground"
            >
              <ArrowLeft size={16} aria-hidden="true" />
              Back to homepage
            </Link>
          </section>
        </div>
      </main>
    </>
  );
}
```

- [ ] **Step 4: Replace the login state presentation while preserving API behavior**

Keep the existing state types and request validation in `login-form.tsx`, then make these exact behavior changes:

1. Add `router` to the session-check effect dependencies.
2. Replace the authenticated branch inside `checkSession` with:

```ts
        if (!canceled) {
          if (!validSession.authEnabled) {
            setSessionState("local");
          } else if (validSession.authenticated) {
            setSessionState("authenticated");
            router.replace("/onboarding");
          } else {
            setSessionState("anonymous");
          }
        }
```

3. Replace failed-login handling with:

```ts
      if (!response.ok) {
        setError(
          response.status === 429
            ? "Too many sign-in attempts. Try again shortly."
            : body.message || "Email or password is incorrect.",
        );
        return;
      }

      router.replace("/onboarding");
      router.refresh();
```

4. Replace the authenticated rendering branch with:

```tsx
  if (sessionState === "authenticated") {
    return (
      <div className="flex items-center gap-3 text-sm text-muted" role="status">
        <Loader2 size={17} className="animate-spin" aria-hidden="true" />
        Opening your workspace.
      </div>
    );
  }
```

5. Add `data-testid="login-form"` and `aria-busy={submitting}` to the `<form>`.
6. Replace the form introduction with:

```tsx
      <div className="text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-md bg-primary/12 text-primary">
          <LogIn size={21} aria-hidden="true" />
        </div>
        <p className="mt-6 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
          Private owner access
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.035em]">
          Welcome back
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Sign in to your OmniAgent workspace.
        </p>
      </div>
```

Keep explicit labels, `autocomplete`, password visibility, session retry, local-auth direct workspace, loading state, error roles, and disabled submit behavior. Keep the owner-only footer from Task 2.

- [ ] **Step 5: Simplify the login page API and metadata**

Replace `src/app/login/page.tsx` with:

```tsx
import type { Metadata } from "next";
import { AuthShell } from "@/components/onboarding/auth-shell";
import { LoginForm } from "@/components/onboarding/login-form";

export const metadata: Metadata = {
  title: "Private Sign In",
  description: "Sign in to the private OmniAgent owner workspace.",
};

export default function LoginPage() {
  return (
    <AuthShell>
      <LoginForm />
    </AuthShell>
  );
}
```

- [ ] **Step 6: Run login, redirect, mobile, and theme verification**

Run:

```bash
npm run test:e2e -- --grep "local bootstrap authentication|private login is form-first|public signup redirects"
npm run typecheck
npm run lint
```

Expected: all commands PASS. The desktop test sees the story; mobile hides it; the form has no horizontal overflow; theme preference survives reload; 429 copy is explicit; valid login still reaches `/onboarding`.

- [ ] **Step 7: Commit the private login**

```bash
git add "src/components/onboarding/auth-shell.tsx" "src/components/onboarding/login-form.tsx" "src/app/login/page.tsx" "tests/e2e/smoke.spec.ts"
git commit -m "Build the private owner login"
```

---

### Task 5: Run integrated acceptance verification

**Files:**
- Verify only; fix failures in the task that owns the affected file.

**Interfaces:**
- Verifies the complete public browser path: homepage → login → onboarding.
- Verifies the closed path: signup → login and request-intake POST → 404.
- Verifies no regression to authenticated administration of historical access requests.

- [ ] **Step 1: Scan for prohibited public intake references**

Run:

```bash
! rg 'href="/signup"|/api/onboarding/request-access|Get access|Request workspace' src --glob '!**/*.test.ts'
test ! -e "src/app/api/onboarding/request-access/route.ts"
```

Expected: both commands exit successfully with no `rg` output. Closed-path tests and planning documents intentionally retain the old route string so they can verify and describe its removal.

- [ ] **Step 2: Run focused unit and browser checks**

Run:

```bash
npm run test:unit -- src/lib/marketing-content.test.ts src/components/marketing/public-surface.test.ts src/lib/performance/budgets.test.ts
npm run test:e2e -- --grep "landing stays|homepage presents|public and mobile application navigation|local bootstrap authentication|private login is form-first|public signup redirects"
```

Expected: both commands PASS.

- [ ] **Step 3: Run the full repository release-quality verification**

Run:

```bash
npm run verify
```

Expected: typecheck, lint, coverage, integration tests, worker checks, operations checks, production build, and production dependency audit all PASS.

- [ ] **Step 4: Inspect the final change set**

Run:

```bash
git status --short
git diff HEAD~4..HEAD --stat
git log -4 --oneline
```

Expected: only the pre-existing `.superpowers/brainstorm` runtime artifacts and this saved plan remain untracked; the four implementation commits are present; no application change is left unstaged.

- [ ] **Step 5: Stop before deployment**

Do not run `npm run deploy:production`. Report verification results, the four commit hashes, and any intentionally deferred secondary-page redesigns to Bennie.
