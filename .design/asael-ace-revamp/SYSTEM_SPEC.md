# Asael shared visual system

Updated 30 October 2026 for the owner-requested web, Mac and mobile revamp.
Read [DESIGN.md](../../DESIGN.md) for product composition and platform rules.
Runtime tokens live in `src/app/globals.css` and Flutter `app/theme/app_theme.dart`;
components consume those semantic tokens. Earlier eagle/Daybook studies are
historical assets, not current UI direction.

## 1. Semantic color contract

| Token | Light | Dark |
|---|---|---|
| `background` | `#F5F7F8` | `#111719` |
| `surface` | `#FFFFFF` | `#182225` |
| `surface-raised` | `#EDF2F3` | `#1D2B2D` |
| `surface-overlay` | `#E4ECEE` | `#27383B` |
| `surface-navigation` | `#EEF2F3` | `#141E20` |
| `foreground` | `#1E293B` | `#ECF3F2` |
| `muted` | `#53666E` | `#B0C1C3` |
| `line` | `#D8E2E5` | `#34474C` |
| `line-strong` | `#6C7D84` | `#8A9EA1` |
| `primary` | `#216B62` | `#85D1BF` |
| `primary-ink` | `#FFFFFF` | `#10221D` |
| `primary-hover` | `#19584F` | `#A2E3D4` |
| `primary-pressed` | `#154A43` | `#6EBCA9` |
| `accent` | `#216B62` | `#85D1BF` |
| `accent-surface` | `#E3EFEC` | `#203D37` |
| `success` | `#286243` | `#91CFAC` |
| `success-surface` | `#E8F2EB` | `#203A2B` |
| `warning` | `#805814` | `#E7C37C` |
| `warning-surface` | `#FAF0D6` | `#41351F` |
| `danger` | `#AC3530` | `#F1A09A` |
| `danger-surface` | `#FBECEA` | `#422728` |
| `info` | `#2E627C` | `#9CCAE0` |
| `info-surface` | `#EAF1F5` | `#263944` |
| `focus` | `#216B62` | `#85D1BF` |

Selection uses readable labels, `aria-current`/selected semantics and weight or
shape as well as color. Alerts keep their functional palettes and explicit text.
Voice uses the owner’s selected theme and actual audio state.

### Calculated contrast evidence

Computed from the current sRGB tokens using WCAG relative luminance, 30 October
2026. These are mathematical token checks, not rendered accessibility proof.
Ratios below use canvas / surface / raised / overlay, in that order.

| Text | Light | Dark |
|---|---|---|
| `foreground` | 13.61 / 14.63 / 12.95 / 12.21 | 16.09 / 14.42 / 13.00 / 10.89 |
| `muted` | 5.59 / 6.01 / 5.32 / 5.02 | 9.71 / 8.70 / 7.84 / 6.57 |
| `accent` | 5.84 / 6.28 / 5.56 / 5.24 | 10.23 / 9.17 / 8.27 / 6.92 |
| `focus` | 5.84 / 6.28 / 5.56 / 5.24 | 10.23 / 9.17 / 8.27 / 6.92 |

Focus is immediate: a 3px ring with a 3px opaque surface gap. Keep it unclipped
and visible under sticky chrome. Under forced colors use system Canvas,
CanvasText and Highlight; never opt essential controls out.

## 2. Type, space and geometry

Keep web Geist Sans and Geist Mono; native keeps system typography and text scaling. Use one sans hierarchy, weights 400/500/600. Mono is for actual code, identifiers or aligned technical values; tabular numerals suffice for counts. Do not add a competing display typeface to routine workspace chrome.

| Role | Size / line height | Weight / tracking | Use |
|---|---|---|---|
| Page title | 28 / 36px; phone 24 / 32px | 600 / −0.02em | One `h1` per page; never repeated in a large hero |
| Section title | 20 / 28px | 600 / −0.01em | A working region or inspector title |
| Item title | 16 / 24px | 600 / 0 | Project/task/approval title |
| Reading/conversation | 16 / 26px | 400 / 0 | Transcript and prose; max 768px or about 65–75ch |
| UI body / dense row | 14 / 20px | 400 or 500 / 0 | Navigation, controls, tables |
| Supporting information | 13 / 20px | 400 / 0 | Timestamps, status detail, provenance; never weakened with opacity |
| Code / exact inputs | 13 / 20px | 400 / 0 | Wrap safely; preserve exact string meaning |
| Voice transcript | `clamp(24px, 2.5vw, 36px)` / 1.3 | 400 / −0.02em | Current utterance, maximum 32ch; previous text remains accessible |

Implement sizes in rem equivalents (16px root), line heights without clipping, and heights as minima. Phone form input text remains at least 16px. At 200% text size, controls grow vertically, labels wrap, and columns stack rather than truncate important information. Compact metadata has a readable full-detail alternative; never make a tooltip the only place a necessary value exists.

Spacing tokens: `4, 8, 12, 16, 24, 32, 48, 64px` (`0.25–4rem`). Icon/text gaps 8px; field label/helper gaps 8px; related controls 8px; row inset 12–16px; section gaps 24–32px. Page gutters are 16px below 768px, 24px at 768–1023px, and 32px above. Use CSS logical properties.

Radius tokens: `6px` small inline badge/code surface, `10px` controls, `12px` menus/user bubble, `16px` composer or decision surface, `24px` modal/sheet corner, `999px` only for compact filter chips, circular avatar and deliberate voice dock. Ordinary rows are flat, divided by `line`; do not box every section.

Elevation: ordinary panels have no shadow. Composer/menu may use `0 2px 8px rgb(24 23 21 / 0.06), 0 12px 32px rgb(24 23 21 / 0.04)` in light; dark uses `0 8px 32px rgb(0 0 0 / 0.24)` with a visible edge. Modal scrim is `rgb(12 12 12 / 0.40)` in light and `/ 0.60` in dark. Never place readable text directly on the scrim. No ambient radial glows, glass blur or decorative gradient rules in routine workspace chrome.

## 3. Shell, controls and resource states

Desktop rail: retain the existing persisted expanded/collapsed preference and all authorized destinations. Expanded width 240px, compact width 80px, compact header 52px minimum. Expanded rows are 40px minimum with visible 14px labels, 18px Lucide icons and 12px inset. Compact targets are 44 × 44px with accessible names and hover/focus labels that also work on touch. Active item uses a neutral or accent-surface fill and a non-color selection cue; no glow. Preserve counts and grouped navigation. Navigation search remains navigation search until universal content search exists.

At widths below 1024px use the existing top menu and mobile drawer, including its focus trap, Escape, close control and focus restoration. Keep all current destinations reachable. Header is 56px minimum; allow wrapping/overflow handling at zoom. Existing mobile dock gets 64px minimum plus safe-area inset; do not add another competing navigation layer. Reserve its actual occupied height in the content/composer layout. When the software keyboard is open, the composer sits above it, the bottom dock may yield space, and the top menu remains available. Never hide controls behind the keyboard or infer mic activation from opening a keyboard.

Default controls: 44px minimum height, 14px/20px label, 12px horizontal padding, 8px icon gap, 10px radius. Coarse-pointer/native touch targets are at least 48 logical pixels. Dense desktop toolbar controls may be 36px high; row actions use a 32px target with at least 8px separation, never an isolated 16px glyph target. Increase to touch size for coarse pointers. Input boundary uses `line-strong`; decorative row dividers may use `line`.

| State | Presentation and behavior |
|---|---|
| Default / hover / pressed | Neutral control uses surface / raised / overlay; primary uses the three explicit primary fills. No geometry shift or brightness filter. Hover does not reveal the only route to an action |
| Focus | Ring contract above; preserve browser/keyboard semantics and a visible focus state for links, summaries, tabs and custom targets |
| Selected | Actual pressed/selected/current semantics, stable marker and text weight; distinguish selection from keyboard focus |
| Disabled | Raised fill, muted label, no hover/press motion; no whole-control opacity. Explain an unavailable action in nearby text. Preserve the existing disabled reason and real mutation guards |
| Pending mutation | Keep width and action label stable, add a small progress indicator plus “Saving…”/specific status; prevent duplicate invocation through the existing controller. Do not remove the focused control mid-request |
| Validation/error | Danger boundary plus icon and specific inline text; associate help/error by `aria-describedby`, set `aria-invalid` appropriately. Preserve typed input; no shake animation |
| Toggle/checkbox | Entire label is the target, visible selected shape/check, actual native or equivalent keyboard semantics; color is supplementary |
| Menu/tab | Keep implemented keyboard model. Use menu roles only with menu keyboard behavior; use tab roles only with the complete tab pattern. Do not turn arbitrary lists into grids for styling |

First load reserves known layout geometry with static skeleton blocks and one concise loading announcement. Refresh retains rows, selection, draft and scroll, with source freshness and a retry/status line; it does not replay entrances or replace useful data with a spinner. Empty, inaccessible, unavailable, stale and partial results have separate wording. Never show an empty collection as evidence that nothing exists while a source failed. Announce meaningful completion/error changes through the existing live regions, not individual stream tokens, skeletons or mascot gestures.

## 4. Three reference compositions

These are build specifications over existing controllers, not shipped screenshots or new routes.

### A. Assistant and voice

For a 1440 × 900 desktop frame, center a 768px transcript in the available workspace with a composer aligned to it. Let the shell own its measured header and rail dimensions; never hard-code a page offset. Keep at least 24px side clearance where space allows. Expanded rail centers the same transcript in its remaining canvas. Use a grid with header, scrollable conversation and composer rows; the composer is not a fixed overlay over unread messages. Reserve actual composer/dock height when scrolling to a message. Show thread/history and optional detail only when opened; neither consumes the conversation by default.

Start state: optional 144px ATLAS greeting stage, Asael name and one true status line, then the useful starting prompt. After the first interaction use a 36px portrait beside the assistant identity/status and devote space to the transcript. Character-hidden mode retains the same reading geometry and status text. User text uses raised fill, 12px corner, 16px inset, right aligned with maximum width 85% of the column. Assistant prose uses the bare canvas and clear paragraph rhythm. Evidence/results may be a distinct 16px-radius interactive region with a real review/open action. Never imply that an itinerary, draft or unverified output has been executed.

Composer: minimum 64px outer height, surface fill, 16px radius, 8px inset, strong boundary, 44px attachment/voice/send targets. Textarea starts at one line, grows to at most the smaller of 240px or 35% of available viewport height, then scrolls internally. Keep agent/model/target/context selection and locked context discoverable; preserve thread draft, queue editing/dispatch, streaming reconnect, clarification, cancellation and current query/deep-link behavior. Preserve the existing Enter/Shift+Enter behavior and IME composition handling; the reference's “Hold Space” hint must not create a global recording shortcut.

On phone use one column with 16px gutters, 56px header minimum, 48px targets and the composer above keyboard/safe area. Thread history and evidence become labelled sheets with a close action; Back restores the original thread and scroll. Sheets must not submit a draft when dismissed. At 320px width the transcript and controls reflow; long code/data may have local, labelled horizontal overflow.

Voice reference: on a wide window use a 44% character / 56% transcript stage, within a maximum 1200px content width and 32px gap. Reserve at most 420px square for ATLAS without cropping its face. Put explicit recording/playback status near the transcript and maintain a bottom control region with 48px targets; the exact action review can replace the current transcript region when required. On narrow/short windows shrink the character to 96–160px and prioritize editable transcript, review and stop/close controls in normal scrollable flow. Never make artwork the reason an essential button falls offscreen.

The reference says “Listening” and “Asael speaking” simultaneously. Resolve this from the real voice state: microphone listening, user speech detected, reviewing draft, working, playing reply, reconnecting and error are distinct labels. Audio foreground state owns ATLAS's pose; background work has its own text. Keep the existing provider disclosure, consent/start, Stop & review, editable transcript/attestation, explicit Send, playback interruption, exact approval and End voice behavior in `voice-mode.tsx`. Spoken words do not approve an action. Stopping playback does not cancel the run. Dismissing voice follows existing cleanup and returns focus to its trigger.

### B. Dense Work detail

Use current `/app/projects` with selected `project` and `artifact` identities; do not invent a web project-detail route. Workspace title and compact toolbar lead, followed by the existing Plan & context / Execution / Build views. Preserve their underlying view values (`overview`, `execution`, `build`). Replace decorative statistics/orbits with a short line of actual state and counts; closed task count is not a claim of verified success.

Inside the available content area: a 256px project list, 24px gap and a flexible selected-work region with 480px minimum useful width. An optional 320px evidence inspector plus another 24px gap is inline only when the inner content width is at least 1104px; otherwise open it as a sheet. At 1440px with expanded 240px rail and 64px page gutters, inner width is 1136px and all three fit; at narrower widths preserve the selected work and use a drawer for the list/inspector. At phone widths, list → selected detail → artifact are separate focusable views with an explicit Back action and retained selection/scroll.

Selected header: one title, canonical state, last update and permitted next action. Below it, show the actual blocker/approval when present, then a 40px minimum task row list (48px on touch), followed by outputs/evidence. Suggested columns are task title `minmax(240px, 1fr)`, agent/status `128px`, next action `112px`; adapt to available width. Use 14px/20px text, 12px vertical cell padding when rows wrap, aligned tabular counts and subdued 1px dividers. Only nonessential columns collapse; the title, state and action remain readable.

Preserve templates, plan creation, task edit/add, budgets/parallelism, archive/reopen, execution start/pause/resume/sync/retry, canonical task constraints, artifact selection, Library, feedback and all Build Studio preview/code/files/restore/activity/repository/release controls. Keep actual agent/version and workflow links visible when relevant. Selection opens detail; it does not also execute an action. A row is not one giant nested button: use its title link/button and separate named actions. Maintain table semantics where data is tabular, and a list where tasks are a simple sequence. No large ATLAS stage in Work; a compact companion affordance may open the ordinary work/voice controls.

### C. Exact approval

Restyle the shared `ApprovalCard` used by Inbox and inline conversation, retaining `InlineApproval`, `approval-decision.ts` and the existing server contracts. One 16px-radius decision surface, surface background, decorative outline and 24px desktop / 16px phone inset is justified because the whole region is one decision. Use a 720px reading width inline; Inbox detail may reach 840px. The focused item gets the focus treatment and its existing stable heading identity.

Order: (1) title/kind/risk and requester/time; (2) what will happen, reversibility/authority and why it is waiting; (3) exact target/inputs, secrets redacted; (4) quorum, policy, track-record and attestation/break-glass requirements where applicable; (5) decision note and actions; (6) server-returned outcome and origin link. A friendly summary may introduce the bound inputs but never replace them. Render facts only from the existing response; absent expiry/scope/cost is not permission to invent it. Keep the exact-input disclosure open by default, copy-safe and selectable, with a bounded code region and an accessible name. Long strings wrap or scroll without changing their underlying value.

Preserve the current action labels/branches: Reject, Approve and run, Record approval N of M, Emergency approve, and Reconcile and continue. Preserve approver/requester restrictions, ticket and rationale requirements, role checks, bound execution identity, idempotency and re-read after decision. Reconciliation remains an already-approved action with its immutable bindings, not a new grant. The visual refactor must not add a new approval step or bypass an existing one.

Buttons sit together below the reviewed content, not as a floating bar that hides it; 44px minimum on web, 48px touch, 12px gap. On phone the note and action row wrap cleanly; a destructive irreversible operation still communicates its actual effect without mascot jokes or pressure. Disabled approval has a visible specific reason. Retain all review content while recording; announce the real result through `DecisionNoticeRegion`. Quorum pending, decision recorded, execution failed, no longer waiting, expired/changed and reconnect/error are different outcomes; no automatic success celebration after clicking Approve. Preserve the current focus-after-decision rule and authorized return link to the original conversation.

## 5. Motion and ATLAS behavior

| Token | Value | Use |
|---|---:|---|
| `--duration-immediate` | 0ms | Focus, essential labels, data availability and control enablement |
| `--duration-control` | 120ms | Hover/press color, compact menu opacity, state crossfade |
| `--duration-content` | 180ms | User-opened detail, small content reveal, tab content opacity |
| `--duration-sheet` | 220ms | Sheet/dialog entry or exit; at most 16px travel |
| `--duration-settle` | 420ms | Optional character recovery after a meaningful gesture |
| `--duration-character` | 900ms | Complete occasional expressive beat, including anticipation and settle |

Easing: `--ease-standard: cubic-bezier(0.2, 0, 0, 1)`; entry `cubic-bezier(0, 0, 0.2, 1)`; exit `cubic-bezier(0.3, 0, 1, 0.3)`; linear only for actual progress. No spring on routine controls, fields, tables or approval actions. Character animation may use authored overlap/overshoot after its renderer proof. An example 900ms comic beat is 80ms anticipation, 260ms reaction, 140ms hold, 420ms settle; it never postpones the response or next action.

Animate only opacity and short transform where practical; do not transition `all`, large backdrop filters or page heights. A user-opened menu may move 4px, a detail reveal 6px, a sheet 16px. An optional first-use introduction can stagger at most three elements by 30ms and finish within 300ms. No repeated entrance on refresh, token-by-token bounce, route-wide sweep or delayed button. Preserve scroll/focus/drafts when a rail or inspector changes width; prioritize stable final layout over interpolating the whole transcript width. An interrupted transition resolves to the latest actual state.

ATLAS uses the authored Scout character: ivory shell, charcoal face, clear eyes, articulated hands and restrained gold details. Existing Lottie clips and static state portraits are the production assets; historical eagle concepts are not a rig or implementation requirement.

| State | Character direction | Required independent UI |
|---|---|---|
| Available | Neutral attentive pose; mostly still | Availability label, current conversation |
| Listening | Small head tilt / eye attention; restrained | Actual mic state and visible stop/review control |
| Responding | Compact face/hand performance when playback is real | Reply text, playback and interrupt controls |
| Working | Brief orienting glance then still | Real work status, progress only when known |
| Needs you | One attentive eye/hand cue, then hold | Exact approval/clarification and choices |
| Blocked/reconnecting | Calm concerned pose; no repeated alarm | Specific cause, preserved work and recovery |
| Completed | One satisfied nod after confirmed successful outcome | Verification/result; unverified completion stays labelled unverified |
| Paused | Settled resting attention | Paused state and permitted resume/end action |

Balanced is the proposed default intensity. Quiet uses static/brief functional cues; Expressive adds occasional double-take, glance and hand reactions with original quick wit. These settings change presentation, not executing agent identity, authority or accuracy. The built-in Supervisor named Atlas retains its own immutable agent/version. No celebrity likeness or voice, comedy during sensitive decisions, or celebration of an unverified result.

All modes pause hidden/offscreen renderer work, release unused GPU/audio-independent resources, and cancel stale gesture queues. Default idle is still while reading; no mandatory infinite bounce or breathing. A completed reaction plays once per confirmed event identity, not again on poll, rerender or focus. ATLAS is lazy-loaded with reserved dimensions and a same-character static fallback; app controls and status work if all character assets fail. Renderer/model/texture/frame budgets must come from the outstanding Phase 0 proof and existing route budgets, not guesses here.

## 6. Reduced motion, implementation boundaries and evidence

OS reduced motion is the floor: effective reduction applies when the OS requests it or the product chooses Reduced/Off. A product Full choice does not override OS reduction. Set UI duration tokens to 0, remove slide/scale/rotation, use static state poses, disable character clips, smooth scrolling, shimmer and decorative waveform movement. Labels, progress values and controls remain immediate; an essential indeterminate state can be conveyed by static text instead of a spinner. Voice playback and mic permission remain independent of visual motion. Product character visibility and low-power/static mode also do not change execution behavior.

Implementation seams: consolidate tokens in `src/app/globals.css`; incrementally replace the conflicting `.daybook` palette/serif/glow overrides in `app-shell.module.css`, rather than adding a third theme. Preserve early theme boot, theme persistence, protected session behavior, skip link, main focus, intent prefetch, drawer focus restoration and visibility-aware refresh. Reuse existing conversation, projects, approval and voice controllers; source new character poses from a read-only presentation adapter, never animation callbacks that can execute actions. Read the installed Next guides before runtime changes as required by `AGENTS.md`. Native uses the same semantic values and behavior with native controls/menus/window conventions, not a forced web DOM layout.

Outstanding implementation evidence is concrete: light/dark screenshots for these three compositions and phone variants; 200% text scaling and 320px reflow; keyboard/VoiceOver or other supported screen-reader walkthroughs; actual computed style contrast including every new composite; reduced motion and forced-color captures; functional checks for preserved controllers and exact decision branches; and measured static-versus-character performance against `QUALITY_AND_ROLLOUT.md`. No runtime code, renderer proof, builds, browser tests, deployment or completed page migration is claimed by this specification. This work introduces no additional owner approval flow.
