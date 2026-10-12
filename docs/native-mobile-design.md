# Asael mobile experience

12 October 2026. Android and iOS presentation, version 1.32.0.

## Design revision after phone feedback

The 1.30.0 release added mobile navigation but retained too much of the shared
desktop information hierarchy. This revision changes the actual compositions:
one personal brief and agenda on Today, a conversation-led Assistant, intentional
capture modes, a project notebook, content-first Memory, and grouped preferences.
The dedicated `MobileAppTheme` adapts typography, fields, surfaces and touch
controls while inheriting the existing colour contract. Web and Mac retain their
own theme and presentation boundary.

The design work is recorded in the [Asael mobile Stitch project](https://stitch.withgoogle.com/projects/8430793197862040849).
It contains 35 reference screens: five primary destinations, ten settings and
control screens, twelve Work and knowledge screens, and eight voice, capture,
research and recovery flows. Implementation uses the compositions with the
current native field and action contracts; it is not an import of generated
HTML or a promise of every fictional feature shown in a reference.
Stitch screens are design references with synthetic examples. Generated claims
about hardware, subscriptions, encryption, permission readiness, model names or
health metrics are not product requirements and must not be copied into the app.
Only existing native data and governed actions can populate the implemented UI.

Pinterest references inspected during this revision:

- [Daily planner and task flows](https://in.pinterest.com/pin/34691859628693056/):
  clear personal entry point, one prominent focus, short agenda rows, and focused
  task editing. Asael retains its own palette and factual task data.
- [Recording interface reference](https://in.pinterest.com/pin/292171094593870801/):
  a dedicated recording stage, useful elapsed time and sparse reachable controls.
  Asael retains its existing consent and real recording state.

Reusable phone controls are in `app/mobile/mobile_page_scaffold.dart`:
`MobileSurface`, `MobileSegmentBar`, `MobileStatusPill`, headers and grouped action
rows. Short option sheets scroll with the keyboard. Segments scroll when text
scaling or long category names cannot fit. Spotlight surfaces provide their own
readable dark theme rather than assuming surrounding text colours.

## Product direction

The owner checks Asael on a phone between meetings, captures conversations and documents, speaks to ATLAS and follows up on client work. A phone screen should answer one question at a time and put the next action within reach. The phone has its own composition while retaining the web palette and the existing controllers, scoped repositories and governed actions.

The installed mobile boundary is `usesMobilePresentation()`, independent of the Mac boundary. It recognizes native Android and iOS; tablet width changes layout within that boundary. The existing web and Mac surfaces retain their established composition.

## Navigation

Five labeled destinations stay in a stable order: Today, Assistant, Capture, Work and Library. The current destination remains obvious through icon, text and gold selection treatment. The existing lazy StatefulShellRoute retains branch state. Re-selecting a destination does not discard a draft or reset a nested page. Hide the dock while the keyboard is open. On wide tablets the same five destinations use a rail.

Library is a lightweight grouped index of Memory, saved files, History, Markets, Inbox, Meetings, Follow-ups, Agents, Capabilities, Payments, Settings and Security. Its search filters this index locally. It does not fetch every workspace or start their controllers. Search your content is a separate explicit action. Connections stay inside Capabilities. Quality Checks and Monitoring stay inside Settings.

The mobile shell does not add a duplicate page title above each feature. Features provide a single meaningful header. Use focused details with Back navigation; short filters and choices use keyboard-aware sheets. Longer reading and editing use full pages. Every gesture has a visible alternative.

## Shared visual language

Keep the production palette exactly: light canvas #FAF9F6, white surface, charcoal #242321, gold #806019; dark canvas #191A1B, surface #222325, ink #F4F1EA and gold #E2BD74. Consume AppTheme and its semantic tokens, not page-specific color constants. Status has a readable label, not a color-only dot. Preserve high contrast and text scaling.

Use system sans typography, 30dp primary page titles, 20–24dp detail headings,
16dp primary rows and reading text, 14–15dp controls and 13dp supporting text.
Screen gutters are generally 20dp, with 12–16dp inside grouped content. Controls
retain at least 48dp touch targets. A row grows with its content; fixed-height
cards must not clip larger text.

Gold identifies selected navigation, useful actions and ATLAS details. Lists use hierarchy, spacing and dividers; there is no repeated ornamental card grid. No decorative blur or animated background. Motion is finite, normally 180–220ms, respects the system preference and never delays access to content. ATLAS animation remains tied to its real state and existing power/lifecycle preferences.

## Screen families

| Surface | Mobile composition |
| --- | --- |
| Today | Personal date and next action, useful brief, focused tasks and agenda; lazy slivers |
| Assistant | Dominant conversation, thumb-reachable composer, compact model/context selection, options sheet, expressive voice with visible mute/end |
| Capture | Note, Scan, Files and Listen choices; progressive metadata; visible save/upload state |
| Listen | Conversation summary and next actions first; transcript available separately; nightly setup accessible |
| Work | Searchable work list, readable state and next task, compact filters; focused plan/tasks/files/build details |
| Memory | Memory, Sources and Map as common entries; explicit advanced tools, stable bounded graph and scoped detail |
| Meetings / Follow-ups | Agenda or outcomes list, focused detail and reachable creation/editing |
| History | Results and Timeline, readable outcome rows and source detail on demand |
| Agents / Markets | Readable specialists or market brief, meaningful status/evidence; technical records secondary |
| Capabilities | Connections, skills and automation catalogue; clear existing native/browser boundaries |
| Inbox / Payments | Consequence and exact inputs before governed decisions; preserve existing read-only limits |
| Settings / Security | Grouped preferences with selected detail; clear access, data, device and decision information |
| Search / Authentication | Focused search and keyboard-aware sign-in/recovery; existing scope and session protection |

Native contract v55 adds CSM client briefs, role notes, exact Library source links and a scoped Assistant draft handoff. Mobile Work now separates Clients, My role and Projects. Client creation reuses the created project if saving its initial brief is interrupted. The Assistant handoff selects Client Success Partner, confirms replacement of any existing draft, and never sends automatically. The server adds the latest role and client context when the selected client is used. Existing v54, v53 and v52 clients remain supported; the installed Mac is not forced into an incompatible upgrade.

The completion pass also adds phone-sized nested forms, readers and reviews across Voice, Work, Memory, Meetings, Follow-ups, Results, Capabilities, Agents and Settings. `MobileFlowScaffold` provides keyboard-aware scrolling and a reachable action footer without owning feature authorization. Voice Options unifies model/context information, appearance, personality and behaviour; changes that affect a new call are labelled accordingly.

Android file export uses a two-step destination flow. The Android picker receives no private bytes; normal app locking still applies. After unlocking, the user explicitly verifies and saves freshly downloaded content into the chosen destination. Owner/API binding and byte/hash validation remain mandatory. Private exports are not copied into a public Downloads path automatically.

Browser handoffs remain explicit for external account consent and unsupported privileged operations; they do not transfer native credentials. Native source upload, client edits, role context, memory actions, connection registration/import/discovery/rotation/removal and normal app work use the phone UI.

## Performance and authority

Use lazy list/sliver builders for repeated records, one principal scroll owner per screen and existing bounded projections. Avoid nested long shrink-wrapped lists, intrinsic sizing of large content and eager mounting of detail/Build/maintenance workspaces. Keep rebuilds local and static children outside animation builders. Retain scroll state, lifecycle suspension and background/offscreen animation guards.

No navigation or presentation callback may create authorization. Keep current tenant/actor scope, approvals, idempotency, device consent, recording state and explicit confirmations. Private detail sheets remain inside the current authorized route or invalidate with its scope. Sign-in, biometric locks, capture queues, nightly jobs and original call files are unchanged.

## Research

The decisions above adapt primary platform guidance to Asael rather than reproducing a desktop screen at a smaller width:

- [Android adaptive navigation](https://developer.android.com/develop/adaptive-apps/guides/build-adaptive-navigation): compact bottom navigation and larger-screen rails.
- [Apple tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars): stable destinations, visible labels and persistent navigation context.
- [Apple sheets](https://developer.apple.com/design/human-interface-guidelines/sheets): short contextual tasks and clear dismissal.
- [Android touch targets](https://support.google.com/accessibility/android/answer/7101858): 48dp interaction targets.
- [Flutter adaptive design](https://docs.flutter.dev/ui/adaptive-responsive/general): adapt composition to the device and available space.
- [Flutter platform adaptations](https://docs.flutter.dev/ui/adaptive-responsive/platform-adaptations): native back, input and scrolling conventions.
- [Flutter performance practices](https://docs.flutter.dev/perf/best-practices): local rebuilds, lazy collections and avoiding expensive rendering operations.

Validation for this release uses compilation, signed builds and focused on-device inspection. Test suites and audits are deferred at the owner’s request. No frame-rate or memory improvement is claimed without measurement.

The optional `tool/mobile_design_preview.dart` entrypoint renders the actual
Library and shared phone components without application bootstrap, sessions,
repositories or device bridges. Other preview pages are explicitly sample
compositions. It can be compiled with `flutter build web --release --no-pub
--target=tool/mobile_design_preview.dart --output=build/mobile-design-preview`.
This provides visual checks for light/dark and larger text without disabling
Android's protected screenshot boundary. It does not validate live feature
data, recording, authentication or the complete installed application.


## 1.32 completion coverage

| Area | Implemented phone flows |
| --- | --- |
| Work / CSM | Clients, role notes, briefs, source linking and removal, new client recovery, dedicated partner setup and owner-bound Assistant drafts |
| Projects | Creation, tasks, plans, deliverables, artifact feedback, archive and active native Build workspace |
| Assistant / Voice | History, progress, results, prompt queue, draft editing, context search and selection, approvals, unified Voice Options |
| Capture / Listen | Recording stage, named person/project selection, processing receipt, conversation and cited-source reader |
| Memory | Editing, provenance, source selection, Map filters, recall, promotion, maintenance and deletion-impact reviews |
| Meetings / Follow-ups | Editors, local date/time selection, recording and calendar reviews, commitment/lifecycle confirmation |
| History / Results / Markets | Existing phone readers plus full-screen action reviews and Android file destination/save flow |
| Settings / About me | Grouped native profile editor, AI settings and workspace administration with focused details |
| Capabilities / Agents | Native connection setup/import/discovery/rotation/removal/trash, specialist and skill editing, governance/permission review |
| Security / Quality / Monitoring | Grouped entry points and guarded full-screen readers for the native-supported operations |
| Navigation / Today / Library / Inbox / Payments / Search / Authentication | Dedicated phone compositions delivered in 1.31 retained and integrated with these child flows |

Native write support is not claimed for browser-only provider credential changes,
archive restoration, payment signing, evaluation/monitoring writes or signed
retention/audit administration. External consent and OS permissions retain their
normal destination. Android saving is bounded to 32 MiB with an expiring one-use
destination; iOS file export is not enabled by this Android release. These are
functional platform boundaries, not placeholder success states.

Compilation and release checks are recorded separately from full interaction
coverage. Test suites, analyzer and audits remain deferred by the owner.
