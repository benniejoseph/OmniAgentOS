# UI and ATLAS priority — 5 October 2026

The owner explicitly prioritized the UI revamp and ATLAS, asking to stabilize the current release and return to connector expansion afterward. The full implementation plan remains in scope; this changes execution order.

Software releases through PR59 are accepted and merged. Scoped Search passed all
sixteen hosted checks at `608368ed679e483105198e62966f02dac198b662` and merged as
`2fd786531899d686da6686988e82e3c5faa83224` with an identical full Git tree.
The universal private Mac 1.23.17+52 package is verified; its original build source
differs only in two corrected test expectations. Production remains unchanged.
Connector work is preserved in
`codex/native-connector-controls` and is deferred until after this UI/ATLAS priority.

## Native Quality and Monitoring — 5 October implementation checkpoint

Quality now presents typed evaluation runs, jobs, case catalog and release
evidence. Completion and measured case success are separate; quarantine, failed
cases, warnings, bounded coverage and server approval remain explicit. Release
evidence retains its own permission and freshness state. Monitoring presents
public health, SLO policies, active incidents, alert deliveries and runtime events.
Configured dependencies do not imply reachability; unmeasured SLOs, insufficient
samples and skipped deliveries cannot imply success. Every metric uses its own
eligible event or sample evidence.

Both workspaces use existing authorized GET operations with exact session,
tenant, actor, role, API, lock and visibility fences. Outgoing controllers clear
private data synchronously, cancel reads and reject late replies. Hidden or
background workspaces reopen under a fresh visibility epoch. Manager navigation
and narrower administrator-only lanes remain enforced. No native mutation,
polling loop, offline projection, API publication or database migration is added.
Existing browser routes provide the explicit operational actions.

Desktop uses readable lists and inspectors; compact screens place the selected
detail at the top and move focus only while the exact selection remains current.
Command/Control-R refreshes; Escape closes detail. Forty-six Quality and
fifty-seven Monitoring focused cases pass, including scope replacement,
cancellation and late-row compact navigation. Independent source review has no
unresolved concrete finding. Eight actual-widget captures have passed and been
reviewed: light/dark desktop and 390px phone at 200% text, including actual selected
details in both modules. Their archived harness, matching sources, image hashes
and capture receipt are retained in the external `native-operations-visual`
evidence directory. Fixtures and system fonts do not establish device acceptance.

Full Flutter analysis is clean, and all fifteen existing foundation, navigation
and administration metadata checks pass. App `1.23.18+53` identifies this combined
checkpoint. Private packaging and exact-head hosted acceptance are separate
release gates.
The app retains native v39 and requires the matching server promotion before
compatible production distribution. Connector work must use build 54 or later.

## Native scoped content search — 5 October accepted

The native Search destination now exposes live, authorized conversations, Work,
private active Memory and saved Library sources. Command-K/Control-K opens it in
both native shells. Deliberate queries and independently paginated source groups
are bounded, and each source reports its coverage and availability. Search state
is held only for the visible session; hidden pages, changed identity, API scope or
lock state discard private content and cancel outstanding reads.

Typed links preserve exact result identity, including legacy Work task identifiers.
Work and Memory open dedicated read-only inspectors using the existing exact
search readers; refused reads never fall back to broader readers. Explicit
workspace actions hand off to the established mutation controllers. Library
controllers are isolated by visibility and target identity, and conversation
navigation retains the existing draft safeguards.

Native contract v39 publishes these three existing GET routes, retaining frozen
v38 and v37 artifacts. It introduces no mutation enrollment or database migration.
App `1.23.17+52` identifies this follow-up. The deferred connector checkpoint must
rebase its contract publication beyond v39 and use build 54 or later.

Independent source review has no unresolved concrete authority/navigation finding.
Contract generation/check and 44 focused contract/authentication cases pass, as
well as changed TypeScript lint. Full Flutter analysis is clean and 59 focused
search, scope, keyboard, shell and destination cases pass. Three actual widget
captures cover light/dark desktop and a 390px phone with 200% text, using synthetic
data and system-font substitution. Private packaging and exact-head hosted
acceptance are complete. The full hosted Flutter suite passed 1,189 cases.
The new app requires the
matching v39 server promotion before compatible production distribution.

## Native Automation run navigation — 5 October checkpoint

Recent workflow runs and schedule-occurrence history now expose an accessible
Open run action in both native presentations. It opens the existing authorized
Results detail using the exact validated workflow identity. Missing or malformed
identities receive no action. Returning preserves the selected Automation section;
protected inventory and history still dispose while hidden and are read again on
deliberate reopening. Explicit section URLs remain authoritative.

Six focused integration cases pass through the actual app router, covering both
presentations, encoded identities, unavailable Results, Back navigation, fresh
history reads, malformed identities and button semantics. Full Flutter analysis is
clean. This checkpoint adds no database migration or API contract version.
App `1.23.16+51` identifies the native follow-up; the deferred connector checkpoint
must use build 54 or later. Packaging and exact-head hosted acceptance are separate
release gates, and physical-device acceptance remains pending.

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

The latest separately archived art study is throat04: 49,748 triangles, a
2,035,216-byte GLB, fourteen bones and twelve clips, with all nine structure checks
passing. Beak volume and throat continuity improve, while fine boundary stepping,
feather finish, body integration and eyelid closure remain unaccepted.
No 3D artwork has been published. The approved concept portrait remains active,
with the static full-body greeting implemented above. The final authored model,
material pass, convincing facial closure, animated greeting/state delivery and
state-performance/device acceptance remain open.

## Greeting acceptance and personality follow-up

PR55 passed all sixteen hosted checks on
`e9f1fbdbcf8f5e4bc576787e7d355820787490ba` and merged at
`2026-10-04T17:01:53Z` as `c597c204aa49a852da4fe5f02b8708ab5cf3e0e1`.
The private Mac 1.23.14 (49) package above is verified. Production promotion
still awaits the owner release environment.

The next implementation pins the initiating person's Quiet/Balanced/Expressive
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

Validation and exact-head hosted acceptance are pending for this Voice follow-up.
