# Asael Design System

This is the shared product-design contract for web, macOS, and installed mobile.
The 30 October 2026 revamp follows a personal working desk: quiet navigation,
a focused task canvas, and useful context that opens when needed.

## Current visual system

The porcelain and deep-teal system is the shared direction for
web and native UI. Its authoritative tokens and interaction rules are in
[the ATLAS system specification](.design/asael-ace-revamp/SYSTEM_SPEC.md).
Use the existing web CSS variables and native theme; do not introduce page-specific
palettes, control shapes or typography. Work, Assistant and Activity share these
controls, readable status language and compact row patterns.

The owner requested the original raster mascot be replaced on 7 October 2026.
ATLAS uses an original Scout character with an ivory shell, charcoal face,
expressive eyes, articulated hands and restrained gold details. Its authored
Lottie gestures use LottieFiles character references; the earlier eagle studies
remain historical design references, not the production asset direction.

## Direction

**Scene:** One owner checks a long-running agent system throughout the day, often one-handed on a phone and later at a wide desktop, under changing ambient light. The interface must remain calm, exact, and immediately legible while work is moving.

**Visual thesis:** A personal working desk with porcelain reading surfaces, deep-teal actions, and an ink-dark counterpart. The work and its outputs carry the visual emphasis; Scout supplies character without competing with the task.

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
Light uses porcelain `#F5F7F8`, white surfaces, ink `#1E293B`, and
deep teal `#216B62`. Dark uses `#111719`, `#182225` surfaces, light ink
`#E8EFF1`, and sea-glass `#85D1BF`. Scout retains its authored gold details. Success, warning, danger and information use their
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

- Compact layouts use four primary destinations, contextual sheets and drill-down detail.
- Web navigation becomes a rail at 768px and an expanded sidebar at 1024px.
  Native mobile keeps its touch dock below 840dp of usable window width.
- Native feature panes can reveal list/detail or task/context at 720dp of local
  available width, independently of the navigation breakpoint. Mac keeps its
  pointer-oriented sidebar and reveals inspectors only when the content fits.
- Conversation content and its composer use a 768px reading measure. Collection
  workspaces cap at 1408px; Studio and evidence canvases expand when spatial work
  benefits. Use local pane constraints, not the device model or screen diagonal.
- Preserve route, draft, selection and scroll state across resizing. Exclude
  occluding display features; add useful context on expanded screens rather than
  stretching a phone column.

## Installed mobile application

Android and iOS use an explicit `usesMobilePresentation()` boundary and their
own phone composition. The full rationale and platform research are in
[the mobile design guide](docs/native-mobile-design.md). Preserve the web color
contract while adapting navigation, density and interaction to touch.

`MobileAppTheme` adapts the shared colour contract for native phones: system
sans hierarchy, tonal fields, quiet grouped surfaces and 48dp interaction
targets. Use `MobileSurface`, `MobileSegmentBar` and `MobileStatusPill` for
consistent content groups and choices. Dark spotlight surfaces supply their own
text and icon theme. Phone-specific layouts must still read real feature state.

- Four labelled primary destinations: Today, Assistant, My work and Library.
  Capture and Listen remain contextual shortcuts. Library groups remaining
  features and preferences without eagerly mounting every workspace. Creative
  Studio opens the real web workspace through an explicitly labelled handoff;
  it is not the Automation Studio feature or an embedded native editor.
- One feature header per page, generous touch targets, focused detail views,
  compact filter/choice sheets and a keyboard-aware bottom composer. Keep tab
  navigation and drafts when switching; hide the bottom dock during text input.
- Common collections are lazy rows/slivers. Use content height rather than
  fixed desktop cards; preserve text scaling, reduced motion and safe areas.
- Settings uses grouped preferences and a selected detail. Work and knowledge
  use list-to-detail composition. Technical inputs remain available when required
  for an exact approval, but are not the primary labels for everyday records.
- Navigation and content respond independently to available width. Expanded
  mobile panes must preserve touch targets and state through folding; native Mac
  retains its own pointer density and window chrome.

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
  and evidence inspectors.
- **Control:** Workflows, Integrations, Tools, Security, and Settings containing
  model/provider configuration, Quality Checks, Monitoring, and a signed-installation
  Devices & Security ledger.
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

## Conversational personality

Under Companion settings, offer **Butler** (British poise and dry wit) and
**Playful** (quick wit and friendly banter), with short original writing samples.
Describe the choice as saved on this device, applying to the next message or new
voice conversation. Keep it separate from appearance, expressive intensity and
motion. The shared character and delivery rules are defined in
[ATLAS personality](docs/research/atlas-personality.md). No personality selection
starts audio or work. Use friendly product language; omit internal versions and
request fields from the controls.

## Motion

- Standard duration 180ms; panel changes 220ms; micro-feedback 120ms.
- Curves use emphasized deceleration without bounce.
- Navigation uses a short fade-through; inspectors use shared-axis movement; live content crossfades in buffered batches.
- Repeated lists do not animate every row on every refresh.
- Animations stop when offscreen, avoid blur filters and layout thrash, and collapse to crossfades or instant changes when reduced motion is enabled.

### Voice companion

Voice has two owner-selected appearances: **Companion**, a compact dock with a
readable Scout face, short caption, and Mute/End controls; and **Perch**, a larger
free-standing Scout with a temporary caption and the same discoverable controls.
The choice lives under Settings → Companion → Voice appearance. It is saved for
the current account on this device; changing it never restarts the conversation.
Companion is the default. Both appearances share the same voice controller,
microphone state, agent context, and accessibility/motion preferences.

Make Scout expressive through clear eyes, eyelids, mouth, head tilt and hand
gestures at the actual display size. Listening and thinking get distinct finite
entry gestures. During an explicitly started voice conversation, Balanced and
Expressive allow these reactions; the speaking clip may repeat only while real
reply audio is playing. Interruption immediately yields the speaking pose to
listening. Quiet, Reduced, Off, system reduced motion and native low-power mode
retain static state portraits. There is no continuous idle loop. A visible Mac
voice companion must not disappear merely because another application has focus.

Microphone-off status remains separate from speech output: ATLAS may continue
speaking while input is muted. Ending a call is never a task-completion signal.
The character supplements readable status and controls, which remain useful when
the character is hidden. Captions use real conversation text; presentation never
invents audio levels, progress percentages, or phoneme synchronization.

## Page Families

- **Today:** a personal welcome and one useful next action, followed by the daily brief, focus list and agenda. Decisions and overdue work take priority. Collapse completed tasks and omit empty secondary sections; preserve visible unavailable states. ATLAS follows owner visibility and motion preferences.
- **Talk:** transcript as the dominant plane; stage, tools, plan, citations, and evidence remain adjacent.
- **Capture:** one strong composer that expands by modality; upload/index progress stays inline.
- **Missions and Projects:** state rail, task progression, attempts, artifacts, and proof in responsive master-detail.
- **Inbox:** decision queue ordered by risk and urgency; each item explains consequence before action.
- **Results:** evidence ledger with filters, verification state, and compact inspectors.
- **Agents and Knowledge:** a named collection map built from the authorized memory and source catalog. Category branches explain where each saved record belongs; they must not imply inferred factual relationships. Offer title search, collection focus and direct access to the existing inspector. Keep relationship exploration secondary: one selected item, at most 12 direct connections, bounded name disclosure and predictable pan/zoom. Keep technical types and IDs in optional details. Make Delete memory discoverable, then explain the exact permanent impact before the final action.
- **Administration:** dense domain navigation, health summary, resource list, and progressive configuration detail.

## Prohibited Patterns

No decorative glass, gradient text, nested card grids, oversized rounded containers, ornamental animation, ambiguous loading zeros, or color-only status. The authenticated product never uses marketing hero composition.

Desktop navigation starts with Today, Assistant, My work, Visual Studio and Library. Secondary destinations remain available in More and navigation search. History brings Results and Timeline together lower in the menu. Connections live inside Capabilities; Quality Checks and Monitoring are categories inside Settings, with no separate workspace-navigation entries. Open those operational surfaces only when selected; entering Settings must not run checks or monitoring actions. Motion should clarify selection, expansion and focus, stop after the transition and respect reduced-motion preferences. Security begins with Your access, Your data and Recent decisions; technical identifiers and maintenance controls require deliberate expansion.

## Research basis for the October 2026 revamp

- [Impeccable](https://github.com/pbakaus/impeccable) and [Anthropic frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md): intentional composition, distillation and consistent finishing.
- [Flutter adaptive guidance](https://docs.flutter.dev/ui/adaptive-responsive/best-practices) and [Android canonical layouts](https://developer.android.com/develop/ui/views/layout/canonical-layouts): local width decisions and retained state across window changes.
- [Apple motion guidance](https://developer.apple.com/design/human-interface-guidelines/motion) and [Motion accessibility](https://motion.dev/docs/react-accessibility): short feedback with an equivalent reduced-motion state.
- [Linear’s 2026 refresh](https://linear.app/now/behind-the-latest-design-refresh): reduce competing chrome as features accumulate. This informs hierarchy, not copied branding.

Use existing CSS, Flutter implicit transitions and Scout Lottie assets. No extra
animation framework is necessary for the interactions described here.
