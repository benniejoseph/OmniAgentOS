# Asael Command Experience and Surface Harnesses — Implementation Tasks

This checklist is ordered to prevent UI work from inventing behavior that the execution core cannot honor.
Each phase should be validated through the affected installed surface and narrow feature checks; broad audit
suites are outside this workstream unless a failure requires one.

## Phase 1 — Shared contracts and safety boundaries

- [ ] Add `SurfaceCapabilitiesV1` to web/native bootstrap contracts with server-validated capabilities for
      cloud tools, project sandbox, local Computer Use, local terminal, share intake, file picker, offline
      capture, push, and background audio.
- [ ] Define explicit execution targets (`cloud`, `project_sandbox`, enrolled device id) and remove ambiguous
      client-only platform inference.
- [ ] Define immutable `RunModelPreferenceV1` with Auto/Exact selection, provider, model, product intensity,
      assignment revision, effective mapping, and validation receipt.
- [ ] Extend provider catalog records with supported intensity/control metadata, safe reasoning-summary
      support, provenance, and last validation time.
- [ ] Pin effective provider/model/intensity to prompt-queue items, run continuation, retry, resume, and the
      `run.harness` receipt.
- [ ] Define bounded public `work_step` and `decision_summary` events. Explicitly prohibit prompts, private
      reasoning, secrets, and raw untrusted outputs.
- [ ] Define `ResponseDocumentV1` blocks, limits, URL policy, artifact bindings, versioning, and streaming rules.
- [ ] Write the terminal boundary ADR before implementing native authority; preserve the existing Computer Use
      helper's no-shell contract.

**Exit:** all three clients can negotiate the same capability, model preference, work-event, and response
document contracts without changing current execution behavior.

## Phase 2 — Command foundation refactor and macOS vertical slice

- [ ] Extract web Command domain/state logic from the monolithic workspace component into focused request,
      queue, stream, process, response, artifact, and composer modules.
- [ ] Extract Flutter Talk controller/domain behavior from its monolithic view while retaining one shared Dart
      domain layer and separate macOS/mobile renderers.
- [ ] Implement the compact macOS workspace: collapsible thread rail, central transcript, collapsible Process
      inspector, artifact/queue tabs, slim header, and sticky composer.
- [ ] Replace technical native event labels with the bounded public work-stage vocabulary.
- [ ] Collapse the empty-state hero after the first message and eliminate unused permanent panels.
- [ ] Add keyboard shortcuts for focus composer, toggle Process, switch thread, voice, cancel run, and attach.

**Exit:** the existing backend lifecycle works through the redesigned macOS shell with no loss of queue,
approval, artifact, reconnect, or Computer Use behavior.

## Phase 3 — Rich answers and public process timeline

- [ ] Add a shared server normalizer/parser for `ResponseDocumentV1`; preserve canonical source content.
- [ ] Replace the custom web-only parsing path with a safe React renderer for all v1 blocks.
- [ ] Add the native Flutter renderer and replace plain assistant `SelectableText` output.
- [ ] Add copy-code, link confirmation/allowlisting, responsive tables, citations, callouts, task lists, and
      artifact/media cards.
- [ ] Render live process events inline during a run and in the Process inspector.
- [ ] Collapse a completed process into a concise durable summary while preserving expandable receipts.
- [ ] Add virtualization/incremental parsing so long conversations do not rerender wholesale.

**Exit:** one representative rich response, streamed activity log, citations, code, table, and artifact render
semantically consistently on web, macOS, and Android.

## Phase 4 — Dynamic model and intensity selection

- [ ] Add per-command model and intensity fields to the agent API and native contract.
- [ ] Implement provider-specific adapters for effort, thinking level, thinking budget, adaptive thinking, and
      unsupported models behind the product-neutral profile.
- [ ] Remove deployment-global effort as the sole runtime control; retain it only as a validated default.
- [ ] Add compact Auto/Exact model and Low/Medium/High/Extra high/Ultra controls to the composer.
- [ ] Filter or disable values using live catalog capability metadata and explain limitations in plain language.
- [ ] Define Ultra as an explicit product profile with model-supported effort, bounded budgets, verification,
      and delegation—not as a fictional universal provider value.
- [ ] Persist the user's preferred default separately from the immutable choice pinned to each command.
- [ ] Show the effective route in the work log and final receipt.

**Exit:** selection survives queue, reconnect, retry and resume, and the final receipt proves what actually ran.

## Phase 5 — Asael Seed, light theme, and motion library

- [ ] Produce the Asael Seed vector master based on the existing shield/leaf/circuit mark.
- [ ] Implement cross-client animation wrappers with preload, pause, reduced-motion, poster-frame, semantic
      label, theme slots, and failure fallback.
- [ ] Create and approve the first four state assets: idle, listening, working, and success.
- [ ] Connect animation state only to actual voice/run state machines.
- [ ] Add persisted System/Light/Dark/High Contrast selection to Flutter/macOS and align with web behavior.
- [ ] Polish light and dark surfaces for transcript, code, tables, Process, approvals, artifacts, waveform,
      focus and mascot colors.
- [ ] Expand the state kit to searching, delegating, tool, terminal, speaking, approval, warning, recovery,
      offline, reconnecting, memory learning, upload, and capture.
- [ ] Add a manifest, asset-size budget, state ownership, and usage guidance so the library remains coherent.

**Exit:** animations render with equivalent state semantics across clients, themes persist, and reduced-motion
users receive complete non-animated feedback.

## Phase 6 — Voice mode redesign

- [ ] Define the shared presentation state machine: idle, listening, transcribing, ready, speaking,
      interrupted, reconnecting, canceled, and failed.
- [ ] Expand the composer into the voice surface without navigating away or causing layout jumps.
- [ ] Add waveform, input level, elapsed time, partial transcript where supported, and listening mascot state.
- [ ] Make transcript review/edit/send explicit and preserve the draft on recoverable failure.
- [ ] Add clear Stop, Cancel, Edit, Send, interruption, and optional hands-free controls.
- [ ] Keep realtime web and native recording transports behind the same presentation contract.
- [ ] Validate microphone permission denial, empty audio, timeout, reconnect and cancel paths in the apps.

**Exit:** voice is understandable and recoverable on all three surfaces, with platform-native transport and
shared semantics.

## Phase 7 — Governed macOS terminal capability

- [ ] Create a separately signed credential-free `AsaelTerminalHelper`; do not modify Computer Use authority.
- [ ] Implement an authenticated native IPC protocol bound to the enrolled device and exact governed run.
- [ ] Add security-scoped workspace-root enrollment and an explicit execution-target picker.
- [ ] Accept executable plus argv with shell disabled; add stripped environment and executable/profile policy.
- [ ] Enforce cwd, filesystem mode, network mode, timeout, output caps, redaction, process-tree cancellation,
      blocked system operations, and kill switch.
- [ ] Register governed terminal tools with risk classification, approval, idempotency, and indeterminate-effect
      semantics.
- [ ] Stream bounded stdout/stderr as untrusted public work output and store digest-bound receipts/artifacts.
- [ ] Expose request/monitor/cancel from web and mobile only for an explicitly selected online Mac.
- [ ] Validate read-only, approved write, timeout, cancel, disconnect, denied path, blocked executable, and
      unknown-outcome flows through the installed macOS app.

**Exit:** a natural Command request can safely run an allowed terminal task on a selected Mac with observable
progress, approvals and a durable receipt, without weakening Computer Use.

## Phase 8 — Jev shadow pilot 2.5

- [ ] Add `semantic_decision` scope/capability parity to Flutter Settings and a clear web setup deep link when
      native credential enrollment remains unavailable.
- [ ] Add tenant/actor-scoped status projection and UI for Off, Ready, Shadowing, Paused and Degraded.
- [ ] Add explicit pilot enrollment, purpose allowlist, deterministic sample rate, daily budget, privacy
      disclosure, tenant kill switch, and automatic circuit breaker.
- [ ] Move the external evaluation into a durable idempotent background job with retryable evidence writes.
- [ ] Extend the provider-neutral interface to bounded parallel Choice, Noul and Score questions.
- [ ] Add decomposed shadow questions for clarification, durable work, retrieval, likely tools, specialist or
      verifier escalation, and Auto-mode tier/intensity recommendation.
- [ ] Build an owner-review set and outcome join; calculate calibration, Brier score, slices, drift, version
      comparison, cost, and latency.
- [ ] Define minimum sample, calibration, privacy, cost, and rollback gates.
- [ ] After a separately recorded promotion decision, enable only model-tier suggestion in Auto mode,
      authorized-candidate reranking, or monotonic verification/risk escalation.

**Exit:** Jev is measurable and operable. Any enabled influence is bounded, reversible, receipt-backed, and
cannot add authority, reduce risk, waive approval, or override an explicit model choice.

## Phase 9 — Cross-surface parity and release

- [ ] Adapt the macOS-approved interaction model responsively to web without importing native-only controls.
- [ ] Complete the Android/mobile renderer using sheets and touch-first controls.
- [ ] Add a parity matrix for shared semantics versus platform-specific capabilities.
- [ ] Reconcile architecture/ADR/native-contract documentation and remove stale isolated-browser terminology.
- [ ] Validate cold launch, offline/reconnect, queued commands, cross-device monitoring, approvals, artifacts,
      light/dark, reduced motion, model/intensity pins, voice, Computer Use and terminal receipts in the apps.
- [ ] Roll out by capability flag: rich response/process, model control, mascot/theme, voice, terminal, then Jev.

**Exit:** every surface shares the same truth and receipts, while each exposes only the capabilities it can
actually execute safely.
