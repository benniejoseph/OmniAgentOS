# UI and ATLAS priority — 4 October 2026

The owner explicitly prioritized the UI revamp and ATLAS, asking to stabilize the current release and return to connector expansion afterward. The full implementation plan remains in scope; this changes execution order.

PR53 is stabilized and merged with all sixteen hosted checks passing. The current
visual release is PR54. Connector work is preserved in
`codex/native-connector-controls` and is deferred until after this UI/ATLAS priority.

Visual thesis: a warm, precise conversation workspace with a quiet graphite rail, readable typography, restrained gold and an expressive umber eagle.

Content plan: one orientation header, a focused conversation column and compact ATLAS status, then a slim composer; expose model, Agent, context, queue and authority details through deliberate accessible controls. Keep operational warnings and required decisions visible.

Interaction thesis: immediate focus/press feedback, brief interruptible disclosures with preserved drafts and scroll, and bounded ATLAS expressions driven by real state. No ornamental idle loops or fabricated progress.

Owned work:

- Root: shared web shell, preference compatibility, serial visual/build validation and release stabilization.
- Web presentation: Assistant, companion presence and scoped composer/message presentation.
- Native presentation: Talk, companion presence, Today and dense Work detail, preserving controllers and platform behavior.
- ATLAS: sculpt04 prototype refinement against the approved eagle; root reviews actual renders before any publication.

The approved reference in `DESIGN_BRIEF.md` remains authoritative. Sculpt02 remains rejected. New source is not visual approval, and a passing build does not complete the art or physical-device gates.

## Implemented UI checkpoint

The web shell begins with the compact rail while preserving an explicit expanded
preference. Assistant has one title, a 720px reading column, compact ATLAS status,
and attachment/text/voice/send controls. Secondary options, feedback and queue
detail are disclosed; errors, decisions and uncertain recovery remain visible.
The phone composer reserves bottom-navigation space, including when its own long
draft or options need scrolling. Map menus retain real pointer hit testing.

Web Voice now has an expanded desktop stage and a compact phone composition with
visible action controls. Actual microphone and playback state remain authoritative;
consent, exact reviewed send, interruption and text continuity use existing paths.

Native Talk uses a bounded reading column and simplified composer. Today replaces
the Daybook hero with a compact brief and focus list. Work detail brings task state,
Agent, outcome and actions ahead of routine identifiers, using an 880px desktop
column and scoped disclosures. Approval consequences and exact inputs stay visible.

Evidence is retained in the `ui-validation` release directory. The maintained web
interaction/Voice capture suite passes 107 checks; companion presence passes 73,
including 320px/200% text, forced colors and scope replacement. Full Flutter analysis
is clean. Selected native Talk/companion, Today and Work checks pass; eight actual
widget captures cover Talk, Today, dense Work and exact Inbox. The temporary capture
harness is archived with the images, not added to the application test suite.
Those captures use synthetic data and system-font loading (San Francisco substitutes
for Android Roboto); they do not establish physical-device or microphone acceptance.

App version `1.23.13+48` is reserved for this UI release. The deferred connector
checkpoint must advance its build version when resumed. This UI change introduces
no database migration or native API contract version.

## Release correction checkpoint

The universal private Mac package `Asael-1.23.13-48-macOS.dmg` was built from
`2fe00481f8505d9ffa241fb9553e095011eb03e9`; its SHA256 is
`d38b7787c35ee757cb443a58b41a7a7ba7df5bb99b41c4d076d46d87bd9c5c68`.
Both architectures and version metadata are verified. Nested signatures are
verified in local/private signing mode; this is not Apple notarization.

Hosted review exposed a required-prop test typing error, outdated theme/menu
fixtures, Search layering at 200% text and an undersized Connections link.
Search now uses a body portal with reversible background inert state and a
scrollable panel; phone navigation labels wrap within their columns. Native
corrections affect tests only, so packaged application code remains unchanged.
The affected native files pass all forty cases and the shell/palette files pass
twelve cases. A fresh-data integration timeout is addressed by analyzing only
the test fixture tables after bulk seeding; all ten Account projection cases
pass locally with the original application timeout and RLS assertions intact.
The complete corrected hosted cycle still determines release acceptance.

PR54 is accepted: all sixteen hosted checks pass on
`4e62457533a3a57a4cf4470c353a1bfe5f67a1b2`, including the production build,
Flutter and PostgreSQL integration. It merged on 4 October 2026 at 08:29:52 UTC
as `cab9d5f77066872ae9a9a3b4f7a68a76cc6b0ea2`.

## Static full-body greeting

The next bounded ATLAS change uses the already-approved first full-body pose in
empty, idle Assistant/Talk. It retains the source's pale studio background and
does not publish a 3D model or any state animation. Active conversations, work
and audio keep their existing portrait presentation. The greeting is at most
144px high, reducing to 96px on constrained screens; hidden-character preference,
scope replacement and neutral-image fallback remain authoritative.

Identical 211×432 PNGs and crop/source provenance are enrolled in web and native
asset roots. Each PNG is 84,847 bytes, SHA256
`cb5db22c48af8e2f883be9b256226a50b4d26f97c82e516b3c240e9aa691eb53`.
App version `1.23.14+49` is reserved for this follow-up. Connector work must use a
later build number when resumed. Full Flutter analysis and 21 focused cases pass;
five native widget captures cover light/dark desktop, phone, 200% text and the
populated state. These synthetic captures do not establish physical-device or
microphone acceptance. Web visual review and the exact hosted cycle remain the
release gate. No separate portrait/material study was saved; sculpt04 remains
the latest exported, unaccepted 3D prototype.

## ATLAS boundary

Sculpt04 is exported and structurally checked: 41,580 triangles, a 1,750,516-byte
GLB, fourteen bones and twelve clips, with all nine geometry/lifecycle checks
passing. Actual turnaround and blink review still finds a likeness/finish gap.
No new artwork has been published. The approved concept portrait remains active;
the final authored model, material pass, convincing facial closure, full-body
greeting delivery and state-performance/device acceptance remain open.
