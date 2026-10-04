# UI and ATLAS priority — 5 October 2026 (IST)

The owner explicitly prioritized the UI revamp and ATLAS, asking to stabilize the current release and return to connector expansion afterward. The full implementation plan remains in scope; this changes execution order.

The UI, static greeting, personality, expanded Voice, native Automation and native
scoped content search releases are accepted through PR59. FACE02 is the current
complete ATLAS export and retains the reviewed brow integration; final character
artwork, acting and device acceptance remain open. Quality + Monitoring is underway
on a separate branch for `1.23.18+53`. Connector work is preserved in
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

## Current software checkpoint — 5 October

PR59 native scoped content search is accepted with native API v39 and app
`1.23.17+52`. All sixteen hosted checks passed on
`608368ed679e483105198e62966f02dac198b662`; the accepted merge is
`2fd786531899d686da6686988e82e3c5faa83224`.

The verified universal private Mac 1.23.17 (52) package was built from
`2d4c1410b400f2d72e1ca7e3ec9ed6471ce8ed49`. Its SHA256 is
`f52edbd1dc200e55b86dc9ced5e8ef7d9b335fe27d118fe8929a7456376d5fa7`.
Only two test files differ on the accepted head; application and package inputs
are exact. This remains a private package, not a production promotion.

Quality + Monitoring is underway on a separate branch for `1.23.18+53`.
Forty-six focused Quality and 57 Monitoring checks pass; eight actual-widget
captures have passed and been root-reviewed. Full Flutter analysis is clean and fifteen existing foundation/navigation/admin cases pass. Build 53 and exact-head hosted PR #60 checks remain pending. This slice is not yet accepted and does
not complete the full plan.
Canonical production remains `a06aa78b843cce6c8f41a79ec5beb6192f3c4b20`, with the
owner release environment still pending. Parked connector work must rebase onto
native v39 and use build 54 or later when resumed.

## Historical native Automation acceptance — 5 October

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
canonical production revision were unchanged at this checkpoint. Paired v38
server promotion required the complete operator release environment. The current
package and connector baseline are recorded in the PR59 checkpoint above.

## Historical implemented UI checkpoint — 4 October

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

App version `1.23.13+48` was reserved for this UI release. This UI change introduced
no database migration or native API contract version.

## Historical release correction checkpoint — 4 October

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
passed locally with the original application timeout and RLS assertions intact.
The subsequent complete corrected hosted cycle established release acceptance.

PR54 is accepted: all sixteen hosted checks pass on
`4e62457533a3a57a4cf4470c353a1bfe5f67a1b2`, including the production build,
Flutter and PostgreSQL integration. It merged on 4 October 2026 at 08:29:52 UTC
as `cab9d5f77066872ae9a9a3b4f7a68a76cc6b0ea2`.

## Accepted static full-body greeting — 4 October

The accepted static ATLAS greeting uses the already-approved first full-body pose in
empty, idle Assistant/Talk. It retains the source's pale studio background and
does not publish a 3D model or any state animation. Active conversations, work
and audio keep their existing portrait presentation. The greeting is at most
144px high, reducing to 96px on constrained screens; hidden-character preference,
scope replacement and neutral-image fallback remain authoritative.

Identical 211×432 PNGs and crop/source provenance are enrolled in web and native
asset roots. Each PNG is 84,847 bytes, SHA256
`cb5db22c48af8e2f883be9b256226a50b4d26f97c82e516b3c240e9aa691eb53`.
App version `1.23.14+49` was reserved for this follow-up. Full Flutter analysis and
21 focused cases passed; five native widget captures cover light/dark desktop,
phone, 200% text and the
populated state. These synthetic captures do not establish physical-device or
microphone acceptance. All 39 focused web greeting checks pass, including
hidden-character preference, exact neutral-image fallback and return to the
compact conversation portrait. Visual review found and corrected draft crowding
at 320px with 200% text: controls wrap below the draft, preserving 198px of usable
text width and a reachable Send control above navigation. The exact hosted cycle
subsequently passed for PR55, as recorded below.

The private Mac greeting package `Asael-1.23.14-49-macOS.dmg` was built from
`38839901326f7a065a25235a898aaf0195ce1529`; its SHA256 is
`053f382551b221f1b774bf088098a25033571ac6d882df135e81bef064cd329e`.
The later composer correction changes only web CSS and browser verification;
packaged native application code is unchanged. Signing is local/private,
not Apple notarization.

At this greeting checkpoint, no separate portrait/material study was saved and
sculpt04 was the latest complete 3D export. Later beak/throat refinements are
recorded below and remain separate from the approved static greeting.

## Current ATLAS boundary — FACE02, 5 October

The current complete export is `sculpt-04-face-02-anchored-brows` (FACE02), exported
at `2026-10-04T22:10:08.914731+00:00`. It verifies seventeen sources, 104 artifacts
and 169 archive members. The GLB is 2,969,076 bytes with 27,543 vertices, 49,844
triangles, fourteen bones, twelve clips, 167 parts and one embedded 1024×1024 RGBA
map. Full archive SHA256:
`5c51cca88d2df62d38b725ef9c1524532499249e2adecd35a0588aa6ae87508a`.
The external verification receipt is
`/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-face-02-export-verification.json`.

Root and independent review retained the brow integration after seventeen sheets
containing 102 images. Only the two brows change; the other 165 parts, full texture
and all 168 animation tracks remain exact. Neutral and listening read more clearly,
with no new trench, detached tips or lid obstruction in the sampled views. The
eyebrow gesture is substantially quieter, especially at three-quarter view.

All ten current model checks pass. The ten static-tool checks remain the FEATHER02
results for unchanged scripts and were not rerun for FACE02. Forty-two source/GLB
captures cover 21 pairs across seven groups and three views: fifteen pairs are
pixel-exact, with 21 changed pixels in total and a maximum channel difference of
one. Hide, reload and disposal pass in both modes. These checks do not establish
continuous attachment, final art or physical performance.

Bulky closed lids, final likeness, natural acting, continuous attachment,
`needs_you` at small delivery sizes, device acceptance and publication remain open.
FEATHER03 and all older exports are historical checkpoints. The approved static
portrait and full-body greeting remain active; no 3D artwork has been published.

## Historical grain02 art checkpoint — 4 October

The grain02 archive had 27,543 vertices, 49,844 triangles, a 2,494,008-byte GLB,
fourteen bones, twelve clips and one embedded 1024px color map. The smooth throat,
shorter crown, completed breast fold, fitted wing coverts and settled body tufts
were retained. Sixty-four before/after captures supported subtle continuous
body-color variation while preserving the old throat pixels and all geometry,
rig and clips. The small-size visual gain remained modest.

That export at `2026-10-04T20:49:56.541894+00:00` verified seventeen sources,
104 artifacts and 156 archive members. Nine model/lifecycle and ten static-tool
checks passed at that checkpoint. Forty source/export captures showed eight
pixel-identical rest pairs and twelve posed pairs differing at 0–10 pixels by at
most one channel value, with successful hide/reload/disposal. Decoded map storage
was 4,194,304 bytes, not a measured GPU allocation. Full archive SHA256:
`0481b753a17762d02aa5710e5f4bcbd53f4a83a9c205d86699e0e71747fb0669`.
FACE02 above supersedes this export as the current complete art checkpoint.

## Historical greeting acceptance and personality follow-up — 4 October

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
`1.23.15+50` was reserved for this follow-up.
No database migration, API contract or Agent definition version changes are made.

## Historical personality acceptance and expanded Voice follow-up — 4 October

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
passed. At PR57, native code was identical to the verified Mac 1.23.15 (50) package.

## Historical primary-fan art checkpoint — 4 October (UTC)

The unaccepted art source was checkpointed separately. The matching full
export at this historical checkpoint was `sculpt-04-primary-01-overlapping-fan`,
exported at `2026-10-04T18:55:02.119850+00:00` and archived in
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
indices, rig, poses, clips and palette. The next local art task at that checkpoint
was to soften the mechanical covert/primary transition during the gesture, then
finish face/throat edges and review all eight states at their actual delivery
sizes. FACE02 above records the current art boundary and remaining acceptance work.

At this 4 October checkpoint, the clean software release was accepted main
`79386e26`, with private Mac 1.23.15 (50) unchanged. A read-only environment probe
at 18:13 UTC found required production credentials absent. Canonical health at
18:42 UTC remained
healthy on `a06aa78b`; no migration or production deployment occurred. The PR59
checkpoint above records the current accepted software and connector baseline.
