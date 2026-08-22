# Product

## Register

product

## Users

OmniAgent OS is for engineering, operations, product, and security teams that need an AI agent to complete real work across connected systems without losing human control. The primary user is an operator or administrator who gives the agent a goal, watches progress and evidence, resolves approvals, and reviews the outcome. Viewers need a trustworthy read-only view of results and system health.

## Product Purpose

OmniAgent OS turns a goal into governed, durable work. It combines context, tools, approvals, recovery, and evidence so routine reversible actions can earn autonomy while novel or dangerous actions remain supervised. Success means users can quickly answer four questions: what is running, what needs me, what changed, and can I trust the result?

The authenticated product is primary. Marketing and documentation support adoption but must not compete with the core workflow. The deeper product thesis and earned-autonomy model live in `docs/vision/PRODUCT.md`.

## Brand Personality

Clear, calm, and accountable. The interface should feel technically capable without feeling theatrical. Copy should be direct, specific, and honest about uncertainty, simulated behavior, approvals, failures, and incomplete work.

## Anti-references

- A cockpit with many equal-priority dashboards and no obvious next action.
- A generic AI chat wrapper that hides plans, tools, evidence, and side effects.
- Governance theater: impressive labels without enforceable isolation, recovery, or audit history.
- A marketing-heavy SaaS shell inside the authenticated product.
- Status displays that turn loading, missing data, or failures into reassuring zeros.
- Desktop-only navigation or custom interactions that break familiar keyboard and screen-reader behavior.

## Design Principles

1. **Center the work loop.** The default path is give work, watch progress, resolve approvals, and review results. Everything else is progressive disclosure.
2. **Make state unambiguous.** Running, waiting, blocked, failed, canceled, and completed must be visually and semantically distinct. Unknown is never rendered as healthy.
3. **Put evidence next to claims.** Results link to the plan, tool activity, approvals, sources, and verification that produced them.
4. **Earn trust through control.** Explain consequences before actions, make permissions visible, preserve tenant boundaries, and support safe recovery.
5. **Prefer familiar product patterns.** Standard navigation, forms, dialogs, tables, focus behavior, and responsive layouts should disappear into the task.

## Accessibility & Inclusion

Target WCAG 2.2 AA across authenticated and public surfaces. All workflows must be keyboard operable, screen-reader understandable, robust at 200% zoom, usable without color alone, and functional with reduced motion. Touch targets, focus visibility, live status announcements, contrast, error recovery, and mobile navigation are release requirements rather than polish.
