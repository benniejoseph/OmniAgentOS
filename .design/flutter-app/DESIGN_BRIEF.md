# Design Brief: OmniAgent Flutter App

## Problem

Operators need to capture work, direct autonomous agents, monitor execution, approve consequential actions, and verify results from anywhere. The web product exposes this power, but its breadth, desktop-oriented administration, and lack of a native client make fast mobile supervision and capture unnecessarily difficult.

## Solution

A production iOS and Android client for the complete OmniAgent platform. It preserves the existing Next.js/Postgres system of record and presents every capability through an adaptive, role-aware workspace: capture instantly, converse with agents through live streams, manage durable work, resolve approvals, inspect evidence, and administer the platform.

## Experience Principles

1. **Operational clarity over spectacle** -- live state, risk, ownership, and next actions are always legible.
2. **Progressive disclosure over feature reduction** -- every web capability is present, while advanced controls stay contextual.
3. **Confidence over false immediacy** -- optimistic interactions are reserved for safe local state; consequential actions show server confirmation and evidence.

## Aesthetic Direction

- **Philosophy**: Precision instrument -- Linear-style restraint with a tactile, dark technical surface and warm emerald signal color.
- **Tone**: Calm, exact, capable, quietly futuristic.
- **Reference points**: Linear, Arc, Raycast, modern flight instrumentation, the existing Asael/OmniAgent web palette.
- **Anti-references**: Generic SaaS card mosaics, neon cyberpunk clutter, glassmorphism everywhere, ornamental gradients, chat-only assistants.

## Existing Patterns

- Typography: Geist Sans and Geist Mono on web; Flutter uses Inter/system sans and JetBrains Mono-compatible fallbacks.
- Colors: warm light neutrals, cool near-black dark surfaces, emerald primary, amber accent, semantic success/warning/danger/info.
- Spacing: dense operational layouts with compact labels and clear section rhythm.
- Components: authenticated shell, command palette, notifications, workspace readiness, resource states, live agent transcript, mission inspector, and domain consoles.

## Component Inventory

| Component | Status | Notes |
| --- | --- | --- |
| Adaptive app shell | New | Bottom destinations on phones; rail/sidebar on larger screens. |
| Session gate and login | New | Password first; mobile OAuth handoff follows backend contract. |
| Command palette | New | Global navigation and action search. |
| Resource state | New | Loading, empty, stale, partial, error, forbidden, offline. |
| Live status rail | New | Shared mission/workflow/run state language. |
| Streaming transcript | New | Buffered SSE rendering, tools, citations, approvals, evidence. |
| Risk and approval sheet | New | Risk tiers, quorum progress, reasons, confirmation. |
| Evidence inspector | New | Runs, trajectories, artifacts, reports, signatures. |
| Capture composer | New | Text, files, camera, audio, URLs, tags, offline outbox. |
| Data explorer | New | Search, filters, cursor pagination, split-pane detail. |
| Graph canvas | New | Memory and agent relationship maps. |
| Admin form system | New | Connectors, tools, evaluations, monitoring, security, identity. |

## Key Interactions

- Login establishes a secure device session, then bootstrap returns permissions, readiness, counters, and version policy.
- Talk streams agent events into a five-stage working surface and can transition into a durable workflow or waiting approval without losing context.
- Capture saves drafts immediately, queues safe uploads offline, and reports indexing provenance.
- Missions and workflows poll only while active, resume from cursors, and preserve server-authoritative state transitions.
- Consequential mutations show risk, request confirmation, use idempotency keys, and end in verifiable evidence.
- Navigation and actions adapt to viewer, operator, admin, and system permissions without weakening backend enforcement.

## Responsive Behavior

- Phone: five primary destinations (Today, Talk, Capture, Work, Inbox), contextual sheets, full navigation drawer.
- Tablet: navigation rail, primary workspace, optional inspector.
- Desktop: grouped sidebar, dense lists, persistent detail inspector, keyboard-first command palette.
- Admin surfaces remain complete on phone through staged forms and drill-down routes rather than compressed tables.

## Accessibility Requirements

WCAG 2.2 AA contrast; semantic labels and live-region announcements; logical focus traversal; visible focus; 48dp touch targets; dynamic text without clipping; keyboard support; reduced motion; high-contrast theme; color never as the only state indicator.

## Performance Requirements

Smooth 60/120 Hz scrolling, bounded list rendering, batched SSE deltas, cursor pagination, stale-while-revalidate reads, background-aware polling, isolates for large reports/graphs, explicit image dimensions, and telemetry for startup, frame time, API latency, SSE first token, and crashes.

## Scope

All authenticated web capabilities: Today, Talk, Capture, Missions, Projects, Results, Inbox/Approvals, Agents/Skills, Memory/Knowledge, Workflows/Triggers/Operations, Integrations, Tools, Evaluations, Monitoring, Security, and Settings. Legal, help, privacy, and account surfaces remain reachable.

## Out of Scope

- Replacing Postgres, first-party auth, RBAC, orchestration, or audit state with Firebase.
- Shipping database, model-provider, connector, cron, or internal-auth secrets in the client.
- A visual clone of the web implementation; behavior and capability parity are required, with native interaction patterns.
