# OmniAgent Design System

This document is the Stitch-compatible design handoff for the Flutter product.

## Direction

**Scene:** One owner checks a long-running agent system throughout the day, often one-handed on a phone and later at a wide desktop, under changing ambient light. The interface must remain calm, exact, and immediately legible while work is moving.

**Visual thesis:** A precision console made from quiet graphite and clean mineral surfaces, with emerald reserved for agency and amber reserved for human attention.

**Color strategy:** Restrained. Neutral surfaces carry the product; semantic colors communicate action, risk, status, and evidence. Decorative color is not used.

## Themes

### Light

- Canvas `#F7F9FA`
- Surface `#FFFFFF`
- Raised surface `#F0F4F3`
- Ink `#10201E`
- Muted ink `#536864`
- Hairline `#D5DFDC`
- Primary `#087A5B`
- Primary container `#C9F4E4`
- Attention `#9A6700`
- Danger `#B4232C`

### Dark

- Canvas `#0C1211`
- Surface `#121B19`
- Raised surface `#1A2522`
- Ink `#E8F1EE`
- Muted ink `#A8BAB5`
- Hairline `#30413C`
- Primary `#51D0A2`
- Primary container `#164C3C`
- Attention `#F0BE58`
- Danger `#FF7A82`

Both themes meet WCAG 2.2 AA for body copy and preserve semantic meaning without relying on color alone.

## Typography

Use the platform sans family throughout. Headings use weight 700 and modest negative tracking. Operational labels use weight 600, never decorative all-caps sentences. Monospace is reserved for IDs, timestamps, code, model names, and signed evidence.

| Role | Size | Weight | Line height |
| --- | ---: | ---: | ---: |
| Display | 36 | 700 | 1.12 |
| Page title | 28 | 700 | 1.18 |
| Section title | 20 | 700 | 1.25 |
| Body | 15 | 400 | 1.45 |
| Label | 13 | 600 | 1.30 |
| Detail | 12 | 500 | 1.35 |

## Shape and Spacing

- 4dp base grid; common spacing 8, 12, 16, 24, 32.
- Controls use 10dp corners; interactive surfaces use 12dp; sheets use 16dp.
- Pills are limited to filters, compact status, and segmented choices.
- Touch targets are at least 48dp.
- Borders define dense regions. Shadows are reserved for floating overlays and never paired with ornamental borders.

## Layout

- Compact `<600dp`: five primary destinations, contextual bottom sheets, drill-down detail.
- Medium `600–1023dp`: navigation rail and flexible two-column content.
- Expanded `>=1024dp`: extended rail, master-detail workspaces, persistent evidence inspector where useful.
- Content width is capped at 1440dp. Reading text is capped near 72 characters.

## Components

- **App frame:** adaptive navigation, current-work context, status-aware destination selection.
- **Workspace header:** page title, one-line scope, primary action, refresh/status utility.
- **State marker:** icon, label, and semantic color for running, waiting, blocked, failed, canceled, and completed.
- **Interactive surface:** border or tonal fill, never both border and broad shadow.
- **Evidence row:** source, timestamp, integrity state, and direct action.
- **Risk decision:** consequence, reversibility, requester, trust evidence, and explicit verb-object actions.
- **Resource state:** skeleton, useful empty guidance, stale state, partial error, full error, forbidden, offline.

## Motion

- Standard duration 180ms; emphasized state change 240ms; micro-feedback 120ms.
- Curves use emphasized deceleration without bounce.
- Navigation uses a short fade-through; inspectors use shared-axis movement; live content crossfades in buffered batches.
- Repeated lists do not animate every row on every refresh.
- Animations stop when offscreen, avoid blur filters and layout thrash, and collapse to crossfades or instant changes when reduced motion is enabled.

## Page Families

- **Today:** editorial priority strip plus operational agenda, with attention surfaced before activity.
- **Talk:** transcript as the dominant plane; stage, tools, plan, citations, and evidence remain adjacent.
- **Capture:** one strong composer that expands by modality; upload/index progress stays inline.
- **Missions and Projects:** state rail, task progression, attempts, artifacts, and proof in responsive master-detail.
- **Inbox:** decision queue ordered by risk and urgency; each item explains consequence before action.
- **Results:** evidence ledger with filters, verification state, and compact inspectors.
- **Agents and Knowledge:** searchable workspace with relationship map and structured inspector.
- **Administration:** dense domain navigation, health summary, resource list, and progressive configuration detail.

## Prohibited Patterns

No decorative glass, gradient text, nested card grids, oversized rounded containers, ornamental animation, ambiguous loading zeros, or color-only status. The authenticated product never uses marketing hero composition.
