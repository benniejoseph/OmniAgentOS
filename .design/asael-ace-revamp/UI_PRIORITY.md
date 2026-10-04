# UI and ATLAS priority — 5 October 2026 (IST)

The owner explicitly prioritized the UI revamp and ATLAS, asking to stabilize the current release and return to connector expansion afterward. The full implementation plan remains in scope; this changes execution order.

PR53 is stabilized and merged with all sixteen hosted checks passing. The UI, static greeting, personality and expanded Voice releases are accepted
through PR57. Final character artwork and device acceptance remain active. Connector work is preserved in
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

## Native Automation acceptance — 5 October

PR58 is accepted and merged after all sixteen hosted checks passed on
`52e54d2cd14ccc4501d23b46367e94dcd9e30b16`; its merge is
`d7b5bca4292dd6c8f31c09fdd949c04cd0556f9c` at 20:43:05 UTC. Both native
Automation presentations now open recent/occurrence run output in the existing
Results detail using the exact validated workflow identity. Back retains the
selected section while private inventory/history still dispose and reload through
existing access checks. Full Flutter analysis and six focused actual-router cases
pass. No migration or API version change is introduced.

The universal private package `Asael-1.23.16-51-macOS.dmg` is verified from that
accepted head, including version, both architectures and nested signatures on the
read-only mounted image. SHA256:
`3616583ca5151a8373355e2f7f7b35df22739c05439965e0c37983018c79de9f`.
Signing is local/private, not Apple notarization. The installed application and
canonical production revision are unchanged. Paired v38 server promotion still
requires the complete operator release environment. Parked connector work must
use build 52 or later.

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
microphone acceptance. All 39 focused web greeting checks pass, including
hidden-character preference, exact neutral-image fallback and return to the
compact conversation portrait. Visual review found and corrected draft crowding
at 320px with 200% text: controls wrap below the draft, preserving 198px of usable
text width and a reachable Send control above navigation. The exact hosted cycle
remains the release gate.

The private Mac greeting package `Asael-1.23.14-49-macOS.dmg` was built from
`38839901326f7a065a25235a898aaf0195ce1529`; its SHA256 is
`053f382551b221f1b774bf088098a25033571ac6d882df135e81bef064cd329e`.
The later composer correction changes only web CSS and browser verification;
packaged native application code is unchanged. Signing is local/private,
not Apple notarization.

At this greeting checkpoint, no separate portrait/material study was saved and
sculpt04 was the latest complete 3D export. Later beak/throat refinements are
recorded below and remain separate from the approved static greeting.

## ATLAS boundary

The latest separately archived art study is grain02: 27,543 vertices, 49,844 triangles,
a 2,494,008-byte GLB, fourteen bones, twelve clips and one embedded 1024px color map.
The smooth throat, shorter crown, completed breast fold, fitted wing coverts and
settled body tufts remain retained. Sixty-four before/after captures support subtle
continuous body-color variation while preserving the old throat pixels and all
geometry, rig and clips. The small-size visual gain remains modest.

The full export at `2026-10-04T20:49:56.541894+00:00` verifies seventeen sources,
104 artifacts and 156 archive members. Nine model/lifecycle and ten static-tool
checks pass. Forty source/export captures show eight pixel-identical rest pairs and
twelve posed pairs differing at 0–10 pixels by at most one channel value, with
successful hide/reload/disposal. Decoded map storage is 4,194,304 bytes, not a
measured GPU allocation. These checks do not establish motion shimmer, final art
or physical performance. Full archive SHA256:
`0481b753a17762d02aa5710e5f4bcbd53f4a83a9c205d86699e0e71747fb0669`.

Dense fine feather layering, descending temple/eye edges, wing-joint finish,
overall likeness and natural acting remain open. No 3D artwork has been published.
The approved portrait and static full-body greeting remain active; animated delivery
and physical-device acceptance remain pending.

## Greeting acceptance and personality follow-up

PR55 passed all sixteen hosted checks on
`e9f1fbdbcf8f5e4bc576787e7d355820787490ba` and merged at
`2026-10-04T17:01:53Z` as `c597c204aa49a852da4fe5f02b8708ab5cf3e0e1`.
The private Mac 1.23.14 (49) package above is verified. Production promotion
still awaits the owner release environment.

The personality implementation pins the initiating person's Quiet/Balanced/Expressive
language preference for a new authenticated direct conversation, including a
foreground prompt-queue dispatch. Only fixed delivery guidance enters the prompt;
Agent identity, instructions, requested format and governed authority keep their
precedence. Failed or ambiguous reads select neutral wording. Approval resumes
retain the original compiled instructions rather than rereading changed settings.
Background, delegated, durable and genuine loop-v2 executions are outside this
slice. An explicit model selection now labels the execution scope for the ordinary
runner it actually dispatches, even when the request was canary-eligible.

Web/native decorative motion now differs by intensity: Quiet remains still,
Balanced permits a newly verified completion reaction, and Expressive also permits
truthful listening/responding/working transitions. Attention, errors and paused
states remain composed; no preference change replays consumed history. The static
greeting and unpublished state manifest remain unchanged. Native build
`1.23.15+50` is reserved for this follow-up; parked connectors need a later number.
No database migration, API contract or Agent definition version changes are made.

## Personality acceptance and expanded Voice follow-up

PR56 passed all sixteen hosted checks on
`a3fb4215b632f8b6d56487e3617b0afb82085aba` and merged at
`2026-10-04T17:24:06Z` as `fe36089bc409e79e5fc267a277a65cb2605c3ee0`.
The universal private Mac 1.23.15 (50) package is verified; its SHA256 is
`be0c8ecb2f5e24f54d10c48a1ef020798cd864bade14d31ec380009ec443c185`.
All 277 focused web/server cases, full Flutter analysis and 11 companion cases
passed before the hosted release gates.

The web-only follow-up connects expanded Voice to the same decorative state
player as compact presence. Existing device observations, consent, transcript
review, authority and approval paths remain authoritative. The shared player
retains the current neutral portrait while the manifest awaits art review,
consumes suppressed transitions, and stops on reduction, background, offscreen,
theme or owner/conversation changes. It uses responsive sprite geometry without
restarting a clip when layout changes. No native version, migration, API contract
or public asset publication changes are included.

PR57 passed all fourteen applicable hosted checks on
`76a2230e911d1d8436c731fc965f53037b5dadd6`, then merged at
`2026-10-04T17:57:33Z` as `79386e2694a39cb01d5948f1fbbc6e06513105cf`.
All 48 focused unit cases, changed-file ESLint and 114 maintained browser checks
passed. The local compact/greeting run passed 75 checks before a document
navigation timed out; the complete exact-head hosted browser suite subsequently
passed. Native code remains identical to the verified Mac 1.23.15 (50) package.

The unaccepted art source is checkpointed separately. Its latest matching full
export is `sculpt-04-primary-01-overlapping-fan`, exported at
`2026-10-04T18:55:02.119850+00:00` and archived in
`atlas-primary-01-review.tar.gz`. All seventeen source hashes and 104 artifact
hashes/byte counts match, and all 129 archive members were verified. Body/wing refinements preserve topology; the temporal
lid return adds fifty vertices and ninety-six triangles, for 27,240 vertices and
49,844 triangles overall. The retained completed acting pass changes only its two wing
channels; the other eleven clips are identical, and 2,172 sampled non-wing
quaternions remain within 4.246830940246582e-7 component difference.

Root reviewed six matching comparisons: 22 tuft, 22 grain, 38 wing, 24 blink,
48 completed-trajectory and 48 primary-fan captures. The completed wing now clears
the torso and returns to its resting side; the overlapping fan replaces the long
separated strips. Exact primary parity preserves the other 151 parts and all
indices, rig, poses, clips and palette. The next local art task is to soften the
mechanical covert/primary transition during the gesture, then finish face/throat edges and
review all eight states at their actual delivery sizes. Natural acting, final
art publication and physical-device/performance acceptance remain open.

The clean software release remains accepted main `79386e26`, with private Mac
1.23.15 (50) unchanged. A read-only environment probe at 18:13 UTC still found
required production credentials absent. Canonical health at 18:42 UTC remained
healthy on `a06aa78b`; no migration or production deployment occurred. Connector
expansion remains parked behind the UI/ATLAS priority.
