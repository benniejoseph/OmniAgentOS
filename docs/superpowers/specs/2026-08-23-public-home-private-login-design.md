# OmniAgent Public Home and Private Login Redesign

**Date:** 2026-08-23  
**Status:** Design approved; written specification awaiting final review  
**Visual direction:** Omni adaptive

## Context

OmniAgentOS currently has a capable public homepage, a shared authentication shell, and a public access-request page. The product is now intended for one private owner rather than public customer acquisition. The public experience should therefore explain the system clearly and provide one account-entry action: signing in.

The redesign adopts the hierarchy and pacing of the TradeTaper reference—concise navigation, an outcome-led hero, visible product proof, a guided walkthrough, and a focused authentication layout—without copying its branding, content, assets, or domain-specific claims. OmniAgent keeps its green and amber identity, operational subject matter, and existing light/dark theme model.

## Goals

1. Make the homepage explain what OmniAgent does, how work flows through it, and where human control applies.
2. Give the public surface a cohesive, professional visual system in light and dark modes.
3. Make private owner login the only account-entry path.
4. Preserve the existing email/password authentication contract and secure HttpOnly session behavior.
5. Improve mobile usability by placing the complete login form before all promotional content.
6. Preserve the performance gains and budgets established by the performance-remediation release.

## Non-goals

- Redesigning the authenticated application workspace.
- Changing authentication providers, session semantics, credentials, or authorization rules.
- Adding public registration, invitations, password recovery, social login, billing, or pricing.
- Rebuilding every secondary marketing page in this change.
- Adding video, carousels, parallax, animated backgrounds, or another large client-side UI dependency.
- Copying TradeTaper text, assets, source code, or branding.

## Product and Content Decisions

### Private-owner positioning

The product is presented as a private agent operating workspace, not a public SaaS accepting new teams. Public copy must not promise account creation, sales follow-up, commercial plans, or access-review timelines.

The primary call to action is **Sign in**. The secondary call to action is **Explore sample workspace** and continues to use the existing `/demo` route.

### Public navigation

The desktop and mobile header contains:

- Platform
- Solutions
- Security
- Demo
- Docs
- Theme control
- Sign in

Pricing and public-access CTAs are removed from navigation. Existing secondary marketing pages remain available, but every rendered public link to `/signup`, including links in the header, docs guide, and demo, is changed to `/login` or removed.

### Homepage narrative

The homepage presents one continuous operating story:

1. **Navigation:** restrained brand treatment, product links, theme control, and one prominent login action.
2. **Hero:** “Give agents goals. Keep the controls.” Supporting copy explains planning, supervision, approvals, memory, and evidence. A framed workspace visual uses the existing optimized command-center asset.
3. **Product facts:** real, stable system facts rather than invented customer or business metrics. These include seven recorded workflow stages, three worker lanes, tenant-scoped operations, and live evidence-backed health.
4. **Operating loop:** Define, Execute, Approve, Verify.
5. **Capabilities:** command center, durable workflows, governed tools, memory and knowledge, observability, and release evidence.
6. **Product walkthrough:** Command, Workflow, Approval, and Evidence shown as one static operating sequence. It remains understandable without JavaScript.
7. **Trust and control:** tenant isolation, server-held secrets, approval policy, release gates, and auditable results replace pricing and testimonials.
8. **FAQ:** concise answers about agent capabilities, approval pauses, retained information, and release-readiness verification. It uses native `<details>` and `<summary>` disclosure controls.
9. **Final CTA:** private owner sign-in plus the existing demo.

Live health is supplementary. It loads after critical content and degrades to a neutral unavailable state rather than blocking or shifting the hero.

## Visual System

### Design thesis

The interface should feel like a calm operations desk: precise, capable, and trustworthy. It uses strong typographic hierarchy, generous spacing, low-noise borders, restrained radii, and one dominant action per section.

### Theme rules

- All page surfaces use the existing semantic theme tokens such as background, surface, raised surface, foreground, muted, line, primary, accent, warning, and danger.
- New UI must not rely on hard-coded light-only colors.
- Green remains the primary action and system-health color.
- Amber is reserved for attention, approval, and caution rather than general decoration.
- Dark mode is designed independently, not produced by blindly inverting light mode.
- The framed product visual may use an intentional inverse surface in both themes to read as an application window.
- Focus, hover, active, disabled, error, and loading states must remain distinct in both themes.
- Existing theme persistence and system-theme behavior are retained, with no theme flash introduced by the redesign.

### Typography and motion

The existing typography stack remains in place. Headlines use tighter tracking and shorter measures; body copy uses readable line lengths and a consistent type scale.

Motion is limited to short opacity or translation transitions on nonessential elements. `prefers-reduced-motion` removes them. There is no autoplay, looping decorative motion, or motion required to understand content.

## Responsive Behavior

### Homepage

- Desktop uses a two-column hero with copy first and the workspace visual second.
- Tablet stacks complex two-column sections and removes perspective effects from the product frame.
- Product facts and the operating loop become two-column grids at intermediate widths.
- Capabilities become a single-column sequence on narrow screens.
- Content order remains logical in the DOM and does not depend on visual reordering.
- All controls provide at least a 44-by-44-pixel interaction target.

### Login

- Desktop uses the approved split composition: product story on the left, authentication on the right.
- The story panel contains the OmniAgent brand, private-workspace positioning, three short proof points, and a single-account marker.
- On mobile, the promotional story panel is not rendered. A compact brand row is followed immediately by the form heading, email field, password field, and submit action, with no promotional content between them.
- The layout uses small-viewport units where full-height behavior is needed and does not create a second nested scroll region.

## Component Architecture

### Public homepage

`src/app/page.tsx` remains a Server Component entry point. `LandingPage` becomes a focused composition of small marketing sections rather than one large implementation file. The expected boundaries are:

- `PublicHeader`: shared public navigation, responsive menu, theme control, and login CTA.
- `LandingHero`: headline, two CTAs, delayed health status, and optimized product visual.
- `ProductFacts`: stable platform facts.
- `OperatingLoop`: four-step owner workflow.
- `CapabilityGrid`: six product capabilities.
- `ProductWalkthrough`: static command-to-evidence story.
- `TrustControls`: private operation and governance proof.
- `MarketingFaq`: semantic FAQ disclosures.
- `PrivateWorkspaceCta`: final login and demo actions.

Homepage content is exported as typed static data from `src/lib/marketing-content.ts`. It is not fetched from an API or added to the already broad navigation module.

### Private login

`src/app/login/page.tsx` remains a Server Component. The authentication boundary contains:

- `AuthShell`: responsive split layout and private-workspace story.
- `LoginForm`: the existing client-side session and form state machine.
- Existing `ThemeToggle`: available without loading the full public navigation.
- A simple home link rather than the full marketing header inside the form layout.

`LoginForm` continues to own email, password, visibility, session check, submission, loading, and inline error state. The visual redesign must not duplicate authentication logic in the shell.

### Signup removal

- `/signup` performs a permanent server-side redirect to `/login`.
- `SignupForm` is removed in this implementation slice.
- All public `/signup` links are removed or redirected to the private login.
- The unauthenticated `/api/onboarding/request-access` route is removed, so direct POST requests receive the framework’s `404` response and cannot persist a request.
- The authenticated `/api/onboarding/access-requests` administrative route remains so historical records can still be reviewed; this redesign only closes public intake.

## Data and Interaction Flow

### Homepage

1. The server renders all critical marketing content.
2. The optimized hero image uses `next/image` inside a fixed-aspect-ratio frame with a correct responsive `sizes` value and reserved layout space.
3. The public health badge requests cached `/api/health?public=1` data after the critical content is usable.
4. Theme state continues through the existing theme provider and control.
5. No homepage section requires authenticated data.

### Login

1. `LoginForm` checks `/api/auth/session`.
2. An authenticated owner is redirected with `router.replace("/onboarding")`; onboarding remains responsible for deciding the next workspace destination.
3. If authentication is disabled locally, the existing direct-workspace path remains available.
4. An anonymous owner submits email and password to `/api/auth/login`.
5. A successful response sets the existing secure session cookie and navigates to `/onboarding`.
6. The client never stores credentials or session tokens.

### Closed signup path

1. A request for `/signup` is redirected before any signup UI renders.
2. A direct request to the old public intake API cannot create a record.
3. Existing authenticated administrator APIs for viewing or deciding historical requests remain governed by their current authorization checks.

## Error Handling

- A failed session check shows a nonblocking status with a retry action while still allowing sign-in.
- Invalid credentials use a generic message and do not reveal whether an email exists.
- A `429` response shows “Too many sign-in attempts. Try again shortly.” and otherwise preserves the API’s generic credential handling.
- Network failures preserve entered email, never expose the password, and let the owner retry.
- Submission prevents duplicate clicks and announces progress without moving focus unexpectedly.
- Errors use `role="alert"`; background status uses `role="status"` or an appropriate live region.
- A health-check failure becomes quiet neutral copy and never presents a false healthy state.
- The signup redirect has no intermediate success or access-request messaging.

## Accessibility Requirements

- One page-level `h1` and a logical heading hierarchy.
- A skip link and correctly named navigation landmarks.
- Explicit form labels, native email/password semantics, and correct autocomplete values.
- Keyboard-accessible theme, mobile-menu, password-visibility, FAQ, and submit controls.
- Visible focus indicators in both themes.
- WCAG 2.2 AA contrast for text, controls, borders needed for comprehension, and focus indicators.
- Status and validation must not depend on color alone.
- Password visibility retains an accessible changing label.
- Responsive layouts must work at 320 CSS pixels without horizontal page scrolling.

## Performance Requirements

- Keep the homepage predominantly server-rendered.
- Do not add a client runtime for static marketing sections.
- Reuse the existing optimized WebP product asset unless a replacement is smaller at equivalent quality.
- Preserve image sizing and priority behavior so the hero does not regress LCP or CLS.
- Keep the cached health check outside the critical rendering path.
- Add no new font, carousel, animation, or design-system dependency.
- Preserve the existing landing, Web Vitals, API, and dashboard release budgets.
- Avoid hydration mismatches and console errors in both theme modes.

## Testing Strategy

### Unit and component coverage

- Public navigation contains Login and no public signup or pricing CTA.
- Marketing content is rendered from the expected static sections.
- The signup page resolves to the login redirect.
- The old unauthenticated intake endpoint cannot persist an access request.
- Existing login state behavior remains covered: checking, anonymous, authenticated, local-auth-disabled, failure, and retry.
- Performance-budget tests continue to verify optimized hero-image and Web Vitals behavior.

### End-to-end coverage

- Homepage renders the approved hierarchy at desktop and mobile widths.
- Light and dark themes both expose readable text, visible controls, and the correct theme state after reload.
- Primary homepage and header actions open `/login`; demo actions open `/demo`.
- `/signup` redirects to `/login`.
- A direct public intake request is rejected and creates no record.
- Invalid credentials show a generic inline error.
- Valid credentials create a session and continue through `/onboarding`.
- The login form is keyboard-operable, and focus remains visible.
- The mobile login displays the form before promotional content and does not horizontally overflow.

### Release verification

Run the repository’s normal lint, type, unit, integration, build, and relevant Playwright checks. Re-run the established landing and Web Vitals performance assertions. Production deployment remains a separate action and is not implied by implementing this design.

## Acceptance Criteria

1. The homepage matches the approved Omni adaptive structure and content hierarchy.
2. Light and dark modes look intentionally designed and use semantic theme tokens consistently.
3. The only public account-entry action is Sign in.
4. No rendered public UI links to `/signup`.
5. `/signup` redirects to `/login`, and the old public access-request path cannot create data.
6. Email/password login, session checking, local-auth behavior, errors, and the `/onboarding` handoff still work.
7. Desktop, tablet, and mobile layouts have no page-level horizontal overflow.
8. Keyboard navigation, focus visibility, labels, status announcements, contrast, and reduced-motion behavior meet the stated accessibility requirements.
9. The redesign adds no unnecessary client-side dependency and passes existing performance budgets.
10. The authenticated application is unchanged outside targeted link cleanup.

## Implementation Boundary

This is one implementation slice: redesign the public home and private login, remove public signup intake, update directly affected links and tests, and verify the result. Redesigns of Demo, Platform, Solutions, Security, Docs, Pricing, and the authenticated application should be handled as later page-by-page slices rather than expanded into this change.
