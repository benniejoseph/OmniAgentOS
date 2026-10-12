# Asael mobile experience

12 October 2026. Android and iOS presentation, version 1.30.0.

## Product direction

The owner checks Asael on a phone between meetings, captures conversations and documents, speaks to ATLAS and follows up on client work. A phone screen should answer one question at a time and put the next action within reach. The phone has its own composition while retaining the web palette and the existing controllers, scoped repositories and governed actions.

The installed mobile boundary is `usesMobilePresentation()`, independent of the Mac boundary. It recognizes native Android and iOS; tablet width changes layout within that boundary. The existing web and Mac surfaces retain their established composition.

## Navigation

Five labeled destinations stay in a stable order: Today, Assistant, Capture, Work and Library. The current destination remains obvious through icon, text and gold selection treatment. The existing lazy StatefulShellRoute retains branch state. Re-selecting a destination does not discard a draft or reset a nested page. Hide the dock while the keyboard is open. On wide tablets the same five destinations use a rail.

Library is a lightweight grouped index of Memory, saved files, History, Markets, Inbox, Meetings, Follow-ups, Agents, Capabilities, Payments, Settings and Security. Its search filters this index locally. It does not fetch every workspace or start their controllers. Search your content is a separate explicit action. Connections stay inside Capabilities. Quality Checks and Monitoring stay inside Settings.

The mobile shell does not add a duplicate page title above each feature. Features provide a single meaningful header. Use focused details with Back navigation; short filters and choices use keyboard-aware sheets. Longer reading and editing use full pages. Every gesture has a visible alternative.

## Shared visual language

Keep the production palette exactly: light canvas #FAF9F6, white surface, charcoal #242321, gold #806019; dark canvas #191A1B, surface #222325, ink #F4F1EA and gold #E2BD74. Consume AppTheme and its semantic tokens, not page-specific color constants. Status has a readable label, not a color-only dot. Preserve high contrast and text scaling.

Use system sans typography, 24dp page titles, 20dp sections, 16dp primary rows and reading text, 14dp controls and 13dp supporting text. Screen gutters are generally 20dp, with 12–16dp inside grouped content. Controls retain at least 48dp touch targets. A row grows with its content; fixed-height cards must not clip larger text.

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

This is a presentation release. Native Work currently exposes projects, tasks and artifacts; the web CSM client/role-context workspace is not represented by the current native contract. A redesign must not imply that unavailable native functionality exists. Connection-management browser handoffs likewise remain explicit where required.

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
