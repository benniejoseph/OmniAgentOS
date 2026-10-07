# Asael Design System

This document is the Stitch-compatible design handoff for the Flutter product.

## Current visual system

The warm-neutral and graphite system is the shared production direction for
web and native UI. Its authoritative tokens and interaction rules are in
[the ATLAS system specification](.design/asael-ace-revamp/SYSTEM_SPEC.md).
Use the existing web CSS variables and native theme; do not introduce page-specific
palettes, control shapes or typography. Work, Assistant and Activity share these
controls, readable status language and compact row patterns.

The owner requested the original raster mascot be replaced on 7 October 2026.
ATLAS now uses an original vector Lottie companion; the earlier eagle studies
remain historical design references, not the production asset direction.

## Direction

**Scene:** One owner checks a long-running agent system throughout the day, often one-handed on a phone and later at a wide desktop, under changing ambient light. The interface must remain calm, exact, and immediately legible while work is moving.

**Visual thesis:** A precision console made from quiet graphite and clean mineral surfaces, with a restrained gold accent and semantic colors for attention and outcomes.

**Color strategy:** Restrained. Neutral surfaces carry the product; semantic colors communicate action, risk, status, and evidence. Decorative color is not used.

## Product language

Use familiar names and plain-language status messages in everyday screens.
Show document titles, client names, readable model names, and meaningful next
steps. Keep internal IDs, hashes, event names, routing messages, storage fields,
and implementation terminology in the backend or explicitly opened diagnostics.
Do not replace missing evidence with a reassuring claim: explain what needs
review in ordinary language, with source details available on demand. Preserve
user-entered names and the underlying identity, permissions, and evidence.

## Themes

### Light and dark

The production palette is the shared semantic contract in
[the system specification](.design/asael-ace-revamp/SYSTEM_SPEC.md#1-semantic-color-contract).
Light uses warm near-white `#FAF9F6`, white surfaces, charcoal `#242321`, and
gold `#806019`. Dark uses graphite `#191A1B`, `#222325` surfaces, light ink
`#F4F1EA`, and gold `#E2BD74`. Success, warning, danger and information use their
existing semantic tokens with readable text and icons.

Components consume tokens rather than copying these colors. All new UI supports
both themes, keyboard focus, reduced motion, responsive layout and readable
empty/error states. Global token inheritance alone does not establish that a
screen has been visually verified.

## Typography

Use Geist Sans on web and the system sans on native. Headings and operational labels use weight 600 with modest heading tracking. Use the system specification’s 28px page, 20px section, 16px item, 14px UI and 13px supporting scale. Monospace is reserved for actual code and explicit technical details; readable model names and timestamps use normal UI type.

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
- Assistant and Work use the available screen width with responsive controls.
  Other reading surfaces may cap content at 1440dp; long prose stays readable.

## Installed macOS application

The installed application has its own presentation layer. It reuses the same
controllers, repositories, generated contracts, and server authority as Android
and web, but it does not reuse their page composition. The branch is activated
only for a non-web macOS target.

- Use the native system typeface, unified compact title bar, permanently labelled
  source sidebar, keyboard focus rings, pointer hover states, conventional menus,
  and 32–38pt desktop control heights.
- Prefer a three-part desktop workspace: searchable or filterable source list,
  dominant working canvas, and a resizable 270–460pt inspector. Collapse the
  inspector to an explicit sheet below the minimum useful width. Inspector
  dividers must support pointer drag, keyboard arrows, focus indication, and
  adjustable accessibility semantics.
- Use border-separated tables and ledgers for repeatable records. Avoid mobile
  card stacks, oversized touch spacing, pull-to-refresh, marketing heroes,
  ornamental glass, and decorative 3D scenes.
- Preserve selection while data refreshes. Search and filter locally after one
  bounded projection load; never restart a visualization because the pointer
  moved. Expensive detail and Build Studio surfaces load only when selected.
- Keep exact status, freshness, source, actor, and approval context visible beside
  every consequential action. Destructive device, run, and project actions retain
  explicit confirmation and the existing governed mutation path.
- Support wide monitors without stretching prose: lists and evidence canvases may
  expand, reading columns remain bounded, and inspectors remain resizable.

The macOS route families are:

- **Work:** Today command desk, Conversation cockpit, focused Capture intake,
  Project browser/detail/Build Studio, Meeting agenda/detail, and Results ledger.
- **Knowledge:** practical indexed Memory browser with stable pan/zoom graph,
  Agent roster/capabilities/outcomes, and the market research terminal.
- **Review:** attention Inbox and approval detail, trusted read-only Payments,
  Quality Checks, and evidence inspectors.
- **Control:** Workflows, Integrations, Tools, Monitoring, Security, model/provider
  Settings, and a signed-installation Devices & Security ledger.
- **Lifecycle:** native sign-in, protected-session bootstrap, Quick Entry, auxiliary
  windows, empty/loading/error/offline states, and narrow-window inspector sheets.

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
