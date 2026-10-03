# Feature and functionality implementation plan

**Preparation only; implementation authorized after the operational follow-ups.** This document specifies the behavior and work required. “Existing” refers to inspected source, reconfirmed against `origin/main` `89f65c2f`, not a live service certification. The first release should make today's capabilities coherent; ongoing responsibilities are a separate functional release.

**3 October 2026 decision:** ATLAS, an original eagle, is selected. The owner wants energetic quick wit, Kevin-Hart-inspired comic timing and more purposeful animation while preserving the elegant light/graphite interface. ATLAS has its own identity and voice; production assets and animation remain to be made.

## Capability map

| Experience | Existing foundation | Proposed implementation | Classification |
|---|---|---|---|
| One familiar assistant | Durable scoped threads, run links, specialist identities | Assistant as the primary entry, history and continuation, persisted preferred home thread/destination, clear executing Agent | Extend |
| Rich conversation | Streaming, context/file pins, plans, artifacts, citations, feedback | Consistent composer and message/result components, compact actual progress, progressive evidence disclosure, mobile keyboard behavior | Extend |
| Work queue | Durable ordered prompts, pause/remove/reorder, versioned context/model/target pins | Clear queued versus dispatched state, edit review and status linked to the resulting run | Extend; never make queue placement an authorization grant |
| Activity and decisions | Run events, safe progress, approval records and notification dispositions | New human-facing Activity aggregation, shared inline/detail decision card, contextual return links | New presentation/read projection over existing records |
| Work and outcomes | Projects, tasks, templates, execution, App Builder, Results and WorkItem projection | Outcome-oriented Work overview, consistent inspectors and evidence, goal presentation over canonical work | Extend; no second task/goal ledger |
| Memory and Library | Memory provenance/lifecycle, knowledge, reviews, graph, source versions, captures and artifacts | Understandable source/fact distinction, correction/forget review, useful file view and context attachment | Extend; no duplicate byte or memory store |
| Search | Navigation command palette and domain-specific search | Permission-filtered search of conversations, work, memory and Library, grouped results with origin and freshness | New content-search aggregation/indexing work |
| Voice | Live transcription, reviewed send, governed run, exact-response TTS and speech interruption | Immersive voice stage, ATLAS states, clear listening/transcribing/sending/working/playing controls, text continuity | Extend; full automatic turn taking is not assumed |
| ATLAS | Selected eagle concept exported from Stitch and visually inspected; existing generic orbit Lottie components; no production ATLAS asset | Production 3D asset, state adapter, expressions, delivery fallbacks, independent visibility/motion settings | New asset and presentation work |
| Personality | Versioned Agent persona/charter/style and voice delivery | Owner-controlled expressive intensity, consistent microcopy/performance rules and tested behavior precedence | New preference contract plus persona integration |
| Notifications | Quiet hours, send/defer/digest/suppress decisions and durable records | Preference UI, readable history, cross-device deep links, truthful delivery receipts | Extend; “accepted” is not “delivered” |
| Ongoing responsibilities | Mature procedures, triggers, schedules, approvals, policy leases and durable runs | Purpose across checks, accepted evidence baseline, meaningful-change comparison, cumulative limits, coordinated pause/end | New domain contract built on the existing execution harness |
| Connections and Skills | OAuth, MCP/OpenAPI, contract/manifest review, capability readiness | Task-oriented setup, permissions/freshness, reconnect/revoke, exact activation review | Extend; installed, connected, indexed and approved remain different states |
| Local computer work | Governed explicit This Mac target and native leases/OS permissions | Clear target/readiness and live activity in Assistant/Work; retain exact authority boundaries | Extend presentation; retired cloud browser is not reintroduced |
| Specialist/admin work | Meetings, customer accounts, markets, agents, payments, quality, monitoring, security, advanced settings | Complete page-family revamp with retained operations and accurate state coverage | Extend; see every-page plan |

## Companion behavior

### ATLAS's personality

Use warm confidence, brisk delivery, quick reactions, well-timed pauses and occasional self-aware humor. Kevin Hart informs energy and comic timing; ATLAS retains original phrasing, an original eagle identity and its own voice. Attentive eyes, brow feathers, head tilts and compact wing gestures give it a broader expressive range while concise useful answers remain the default. Serious decisions, errors and sensitive subjects use direct language and a composed pose.

| Setting | Language and performance |
|---|---|
| Quiet | Direct wording, static or very restrained poses, no unsolicited jokes |
| Balanced — proposed default | Warm phrasing and occasional small reaction after a meaningful result |
| Expressive | Energetic quick wit, stronger anticipation, brow/wing reactions, double-takes and brief celebrations; still concise, interruptible and sensitive to context |

Voice output, character visibility and reduced motion are independent controls. A person can choose expressive writing with no audio or animation. Store owner preferences under tenant/actor scope on the server and use local caches only for fast presentation. Honor OS reduced motion as well as the product setting. Provide preview and reset controls; changing personality must not start a task.

Task instructions, safety and truthful reporting take precedence; the versioned executing Agent's charter and limits remain authoritative. Personality preferences affect delivery, not permissions, factual confidence, routing or tool arguments. Record the selected style version when needed for reproducible delivery without exposing private reasoning. Preserve the current Cedar voice configuration until a separate original-voice audition establishes a supported replacement.

Proposed dialogue examples for design testing:

| Situation | Example | Acting |
|---|---|---|
| Greeting | “What are we getting done today?” | Brief eye contact, small confident nod |
| Ambiguous request | “Quick check: which project should I use?” | Attentive tilt; wait for the answer |
| Confirmed success | “Done. One less thing on your list.” | One small celebration, then settle |
| Optional expressive success | “That was a lot of tabs. We have a plan now.” | Short double take only when context supports it |
| Approval | “Ready to send to Maya. Review the message below.” | Still and attentive; exact action card supplies details |
| Failure | “The connection expired. Reconnect it to continue.” | Neutral concern; direct recovery action |

Avoid repetitive catchphrases, invented emotional dependence, jokes in sensitive situations or exaggerated claims of success. A joke may never replace an error, evidence or decision. Treat these lines as samples, not claims about work already completed.

### Character state and interaction contract

The presentation adapter consumes public application state and emits a pose/clip plus accessible text. Assets and animation callbacks have no tool authority. If the renderer fails, the application continues with a static portrait and the same controls.

| State | Real trigger | Performance and required UI |
|---|---|---|
| Available | No foreground voice or selected active work | Mostly still; occasional non-looping gesture; ordinary composer |
| Listening | Device actually capturing audio | Attentive pose; visible mic state and stop control |
| Responding | Response audio actually playing | Speech pose; visible transcript, interrupt and volume/output controls |
| Working | Selected run confirmed active | Restrained anticipation; labelled real activity, no fabricated percentage |
| Needs you | Clarification or live approval exists | Attentive pause and a decision/request surface |
| Blocked/reconnecting | Reported failure, missing permission or lost connection | Neutral pause; recovery steps and retained context |
| Completed | Persisted terminal success/verification evidence | Single brief gesture; distinguish partial or unverified results in text |
| Paused | Pause acknowledged by the relevant system | Resting pose; actual scope and resume controls |

Foreground audio owns the main pose when voice and background work overlap. Background runs keep separate labelled status. “Stop speaking,” “Stop recording,” “Cancel this run,” and “Pause this responsibility” are different commands with distinct effects. Reopening a completed thread does not replay a celebration indefinitely.

Interface motion starts at approximately 120ms for controls, 180ms for content changes and 240ms for sheets. Expand the character vocabulary with occasional state-driven reaction sequences; do not repeat entrances on refresh, keep idle mostly still, and never wait for acting before enabling a control. Reduced motion supplies static state poses and the same accessible labels.

### Production assets and rendering decision

1. Use the exported and visually inspected Stitch eagle concept to make consistent model sheets and a rough animated prototype of its tapered umber body, pale throat, golden beak, charcoal collar, eyes/brow feathers and expressive wings. No production ATLAS asset is currently available.
2. Test that prototype on the web and real native target devices before final rig/export production. Measure loading, memory, frame stability, thermals, text responsiveness and accessibility fallbacks.
3. Choose the delivery matrix. Preferred candidate: an optimized authored glTF character for expanded web voice where budgets permit; compact portrait/short renders for small surfaces. Flutter can use a proven compatible renderer or pre-rendered clips of the same 3D asset. Do not assume Three.js or an existing Flutter Lottie component supplies native 3D support.
4. Finish topology/materials, rig and expressions against the proven export pipeline, then deliver the eight state clips, beak/speech test, close-up crop, light/dark lighting, poster and static fallbacks. Document usage rights, source project and export settings.
5. Integrate lazy loading, reserved layout space, cached assets, pause when hidden, resource disposal and reduced-motion/low-power fallbacks. App navigation and the composer must remain available before the character loads.

Three.js already provides a candidate web foundation: [GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html) supports glTF loading, and its [rendering-on-demand guidance](https://threejs.org/manual/pages/rendering-on-demand.html) is relevant to idle battery use. These are options to benchmark, not evidence that the selected asset meets the app's budgets. Lottie is useful for compatible vector effects and small UI motion; it is not the production rig for a spatial 3D character. The reviewed [LottieFiles skill](https://github.com/LottieFiles/motion-design-skill/blob/f9a8a041b85185ee4881b3471d3415e939aac772/skills/motion-design/SKILL.md) remains useful for timing, storyboards and transition critique.

## Conversation, Activity, search and voice

**Conversation:** keep existing scoped thread/run identities, prompt queue semantics, exact attachment versions and approval continuation. Allow designate/change/reset of the preferred home thread; recheck access whenever opening it and fall back to history/new-conversation choices if deleted or inaccessible, without silently creating a duplicate. Preserve drafts when opening details, switching themes or recovering from a network error. Keep potentially unsafe markup isolated through existing safe renderers. Rich result blocks link back to canonical artifacts/evidence rather than making decorative copies with a different truth state.

**Activity:** add a bounded, permission-filtered read model over existing run progress, approvals and notification records. Group by work/run with stable event references, cursor pagination and deduplication. Distinguish Needs you, Working, Updates and History. Provide safe human summaries, source links and updated timestamps; keep technical incident monitoring separate. Do not promote the partial/shadow canonical event-log program to authority just to support a new feed.

**Search:** start with one scope at a time behind a single grouped UI. Enforce access during retrieval and again when opening a result; index updates/deletion and revocation must not leave sensitive snippets visible. Use bounded results, stable source identities and honest partial/unavailable scope indicators. Preserve navigation search even when content search is unavailable. This is a separate feature from merely restyling the current palette.

**Voice:** retain live transcription and editable review/send as the initial behavior. Existing playback interruption remains available in both web and native experiences. Build explicit reconnect, microphone denied/busy, silence, transcription failure, interrupted audio and background-window states. Switching to text preserves the thread and attachments. Do not add always-on capture, wake words or automatic conversation turns as an implicit part of the visual revamp.

**Capture:** preserve note, audio and file ingestion and the existing supported offline queue. A shared URL currently enters as note text; arbitrary URL fetching and preview/indexing are not presumed implemented. A future URL-source ingestion feature would need its own governed retrieval and provenance contract.

## Ongoing responsibilities: the substantial new capability

A schedule answers when to run a procedure. A responsibility also needs to know what it is trying to accomplish, what evidence it last accepted, whether anything meaningful changed, whether to notify, and whether its cumulative authority remains valid. Build this above existing procedures, triggers and governed execution rather than introducing another agent loop.

### Proposed records and contracts

| Contract | Required contents and behavior |
|---|---|
| Responsibility | Tenant/actor, stable ID/version, purpose/outcome, canonical linked work, explicit sources, selected Agent/version and immutable procedure/policy references |
| Bounds | Cadence/trigger, timezone, start/end, maximum checks, cumulative cost/action limits, success/stop conditions and notification destination/rule |
| Observation | Source/version/evidence references, source freshness, observation time and retrieval failures; restricted bodies remain in their existing scoped stores |
| Accepted baseline | Last accepted observation/digest and comparison version, with a defined advancement rule; a failed/partial retrieval cannot silently become the new baseline |
| Check outcome | Typed meaningful_change, no_change, insufficient_evidence, blocked or failed; safe reason, evidence references and linked run |
| Change/delivery identity | Stable semantic change identity across repeated checks, notification deduplication and delivery acknowledgement/disposition; occurrence idempotency alone is insufficient |
| Lifecycle | Draft, active, pausing, paused, ending, ended and blocked/failing presentation derived from persisted lifecycle/generation and linked work |
| Authority | Revalidation on every wake; version/target changes return to exact review where required. A prior grant never becomes permission for a newly discovered target |

Initial baseline rule: the first successful bounded observation establishes the baseline. Later complete successful comparisons may advance it under the pinned comparison policy; insufficient, blocked and failed checks keep the prior accepted baseline. Preserve meaningful-change records independently of baseline advancement so retrying a delivery cannot lose or rediscover the same update. Outcome completion and notification delivery are distinct states.

### Pause, end and recovery

The existing schedule pause operation changes trigger status and protects some subsequent lease consumption; that is not yet a complete responsibility pause contract. Add a lifecycle generation fence and coordinate queued wakes, active runs, pending approvals, unconsumed leases and queued notifications. Every later effect/delivery checks the current generation and authorization.

Show “pausing” or “ending” until the linked systems acknowledge the relevant boundary. An already committed external effect is reconciled and reported; pausing is not a rollback promise. Ending prevents future work; deleting history or forgetting source data is a separate explicit operation. Resume specifies how missed checks are handled and retains the cumulative budget and evidence history across restarts.

### Read-only pilot

Use one bounded upcoming-meeting preparation responsibility with owner-selected existing sources and an explicit expiry. Surface it under Work, in Assistant and in Activity. The owner reviews its purpose, participants/source permissions, cadence, limits and “notify only on a material change” rule before activation. Do not imply permission to record a meeting or message participants.

The pilot reads authorized material, prepares a cited brief, compares it with accepted evidence and sends the owner at most one update per meaningful change through an already supported destination. Missing or stale data produces an honest status, not “nothing changed.” An uneventful successful check stays quiet unless the owner chooses otherwise.

Pin a reviewable comparison policy with owner-facing examples: changed meeting time or cancellation, a material agenda item, participant change, or a new/changed cited commitment or relevant source fact may qualify. Whitespace, formatting, duplicate imports, reordered equivalent content and fetch timestamps alone do not. Normalize deterministic metadata changes first; any semantic comparison must provide bounded evidence references and a typed reason. Evaluate the policy against a fixed fixture set; uncertainty yields insufficient_evidence or an explicit review state rather than a confident no_change. Policy changes are versioned and require an explicit baseline transition.

Acceptance requires duplicate/restarted wakes to produce no duplicate work or notifications; revoked access to prevent retrieval/disclosure; cumulative limits to survive restarts; and pause/end racing with approval or delivery to fence later activity correctly. Test source drift, comparison-version changes, unavailable destinations and partial evidence explicitly.

### Later expansion

After the read-only pilot is reliable, add one concrete reviewed action, such as drafting a follow-up and separately reviewing its exact recipients/content before sending through an existing governed connector. Add one external conversation channel only after account linking, identity verification, delivery receipts, deduplication and channel privacy are defined. Select the channel from actual user need and current connector support at that time. General cloud computer control, arbitrary long-lived grants and always-listening voice are outside this release sequence.

## Native and cross-device contract additions

Keep all existing native paths from the page inventory. Proposed additions are `/activity`, `/responsibilities` and `/responsibilities/:id`; map them explicitly to web `/app/activity`, `/app/responsibilities` and `/app/responsibilities/[id]`. Do not ship destination links before their route, permission and loading/error handling exist. Notification links carry opaque IDs and allowlisted focus parameters, not private content.

Restore the same authorized thread, project, responsibility, run, approval and evidence references on another device. Persist shared owner preferences centrally; keep platform-specific window/last-selection preferences local when appropriate. Native secure storage, signing/install identity and This Mac permission boundaries must survive the redesign. Introduce contract changes compatibly so an older native client remains usable during a staged web rollout.

## Code evidence and boundaries

Key inspected contracts include `src/lib/command/prompt-queue-contracts.ts`, `src/lib/command/composer-context-contract.ts`, `src/lib/threads/types.ts`, `src/lib/memory/types.ts`, `src/lib/workflows/types.ts`, `src/lib/voice/realtime-session.ts`, `src/lib/voice/profile.ts`, `src/lib/agents/persona.ts`, `src/lib/runs/types.ts` and `src/lib/tools/executor.ts`. UI evidence includes `agent-runs-workspace.tsx`, `voice-mode.tsx`, `automation-studio.tsx`, `command-palette.tsx` and the Flutter router/controllers. File locations should be re-resolved before implementation if the branch changes.

Architecture, API and harness rules still govern every feature: explicit tenant/actor scope, authorization on current state, idempotent governed actions, exact approval continuation, typed observable events, and safe evidence summaries. Animation, personality, search results and source content never grant authority. Reuse existing authoritative stores and projections; do not accidentally activate a future architectural proposal during the revamp.
