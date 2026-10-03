# ATLAS implementation evidence

## First web slice — merged, 3 October 2026

Source baseline: `dc1cfe6e9c51e84f85c78bb482fe1d082dfc735a` on `main`,
including the merged operational follow-ups and ATLAS plan. The implementation
branch is `codex/atlas-web-foundation`.

| Surface | Scope in this slice | Validation status |
|---|---|---|
| Shared foundation | Canonical light/dark tokens, shared controls, focus, motion and contrast modes | Local and hosted checks passed; PR #14 merged |
| Navigation | Existing expanded/compact rail and mobile navigation, simplified surfaces and sizing | Browser layouts and keyboard recovery passed |
| Theme controls | Existing Light/Dark/System behavior with restrained segmented controls and explicit icon-only names | Light/dark rendering, System preference and accessibility passed |
| Today | Useful agenda/attention first; remove ornamental scene; disclose usage/source detail | Unit, browser and accessibility checks passed |
| Command | Reading column and visible composer; optional conversation history and details; remove ornamental scene | Browser layouts, draft/history and accessibility checks passed |
| Voice presentation | Bounded, scrollable consent/transcript/review dialog; functional status and meter; reachable controls; remove orbital decoration | Consent layout, no-mic opening, keyboard and accessibility checks passed |

These are presentation changes over existing controllers. This slice does not
complete live voice validation, exact approval surfaces, other page families, native parity,
new companion preferences or ongoing responsibilities. The ATLAS concept sheet
is not a production asset and is not being presented as a working 3D character.

Voice preserves provider disclosure, explicit start/consent, editable transcript,
attestation, send, playback interruption, exact approval and cleanup controllers.
Opening the dialog does not start the microphone. This presentation work does
not validate microphone/device transport or supply production ATLAS assets.

## Baseline and local review method

The baseline was inspected in Chrome on the 8 GB Mac host using a loopback-only
Next development server and normal session authentication. It used a fresh
synthetic tenant and data directory, an explicit process environment and no
database, provider or connector credentials. No existing private workspace
records were loaded. This file-backed configuration is not a universal
no-effects sandbox; review must not approve arbitrary tools.

The baseline Today and Command screens showed large orbital scenes, repeated
serif headings, glow treatments and oversized controls. Command's composer was
below the initial desktop viewport. Two Today cases also need correction:
zero token usage produced a 100% output share, and failed agenda sources could
be described as a clear schedule.

File-backed review covers empty and unavailable states. It does not exercise
Postgres-only sources: the existing prompt-queue endpoint returned 500 before
the UI changes, and meeting/customer coverage was unavailable. Populated queue,
approval and device workflows require separate appropriate fixtures and checks.

The preview server and Chrome were stopped between baseline review and editing
to reduce memory pressure. Local checks and browser review run serially.
Cold webpack compilation timings are not production performance measurements.

## Fresh validation after the desktop restart

The interrupted test run from the prior chat is not counted. Fresh Node 24
single-worker runs passed 55 unique tests across 12 files: shell/navigation,
session permissions, Command/page, Today/source truth, timestamp formatting,
client bundle boundaries, performance budgets and voice review/transcript.
Full strict lint and the 1,177-file minimum type-size check passed. The changed
Today files were linted again after fixing a review finding: an incomplete
timezone preference now uses the guarded formatter instead of throwing during
render. Its regression checks date boundaries and incomplete timezone drafts.

An independent read-only review also found that the full theme control could
outgrow the reserved tablet header height. The reservation now accommodates
the control at tablet widths and with a coarse pointer. Review found no
additional confirmed changes to action, draft, authentication or voice handlers.

Local route type generation passed; the full TypeScript check exhausted the
explicit 2 GiB heap cap. No successful local type-check result is claimed.
Hosted type/build/coverage/integration checks must pass before merge. Tests,
lint and the isolated preview are run serially on this 8 GB machine; the
embedded browser and visual-preview panes remain closed.

The final headless Chrome pass completed 82 checks with no failures and no
uncaught browser exceptions. Nine axe-core 4.11 WCAG A/AA scans found no
violations in the tested Today, Command and voice-consent states. Viewports
covered 1440×900, 1024×600, 768×1024, 720×450, 390×844 and 320×740, with fine
and coarse pointers as applicable. Checks included light/dark, long drafts,
Chat/Map draft retention, saved history preference, mobile-menu Escape,
voice focus trapping/restoration, reachable consent controls, reduced motion,
forced colors and 200% root text scaling. The 720×450 viewport is a reflow
proxy for a 1440×900 window at 200% zoom, not a physical-device zoom test.
Two additional browser checks passed: System theme follows both emulated OS
color schemes, and closing the command palette with Escape restores its trigger.

Browser review corrected an unlabeled attachment input and a phone layout
where a long draft could place Send/Voice behind the dock. Narrow/short Command
layouts now use document flow, with enough reserved space for wrapped dock
labels. Today completion copy describes the visible subset rather than implying
an exhaustive count in the selected timezone.

The first broad local preview hit Next's memory restart threshold; its affected
draft result was discarded and rerun. Final presentation checks used a 2.5 GiB
server heap cap, real synthetic session authentication and real file-backed
server-rendered pages. Optional client reads used explicit unavailable-source
503 fixtures, except session and Inbox reads. Mutations and microphone access
were blocked. This is evidence for presentation and failure recovery, not for
live providers, populated queues, tool effects or Postgres-only sources.
Detailed logs, screenshots and results are retained outside the repository in
the dated release records under `2026-10-03-followups/ui-validation`.

PR [#14](https://github.com/benniejoseph/OmniAgentOS/pull/14) merged as
`10f877cb34ded10cc38c70564ac51aca326df4f6`. Hosted checks passed on implementation
head `89fcdcb37824e9194188299aba74ae40cb87b0a5`: full types, lint, coverage,
integration, production build, route JavaScript/server trace budgets, dependency
audit, worker checks and secret scans. The Vercel preview also passed. This
records repository acceptance, not a production promotion.

## Inbox and shared approval presentation — 3 October 2026

Inbox and the shared inline decision card now use a dedicated scoped module.
The decision order is consequence, reversibility and reason, then expanded exact
inputs, policy/trust context and labeled decision controls. Inputs remain complete,
selectable and keyboard-scrollable; explanation IDs are unique to each card.
The queue distinguishes a current empty result from the last loaded queue after
a failed refresh. Access approval and unfinished identity provisioning remain
distinct states.

The change retains request bodies, permission checks, quorum, self-approval
restrictions, emergency-policy gates, reconciliation, idempotency, rereads,
return links and focus recovery. Both decision announcers remain mounted.
Independent read-only review found no action-controller changes.

Local focused runs passed 172 tests in nine files. One additional detail-route
suite failed collection because the local shared installation could not resolve
the existing `pptxgenjs` ESM entry; no assertion result is claimed for that suite.
Targeted strict lint, CSS parsing and the 1,179-file minimum type-size check passed.
An additional 15 shared-shell tests passed. The final Inbox head also passed
the hosted full suite before merge.

Headless Chrome completed 66 checks with no failures or uncaught exceptions.
Three settled light/dark/phone axe-core 4.11 scans reported no violations.
The real local pages and synthetic authenticated session used explicitly synthetic
read responses for populated ordinary, quorum, self-blocked, emergency,
reconciliation and access/provisioning states. Checks covered exact input content,
keyboard scrolling, required-field explanation transitions, linked-item/return
navigation, stale empty queues, 1440/768/720/390/320px layouts, coarse targets,
200% root text, reduced motion and forced colors. No decision or provider request
was attempted; automatic web-vitals posts were blocked with all other mutations.
This does not validate live tool effects or physical-device/screen-reader behavior.

The narrow-screen review found shared layout issues and corrected them: body
width no longer grows with the text-size minimum; header actions can wrap; the
smallest header flows with the document; document scroll padding keeps controls
above the fixed dock without adding shell margins to nested dialogs/scrollers.
The final phone checks include hit testing and full control visibility above the
dock at 200% text. Theme scans wait for the existing transition to settle.
A fresh 82-check Today/Command/voice browser regression passed after these shared
changes, including all nine accessibility scans and dialog focus recovery.

PR [#15](https://github.com/benniejoseph/OmniAgentOS/pull/15) merged as
`50245c9594f2e2fc5349093771955af7dd759544`. The first hosted run found a strict
TypeScript narrowing issue in a new markup assertion; an explicit missing-node
guard fixed it. Final head `e1e3e84e0b075b61c62be582603b0b99a24bd12a` passed
full types, lint, coverage, integration, production build and budgets, audit,
worker checks, secret scans and the Vercel preview.

## Results presentation — 3 October 2026

Results now uses its own scoped module with selected output and status first,
a responsive selectable run list, and compact evidence/status disclosures.
Long output and identifiers wrap; selection is marked visibly and with
`aria-pressed`. Result selection respects reduced motion. Created files and
the shared Library remain mounted with their existing controllers and scoped
presentation overrides.

Independent review found no changes to exact run cancellation/idempotency,
permission-gated approval data, direct result lookup, history selection, stale
data retention, polling or immutable Agent identity. All 16 tests in the
timeline, artifact projection/shelf and Library groups passed, along with
targeted lint, CSS parsing and minimum type-size checks.

Headless Chrome completed 49 checks without failures or uncaught exceptions,
including three clean light/dark/phone axe scans. Synthetic read fixtures
covered direct Agent and omitted-workflow lookup, unknown linked results,
Back/Forward and unrelated query preservation, full output, pinned identity,
artifact version links, Library rows, stale/fresh source failures, reduced-motion
selection, keyboard focus, forced colors and 200% text. Layouts covered
1440/768/720/390/320px with fine/coarse pointers. All mutation requests were
blocked; only automatic web-vitals posts were attempted.

PR [#16](https://github.com/benniejoseph/OmniAgentOS/pull/16) merged as
`0fe44c97346dfdda227fabe91269de29d8de0fc6`. Final implementation head
`1a6b9c3abf94ef1a89b807351e032e876c7cb136` passed all hosted quality,
integration, build/budget, audit, worker and secret-scan checks and its Vercel
preview. These merges record repository acceptance, not production promotion.

## Work overview and Plan/context presentation — 3 October 2026

The Work shell, project list, Plan/context, task rows and project outputs now use
a scoped canonical module. Compact counts and readable titles replace ornamental
headers. Container-based list/detail layouts give narrow screens explicit Back
controls, with focus and scroll restoration. Successful empty data remains
distinct from unavailable or previously loaded data. Execution and App Builder
controllers and their detailed internal presentation remain separate later work.

Independent review found no changes to project/task authority, canonical WorkItem
status, immutable Agent identity, mutation payloads, budgets, approval gates or
idempotency. Seventeen existing tests across Work, execution refresh and Builder
passed. Targeted lint, CSS parsing, minimum type-size checks and the narrow Work
TypeScript dependency graph passed; the full hosted suite remains the merge gate.

Headless Chrome passed 87 checks with four clean light/dark desktop/phone axe
scans and no uncaught exceptions. Checks covered project/output selection,
deep links, draft retention through refresh and view changes, exact output,
failed/empty reads, narrow Back focus restoration, coarse targets, 320–1440px
layouts, 200% text, reduced motion and forced colors. All mutations and external
requests were blocked; no task, budget, reflection, execution or publish action
was attempted. These fixtures validate the overview and Plan/context slice,
not live execution or the unchanged nested Builder/Execution views.

The harness now captures viewport screenshots and asserts pointer mode at each
viewport: full-page screenshots reset Chrome's touch emulation on this host.
Accessibility scans start at the top of the document to avoid measuring controls
partly behind the sticky header at an arbitrary retained scroll position;
separate interaction checks still verify control reachability and focus recovery.

PR [#17](https://github.com/benniejoseph/OmniAgentOS/pull/17) merged as
`a327f7fa6918eacdae5fe874de64af5bfd284a7a`. Implementation head
`1e590469d788dce693c0c881845777ac430c4a6f` passed the complete hosted quality,
integration, build/budget, audit, worker and secret-scan checks and its preview.

## Memory index, Knowledge and inspector presentation — 3 October 2026

The active Memory intelligence page now has a compact heading/search, selectable
memory rows, readable knowledge source rows and explicit filter controls. Health
details are disclosed on demand, with actual steward state, unavailable values
and the existing recall notice and consent action. Source knowledge remains
distinct from personal truth. Reviews and Universe detail presentation remain
separate work; their controllers and shared semantic-shadow style exports remain.

Native inspector and creation dialogs make background content inert, support
Escape and restore trigger focus. Exact content, source and attribution remain
visible. Lifecycle restrictions explain the disabled action, and the existing
two-stage forgetting preview exposes its impact and guarantee. A selected-ID
guard prevents a previous record from appearing while another detail loads or
fails. Index state distinguishes initial unavailable, successful empty and
previously loaded records after a failed request.

Independent review found no changes to the existing mutation endpoints, bodies,
idempotency, ownership manifests, consent hashes, deletion-preview binding,
40-record cursor pagination, debounce/abort guards or Universe suspension.
Thirty-five tests in eight projection, lifecycle, consent, deletion-preview and
route files passed, as did targeted lint, the Memory TypeScript dependency graph,
CSS parsing and minimum type-size checks.

The final main browser pass completed 108 checks and 20 clean axe scans. A
subsequent small phone-label correction passed 14 focused checks and two more
clean scans at 320/390px with normal/200% text. Coverage includes 1440/768/390/320px,
fine/coarse pointers, both themes, exact long content, bounded paging/filter
requests, stale-detail isolation, source errors, unknown health, pinned/archived
restrictions, GET-only forgetting impact followed by Cancel, unsaved creation
drafts, Escape/focus restoration, reduced motion and forced colors. All mutation
and external requests were blocked, with no action mutation attempted.

Browser review corrected coarse dialog-button specificity and made the inspector
surface grow around long content. Both the top and bottom of long inspectors
were scanned in each theme. Native-dialog focus checks distinguish Chrome's own
toolbar from application background content; no inert background element receives
focus. This is synthetic presentation evidence, not a live memory mutation,
physical-device or screen-reader certification.

PR [#18](https://github.com/benniejoseph/OmniAgentOS/pull/18) merged as
`82c2ff93778e98909b1681da5d5a43bb2bb691bc`. Implementation head
`bbd27eae7411d4e658f010c896c3a31e9842d107` passed the complete hosted quality,
integration, build/budget, audit, worker and secret-scan checks and its preview.
Work and Memory acceptance does not promote production or complete their
deeper Execution, Builder, Reviews and Universe presentation work.

## Shared Library presentation — 3 October 2026

The shared Library now uses canonical typography, tokens, control sizes and
static loading geometry. Its layout responds to its own container width in the
full Capture browser and compact Work/Results embeds. Complete titles, source
metadata, immutable citations and version detail wrap instead of truncating.
Redundant Library descendant overrides were removed from Work and Results,
retaining only embedding margins. Initial errors do not invent zero counts;
failed refreshes retain and label the last loaded rows, counts and ranges.
Clipboard success is announced only after the write promise resolves, with a
separate failure message and selectable citation text.

Independent review confirmed the query/project/offset contracts, abort/debounce,
compact URL behavior, lower-bound markers, immutable source/version identity
and canonical links remain intact. Review found that wide selection could leave
the inspector offscreen on long ledgers. Its detail region is now bounded and
keyboard-scrollable; explicit desktop selection brings it into view. Short
windows use inline details, and initial loads/refreshes do not steal focus.

Eighteen focused tests across component helpers, library contracts/store and its
route passed. Targeted lint, the Library TypeScript graph, CSS parsing and type
scale checks passed. The final browser pass completed 171 checks with 12 clean
Library-scoped axe scans across Capture, Work and Results. Nine additional checks
passed for selection at the end of a 40-row ledger, keyboard scrolling and short
desktop windows. Other checks cover list/grid, exact long citations, metadata-only
versions, variable server offsets, history, full URL preservation, compact URL
immutability, initial/empty/stale reads, deferred/rejected clipboard promises,
320/390/768/1440px, fine/coarse pointers, 200% text, reduced motion and forced colors.

Browser fixtures used normal synthetic authentication and explicit read responses.
All API mutations and external requests were blocked; only automatic telemetry
posts were attempted. Clipboard writes were stubbed, and original-file links were
inspected without being followed. Accessibility claims cover the shared Library
region, not the separate Capture studios or other page-family internals.

PR [#19](https://github.com/benniejoseph/OmniAgentOS/pull/19) merged as
`6c0d43a4a1da290e42099718c66dde7f922833fa`. Exact implementation head
`249993fb4116a94afaf88ff044cfbbab7b00ae58` passed all hosted quality,
integration, build/budget, audit, worker, secret-scan and preview checks.

## Capture intake and source management presentation — 3 October 2026

Capture now uses scoped canonical styling for its page frame, Note/Upload intake,
processing summary and original/knowledge management. Mode buttons use complete
native button semantics with pressed state. Long filenames, errors and source
metadata wrap; stage labels replace inferred percentage bars. Local queue removal
explicitly distinguishes clearing a row from canceling a job or deleting a file.
Recording, Connected Sources and Visual Studio internals remain separate slices.

Knowledge, originals/processing, connected accounts and capabilities have
independent read-state evidence. Initial failures show unavailable rather than
zero/empty; refresh failures retain and label existing records. Source recovery
through polling clears the aggregate warning. A stored queued asset absent from
the bounded job list requests a status refresh instead of claiming indexing is
complete. Known queued/running work uses wording covering both states; the job
rows retain their exact individual statuses.

Independent review confirmed permission checks, tenant/actor outbox ownership,
legacy claiming, stable upload/retry identities, 50-file/5 MiB/concurrency limits,
draft reset timing, management guards, polling and child props remain intact.
Thirty-five tests across batch, offline outbox, Capture and asset routes passed,
as did targeted lint, the Capture TypeScript graph, CSS parsing and type-scale
checks. Two review findings—aggregate warning recovery and queued-versus-active
wording—were corrected before the final browser pass.

Headless Chrome passed 122 checks with eight clean scoped axe scans for intake,
processing, originals and knowledge management. Coverage includes shared-query
text, exact filenames/download links, ownership restrictions, separate job states,
initial partial/total failure, retained rows/counts/drafts, healthy poll recovery,
successful empty reads, local accepted/empty/oversized file selection, responsive
layouts, light/dark, 44/48px controls, 200% text, reduced motion and forced colors.
The one accepted file remained an in-memory staged selection. No upload, save,
management, recording, connector or provider mutation was attempted; API mutations
and external requests were blocked, and download links were only inspected.
PR [#20](https://github.com/benniejoseph/OmniAgentOS/pull/20) merged as
`3b8169968bcb1a2adcd99ecf370800696bb7a30a`. Exact implementation head
`551d75f867c746aec2b559de927d16839ef3b610` passed all hosted quality,
integration, build/budget, audit, worker, secret-scan and preview checks.

## Work execution board and settings — 3 October 2026

The execution board and settings deck now use scoped canonical styles instead
of the orphaned legacy board selectors. The board responds to the detail
container with one, two or four columns. Full task titles, descriptions, errors,
canonical agent assignment, evidence counts and exact known/partial/unknown cost
remain visible. Snapshot wording no longer implies live synchronization, and an
unavailable workflow status is never replaced by a stale queued hint.

The exact grouping precedence, request bodies, idempotency, approval/retry
callbacks, manual status gates and 12-second refresh controller are preserved.
Draft controls keep their values across view changes and failed reads; labels
compare them with returned saved settings. Disabled controls explain their
running/approval, supervised, busy, archived or empty-task constraint. A task
move restores focus to the same task after its column changes, while passive
refreshes preserve the current focus.

Eighteen focused WorkItem, refresh-controller and execution-route tests passed,
as did targeted lint, the Work TypeScript graph, CSS parsing and type-scale
checks. Independent review corrected an unreachable four-column breakpoint and
a draft-label comparison. Browser review corrected coarse select specificity.

The final headless Chrome pass completed 165 checks and four clean axe scans.
Coverage includes thirteen canonical task states, grouping precedence, exact
identity/evidence/cost, unavailable status, drafts and server reconciliation,
failed reads, guarded actions, the existing Build mount, keyboard focus,
320–1920px layouts, light/dark, 44/48px controls, 200% text, reduced motion and
forced colors. Screenshots were visually inspected on wide and phone layouts.

One exact synthetic task-advance PATCH was intercepted and fulfilled entirely
inside Playwright, with its idempotency header and canonical response validated;
it never reached the application server. All other action mutations and external
requests were blocked. Approve, retry, execution and Build creation were not
invoked, and Command links were inspected only. This verifies presentation and
focus behavior, not a live workflow effect. Hosted checks remain required.

## Memory Reviews and semantic review bench — 3 October 2026

Reviews now foreground source-map proposals and conflicts/promotions using
canonical controls, full proposed/current text and selectable provenance.
Every returned summary quote, claim/entity/link and overlap reference remains
inspectable. Source-map interruption is a warning state. Exact batch/model,
memory/source/evidence and semantic episode/digest identities wrap in named
disclosures instead of truncating. Keyboard-scrollable evidence regions preserve
complete source conversations and deterministic baselines.

Reconciliation, source maps and semantic evaluation distinguish initial loading,
unavailable sources, successful empty reads and retained last-loaded data. Missing
quality data is unavailable rather than a zero or endless loading claim. The
semantic detail ID guard prevents showing another selected episode's evidence.
Mounted announcements and disabled descriptions expose progress and validation.
Quality signals, the existing collector and semantic bench remain mounted inside
an evaluation disclosure; the collector's controllers and ten shared CSS exports
remain intact. Detailed collector presentation and Universe are separate work.

Independent review found no further actionable issue and confirmed exact decision
handlers, request bodies/headers, policy boundaries, paging, retries and lifecycle
behavior were preserved. Twenty-six tests across reconciliation, cognition groups
and routes, semantic review payloads and the evaluation contract passed. Targeted
lint, the Memory TypeScript graph, CSS parsing and type-scale checks passed.

Headless Chrome passed 161 checks and four clean scoped axe scans. The fixtures
cover pending/interrupted/confirmed source maps, complete long evidence and six
overlap references, memory provenance, local semantic drafts and validation,
episode selection and missing detail, initial/stale/empty reads, both themes,
320–1440px, fine/coarse pointers, 200% text, reduced motion and forced colors.
Wide and phone screenshots were visually inspected. A confirmed/projected source
map was injected only to inspect that existing presentation branch; the real
review-list route normally omits completed projections.

All API mutation and external requests were blocked. No review decision,
projection, collection, rank probe or other action mutation was attempted. Axe
coverage is limited to source-map reviews, conflicts/promotions and the semantic
bench, excluding the separate collector, quality summary, steward and app shell.
Hosted checks remain required before merge.

## Remaining gates and scope

- Hosted build, route budgets and required repository checks on each new exact head.
- Live approval effects and microphone/device scenarios remain outside the
  bounded presentation fixtures. Screen-reader and physical-device review are not claimed.
- Production performance and full page-family acceptance remain later gates;
  development timings and axe scans are not a performance or accessibility certification.

Do not mark a complete page family or the complete revamp done from this slice.
Production promotion remains a separate signed, paired release with the
documented credentials and evidence gates.
