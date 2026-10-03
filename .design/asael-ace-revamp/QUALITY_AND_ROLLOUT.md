# Quality, validation and rollout plan

**Implementation quality gates.** Current progress and observed results are tracked in [implementation evidence](IMPLEMENTATION.md). The owner selected ATLAS and authorized implementation after the operational follow-ups. No revamp application tests or deployments were run by this documentation update. The original planning baseline was `89f65c2f`; implementation starts from `origin/main` `dc1cfe6e`. Validate the complete experience, including slow, stale, interrupted and inaccessible states; design screenshots do not establish functional, accessibility or performance readiness.

## Definition of a completed page family

Each row/subview in PAGE_PLAN.md has a working implementation using the shared system, preserves its existing supported actions and links, and has evidence for relevant loading/empty/stale/error/permission/pending/success states. Review phone/desktop and light/dark compositions, keyboard behavior and reduced motion. Native families additionally preserve platform navigation, lifecycle and secure storage behavior.

Before replacing an old surface, compare the actual before/after workflow using the same safe fixtures. Track retained functionality, intentional changes, current defects and remaining gaps explicitly. Do not remove the old route because its replacement looks finished while its rare controls or recovery states are missing.

## Functional validation matrix

| Flow | Required evidence |
|---|---|
| Auth and navigation | Private access unchanged; permitted direct links, aliases, return paths, browser history, logout and expired session; inaccessible entity gives a safe state |
| Conversation and queue | Send/follow/reopen; live versus queued state; reorder/edit pins; stream reconnect; draft retention; current Agent/model/target visible; cancellation and partial result |
| Preferred conversation | Designate/change/reset home thread; authorization checked when opening; deleted/inaccessible thread falls back without creating a duplicate or revealing content |
| Approvals | Exact action/target/input display; changed/expired/already-decided decision; duplicate click; deny; resume the correct existing run; return to origin |
| Voice | Actual mic/playback state; denied/busy permission; live transcript and review; interruption; text handoff; disconnect/backgrounding; no unintended recording or run cancellation |
| Work and Builder | Canonical tasks/templates/budgets; pause/retry/archive; artifact selection; preview isolation; verification and exact repository/PR/deployment/release actions |
| Memory/Capture/Library/Search | Scope/provenance/version retained; correction and forget impact; partial indexing and retry; supported offline queue; search revocation/deletion and inaccessible result handling |
| Specialist/admin | All listed subviews and supported operations, role-aware details, stale/unknown data, payment challenges, connection review/revoke and one-time secret display |
| Notifications | Quiet hours/digest/suppress, one notification per event/change, safe cross-device destination, failure/retry history; queued/accepted/delivered are distinct |
| ATLAS and personality | Optional character; renderer failure; hidden/low-power/reduced motion; foreground audio precedence; humor/style settings do not alter authority or misstate facts |
| Responsibilities | Accepted-baseline rules; defined material-change policy; no-change quiet behavior; stale evidence; cumulative limits; duplicate/restart/revocation; pause/end races and committed-effect reconciliation |
| Native lifecycle | Background/resume/restart; quick-entry/ambient voice; pending-work guards; notification/share links; encoded result keys; device enrollment/revocation and This Mac leases |

Use synthetic fixtures and isolated test accounts for automated coverage. External effects and paid/provider/device checks are separate bounded validation with the intended target and evidence; visual review is never a reason to execute arbitrary real actions.

## Accessibility and motion

Target WCAG 2.2 AA for web. Check text contrast (normally 4.5:1, large text 3:1), non-text contrast, keyboard operation, focus visibility/obscuration, accessible names, reflow and status announcements. Use the [W3C WCAG 2.2 reference](https://www.w3.org/WAI/WCAG22/quickref/) for exceptions and complete criteria, not this abbreviated list.

Product-specific acceptance:

- Prefer 44px web and 48 logical-pixel touch targets for primary actions; compact desktop controls still require accessible target spacing and keyboard operation.
- Test 200% text scaling, narrow reflow, long labels and dense tables/charts with accessible alternatives. Essential content cannot disappear behind a composer, sheet or software keyboard.
- Preserve skip links, focus trapping/restoration, Escape behavior and scroll position. Hover-only disclosure must also work with keyboard and touch.
- Announce concise meaningful status changes. Do not repeatedly read a stream token, decorative gesture or every refresh through a live region.
- Respect OS/product reduced motion and high contrast/forced colors. Every animated state has a static equivalent; controls never wait for a clip to finish.
- Manually check at least one screen reader on web and VoiceOver on native, alongside automated checks. Verify actual focus order on mobile and macOS.

Motion review uses real interaction recordings: approximately 120ms controls, 180ms content changes and 240ms sheets; short travel, clear cause and effect, stable layout and no repeated list entrance on refresh. ATLAS has a richer occasional repertoire of brow/wing reactions, listening tilts, comic beats and one-shot celebrations, with stillness while reading. Every clip is interruptible, honors motion preferences and remains supplementary to immediate functional feedback.

## Performance gates

Treat `performance-budgets.json` as the source of enforced budget values at implementation time. Values below are the inspected baseline; changing them requires its own reason and review.

| Budget | Current baseline |
|---|---|
| Core Web Vitals | LCP 2,500ms; INP 200ms; CLS 0.1 |
| Authenticated reads / session | p95 500ms / 300ms |
| Normal dashboard usable | 1,500ms |
| Release dashboard | Usable target 2,500ms, maximum 5,000ms; first-load target 4,000ms, limit 5,000ms |
| First run status / visible completion | 1,000ms / 1,000ms |
| Workflow pickup | p95 10,000ms |
| Hero image | 204,800 bytes maximum |
| Default first-visit route JS | Public 560,000 bytes; workspace 800,000 bytes |
| Route JS exceptions | Command 920,000; Agents/Projects 1,100,000; Markets 1,050,000; Missions list/detail 1,030,000 bytes |

Route JS limits refer to uncompressed first-visit build bytes including framework code, not compressed network transfers. Keep the existing trace/bundle checks and distinguish those measurements from runtime asset downloads. Core Web Vitals field assessment uses the 75th percentile; a passing single lab run is not a field claim. See the primary [Core Web Vitals guidance](https://web.dev/articles/vitals).

ATLAS must not become a prerequisite for the initial usable screen. Measure a static-poster baseline against the character-enabled flow; lazy load the renderer/asset, reserve its geometry, pause hidden instances, release resources and cache appropriate exports. Set explicit model/texture/clip/memory/frame budgets after Phase 0 measurements, then enforce them. Do not silently expand route budgets to absorb a large renderer.

Test long conversations, large work lists, graph neighborhoods, source collections and market charts with representative bounded datasets. Preserve current intent-based prefetch and hidden-tab refresh behavior. Use pagination/windowing where measurements justify it. Record device, browser, build, network conditions, warm/cold cache and test method with results.

On native, measure startup and quick-entry latency, voice responsiveness, memory/frame stability and energy/thermal behavior on real supported targets. Agree device-specific budgets after the initial proof; a fast desktop browser does not validate a phone GPU or a background macOS utility window.

## Test layers and evidence

**Existing checks to retain:** strict lint/types, unit/coverage, build, route JS and trace-budget checks; backend/integration/worker checks where contracts change; Flutter analysis/tests and native packaging checks. Read installed Next documentation before implementing routing, transitions or client lazy-loading changes because this repository uses a newer framework version.

**New focused coverage:** browser interaction tests for conversation, approval, navigation and recovery; representative visual regression states; automated accessibility scans plus manual assistive-technology checks. The inspected project has no general Playwright browser suite. Add it deliberately as part of implementation rather than claiming that current unit rendering proves browser behavior.

**Native additions:** theme/text-scaling goldens and widget/state tests for migrated families, controller tests for contract changes, then actual device tests for audio, backgrounding, deep links, local permissions and signed packaging. Avoid brittle snapshots of every pixel and tests that merely repeat a CSS constant.

**Responsibility additions:** contract tests for scope, budgets, baseline/change identity, delivery dispositions and generation fencing; integration tests for pause/end/restart/revocation races. A policy fixture should identify expected material and cosmetic meeting changes and demonstrate reproducible decisions with evidence. No private chain-of-thought is collected as test output.

Evidence per checkpoint: source revision, routes/subviews covered, real functional outcomes, before/after captures, accessibility results, performance/bundle deltas, known limits and rollback path. Record a failed gate and resolve or explicitly scope it; do not label an untested deployment ready.

## Migration and release

1. **Prepare additive presentation changes.** Implement by family around existing controllers, with one token/component source. Keep old URLs and selected-entity query contracts. Update conflicting design documentation when the new system actually becomes the implementation target.
2. **Separate capability availability from visual rollout.** Introduce named reversible configuration only where necessary; there is no assumption that a generic feature-flag service already exists. The new shell must not show dead Activity/Responsibility links before those contracts and routes are ready.
3. **Maintain web/native compatibility.** New preferences, read models and responsibility records need additive/versioned contracts and safe behavior for older clients. Any schema work follows the existing migration and backup/recovery process; never replace domain storage just for a new UI.
4. **Review each usable milestone privately.** Validate with the owner and safe test records, including low-performance/static ATLAS presentation. Complete both light and dark states before marking a page family migrated. Complete Phase 2 and 3 page work as well as Phase 4 before claiming all 38 web routes are finished.
5. **Promote through existing repository procedures.** Follow [production-rollout.md](../../docs/production-rollout.md) and [deployment.md](../../docs/deployment.md). Production releases use the paired runner from a clean, verified main revision with required CI evidence, including for web-only changes. Do not bypass this with an independent direct web/native deployment.
6. **Observe and recover.** Watch auth/route errors, run/approval continuity, notification behavior, latency, memory/asset failures and native compatibility. An ATLAS asset failure should fall back locally without a whole-service rollback. Functional or authorization regressions, incompatible contracts or failing release gates use the documented compatible-artifact and database recovery path.

Rollback must not erase work created during the migration. Prefer compatible additive data changes; preserve run, approval, evidence and notification identities. For ongoing responsibilities, a UI toggle alone does not stop background work: lifecycle fencing and delivery controls remain effective even when its new page is disabled or an older client reconnects.

## Risks and decisions to close during implementation planning

| Open item | Resolution and owner |
|---|---|
| ATLAS concept exported and visually inspected; collar consistency needs correction and no production assets exist | Complete source/rig/clip pipeline after renderer proof; design owner reviews consistency and small-size readability |
| Native 3D feasibility is unproven | Web/native engineers benchmark before production exports; retain same-character pre-rendered/static options |
| Wide page scope and large existing components | Page-family owners migrate presentation incrementally; shared-system owner prevents diverging controls/themes |
| Universal content search is new | Backend owner defines scoped providers, deletion/revocation and partial results; UI does not imply complete search before coverage exists |
| Ongoing responsibilities span several systems | Backend owner defines evidence, lifecycle, budgets and notification identity before activating the pilot |
| Deployment/configuration may differ from source; production credentials are owner-held | Release owner verifies actual availability, readiness and credential access through the existing promotion process; locally verified implementation alone is not a deployment claim |
| Effort and schedule depend on asset/device proof | Re-estimate after Phase 0 and a representative vertical slice; report milestones and remaining evidence rather than invented dates |

ATLAS selection is settled on 3 October 2026. The remaining decisions concern asset inspection, original-character production fidelity, measurable performance and functional scope. Implementation is authorized after the operational follow-ups, with the first web presentation slice now in progress. Production promotion remains contingent on the documented release evidence and the owner-held production credentials/signing materials; report a pending promotion honestly while completing all independent work.
