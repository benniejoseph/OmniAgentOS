# ATLAS conversation controls

The shared agent loop exposes Asael operations in typed tools for text and live
voice. Web, Mac and mobile use the same owner-scoped application services. The
Mac client additionally carries an explicitly selected **This Mac** target;
web and mobile do not remotely operate another device.

## What conversations can do

- Read connections and source freshness, installed plugins, recorded AI usage,
  tasks, History, workflow status, memory and knowledge.
- Update the owner's About me profile, CSM role notes and client fields. These
  operations patch named fields with revision checks and preserve omitted data.
- Link inspected Library evidence to CSM role or client context.
- Start the existing durable research pipeline from a conversation, including
  deep research, and return its report to that conversation. A typed handoff
  records acceptance; completion comes from the actual workflow state.
- Use the existing governed task, project, memory, workflow, settings and
  connector actions. Plugin installation uses the catalog's exact previewed
  version and manifest digest rather than model-written manifests.

Tool discovery keeps readable-name resolvers with relevant actions within the
existing 32-tool and schema-size limits. These preferences never expand an
Agent's grants. Broad requests may still need to be split into smaller turns.
All effects keep tenant/actor scope, executor policy, approvals and idempotency.
Returned documents, pages, screen content and tool results remain untrusted.

Usage is recorded application consumption, not a provider invoice. Unknown
pricing and incomplete coverage remain visible. Public research deliberately
does not inherit saved private documents, mail or CSM context. It requires live
web authority on the parent conversation and pins the executing Agent identity.

## Voice behaviour

A live voice call pins its conversation context and, on Mac, its selected local
target. A turn acknowledges long-running work after eight seconds while the
original request continues. Typed workflow handoffs and approval-resumed run
projections retain the workflow identity so clients can follow its real status.
An approval view can open without disconnecting the call. Spoken assent alone
does not replace an exact action approval.

Spoken answers to supervisor questions bind to saved turns from that same active
call and the unchanged Agent definition and permissions. One immutable question
claim prevents duplicate continuation. A call follows one governed task at a
time; it cannot resume an arbitrary older run supplied by the client.

New continuous voice turns allow ordinary reversible risk-one app actions under
their normal policy, retaining stricter configured Agent policies. Legacy voice
and inferred voice-origin requests retain their previous risk-zero threshold.
Mac keyboard, clicking, typing and commands still follow their explicit review
policy. Routine status retrieval does not require review.

## Mac apps, files and development commands

Native contract **52**, app **1.27.0+86**, adds installed-app discovery and launch,
letters, digits, punctuation and function keys alongside the existing keys.
Shortcut effects are explicit: saving, pasting and closing are not navigation.
Actions bind to the current observation and focused target. Secure fields and
restricted apps remain unavailable to visual control.

Settings → This Mac shows visual and command readiness separately. The command
runner can work with an owner-selected folder even when visual permissions are
unavailable. Visual control requires macOS Accessibility and Screen Recording.
The call preserves current readiness; it does not invent permission from speech.

The signed command helper supports one executable and argument vector at a time,
with a maximum of **300 seconds** on v52. It can inspect Git, search or edit files,
install dependencies and build code using the allowed programs after approval.
There is no persistent shell, interactive stdin or background development server.
The granted folder constrains the starting directory; commands run as the Mac
account and are not a complete filesystem sandbox. Exact commands, process-group
cancellation, courier leases and uncertain-effect non-replay remain enforced.

New key/app options and commands longer than 30 seconds require v52 at enqueue
and claim. Existing v51/v50 clients keep their supported operation surface. No
database migration is added by this release.

## Implementation references

[Peekaboo](https://github.com/openclaw/Peekaboo) informed the structured
observe/action/observe and app/keyboard approach.
[mac-use](https://github.com/entpnomad/mac-use) provides another Accessibility-first
Mac control reference, while [Cua](https://github.com/trycua/cua) includes broader
computer-use and sandbox tooling. No code from these projects is vendored by this
change. Asael retains its existing signed visual and command helpers and shared
governed executor rather than installing an additional privileged service.

Build and live release evidence must be recorded separately. This document
describes implementation contracts, not proof that every application or workflow
has been exercised successfully.
