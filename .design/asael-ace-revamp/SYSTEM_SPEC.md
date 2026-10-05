# ATLAS interface system specification

**Original specification — 3 October 2026.** Implementation has since progressed through accepted PR72; see [current delivery status](CURRENT_STATUS.md). The following original specification and calculated contrast evidence retain their scope. This extends [the design brief](DESIGN_BRIEF.md) and [quality gates](QUALITY_AND_ROLLOUT.md) against source baseline `89f65c2f`. The conversation and voice reference images were visually inspected. Their composition and finish are references; their teal character, faint text and contradictory voice labels are not implementation requirements. The selected ATLAS concept has now been exported and inspected: [four-pose eagle study](references/atlas-selected.png), with provenance in `references/atlas-export.json`. It is a raster concept, not a production model, rig or animation. Runtime rendering, screenshots, assistive technology and performance validation remain outstanding.

**Visual thesis:** warm near-white reading surfaces and graphite voice space, with precise typography, restrained boundaries and an expressive umber eagle. **Content plan:** navigation → current conversation or working list → optional evidence/detail; each area has one clear task. **Interaction thesis:** immediate controls, short interruptible context transitions, and occasional ATLAS reactions tied to actual state. Routine operational pages use utility language and dense rows rather than decorative cards.

## 1. Semantic color contract

Use these opaque sRGB values as the initial portable source for web and native. Keep existing semantic names where indicated so migration can proceed by component. Hex values are intentional; an eventual conversion to another color space must preserve rendered colors and repeat contrast calculations. Do not reduce text opacity or blend these text tokens over unmeasured backgrounds.

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--background` | `#FAF9F6` | `#191A1B` | Main canvas; dark voice stage |
| `--surface` | `#FFFFFF` | `#222325` | Field, composer, menu or distinct interactive region |
| `--surface-raised` | `#F0EEEA` | `#2B2C2F` | User message, hover, neutral badge |
| `--surface-overlay` | `#E8E4DE` | `#34363A` | Pressed/selected neutral region; not a scrim |
| `--foreground` | `#242321` | `#F4F1EA` | Primary text and essential icons |
| `--muted` | `#69645E` | `#B8B3AA` | Secondary information, inactive navigation, placeholders |
| `--line` | `#DDD8D0` | `#3E4146` | Decorative dividers only; not a sufficient control boundary |
| `--line-strong` | `#827A70` | `#888980` | Necessary field/control boundary and essential neutral graphics |
| `--primary` | `#272521` | `#F0EDE7` | Dominant action fill; deliberately neutral |
| `--primary-ink` | `#FAF9F6` | `#242321` | Text/icons inside the dominant action |
| `--primary-hover` | `#3A3731` | `#FFFFFF` | Explicit hover fill, without brightness filters |
| `--primary-pressed` | `#171613` | `#D9D4CB` | Explicit pressed fill |
| `--accent` | `#806019` | `#E2BD74` | Restrained gold: links, selected mark, ATLAS detail |
| `--accent-surface` | `#F5EBD3` | `#3C3222` | Optional selected item fill |
| `--success` / `--success-surface` | `#286243` / `#E8F2EB` | `#91CFAC` / `#203A2B` | Confirmed successful result |
| `--warning` / `--warning-surface` | `#805814` / `#FAF0D6` | `#E7C37C` / `#41351F` | Waiting/attention with an explanatory label |
| `--danger` / `--danger-surface` | `#AC3530` / `#FBECEA` | `#F1A09A` / `#422728` | Error or destructive effect |
| `--info` / `--info-surface` | `#2E627C` / `#EAF1F5` | `#9CCAE0` / `#263944` | Informational state when a distinct semantic color helps |
| `--focus` | `#8D611A` | `#F0C77B` | Keyboard focus ring |

Gold is the brand accent; success, warning, danger and info are functional exceptions. A state always has a text label and, where useful, a distinct icon. Never make an ambiguous green dot mean both availability and successful execution. Inline links are underlined; navigation indicates selection with `aria-current`, weight and a 3px marker in addition to color. Voice follows the effective selected theme. Its graphite variant uses the same dark tokens; opening voice does not override the owner’s light/system preference.

### Calculated contrast evidence

Computed on 3 October 2026 from the above hex pairs using WCAG relative luminance: normalize each sRGB channel, use `c/12.92` for `c ≤ 0.04045` and `((c+0.055)/1.055)^2.4` otherwise; `L = 0.2126R + 0.7152G + 0.0722B`; ratio is `(Lmax+0.05)/(Lmin+0.05)`. Values below are rounded to two decimals; all acceptance comparisons use unrounded values. This is mathematical token evidence, not a rendered accessibility audit.

Each cell lists contrast against **canvas / surface / raised / overlay**, in that order.

| Foreground | Light ratios | Dark ratios |
|---|---|---|
| Primary text `foreground` | 14.91 / 15.70 / 13.55 / 12.40 | 15.45 / 13.94 / 12.38 / 10.73 |
| Secondary/inactive text `muted` | 5.56 / 5.86 / 5.06 / 4.63 | 8.35 / 7.54 / 6.69 / 5.80 |
| Gold link/selected text `accent` | 5.53 / 5.83 / 5.03 / 4.60 | 9.76 / 8.81 / 7.82 / 6.78 |
| Success text/icon | 6.83 / 7.20 / 6.21 / 5.68 | 9.73 / 8.78 / 7.80 / 6.76 |
| Danger text/icon | 6.03 / 6.35 / 5.48 / 5.02 | 8.49 / 7.67 / 6.81 / 5.90 |
| Warning text/icon | 6.00 / 6.32 / 5.45 / 4.99 | 10.37 / 9.36 / 8.31 / 7.20 |
| Info text/icon | 6.32 / 6.66 / 5.75 / 5.26 | 9.91 / 8.94 / 7.94 / 6.88 |
| Focus ring | 5.17 / 5.44 / 4.70 / 4.30 | 10.92 / 9.86 / 8.75 / 7.59 |
| Necessary control boundary `line-strong` | 4.02 / 4.23 / 3.65 / 3.34 | 4.93 / 4.45 / 3.95 / 3.42 |

| Additional pair | Light | Dark |
|---|---:|---:|
| Action ink on primary / hover / pressed | 14.53 / 11.26 / 17.19 | 13.44 / 15.70 / 10.64 |
| Accent on accent-surface | 4.91 | 7.04 |
| Success on success-surface | 6.28 | 6.89 |
| Danger on danger-surface | 5.53 | 6.59 |
| Warning on warning-surface | 5.57 | 7.12 |
| Info on info-surface | 5.83 | 6.82 |
| Lowest primary text ratio across five semantic fills | 13.24 | 10.62 |
| Lowest muted text ratio across five semantic fills | 4.94 | 5.74 |
| Lowest focus ratio across five semantic fills | 4.59 | 7.50 |

Thus all listed normal informational text pairs exceed 4.5:1, including inactive navigation and secondary text. Essential boundaries and focus exceed 3:1 on their specified adjacent surfaces. For a solid destructive button use `danger` with white text in light mode (6.35:1) and `primary-ink` in dark mode (7.65:1); ordinary approval remains neutral. Do not apply a danger fill to the normal Reject action merely because it is a refusal.

**Focus adjacency:** use a 3px `focus` outline with 3px offset. Paint the intervening 3px gap with the exact opaque surrounding surface; the ring then touches that same surface on its inner and outer edges. This is necessary around dark buttons in light mode and light buttons in dark mode: gold does not have sufficient contrast against every action fill directly. Reserve at least 8px unclipped space around focused controls. On imagery, supply an opaque surface plate extending beyond the whole ring. Do not substitute a translucent glow. Focus appears immediately, never fades in, and remains visible beneath sticky chrome through correct scroll padding.

High contrast: set `muted` to `foreground`, `line` to `line-strong`, remove scrim blur/shadows, and retain explicit selection markers. Under forced colors let system colors control rendering; use `Canvas` for surfaces/gaps and `CanvasText` or `Highlight` for outlines/selection, with real borders and text labels. Never opt essential controls out with `forced-color-adjust: none`.

## 2. Type, space and geometry

Keep web Geist Sans and Geist Mono; native keeps system typography and text scaling. Use one sans hierarchy, weights 400/500/600. Mono is for actual code, identifiers or aligned technical values; tabular numerals suffice for counts. Do not use the shell's Daybook serif in the new workspace.

| Role | Size / line height | Weight / tracking | Use |
|---|---|---|---|
| Page title | 28 / 36px; phone 24 / 32px | 600 / −0.02em | One `h1` per page; never repeated in a large hero |
| Section title | 20 / 28px | 600 / −0.01em | A working region or inspector title |
| Item title | 16 / 24px | 600 / 0 | Project/task/approval title |
| Reading/conversation | 16 / 26px | 400 / 0 | Transcript and prose; max 720px or about 65–75ch |
| UI body / dense row | 14 / 20px | 400 or 500 / 0 | Navigation, controls, tables |
| Supporting information | 13 / 20px | 400 / 0 | Timestamps, status detail, provenance; never weakened with opacity |
| Code / exact inputs | 13 / 20px | 400 / 0 | Wrap safely; preserve exact string meaning |
| Voice transcript | `clamp(24px, 2.5vw, 36px)` / 1.3 | 400 / −0.02em | Current utterance, maximum 32ch; previous text remains accessible |

Implement sizes in rem equivalents (16px root), line heights without clipping, and heights as minima. Phone form input text remains at least 16px. At 200% text size, controls grow vertically, labels wrap, and columns stack rather than truncate important information. Compact metadata has a readable full-detail alternative; never make a tooltip the only place a necessary value exists.

Spacing tokens: `4, 8, 12, 16, 24, 32, 48, 64px` (`0.25–4rem`). Icon/text gaps 8px; field label/helper gaps 8px; related controls 8px; row inset 12–16px; section gaps 24–32px. Page gutters are 16px below 768px, 24px at 768–1023px, and 32px above. Use CSS logical properties.

Radius tokens: `6px` small inline badge/code surface, `10px` controls, `12px` menus/user bubble, `16px` composer or decision surface, `24px` modal/sheet corner, `999px` only for compact filter chips, circular avatar and deliberate voice dock. Ordinary rows are flat, divided by `line`; do not box every section.

Elevation: ordinary panels have no shadow. Composer/menu may use `0 2px 8px rgb(24 23 21 / 0.06), 0 12px 32px rgb(24 23 21 / 0.04)` in light; dark uses `0 8px 32px rgb(0 0 0 / 0.24)` with a visible edge. Modal scrim is `rgb(12 12 12 / 0.40)` in light and `/ 0.60` in dark. Never place readable text directly on the scrim. No ambient radial glows, glass blur or decorative gradient rules in routine workspace chrome.

## 3. Shell, controls and resource states

Desktop rail: retain the existing persisted expanded/collapsed preference and all authorized destinations. Expanded width 240px, compact width 80px, header 64px minimum. Expanded rows are 40px minimum with visible 14px labels, 18px Lucide icons and 12px inset. Compact targets are 44 × 44px with accessible names and hover/focus labels that also work on touch. Active item uses a neutral or accent-surface fill and 3px marker; no glow. Preserve counts and grouped navigation. Navigation search remains navigation search until universal content search exists.

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

For a 1440 × 900 desktop reference frame with compact 80px rail: 64px header, 720px transcript centered in the remaining canvas (left edge 400px), 32px side clearance, and a composer aligned to the transcript. Expanded rail centers the same transcript in its remaining canvas. Use a grid with header, scrollable conversation and composer rows; the composer is not a fixed overlay over unread messages. Reserve actual composer/dock height when scrolling to a message. Show thread/history and optional detail only when opened; neither consumes the conversation by default.

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
| `--duration-sheet` | 240ms | Sheet/dialog entry or exit; at most 16px travel |
| `--duration-settle` | 420ms | Optional character recovery after a meaningful gesture |
| `--duration-character` | 900ms | Complete occasional expressive beat, including anticipation and settle |

Easing: `--ease-standard: cubic-bezier(0.2, 0, 0, 1)`; entry `cubic-bezier(0, 0, 0.2, 1)`; exit `cubic-bezier(0.3, 0, 1, 0.3)`; linear only for actual progress. No spring on routine controls, fields, tables or approval actions. Character animation may use authored overlap/overshoot after its renderer proof. An example 900ms comic beat is 80ms anticipation, 260ms reaction, 140ms hold, 420ms settle; it never postpones the response or next action.

Animate only opacity and short transform where practical; do not transition `all`, large backdrop filters or page heights. A user-opened menu may move 4px, a detail reveal 6px, a sheet 16px. An optional first-use introduction can stagger at most three elements by 30ms and finish within 300ms. No repeated entrance on refresh, token-by-token bounce, route-wide sweep or delayed button. Preserve scroll/focus/drafts when a rail or inspector changes width; prioritize stable final layout over interpolating the whole transcript width. An interrupted transition resolves to the latest actual state.

ATLAS is the original umber eagle with pale throat, gold beak/eyes and expressive brow/wing poses. The exported study supports confidence, listening, double-take and satisfaction. Collar visibility is inconsistent across those four raster poses; resolve one consistent charcoal-collar design in production turnarounds. Do not reuse the historical teal mascot, treat the sheet as a sprite-ready rig, or imply that existing orbit animation is ATLAS.

| State | Character direction | Required independent UI |
|---|---|---|
| Available | Neutral attentive pose; mostly still | Availability label, current conversation |
| Listening | Small head tilt / eye attention; restrained | Actual mic state and visible stop/review control |
| Responding | Compact beak/wing performance when playback is real | Reply text, playback and interrupt controls |
| Working | Brief orienting glance then still | Real work status, progress only when known |
| Needs you | One attentive brow/wing cue, then hold | Exact approval/clarification and choices |
| Blocked/reconnecting | Calm concerned pose; no repeated alarm | Specific cause, preserved work and recovery |
| Completed | One satisfied nod after confirmed successful outcome | Verification/result; unverified completion stays labelled unverified |
| Paused | Settled resting attention | Paused state and permitted resume/end action |

Balanced is the proposed default intensity. Quiet uses static/brief functional cues; Expressive adds occasional double-take, glance and wing reactions with original quick wit. These settings change presentation, not executing agent identity, authority or accuracy. The built-in Supervisor named Atlas retains its own immutable agent/version. No celebrity likeness or voice, comedy during sensitive decisions, or celebration of an unverified result.

All modes pause hidden/offscreen renderer work, release unused GPU/audio-independent resources, and cancel stale gesture queues. Default idle is still while reading; no mandatory infinite bounce or breathing. A completed reaction plays once per confirmed event identity, not again on poll, rerender or focus. ATLAS is lazy-loaded with reserved dimensions and a same-character static fallback; app controls and status work if all character assets fail. Renderer/model/texture/frame budgets must come from the outstanding Phase 0 proof and existing route budgets, not guesses here.

## 6. Reduced motion, implementation boundaries and evidence

OS reduced motion is the floor: effective reduction applies when the OS requests it or the product chooses Reduced/Off. A product Full choice does not override OS reduction. Set UI duration tokens to 0, remove slide/scale/rotation, use static state poses, disable character clips, smooth scrolling, shimmer and decorative waveform movement. Labels, progress values and controls remain immediate; an essential indeterminate state can be conveyed by static text instead of a spinner. Voice playback and mic permission remain independent of visual motion. Product character visibility and low-power/static mode also do not change execution behavior.

Implementation seams: consolidate tokens in `src/app/globals.css`; incrementally replace the conflicting `.daybook` palette/serif/glow overrides in `app-shell.module.css`, rather than adding a third theme. Preserve early theme boot, theme persistence, protected session behavior, skip link, main focus, intent prefetch, drawer focus restoration and visibility-aware refresh. Reuse existing conversation, projects, approval and voice controllers; source new character poses from a read-only presentation adapter, never animation callbacks that can execute actions. Read the installed Next guides before runtime changes as required by `AGENTS.md`. Native uses the same semantic values and behavior with native controls/menus/window conventions, not a forced web DOM layout.

Outstanding implementation evidence is concrete: light/dark screenshots for these three compositions and phone variants; 200% text scaling and 320px reflow; keyboard/VoiceOver or other supported screen-reader walkthroughs; actual computed style contrast including every new composite; reduced motion and forced-color captures; functional checks for preserved controllers and exact decision branches; and measured static-versus-character performance against `QUALITY_AND_ROLLOUT.md`. No runtime code, renderer proof, builds, browser tests, deployment or completed page migration is claimed by this specification. This work introduces no additional owner approval flow.
