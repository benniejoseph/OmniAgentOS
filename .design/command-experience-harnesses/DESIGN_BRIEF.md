# Asael Command Experience and Surface Harnesses — Design Brief

**Status:** Proposed  
**Date:** 2026-09-23  
**Surfaces:** Web, macOS, Android/Flutter  
**Primary area:** Command, voice, agent activity, model routing, terminal execution, appearance, motion

## Problem

Asael already has a capable governed agent runtime, persistent command queue, approvals,
artifacts, Computer Use, voice capture, model settings, and observable run events. The user-facing
experience does not yet make those capabilities feel coherent:

- native assistant replies are plain text;
- live activity is technical and fragmented instead of an understandable account of work;
- model and reasoning intensity cannot be chosen per command;
- macOS, mobile, and web do not clearly communicate their different local capabilities;
- voice mode works as a recorder rather than an expressive conversation mode;
- the existing light palettes are not exposed consistently;
- motion is hand-authored and inconsistent, with no shared mascot or semantic animation system;
- local terminal execution is absent and must not be added to the narrow Computer Use helper;
- Jev is a sound shadow-only semantic decision integration, but is dormant and invisible.

The redesign must make Asael feel alive, clear, compact, and trustworthy without turning it into
a generic chatbot or exposing private model chain-of-thought.

## Product decision

Asael will keep **one canonical governed orchestration core** and add **three surface harness
profiles**, not three independent agent engines.

| Surface | Native reach | What remains shared |
| --- | --- | --- |
| Web | Cloud tools, connectors, project sandbox, realtime web voice | Request/run envelope, queue, model preference, work events, approvals, response document, artifacts, receipts |
| macOS | Shared services plus local Computer Use, governed terminal, native files, share extension, windows and notifications | Same shared contracts and backend authority |
| Android/Flutter | Camera, microphone, capture, notifications, offline intake, remote dispatch and monitoring | Same shared contracts and backend authority |

Web and mobile may dispatch work to an explicitly enrolled Mac, but must never imply that they can
run commands on the device on which their UI happens to be open. The server independently enforces
tenant, actor, session, device, execution target, policy, approval, and idempotency.

## Goals

1. Make Command immediately understandable without hiding its real power.
2. Show truthful, live, user-facing work progress without exposing private chain-of-thought.
3. Render rich, safe, consistent answers and artifacts on every surface.
4. Let the user select provider/model and a supported compute intensity per command.
5. Give macOS a safe, separately governed terminal capability.
6. Establish one recognizable animated Asael mascot and a reusable semantic motion library.
7. Make voice mode expressive, interruptible, editable, and state-aware.
8. Expose a polished persisted System/Light/Dark/High Contrast appearance choice.
9. Turn Jev from an invisible dormant pilot into a measurable, calibrated semantic decision service
   before granting it any bounded influence.

## Non-goals

- Exposing raw chain-of-thought, hidden prompts, private reasoning tokens, secrets, or unredacted tool output.
- Creating three divergent orchestration engines or duplicating server policy in clients.
- Giving the web or Android app an unrestricted local shell.
- Adding shell/file/network authority to the existing Computer Use helper.
- Treating every provider's effort controls as interchangeable.
- Letting Jev call tools, waive approvals, lower risk, or establish that an external effect succeeded.
- Filling the app with decorative loops that do not communicate state.

## Users and core jobs

The primary user is the owner of a private, multi-surface personal agent system. The core jobs are:

- issue a natural command and understand what Asael is doing;
- choose speed/depth when it matters, without navigating Settings;
- approve consequential actions with enough context;
- read and reuse a well-structured answer;
- speak naturally, review the transcript, and continue hands-free;
- ask the Mac to use applications or run a bounded command;
- start on one surface and monitor or continue on another;
- understand whether an intelligent routing component such as Jev is ready, shadowing, degraded, or paused.

## Design principles

### 1. Observable work, never simulated thought

Show actual plan steps, retrieved context, delegated specialists, tools, approvals, evidence, verification,
and recovery events. Do not produce a theatrical internal monologue. After completion, collapse the live
timeline into a concise, durable work summary.

### 2. One governed core, platform-native reach

Shared semantics must look and behave consistently; platform powers must be explicit. A command should
not silently switch from cloud execution to “This Mac,” and a mobile surface must not pretend it owns a shell.

### 3. Motion communicates system state

Mascot and micro-animation states are driven by real state machines. Motion should orient, reassure, or
warn; it must stop when offscreen and respect reduced-motion preferences.

### 4. Compact power, progressive detail

The main conversation stays calm and readable. Model controls, activity detail, artifacts, queue, and
technical receipts are one interaction away, not permanently consuming the canvas.

### 5. Capability truth over uniform controls

The UI shows only the effort levels and execution targets supported by the selected provider, model, surface,
and enrolled devices. Unsupported options are explained rather than silently mapped or ignored.

## Experience direction

### Visual concept: “Living command instrument”

The visual language combines Asael's warm Daybook surfaces with emerald/moss accents and a subtle
botanical-circuit identity. It should feel calm, intelligent, tactile, and precise—not cyberpunk, arcade-like,
or like a generic chat clone.

The current shield, leaf, and circuit mark becomes a living sigil called **Asael Seed**. It has no cartoon
face. Its motion and surrounding particles communicate attention, work, delegation, caution, and completion.

### Command workspace

Desktop layout:

- a slim conversation/thread rail that can collapse completely;
- a flexible central transcript with rich answer blocks;
- a collapsible right **Process** rail for activity, approvals, artifacts, and queue;
- one sticky composer with compact model, intensity, execution target, attachment, and voice controls;
- a small contextual header instead of a large hero after the first command.

Mobile layout:

- full-width transcript;
- bottom composer;
- Process, artifacts, and model controls in focused sheets;
- the same semantic states and labels as desktop, adapted for touch.

Empty state:

- Asael Seed in a calm idle state;
- a short natural invitation;
- a few contextual actions based on available capabilities;
- the state collapses as soon as a conversation begins.

## Safe “How Asael is working” experience

The existing observable run events become a single public process timeline with bounded stages:

1. Understanding the request
2. Preparing context
3. Planning the work
4. Delegating specialists
5. Researching or using a tool
6. Waiting for approval
7. Verifying evidence
8. Finalizing the answer
9. Completed, recovered, failed, or needs attention

Each item may show a short safe summary, elapsed state, agent/tool name, approval need, and evidence/artifact
link. Provider reasoning summaries may be shown only when the provider explicitly returns a safe summary;
they are labeled as a summary and never treated as raw hidden reasoning.

## Rich response document

Define a versioned `ResponseDocumentV1` contract. The canonical content may remain Markdown, but clients
render a deterministic, sanitized block document:

- paragraphs, headings, emphasis and dividers;
- ordered, unordered, nested, and task lists;
- quotes and callouts;
- fenced code with language, copy, and optional artifact actions;
- responsive tables;
- citations and allowlisted links;
- image, video, audio, file, workspace and generated-artifact cards;
- tool/action receipts and approval results.

Raw HTML and unsafe URL schemes are rejected. Nesting, block count, text length, image dimensions, and
streaming updates are bounded. Code and tables scroll locally on small screens without widening the page.

## Model and intensity controls

Add an immutable per-command `RunModelPreference`:

- `selection`: `auto` or `exact`;
- exact provider and model when selected;
- product intensity: `low`, `medium`, `high`, `xhigh`, or `ultra`;
- assignment revision and effective capability receipt;
- effective provider mapping and any explicit downgrade reason.

The UI labels `xhigh` as **Extra high**. `Ultra` is a product profile, not a value blindly forwarded to every
provider. It may select the provider's strongest supported effort plus larger governed budgets, verification,
or delegation. If a selected model does not support a requested level, the option is disabled or the user is
told the maximum supported value. Queue, retry, resume, and reconnect preserve the exact effective selection.

The model catalog adds provider-validated metadata:

- supported effort levels and default;
- provider control type (`effort`, `thinking_level`, `thinking_budget`, `adaptive`, or none);
- safe reasoning-summary support;
- tool, vision, audio, structured-output, and streaming constraints;
- provenance and last validation time.

Explicit per-command choice wins over automatic routing. Jev may eventually recommend a tier/intensity only
when Auto is selected and promotion gates have passed.

## Voice mode

Voice expands the composer instead of opening a disconnected utility screen:

- listening mascot state and responsive waveform;
- elapsed time and input level;
- live partial transcript where supported;
- clear Stop, Cancel, Edit, Send, and hands-free controls;
- explicit transitions through listening, transcribing, ready, speaking, interrupted, reconnecting, and error;
- transcript is editable before sending;
- no layout jump when returning to text.

Web may keep its realtime transport and Flutter its native recording adapter; both conform to the same
presentation state contract. macOS is keyboard-first; mobile uses a focused full-screen sheet when useful.

## Mascot and semantic motion system

Start with raw Lottie JSON plus a manifest for reliable cross-client parity. A `.lottie` bundle and state
machine may follow only after both players prove compatible rendering and theming.

Required Asael Seed states:

- idle / breathing
- listening
- transcribing
- thinking / working
- searching
- delegating
- tool working
- terminal working
- speaking
- waiting for approval
- success
- warning
- error / recovery
- offline / sleeping
- reconnecting / syncing
- memory learning / indexing
- upload / capture processing

Supporting micro-animations cover attachment intake, queueing, approval, download, notification, empty state,
and success. They share stroke, glow, timing, easing, particle, and color-slot rules.

Asset rules:

- vector shapes only; no embedded raster or remote animation URL;
- themeable named layers or paired light/dark exports;
- static poster frame and semantic accessibility label;
- reduced-motion fallback;
- lazy loading and offscreen pause;
- no infinite animation for errors, approvals, or completed states;
- typical micro-animation target of 15–40 KB and a compact mascot base target;
- motion is not the only signal for status.

## Appearance

The existing web and Flutter palettes become a persisted System, Light, Dark, and High Contrast preference.
The light theme keeps the warm Daybook/cream canvas with emerald, moss, ink, and amber accents rather than
simply inverting the dark UI. Code, translucency, elevated surfaces, charts, artifacts, mascot colors, and
focus indicators are explicitly designed for both light and dark contexts.

## Governed terminal execution

Terminal access is a separate macOS capability, never an extension of the existing credential-free Computer
Use helper. Introduce a separately signed **Asael Terminal Helper** and governed `local.shell.run` boundary.

First-version constraints:

- explicit target: Asael cloud, project sandbox, or a named enrolled Mac;
- “This Mac” is never inferred;
- executable plus argv with shell disabled by default;
- user-enrolled working roots through security-scoped bookmarks;
- stripped environment with no inherited API keys, bearer tokens, or Keychain authority;
- executable/profile allowlist;
- timeout, stdout/stderr byte caps, process-tree cancellation, and redaction;
- explicit file-write and network modes;
- no sudo, password prompts, TCC changes, launch services, disk administration, or unrestricted filesystem;
- low-risk read-only commands may run directly; writes, installers, network, or consequential effects require
  the appropriate approval; destructive/system commands remain blocked or highest risk;
- uncertain mutating outcomes become `execution_indeterminate` and are never automatically replayed;
- exact actor, tenant, device, executable, argv, cwd, policy, approval, output digest, and effect receipt.

Web and mobile can request and monitor this capability only against an explicitly selected online enrolled Mac.

## Jev integration direction

Jev remains a provider-neutral typed semantic decision service, not a generative model and not the user's
visible “thinking.” The current shadow routing pilot has the right authority boundary but needs operability
and calibration before activation.

Next stage:

1. Add owner-visible status across all surfaces: Off, Ready, Shadowing, Paused, or Degraded.
2. Show exact model, sampling, last evaluation, completion/timeout/error, latency, usage, agreement and
   confidence calibration, with privacy disclosure.
3. Add explicit enrollment separate from model assignment, deterministic sampling, purpose allowlist, daily
   budget, global/tenant kill switches, and auto-pause circuit breaker.
4. Move shadow calls to durable idempotent background jobs with retryable evidence persistence.
5. Expand the neutral contract to bounded parallel Choice, Noul, and Score questions for clarification,
   durable work, retrieval, likely tool use, specialist/verifier escalation, and model tier/intensity suggestion.
6. Join suggestions to owner-reviewed terminal outcomes; calculate calibration, Brier score, slices, drift,
   version comparison, and promotion/rollback gates.
7. Activate only bounded, monotonic uses after gates pass: recommend a model tier in Auto mode, rerank already
   authorized candidates, or increase verification/risk. Jev never adds authority or reduces protections.

Prefer derived structured features over raw request text. Where bounded request text is sent externally, make
the behavior, retention, sampling, and redaction clear.

## Accessibility, performance, and resilience

- Full keyboard navigation and screen-reader labels on model, intensity, process, artifacts, and voice controls.
- Minimum pointer/touch targets appropriate to each platform.
- WCAG-compliant contrast in every theme.
- Reduced motion and static mascot states.
- Virtualized long transcripts and timelines.
- Incremental response-document rendering without reparsing an entire conversation on each token.
- Lazy-load syntax highlighting, media previews, Lottie assets, and Process details.
- Preserve queued selection, draft, transcript, public work log, and artifacts across reconnect.
- The final answer remains usable when animations, streaming, Jev, voice, or a local helper is unavailable.

## Success criteria

- A user can issue a command and understand the current stage without reading technical event names.
- No surface exposes private chain-of-thought or fabricated thought narration.
- The same answer renders equivalent semantic blocks on web, macOS, and Android.
- Provider/model/intensity choices are validated, pinned, and visible in the final receipt.
- Unsupported effort levels and unavailable execution targets cannot be selected.
- macOS terminal commands pass through the governed executor and the separate helper boundary.
- Light/Dark/System preference persists and every Command state remains legible.
- Voice states are visible, cancelable, editable, and recoverable.
- Mascot state reflects the real run/voice state and respects reduced motion.
- Jev can be operated and evaluated without affecting live behavior until explicit promotion gates pass.

## Delivery strategy

Begin with one end-to-end macOS Command vertical slice because it exercises the richest surface. Build all
new semantics as shared contracts, then render the same state on web and mobile. Expand the animation library
only after the core mascot and four critical states prove cross-client fidelity. Terminal and Jev promotion
remain separately gated because their risk and evidence requirements differ from visual work.
