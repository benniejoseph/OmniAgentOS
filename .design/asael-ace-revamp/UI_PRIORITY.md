# UI and ATLAS priority — 4 October 2026

The owner explicitly prioritized the UI revamp and ATLAS, asking to stabilize the current release and return to connector expansion afterward. The full implementation plan remains in scope; this changes execution order.

The current feature release is PR53, separate from this visual branch. Connector work is preserved in `codex/native-connector-controls` and is not part of this UI release.

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

## ATLAS boundary

Sculpt04 is exported and structurally checked: 41,580 triangles, a 1,750,516-byte
GLB, fourteen bones and twelve clips, with all nine geometry/lifecycle checks
passing. Actual turnaround and blink review still finds a likeness/finish gap.
No new artwork has been published. The approved concept portrait remains active;
the final authored model, material pass, convincing facial closure, full-body
greeting delivery and state-performance/device acceptance remain open.
