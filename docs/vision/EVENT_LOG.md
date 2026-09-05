# Event-Log Substrate — Spec (M1)

> **Stage 1 shipped.** `src/lib/events/store.ts` implements the log
> (Postgres `omni_events` with RLS + file fallback); runs, workflows, and trust
> outcomes dual-write into it; `src/lib/events/projections.ts` proves
> projection-rebuild for trust profiles, verifiable live via
> `GET /api/trust?replay=<actionClass>` (returns `consistent: true/false`).
> Streams are readable at `GET /api/events?stream=<id>`. Stages 2–3 below
> migrate the remaining projections and then retire the bespoke ledgers.

## Principle

The target architecture uses one append-only log as the source of truth. All
other state (run status, workflow position, trust profiles, dashboards) is a
**projection** rebuilt by folding events.

Stage 1 is append-only through the application API, not immutable storage:
database privileges do not prohibit update/delete, and file mode rewrites and
caps its ledger. WORM/object-lock controls and retention remain deployment
responsibilities until later stages explicitly implement them.

New P0.1 mutation paths use `appendScopedDomainEvent`, which requires an
`ExecutionScope` and derives tenant, actor, correlation, and causation from it.
Immutable `*.scope_bound` events are retained outside the transient file-event
cap. Legacy dual-writes continue through the compatibility writer only until
their owning store is migrated.

## Shadow run-contract events (P0.2)

Versioned run-contract envelopes are additive shadow data; legacy run records
and projections remain authoritative. A scoped run records three typed lifecycle
events using one metadata-only payload contract:

| Event | Observable decision |
|---|---|
| `run.contracts.bound` | Principal, intent, and outcome contracts were bound to the run. |
| `run.manifests.resolved` | Context and execution manifests were resolved and pinned or explicitly left unassessed. |
| `run.terminal_receipt.recorded` | A terminal disposition and its verification counts were recorded. |

The shared event payload contains only schema and lifecycle enums, opaque IDs,
SHA-256 digests, and bounded counts. It never embeds contract bodies, prompts,
retrieved content, tool input/output, credentials, model output, or private
reasoning. The events retain the run's explicit tenant, actor, correlation, and
causation scope through the scoped event writer. Trajectory exports validate the
payload and use a typed allowlist of the same compact fields rather than copying
arbitrary payload data.

P0.4 canonical status is likewise a shadow projection, not a state transition.
It translates legacy domain status into a shared vocabulary without changing
stores, controls, mutation contracts, or UI presentation. Legacy completion is
`unverified`; `succeeded` requires a valid outcome-evaluator terminal receipt
whose required outcomes are verified.

P1.3 adds `workflow.outcome_evaluated` after a completed workflow stores its
validated shadow evaluation. Its payload is a strict metadata-only projection:
schema version, the explicit `posthoc` contract-binding state, opaque
run/contract/receipt IDs, SHA-256 bindings, terminal and verification enums,
and bounded counts. It does not include goals, reports,
acceptance-criterion text, tool data, model output, errors, or private
reasoning. The result record is the durable shadow source in this slice;
transactional workflow state/event writes remain P1.1 work.

The first P1.4 canary adds `tool.effect_receipt.recorded` only when an approved,
tenant-and-initiating-actor-bound workflow executes live `memory.write` as a
single-tool plan node. Its allowlisted payload
contains opaque receipt, execution, scope, workflow, plan, node, and target
IDs; SHA-256 bindings; and acknowledgement/verification enums. Raw memory,
plans, tool input/output, provider data, and idempotency keys are excluded. The
receipt records a deterministic target, a first-party commit acknowledgement,
and a tenant-scoped read-after-write result.

The first P2.1 shadow emits `source.revision.shadow_indexed` in the same
transaction as the canonical source receipt, item, revision, evidence units,
and new knowledge-document linkage. Its allowlisted payload contains only the
document/source/adapter/connection IDs, entity and set digests, adapter ID, and
evidence count. It excludes source text, external provider IDs, locator
contents, connector payloads, credentials, and arbitrary metadata. This event
describes only newly enrolled shadow writes; legacy retrieval remains the read
authority until the later convergence and actor-aware read gates.

The first P2.2 checkpoint shadow emits `source.sync.page.shadow_observed` in
the same Postgres transaction as its immutable Drive page manifest and next
open checkpoint. `source.sync.page.failed` records a bounded failure category
and digest when a leased page is released or dead-lettered. Both payloads are
strict metadata: checkpoint/connection/source/adapter identifiers, engine and
authorization generations, phase and page counters, hashes, bounded item
counts, and closed outcome/failure enums. Raw Drive IDs, file metadata,
provider cursors, content, credentials, and error text are excluded. Local
file fallback appends these events separately on a best-effort basis and is
development-only compatibility, not atomic audit storage.

The P2.3 convergence foundation defines
`source.revision.canonical_applied` and
`source.tombstone.canonical_applied`, plus
`source.absence.canonical_observed` for a receipt-bound delete observation
whose deterministic source identity has never been enrolled. A
transaction-only mutation appends one of these events only after its receipt,
immutable revision or tombstone when applicable, and ordered source head have
advanced together. Its deterministic event ID binds the adapter receipt and
five-field sync order. Payloads contain only opaque source, revision,
tombstone, connection, adapter, and receipt IDs; SHA-256 digests; bounded
counts; order counters; and closed operation/delete/no-op enums. They exclude
provider IDs, source metadata or content, evidence contents, cursors,
credentials, errors, prompts, and private reasoning. Stale and duplicate
observations append no new event. An absence observation creates neither a
SourceItem nor a tombstone, but fences older delayed upserts. The foundation
batch has no active Drive caller and does not change served RAG.

The first P0.3 rollout registry emits `capability.rollout.registered` and
`capability.rollout.status_transitioned` in the same transaction as the
generation insert or compare-and-swap lifecycle transition. The strict domain
payload contains only opaque capability, engine, contract, and actor IDs; the
monotonic generation; a configuration SHA-256 digest; rollout mode; closed
lifecycle states; a monotonic lifecycle revision; and lifecycle timestamps. It
contains no configuration body, credentials, source data, tool input/output,
or private reasoning. As with all scoped domain events, the event writer adds
the separately validated `_executionScope` attribution envelope, including its
bounded purpose and grant identifiers. The registry is initially empty, so
these events do not activate behavior by themselves.

The first P1.1/P1.2 project cutover covers authenticated project creation,
project metadata updates, and manual task creation and updates. These request
paths require an exact user
`ExecutionScope`, bind a validated idempotency key, and emit
`project.created`, `project.updated`, `project.task.created`, or
`project.task.updated` with schema version 1 in the same Postgres transaction
as the canonical row mutation. Payloads contain only project/task IDs,
lifecycle state, changed-field identifiers, and SHA-256 request and
idempotency bindings; project and task prose never enters the event log.
Creation derives the project or task ID from the tenant scope and idempotency
key, so an exact retry returns the original record while a different request
under the same key fails closed. Background planner/executor project mutations remain on
their legacy path until their real agent or system principal scope is carried
to the store; this slice does not fabricate user attribution for them. The
file store preserves the same validation and deterministic retry behavior but
remains a development compatibility path rather than an atomic production
claim.

Authenticated tool approval decisions now use the same P1.1/P1.2 boundary.
An approve or reject request carries the exact decision principal, execution
causation, request correlation, and an idempotency binding into the row-locked
tool-execution transaction. `tool.approval.recorded` distinguishes a pending
risk-3 quorum from an execution claim; `tool.approval.rejected` records the
terminal rejection. Their schema-version-1 payloads contain only execution and
tool IDs, risk/quorum counts, closed outcome enums, and SHA-256 bindings.
Approval reasons, sealed inputs, outputs, credentials, and claim tokens are
excluded. Legacy internal callers remain compatible but do not receive a
fabricated decision event without an explicit scope.

Workflow dual-writes no longer copy goals, reports, errors, model output, or
arbitrary workflow payloads into `omni_events`. The canonical projection is a
strict schema-version-1 envelope containing only the event type, bounded field
count, and a canonical SHA-256 payload binding. When a workflow has a bound
execution authority, canonical events inherit its actor/principal, scope,
correlation, causation, and grants. `appendWorkflowEvent` now commits its
private workflow-history row and metadata-only canonical event in one Postgres
transaction. Legacy workflows without an authority remain explicitly legacy
attributed; this privacy correction does not invent an owner for them.

Mission lifecycle dual-writes use the same metadata-only projection rule.
`mission.*` canonical event payloads now carry schema version 1, the bounded
event type, a field count, and a canonical SHA-256 binding only. Mission and
task objectives, definitions of done, comments, handoff notes, review text,
artifact bodies, errors, and model output remain in their owner-scoped stores
and are not copied to `omni_events`. Mission mutations still use the legacy
best-effort dual-write boundary in this slice; transactional conversion and an
explicit executing-principal scope remain open P1.1/P1.2 work.

Run lifecycle projections now apply a typed field allowlist instead of copying
the `AgentEvent` object. Status/detail text, memory titles, delegation reasons,
tool summaries, council prose, approval messages, errors, cancellations, and
completed response text are retained only as bounded lengths and SHA-256
bindings. Completed grounding retains its closed status, authorized citation
IDs, and invalid-citation count but not source titles, URLs, snippets, or
evidence text. Model usage and harness policy fields needed for metering,
trajectory verification, and replay remain explicit metadata. New run event
payloads carry schema version 1; replay accepts both legacy plaintext terminal
errors and the new length/hash representation without weakening the status or
response-integrity check.

The Drive generation-2 canary adds `source.sync.page.canonical_settled` in the
same transaction as the page's canonical revisions, tombstones or ordered
no-op decisions, terminal page items, committed checkpoint, and next encrypted
cursor. Its allowlisted payload contains only opaque checkpoint, connection,
source, capability, engine and adapter IDs; authorization, rollout, lifecycle,
phase and page counters; manifest hashes; and bounded applied/no-op counts. It
contains no Drive IDs, names, metadata, source content, provider cursors,
credentials, errors, prompts, or reasoning. Per-item canonical events remain
the exact receipt-bound evidence; the page event is their compact settlement
summary and never changes served RAG authority.

The first P2.7 canary adds `memory.deletion_barrier.recorded` in the same
Postgres transaction as the canonical memory scrub, immutable deletion
receipt, derived trace/graph invalidation, and graph rebuild request. Its
allowlisted payload contains only opaque receipt and memory IDs,
execution-scope, receipt, and lineage-manifest SHA-256 digests, bounded
invalidated-row counts, and closed reason/status enums. It never contains the
forgotten title, content, tags, source, embedding, retrieved text, graph prose,
prompt, or model reasoning. Legacy forgotten rows are protected by explicit
unattributed migration barriers and do not receive fabricated scoped events.
This event proves the immediate memory query barrier; it does not claim that
the later physical descendant scrub SLA has completed.

Migration v43 emits no domain event because its P3.1 access envelope is held
inactive: historical memories remain explicit version-0 legacy rows and
the validated enrollment lock prevents any version-1 row, including through
maintenance paths that bypass RLS. Access-binding
events begin only with the later atomic actor-aware read/write cutover; no
owner, shared scope, purpose, or consent grant is inferred during this shadow.

Migration v44 also emits no domain event. It installs an ungranted,
fail-closed parser for a future transaction-local memory access envelope, but
does not create an envelope, activate a policy, enroll a memory, or infer the
canonical purpose ID that the active contract will require.

The matching P3.1 TypeScript contract and held transaction-local installer
also emit no domain event. Parsing or installing a database session envelope
is not a domain mutation, and the installer has no serving-role grant or call
site. The later activation must emit typed binding/authorization evidence at
the memory operation boundary rather than logging the session mechanism.

Migration v45 emits no domain event. Its ungranted authorization function is
an always-deny enforcement seam: it authorizes no actor, principal, target,
grant, purpose, memory, or operation and has no runtime consumer. Typed memory
authorization evidence begins only when authoritative records are resolved and
held in the operation transaction during the later all-surface activation.

Migration v46 emits no domain event. A generated auth-user actor ID is an
additive identity projection, not an authorization decision or ownership
mutation. Existing historical actor strings, execution scopes, events,
receipts, and hashes remain unchanged; later live alias/ownership convergence
must emit its own bounded evidence where it changes an operation boundary.

The matching canonical-auth-actor accessor also emits no event. Reading a
frozen projection from already-authenticated in-process context changes no
authority or durable state, and no serving path calls it. Authorization events
remain deferred to the later transaction-bound memory cutover.

Migration v47 emits no domain event. It installs immutable global reference
contracts, not a tenant grant, consent decision, memory access, or lifecycle
transition. Later purpose entitlement changes and actual memory authorization
must emit their own typed, metadata-only evidence.

Migration v48 also emits no domain event because it creates an empty, held
tenant-entitlement schema and no tenant decision. No lifecycle writer exists
while scoped events still carry the historical email-shaped actor. A future
writer must append `memory.purpose_entitlement.held`, `.activated`, or
`.revoked` in the same SQL transaction as the row transition, with tenant,
purpose, generation, revision, canonical decision actor, and bounded evidence
identifiers only. Before that DML it must live-lock the active canonical user,
the active same-tenant membership, and a distinct entitlement-management
authority. Entitlement actor columns and events prove attribution, not the
grantee, subject, consent, or mutation authority. Entitlement events must not
contain consent text or memory content and do not substitute for actor-consent
events.

Migration v49 emits no domain event because it creates an empty standing-
consent schema and records no actor decision. A future lifecycle writer must
append `memory.purpose_consent.held`, `.granted`, or `.revoked` in the same SQL
transaction as the row transition, keeping `subjectActorId` distinct from the
decision actor and including only tenant, purpose, generation, revision, and
bounded notice/evidence identifiers. As installed by v49, underlying record
contract version 1 required grants and revocations to be self-decisions.
Migration v55 advances the still-empty ledger to current record contract version
2, retains that self-decision rule, and adds the exact epoch-and-receipt binding.
Both record versions are distinct from typed event payload schema version 1. The
event schema defines no fields for consent text or memory content, and a
standing-consent event cannot represent an export or forget request. Those
data-right flows require their own request-bound typed evidence.

Migration v50 emits no domain event. Exact canonical and retained auth-email
aliases are an additive identity projection, not an authorization, ownership,
consent, or membership decision. It rewrites no historical event, execution
scope, receipt, approval, hash, or encrypted AAD. The first
`omni_today_preferences` dual-read canary also emits no domain event: it makes
no authorization decision, rejects ambiguous rows before mutation, preserves
the selected physical actor, and retains the existing email-owned default
write on a miss. Later store-specific write or governed-operation cutovers
must emit typed evidence where the operation boundary actually changes; the
alias registry itself is not a substitute for that evidence.

The request-bound `omni_today_items` read/edit canary also emits no domain
event. It broadens selection only to the validated canonical/current-email
pair, relies on the collection's globally unique item ID for direct edits,
keeps the selected row's persisted actor and existing business mutation, and
retains email-owned creation. It changes neither authorization nor a governed
operation boundary. Derived briefs, notification state, background workers,
portable data flows, and canonical writes remain outside the canary and must
receive their own typed evidence when their operation boundaries change.

The request-bound conversation-thread canary emits no domain event because it
is read-only. It permits only validated canonical/current-email selection,
projects the current request actor, and resolves the globally unique parent
thread before reading child turns, linked memories, or thread-gated browser
activity. Thread creation, turn append, agent/workflow continuation, execution
scope, approvals, receipts, portable data, and canonical writes are unchanged;
any later action-path identity cutover must carry typed evidence at that
governed boundary.

The request-bound project-read canary emits no domain event because it makes
no mutation or authorization-policy decision. It selects only the validated
canonical/current-email owners, projects the current request actor, and
authorizes a globally unique parent before reading tenant-matched child tasks
or artifacts. Project creation, edits, planning, task execution, workflow
scope, artifacts, approvals, receipts, and canonical writes remain unchanged;
their later identity cutovers must append evidence at the affected governed
operation boundary.

The interactive personal-notification read canary emits no domain event. It
does not generate, reconcile, or mutate a notification: it only reads the
validated canonical/current-email pair, rejects cross-alias occurrence
duplicates before limiting, and projects the current request actor. Reminder
workers, occurrence upserts, notification actions, the coupled Today-item
completion, and canonical writes remain unchanged; their later identity or
lifecycle cutovers require evidence at the affected mutation boundary.

Aligning Today's recent-thread and active-project projection with their
existing request-bound read canaries emits no domain event. The change only
selects the validated canonical/current-email pair, preserves deterministic
global limits, and binds project child summaries to the selected physical
parent. It exposes no owner field and changes no mutation, execution scope,
approval, receipt, worker, cache identity, or canonical write.

Converging authenticated daily-brief reads emits no domain event. The read
transaction rejects same-date alias collisions and malformed scalar/JSON
envelopes before it can commit a default preference, then either projects the
current request email or omits ownership in Today. It changes no brief
generation, model call, save, schedule, action, approval, receipt, worker,
portable record, cache identity, or canonical write.

Converging the authenticated Capture asset collection emits no domain event.
The read-only request merges only the validated canonical/current-email pair,
excludes internal artifacts, applies a deterministic global limit, and
projects the current request actor. It does not read stored bytes or change
asset detail, download, indexing, status, deletion, ingestion, browser-frame,
recording, RAG, worker, file-fallback, event, execution-scope, or canonical-
write behavior; any later action-path identity cutover must emit evidence at
the affected governed boundary.

Converging authenticated custom Skill reads emits no domain event. The
request-only projection merges the validated canonical/current-email custom
rows, fails closed on duplicate slugs, retains persisted global Skill IDs,
and projects the current request actor. Built-ins, Skill mutations, custom
Agent references, execution/run-contract identity, portable data, file
fallback, events, and canonical writes remain unchanged; a later governed or
writable identity cutover must emit its own evidence. Canonical Skill
enrollment stays blocked until Agent/Skill reference ownership and UI
actionability are enforced together.

Installing the custom Agent-to-Skill reference barrier emits no domain event.
Migration v51 and the matching request validation reject invalid or
cross-owner edges, reserve catalog IDs, and block unsafe identity mutation or
direct deletion; they do not alter any valid Agent, Skill, run, approval,
receipt, or external effect. Existing Agent create/update event debt is not
expanded into this integrity-only slice, and a later execution-identity or
canonical-write cutover must add typed evidence at its governed boundary.

Converging custom Agent detail GET and enforcing native Skill actionability
emit no domain event. The request can only reveal one already-authorized
definition as explicitly actionable or read-only, and Command refuses to
submit the latter to the exact-owner runtime. Flutter filters response
capability metadata before local assignment controls. Neither change mutates
an Agent, Skill, Mission, run, approval, receipt, or external system; later
list, runtime, or canonical-write cutovers require their own typed evidence.

The opt-in request-readable custom Agent list emits no domain event. It
projects existing definitions into inspectable Arsenal and web Mission
catalogs and gates all assignment and mutation affordances with explicit
capability booleans; bare list clients and every execution or write path
remain exact-owner. The Mission UI also omits an unchanged nonselectable
historical assignee instead of rewriting it. No Agent, task, run, approval,
receipt, or external system is mutated by the compatibility read itself, so later runtime or canonical-write
cutovers still require their own typed evidence.

Converging public Capture asset metadata detail emits no domain event. The
request reads no stored content and makes no mutation or authorization-policy
decision: it selects one non-internal row from the validated
canonical/current-email pair, projects the current actor, and publishes
owner-derived actionability. The library withholds download and deletion when
those booleans are not explicitly true. Byte access, indexing, status changes,
deletion and RAG cleanup, internal artifacts, recordings, background work,
portable data, and canonical writes remain exact-owner; a later governed or
writable identity cutover must append its own typed evidence.

Native client compatibility telemetry emits no domain event. Login, refresh,
and bootstrap update authentication-session metadata only; the admin adoption
read deterministically aggregates existing tenant-scoped session evidence and
is permanently labeled held in this release. It neither grants a capability
nor changes an Agent, workflow, memory, consent, membership, approval, tool
effect, or external system. A later governed enrollment or authorization
cutover requires its own typed decision event and rollback contract.

Converging public Capture content reads emits no domain event. The request
selects one non-internal asset and its bytes from the validated
canonical/current-email pair, keeps the persisted owner as an internal
integrity fact, and fails closed unless the bounded byte count, response
metadata, and SHA-256 match. It does not index, mutate, delete, reconcile
knowledge, operate on internal artifacts, or change canonical writer identity;
those governed boundaries require their own typed evidence when they later
converge.

Converging request-bound service API-key metadata lists emits no domain event.
The read selects only redacted fields from the validated
canonical/current-email pair, projects the request actor, and publishes a
physical-owner-derived management capability. It never reads a token hash or
changes key status, authentication, last-used state, MCP policy, portable
records, file fallback, or writer identity. Creation, revocation, use, and any
future canonical-write cutover retain their existing typed-event boundaries.

Converging request-bound model-catalog metadata lists emits no domain event.
The read verifies and safely projects already-persisted provider metadata from
the validated canonical/current-email pair, while canonical or unsupported
identifiers remain nonselectable. It neither opens provider credentials nor
refreshes a catalog, saves an assignment, changes runtime routing, mutates a
model lifecycle, or changes writer identity. Those exact-owner operations and
any later canonical cutover retain their existing typed-event boundaries.

Converging the opt-in Capture recording-history catalog emits no domain event.
The request projects only bounded, validated summary metadata from the
canonical/current-email pair, omits owner identity and all transcript, audio,
segment, metadata, source, and linked-job content, and derives detail and
management capabilities from the physical owner. It does not open or change a
recording, enqueue ingestion, alter knowledge, recover background ownership,
or change writer identity; those exact-owner operations retain their existing
scoped event boundaries.

Converging opt-in provider-connection metadata emits no domain event. The read
selects no credential ciphertext or key identifier, retains the physical owner
only to derive management and runtime-readiness capabilities, and projects
canonical history as configuration-only and read-only. It does not open,
validate, rotate, enable, revoke, refresh, assign, route, or otherwise use a
credential. Those exact-owner operations and any later canonical-write cutover
retain their existing governed and typed-event boundaries.

Converging request-bound model-assignment metadata emits no domain event. The
read validates and projects already-persisted route policy, derives management
and runtime readiness from physical ownership, and renders canonical continuity
rows outside writable form state. It does not save an assignment, grant
cross-provider disclosure, open a credential, select a runtime model, refresh a
catalog, change MCP authority, or change writer identity. Those exact-owner
operations and any later canonical-write cutover retain their existing
governed and typed-event boundaries.

Converging request-bound OAuth connection metadata emits no domain event. The
read selects only public connection fields from the validated
canonical/current-email pair, never selects sealed tokens or sync cursors,
projects the request actor, and publishes a physical-owner-derived management
capability. It does not authorize, open, refresh, save, sync, revoke, or use a
provider token; operate a Photos session; remove imported data; change source
lineage; or change writer identity. Those exact-owner operations and any later
canonical-write cutover retain their existing scoped event and governed-action
boundaries.

Converging request-bound MCP export configuration metadata emits no domain
event. The read validates and projects an already-persisted public policy,
retains physical ownership only to derive a management capability, and renders
canonical continuity outside writable form state. It does not save or activate
a policy, authenticate a service key, update last-used state, widen effective
scopes, expose a resource or tool, execute governed work, or change writer
identity. Those exact-owner operations and any later canonical-write cutover
retain their existing scoped event and governed-action boundaries.

Converging request-bound Capture recording metadata detail emits no domain
event. The read validates and projects an already-persisted parent and bounded
segment metadata snapshot, retains physical ownership only for integrity and
capability derivation, and never selects transcript, audio, hashes,
transcription diagnostics, arbitrary metadata, source linkage, or linked
knowledge/job identifiers. It does not complete, transcribe, index, update,
delete, recover, or otherwise operate on a recording, nor does it change writer
identity. Those exact-owner operations and any later canonical-write cutover
retain their existing scoped event and governed-action boundaries.

Converging request-bound Mission collection summaries emits no domain event.
The read validates and projects already-persisted public lifecycle metadata,
uses the hidden source key only to detect a two-owner collision, removes owner
identity after deriving capabilities, and never selects arbitrary mission
metadata. It does not open a full board, poll events, transition a mission,
create or change a task, comment, review, run an attempt, expose an artifact,
start execution, or change writer identity. Those exact-owner operations and
any later canonical-write cutover retain their existing typed-event and
governed-action boundaries.

Re-proving one request-bound Mission summary for an out-of-page deep link emits
no domain event. The read validates already-persisted public lifecycle fields,
uses the hidden source key only to reject a cross-owner collision, and derives
capabilities from physical ownership before removing that owner identity. It
does not read a board, child, event, arbitrary metadata, or artifact; mutate or
execute work; or change writer identity. Exact detail and every governed effect
retain their existing typed-event boundaries.

Installing the held tenant-actor membership-epoch authority emits no domain
event. Migration v54 creates no epoch and makes no membership decision; it
cannot truthfully attribute current mutable membership state to a historical
decision actor. A future lifecycle writer must append typed membership
authority evidence in the same transaction that creates, activates, or
revokes an epoch. That event may contain only versioned authority identifiers,
state, epoch, causation, and decision attribution—not credentials, personal
content, consent text, or inferred administrator intent.

Installing the informed-notice and consent-v2 shadow emits no domain event.
Migration v55 creates no notice contract, presentation, acknowledgement, or
consent row and performs no user decision. A future governed writer must append
typed notice-presentation and consent-decision evidence atomically with those
facts. Events may reference the versioned notice contract, digest, receipt,
purpose, consent generation, and membership epoch, but must not duplicate the
notice text, credentials, private content, or model reasoning.

Contract-only slices fix the future memory-authority event vocabulary in
`src/lib/memory/authority-contracts.ts`; they do not append events. Every closed
payload uses event payload `schemaVersion: 1`. The separate
`recordSchemaVersion` follows the underlying row contract: version 1 for
membership-management authority, membership epoch, purpose entitlement, and
informed-notice receipt, and version 2 for purpose consent.

| Stable event family | Exact metadata-only payload coordinates after `schemaVersion`, `recordSchemaVersion`, and `payloadKind` |
| --- | --- |
| `memory.membership_management_authority.held`, `.activated`, `.revoked` (`payloadKind: "memory_membership_management_authority"`) | `tenantId`, `subjectActorId`, `granteeActorId`, `managementAuthorityId`, `authorityGeneration`, `governanceDecisionId`, `decisionActorId`, `decisionAt`, `state`, `lifecycleRevision` |
| `memory.membership_epoch.held`, `.activated`, `.revoked` (`payloadKind: "memory_membership_epoch"`) | `tenantId`, `subjectActorId`, `membershipEpoch`, `decisionActorId`, `membershipManagementAuthorityId`, `decisionAt`, `state`, `lifecycleRevision` |
| `memory.purpose_entitlement.held`, `.activated`, `.revoked` (`payloadKind: "memory_purpose_entitlement"`) | `tenantId`, `purposeId`, `entitlementGeneration`, `decisionActorId`, `decisionMembershipEpoch`, `entitlementManagementAuthorityId`, `decisionAt`, `state`, `lifecycleRevision` |
| `memory.informed_notice_receipt.recorded` (`payloadKind: "memory_informed_notice_receipt"`) | `tenantId`, `subjectActorId`, `purposeId`, `consentGeneration`, `membershipEpoch`, `noticeReceiptId`, `noticeContractId`, `noticeContractVersion`, `noticeSha256`, `presentedAt`, `acknowledgedByActorId`, `acknowledgedAt` |
| `memory.purpose_consent.held`, `.granted`, `.revoked` (`payloadKind: "memory_purpose_consent"`) | `tenantId`, `subjectActorId`, `purposeId`, `consentGeneration`, `membershipEpoch`, `noticeReceiptId`, `decisionActorId`, `decisionAt`, `state`, `lifecycleRevision` |

Held lifecycle payloads use revision 0; activation or grant uses revision 1;
revocation admits the transition-appropriate revision 1 or 2. The one
`memory.informed_notice_receipt.recorded` fact carries both presentation and
subject acknowledgement evidence (`presentedAt <= acknowledgedAt`); there is no
separate `presented` event contract yet. Standing-purpose payloads still reject
export and forget.

These duplicated coordinates do not create authority. A future append boundary
must require the payload `tenantId` and its decision actor (or receipt
`acknowledgedByActorId`) to equal `ExecutionScope.tenantId` and
`ExecutionScope.initiatingActorId`, as well as the event envelope.
Management-authority IDs, `decisionMembershipEpoch`, and `noticeSha256` are
cross-record evidence coordinates, not authorization. Exact equality of the
receipt and consent structural tuple—`tenantId`,
`subjectActorId`, `purposeId`, `consentGeneration`, `membershipEpoch`, and
`noticeReceiptId`—also proves binding only; it does not prove current membership,
an active epoch or entitlement, consent, or mutation authority. The schemas
define no fields for notice text, consent text, credentials, private content,
tool/model output, or private chain-of-thought. Opaque identifier fields remain
opaque, their accepted grammar can contain `@`, and the validators do not prove
their semantic contents; a future writer must keep content out of those fields.
The pure module has no writer or serving import/call site and appends or persists
no event or row; every v45 and v48-v55 database/runtime hold remains in force.
A contract ID, version, or digest is not legal/privacy approval of the notice
copy; issuance still requires reviewed, pinned wording.

The denial-only memory-authority resolution canary also emits no event. It
performs only sequential, ambiguity-bounded `FOR SHARE` observations inside an
ordinary tenant-scoped PostgreSQL transaction and can return only
`deny / activation_held` with coarse authority identifiers. It does not claim
that hidden or missing authority is absent globally, does not expose resolved
rows or a legacy email, and does not append diagnostics, database failures, or
private content to the event log. Export and forget remain separate
request-bound data-right flows. Typed authority events begin only in future
governed lifecycle writers that commit the authority transition and scoped
event together; the canary has no writer, serving call site, or event-store
import.

Installing the v56 membership-management authority shadow emits no domain
event. The empty ledger makes no grant or membership decision and cannot
truthfully assign the mutable bootstrap membership to a historical authority.
Each future generation is scoped to one tenant, one exact canonical membership
subject, and one canonical grantee; a stored `management_authority_id` is still
only a coordinate until a governed boundary live-locks the active generation.
Migration v56 seeds no row, exposes no runtime reader or writer privilege, and
leaves the v45 and v48-v55 event and database holds unchanged.

Eventful work remains dependency ordered. An explicitly reviewed
bootstrap-governance decision and a separately reviewed activation/ACL/RLS
cutover must precede the future management-grant writer, event append, and
event-store integration. Only afterward may a separate v54 lifecycle writer lock that exact
active grant and append the existing
`memory.membership_epoch.{held,activated,revoked}` event in the same transaction
as the matching epoch transition. V56 defines or emits no grant-lifecycle event,
and the distinct entitlement-management authority remains a later contract.

The following pure contract slice defines that grant-lifecycle vocabulary but
still emits no event. Its strict frozen record mirrors every v56 field:
`schemaVersion`, `tenantId`, `subjectActorId`, `granteeActorId`,
`managementAuthorityId`, `authorityGeneration`, `state`, `lifecycleRevision`,
`createdByActorId`, `activatedByActorId`, `revokedByActorId`, `createdAt`,
`activatedAt`, `revokedAt`, and `updatedAt`. Its event payload carries the exact
record identity, state and revision, state-specific `decisionActorId` and
`decisionAt`, and a required opaque `governanceDecisionId`. Structural binding
requires exact record/event coordinates and maps held to creation attribution,
active to activation attribution, and revoked to revocation attribution. That
equality is evidence only; it proves neither a live/current row nor governance
approval. Because v56 has no governance-decision column, the helper validates
the opaque ID's shape but deliberately cannot bind or authenticate it.

Bootstrap-governance authority, its decision lifecycle, and its trust source
remain deliberately unmodeled. The contract module has no database or event-log
import, writer, append, registry or serving import, or call site. It creates no
row or event and leaves the v56 activation hold, forced RLS, owner-only ACLs,
zero-row postflight, and every earlier event and runtime hold unchanged.

Migration v57 emits no domain event and does not append bootstrap evidence to
the event log. Its empty, owner-only
`omni_membership_management_bootstrap_decisions` table can record only a held,
revision-0 evidence coordinate for the exact tenant, subject, grantee,
management-authority ID, and generation named by the fixed
`create_held_membership_management_authority` action, plus the database
identity that binds the ceremony to one logical database lineage. Restore
preserves that ID, so it cannot prevent replay into a clone by itself.
Ceremony-policy
coordinates; trust-manifest, nonce, evidence, and decision digests; a nonempty
validity window capped at 15 minutes; and operational recording attribution are
not an approval event and do not create the tuple-matched v56 row. The trigger
authors `recorded_at` inside the half-open interval
`[not_before, expires_at)`.

The empty `omni_membership_management_bootstrap_attestations` table reserves
the `organization_custodian` and `independent_reviewer` slots with distinct key
IDs. A possible row repeats the exact parent decision digest, declares
`ed25519`, and stores only its canonical 86-character unpadded base64url
signature ending in `[AQgw]` plus caller-supplied `attested_at`. Its insert
guard requires both the claimed time and the database statement time to fall in
the half-open interval `[not_before, expires_at)`, but does not prove when
signing occurred. Those checks are structural evidence only. V57 neither
requires both attestations nor authenticates a signature or key. The
trust-manifest digest is not a trust anchor; public anchors remain outside
Postgres. Actor foreign keys prove canonical identities only, not signer trust
or same-tenant authority. Raw or private evidence, prose, private keys, and
credentials are excluded from these tables.

The v57 postflight proves both tables empty; forced RLS and owner-only ACLs keep
them unavailable to serving roles. The migration grants no serving access and
adds no writer, route, runtime import, call site, or event append; v56 stays
empty and active-forbidden and every earlier hold remains intact. Broad
development permission and administrator, session, system-scope, or
database-owner status cannot stand in for signed bootstrap governance. External human approval and
signatures, an externally anchored verifier, atomic persistence plus typed
event integration, least-privilege cutover, and a separate v56 activation
migration are future gates.

The subsequent pure bootstrap-governance contract also emits no domain event.
It fixes a versioned, domain-separated decision preimage whose exact signed
coordinates are framed in fixed order with uint32-big-endian UTF-8 name/value
lengths. The governance-decision ID, logical database identity, target
authority tuple, ceremony policy, trust-manifest/nonce/evidence digests, and
validity window are covered; recorder attribution and lifecycle placeholders
are not. Ed25519 verification must target those exact preimage bytes rather
than the hexadecimal digest or a second hash. Recomputing SHA-256 proves only
canonical byte equality.

Attestation-to-decision binding covers the tenant, decision ID/digest, and
half-open window. A frozen two-slot bundle additionally proves stable slot
presence and distinct key IDs, but not signature validity, trust-manifest
resolution, human independence, same-tenant authority, current validity, or
physical-instance uniqueness. No database or event-store writer/import, event
append, registry, serving route, or call site is added. The v57 evidence tables
stay empty and all v45 and v48-v57 holds remain intact.

The following offline verifier contract also emits no domain event. It accepts
an external two-key manifest, an independently trusted manifest digest, the
expected logical database identity, and an explicit observation time. A
separately domain-separated, fixed-frame manifest digest covers the tenant,
database lineage, fixed action, ceremony policy, validity interval, ordered
slots, distinct key and controller coordinates, canonical raw Ed25519 public
keys, key windows, and revocation values. Verification requires that digest to
match both the external anchor and the decision, binds every shared manifest
and bundle coordinate exactly, requires the manifest and key windows to cover
the complete decision window, and verifies each signature over the exact
decision preimage—not its hexadecimal digest.

Successful output is frozen non-authorizing evidence with fingerprints rather
than signatures or public keys. It is not a bootstrap-decision lifecycle event,
authority grant, consumption receipt, or revocation receipt. Trust-anchor
freshness, the caller-asserted time, unsigned claimed attestation times, actual
human independence, same-tenant controller authority, and restored-clone
identity remain outside what it proves. No row, event append, writer, runtime
import/call site, environment key, ACL/RLS change, or activation is added.

The following held-writer slice adds the first atomic persistence boundary but
does not make it reachable from a serving or maintenance runtime. It requires
an existing schema-owner, system-scoped transaction and an attributed human
`memory.maintenance.v1` execution scope. Its injected trust-anchor resolver is
the external authorization boundary: it must return an independently reviewed,
rollback-protected manifest anchor and cannot derive trust from the supplied
manifest. The writer rechecks exact manifest, policy, database-lineage, tenant,
actor, decision, bundle, and anchor coordinates; rejects an independence review
that follows the database observation; verifies both Ed25519 signatures before
and after the trigger-authored decision timestamp; then writes the immutable
decision, its two attestations, one held v56 authority, and the existing typed
`memory.membership_management_authority.held` event through the same
transaction client. The event ID is derived from the decision digest for
idempotent conflict detection.

The result remains explicitly non-authorizing. No default anchor resolver,
database client, environment lookup, CLI, route, worker, serving import, ACL or
RLS grant, activation migration, or runtime call site is added. Therefore this
code cannot manufacture the two independent human approvals, cannot execute
against the owner-only evidence tables, and cannot change memory behavior by
itself. The v56 active-state constraint and every earlier P3.1 hold remain in
force until the external trust registry, real ceremony evidence, and reviewed
cutover exist.

Migration v60 adds the missing non-user execution-principal identity shadow
without enrolling a principal. `omni_tenant_execution_principals` separates a
security principal from descriptive agent configuration and reserves only two
closed kinds: `agent:<id>` principals bound to one same-tenant custom-agent
definition, and actor-bound `service:<id>` principals with one closed system
class. Every generation names a canonical controlling actor, starts held, and
retains explicit lifecycle attribution. Definition ownership is checked through
the append-only canonical/legacy actor-identifier registry; it does not infer
authority from a persona, tool list, model policy, tenant role, or email.

The table starts empty, is owner-only, uses forced tenant RLS plus a restrictive
system-scope holdback, and has a validated active-state prohibition. Its
generation and immutability triggers reserve held/active/revoked transitions,
but no active row is currently reachable. The matching pure contract fixes the
record shapes and metadata-only
`security.execution_principal.{held,activated,revoked}` event family; it has no
writer or event-store import. V60 grants no serving read or write, adds no
resolver call site, does not seed Asael or worker identities, and leaves the v43
memory enrollment lock and v45 denial hook unchanged. Canonical workspace
membership, context/capability grants, operation policy, governed principal
writers, activation, and the atomic memory cutover remain later P3.1 gates.

Migration v61 adds the canonical workspace and workspace-membership authority
inputs without creating a workspace or treating an existing tenant member as a
workspace member. `omni_tenant_workspaces` and
`omni_tenant_workspace_memberships` start empty, remain schema-owner-only, and
use forced tenant RLS plus restrictive system-scope holdbacks. User membership
binds an exact canonical actor that still has an active same-tenant auth
membership. Agent and actor-bound system membership instead pins an exact
same-tenant execution-principal generation and kind. These identities are
structurally disjoint; project ownership, mission ownership, OAuth grants,
connector access, tenant roles, and matching labels create no membership.

Both authorities have validated active-state constraints and hard mutation
holds. The closed membership access levels (`reader`, `contributor`, and
`manager`) establish only the workspace membership coordinate: they grant no
project, asset, memory, tool, approval, or administrative operation. The pure
record contracts add metadata-only `security.workspace.*` and
`security.workspace_membership.*` lifecycle events, but v61 installs no writer,
event-store call site, serving grant, default workspace, or resolver behavior.
Governed workspace and membership lifecycle writers, context/capability grant
authorities, operation policy, and the atomic P3.1 cutover remain held.

Migration v62 adds the single canonical ledger that distinguishes memory
`context:<id>` grants from `capability:<id>` grants. Every generation binds an
exact tenant, user or pinned non-user principal generation, v47 purpose,
visibility-compatible memory target, sorted resource-ID set, validity window,
and explicit bounds. Context grants are limited to read/retrieve purposes and
carry item/byte bounds without operation authority. Capability grants instead
carry a sorted operation set plus invocation, cost, and duration ceilings. A
targeted agent-private scope pins the exact owner-agent principal generation;
project sharing also requires an explicit workspace coordinate.

The ledger starts empty, is schema-owner-only, has forced tenant RLS plus a
restrictive system holdback, and retains a validated active-state prohibition
and hard mutation hold. Creation validation requires live same-tenant human
attribution and checks exact non-user principals, but no writer or serving role
can reach it. OAuth grants, tenant capability rollouts, tenant roles, previous
access, matching labels, and persona/tool declarations are not translated.
The pure contract emits metadata-only `memory.access_grant.*` events without an
event-store dependency. A governed lifecycle writer, operation policy,
transactional resolver, and all-surface activation are still required.

Migration v63 adds the missing tenant-scoped memory operation-policy authority
without installing an active policy. Each generation binds exactly one v47
purpose to its operation class, a fixed minimum risk class, canonical principal,
visibility, and sensitivity sets, and explicit grant/request/approval gates.
Every operation requires a capability grant; read, retrieve, and formation also
require context grants. Forget and export are always critical, request-bound,
and human-approved, so neither a standing consent nor a policy row can disable
those data-right safeguards. Maintenance remains an ordinary attributed
operation and does not enable database maintenance scope or RLS bypass.

The table starts empty, is schema-owner-only, uses forced tenant RLS plus a
restrictive system holdback, and has a validated active-state constraint and
hard mutation hold. It seeds no permissive defaults and has no writer, resolver,
or event-store call site. The pure contract emits only metadata in
`memory.operation_policy.*` lifecycle events. The transaction-bound resolver,
governed authority writers, and atomic all-surface activation remain later
P3.1 work.

The denial-only P3.1 code canary now resolves the executing principal under
the same owned transaction as its existing canonical actor and tenant
membership locks. An exact canonical user is recognized only through the
active auth-user and tenant-membership rows already locked by the canary.
Agent and system identities additionally require exactly one active v60
principal generation controlled by that canonical actor, read with a bounded,
deterministic `FOR SHARE` query. Missing, duplicate, held, revoked, malformed,
or differently controlled principals remain unavailable. The canary still has
no allow result and does not install a database access scope. Any scope with a
workspace or project coordinate now also locks one active v61 workspace and
one exact active membership. User membership is keyed to the canonical actor;
agent and system membership must pin the resolved v60 principal generation.
A project coordinate without its workspace, or any missing, duplicate,
inactive, malformed, or generation-mismatched authority, denies before later
purpose reads. After the immutable purpose row is locked, the canary also
locks exactly one active v63 policy generation and rechecks its fixed risk,
principal, context-grant, capability-grant, request-binding, and human-approval
gates before standing consent is inspected. Missing, duplicate, inactive,
under-classified, unsorted, or gate-weakening policy rows remain unavailable.
For non-data-right purposes with valid standing authority, claimed v62 context
and capability grants are now locked in canonical ID order and matched to the
exact tenant, purpose, principal generation, owner, target coordinates,
policy visibility, resource set, operation set, quantitative bounds, active
lifecycle, and database-observed validity window. Extra context claims are not
accepted when the policy does not require them. Any missing, duplicate,
expired, inactive, malformed, cross-principal, or scope-drifted grant remains
unavailable. Export and forget still stop at the request-bound authority gate
before standing grants can be considered. Even with every observable input
coherent, the canary's only decision remains `deny`.

Migration v64 adds the missing request-bound authority model for the two memory
data rights. A request is limited to `memory.export.v1` or
`memory.forget.v1`, one canonical subject acting as the exact user principal,
one request digest, a canonical resource set, a validity window capped at one
hour, and the
operation-specific human evidence (`explicit_export_request` or
`reviewed_deletion_preview`). Its lifecycle supports held, active, one-time
consumed, and revoked states so an approved request cannot become standing
consent or be replayed indefinitely. Lifecycle events contain only opaque
coordinates, counts, and SHA-256 bindings; raw resources are not copied.

The v64 table starts empty, owner-only, and under forced tenant RLS with a
restrictive system holdback. A validated constraint forbids active and consumed
rows, inserts must start held, and update/delete/truncate are hard-held. No
generic tool approval, tenant role, purpose entitlement, OAuth grant, existing
deletion receipt, or standing consent is imported. There is no writer, serving
reader, resolver call site, or activation in this slice; the v43 memory
enrollment and v45 authorization holds remain unchanged.

The denial-only P3.1 canary now accepts a separate frozen request claim only
for export or forget. It locks the exact v64 request generation in the same
owned tenant transaction and rechecks the canonical human subject/principal,
operation-specific confirmation, request digest, resource set, active
lifecycle, activation actor, and database-observed validity window. A matching
capability grant must cover that exact resource set and name the exact purpose;
an agent principal cannot reuse its controller's human request. Ordinary
purposes reject a request claim and continue to use standing authorities. The
canary still has no allow result, performs no mutation or consumption, installs
no access scope, and has no serving call site; v64's activation hold means a
real row cannot yet satisfy this inspection.

A separate transaction-only writer can now persist the initial held v64
request and its metadata-only event atomically. It accepts only an exact
canonical human execution scope whose tenant, actor, principal, and purpose
match the request; live-locks the active auth user and same-tenant membership;
and verifies the exact v64 marker, activation constraint, forced RLS, policies,
and mutation triggers before insertion. The database remains authoritative for
generation ordering and timestamps, and a valid-but-differently-bound returned
row is rejected before event append. The writer has no client, route,
environment lookup, transaction opener, activation, revocation, consumption,
or serving call site. It requires an explicitly supplied schema-owner system
transaction and returns `authorityGranted: false` and `runtimeAccepted: false`.

Before any v55 notice, receipt, or consent writer can emit events, its existing
exact postflight must become a shared read-only verifier required by that
writer's migration. V56's bounded hold audit is not a substitute for that gate.

Migration v65 extracts that complete v55 structural postflight into the shared
read-only `verifyMemoryInformedNoticeAuthorityBoundary` migration verifier. It
requires schema-owner system scope, stabilizes the identity, purpose,
entitlement, membership-epoch, notice, receipt, and consent surfaces under
shared locks, and re-runs the exact relation, column, default, constraint,
function, trigger, policy, ACL, zero-row, and predecessor-hold checks. Fresh v55
installs use the same verifier, while v65 additionally pins the exact immutable
v55 marker before verifying an existing database. It creates no database
object, authority row, event, writer, serving grant, or runtime call site; a
future notice, receipt, or consent writer migration must invoke this verifier
again at its own boundary.

The following pure informed-notice governance contract defines the reviewed
batch that must precede such a writer. A canonical, domain-separated,
length-framed digest covers the exact UTF-8 notice text and its independently
recomputed SHA-256 together with purpose, immutable contract/version, locale,
governance-policy, nonce, evidence, and batch coordinates. Contracts are
unique and canonically ordered by the exact v55 primary key, are limited to
standing-consent purposes, and preserve the v55 text and locale bounds. Exact
legal-reviewer and privacy-reviewer records must use distinct canonical actors
and review IDs and bind the same batch digest and governance policy.

Those review records are structural evidence only: the pure parser does not
authenticate either human, review system, policy authority, or review time.
It contains no trust registry, signature verifier, database or event-store
import, writer, route, environment lookup, row, event, serving call site, or
activation. A later externally anchored verifier must authenticate both review
records; only after that may a separately reviewed writer migration invoke the
v65 boundary verifier, remove the exact seed hold, and atomically persist the
approved catalog batch with its governed evidence. Notice receipt and consent
issuance remain independently held.

The matching pure offline verifier consumes a caller-supplied two-key trust
manifest whose independently anchored digest, governance-policy coordinates,
validity window, and ordered legal/privacy keys must match the reviewed batch.
Each exact review record is repeated in a domain-separated Ed25519 attestation
that binds its batch digest, policy, slot, review ID, canonical reviewer actor,
review time, and key ID. The verifier recomputes the batch and manifest digests,
requires both keys to be distinct and active at review and observation time,
rejects current revocation, and verifies both signatures before returning only
fingerprints and non-authorizing evidence.

The manifest anchor and observation time are caller assertions and therefore
remain external trust inputs; successful cryptography does not prove legal
authority, human independence, or a durable approval registry by itself. The
verifier has no clock, registry, network, environment, database, event-store,
writer, route, row, event, serving call site, or activation path. It returns
`authorityGranted: false` and `runtimeAccepted: false`; v55 and v65 holds remain
unchanged until an independently reviewed persistence boundary exists.

Migration v66 adds that persistence boundary only as three empty global
governance-evidence shadows: approval batches, their exact ordered notice-copy
records, and the two legal/privacy review attestations. The tables preserve the
verified batch, policy, nonce/evidence digests, externally anchored manifest
digest and observation, exact notice text/digest, review signatures, signer-key
fingerprints, and operational recording actor without treating any of them as
runtime authority. This is intentionally global legal/privacy copy rather than
tenant content; forced system-scope RLS, schema-owner-only ACLs, immutable
triggers, and validated `CHECK (FALSE)` persistence holds keep it inaccessible
and empty. V66 invokes the exact v65 verifier before and after installation,
seeds no review or notice, emits no event, adds no writer or call site, and
leaves the v55 notice-catalog, receipt, consent, membership, and entitlement
holds unchanged. A later separately reviewed writer/cutover must authenticate
real externally anchored evidence, remove only these evidence/catalog holds,
live-lock all coordinates, and commit the approved batch atomically; receipt
and consent issuance remain independent future gates.

Migration v67 closes the remaining durable-evidence gap without changing the
v66 marker: the still-empty approval-batch shadow now requires the exact
external trust-anchor independence-review ID, canonical reviewer actor, review
time, and literal reviewed decision. A separate immutable validator binds that
review between manifest issue and observation time; a canonical-actor foreign
key and unique review identity prevent an anonymous or reused review from
standing in for the external ceremony. V67 requires the schema owner, exact v66
marker, empty owner-only shadows, and all three `CHECK (FALSE)` holds before the
append-only upgrade, then re-runs the v65 boundary verifier. It seeds no row,
removes no hold, grants no runtime access, and emits no event.

The matching transaction-only writer contract accepts an explicitly global
human governance scope rather than borrowing a tenant's authority. It resolves
the trust anchor through a caller-supplied rollback-protected registry,
requires a third canonical independence reviewer after both signed reviews,
serializes all batches with one advisory key and a fixed four-table lock order,
re-verifies both Ed25519 signatures at the database-observed time, and persists
the batch, exact notice copy, signatures, public-key fingerprints, independence
review, and live catalog rows idempotently in one transaction. Its preflight
requires exact v67 plus a separately reviewed future cutover where only the
v55 catalog and v66 evidence persistence holds have been removed; receipt,
consent, membership, and entitlement holds must remain exact. Consequently the
writer cannot succeed against v67 as installed and has no client, route,
environment lookup, default trust resolver, event append, or serving call site.
It returns `authorityGranted: false` and `runtimeAccepted: false`.

The P0.5 offline baseline now observes both intent-routing cases through the
real supervisor rather than leaving them as unsupported probes. The evidence
preserves the current direct-path decision, absent procedure binding, and
absent ambiguity evaluation, so the normative durable-procedure and ambiguous
delete cases remain hard failures. No expected fixture value is copied into
the observation, no model, network, database, tool, connector, clock, or
environment input is used, and the baseline score remains the truthful 5 of
16 (3,125 basis points). This adds regression visibility but does not close
P0.5 or change serving behavior.

In Postgres, the receipt on `omni_tool_executions` and its typed event append
commit in one transaction. File fallback updates the tool ledger before a
separate best-effort event append and remains a development compatibility
path, not an atomic audit guarantee. Legacy records, dry runs, and other tools
remain unchanged. P1.3 can project the ID of a strictly bound, verified canary
receipt as additive evidence, while its evaluation remains `posthoc` and
cannot emit `succeeded`; full P1.4 remains open.

## Notification mutation cutover

Authenticated single-notification actions now require an exact user execution
scope at the API boundary. Their stable event identity is derived from tenant,
actor, and the bounded idempotency key. The strict v1 payload records only the
notification and source IDs, action, resulting status, and a key digest; titles,
message text, and reminder content are excluded.

In Postgres, the notification row, a completed source Today item when
applicable, and `notification.updated` append in one transaction. File fallback
retains the development compatibility sequence and does not provide an atomic
audit guarantee. Authenticated bulk-read actions use a separate aggregate
stream and the same exact request binding. Scheduler-generated notifications
remain outside this cutover.

## Connected-source knowledge deletion cutover

Authenticated connected-source deletion now binds the tenant, initiating user,
exact source-prefix digest, correlation, causation, and bounded idempotency key.
Its strict v1 `knowledge.source_deleted` event contains only operation and digest
metadata; source names and indexed content are excluded.

In Postgres, matching knowledge removal, derived-memory retirement, retrieval
trace and graph invalidation, rebuild scheduling, and the event append commit in
one transaction. Capture asset and recording deletion now joins that transaction
with the exact owner-bound capture row and its typed deletion event. Capture
ingest also locks the same tenant/actor/job-bound row before each knowledge,
memory, and graph persistence stage: ingest either commits first and is scrubbed,
or deletion commits first and the stale writer fails closed. File fallback
remains a non-atomic development compatibility path. Broader P2.7 propagation
and physical scrub completion remain open.

## Pending-run deletion barrier

Memory, governed connected-source, and capture deletion now resolve the exact
retrieval traces being scrubbed while holding the tenant memory-graph lock.
Non-terminal agent and workflow runs that admitted one of those traces are
canceled in the same transaction, approval continuations are cleared, and
`run.context_invalidated` or `workflow.context_invalidated` is appended with
the deleting actor's execution scope. The event retains only bounded counts,
closed reason/source codes, and a source-reference digest.

Context admission takes a row lock on the retrieval trace and rejects a trace
that disappeared or contains a memory deletion barrier. Therefore admission
either commits first and becomes visible to deletion, or deletion commits first
and the stale run or workflow fails closed. Terminal run transitions already
exclude canceled rows, so delayed workers cannot resurrect invalidated work.

## Memory deletion preview and receipt UX

The authenticated Memory workspace now requests an exact, write-authorized
deletion preview before it offers the irreversible confirmation. The preview
enumerates descendant memories and reports exact trace, graph, and pending-run
impact. Its manifest digest uses the same tenant, root, descendant, trace, node,
and edge bindings as the eventual permanent receipt.

The API requires that digest when deletion is committed. The deletion
transaction recomputes the lineage while holding the memory and graph locks;
if anything changed after review, the transaction rolls back and returns a
conflict instead of deleting an unreviewed target set. After commit, the UI
renders the permanent receipt hash, projection counts, and exact number of
non-terminal runs canceled. File mode applies the same preview binding and
scrubs descendant rows, but remains explicitly best-effort rather than a
rollback-proof database guarantee.

The maintenance worker treats every immutable Postgres deletion receipt as a
durable physical-scrub manifest. It leases receipt rows with `SKIP LOCKED`,
scrubs only a bounded number of descendant rows per tick, and resumes from the
remaining non-canonical shells after interruption without storing forgotten
content in a queue. When the entire manifest is physically scrubbed it appends
the idempotent `memory.deletion_scrub.completed` event under a system execution
principal causally bound to the original receipt. The event contains opaque
IDs, counts, status, and SLA outcome only. The immediate receipt barrier stays
authoritative during the scrub window; the default physical completion SLA is
24 hours and overdue receipt IDs are surfaced in worker results.

## Event shape

```ts
type DomainEvent = {
  id: string;              // ULID (sortable by time)
  streamId: string;        // e.g. run:<id>, workflow:<id>, tenant:<id>
  seq: number;             // monotonic per stream (optimistic concurrency)
  type: string;            // intent.submitted, plan.node.completed, tool.executed, approval.granted, correction.applied, ...
  tenantId: string;        // RLS scope
  actorId: string;
  payload: Record<string, unknown>;
  causationId?: string;    // the event that caused this one
  correlationId?: string;  // the originating intent
  at: string;
};
```

## Why this unlocks the product

- **Replay**: re-fold a stream through a newer agent version → regression-test against real history.
- **Fork**: branch a stream at seq N, inject a human correction, continue → "what if" and guided recovery.
- **Audit**: every decision is a first-class, queryable, application-append-only record with causation links; immutable retention still requires WORM/object-lock controls.
- **Evals**: golden tasks are just recorded streams; scoring is folding + asserting.
- **Trust**: the trust ledger becomes a projection of `tool.executed` / `approval.*` events, not a separate store.

## Storage

- Postgres: `omni_events (id, stream_id, seq, type, tenant_id, actor_id, payload jsonb, causation_id, correlation_id, at)`, unique `(stream_id, seq)`, RLS by tenant, BRIN on `at`, GIN on payload.
- Projections are materialized views or cached folds, invalidated by new events.
- Snapshots every N events per stream to bound replay cost.

## Migration path (non-breaking)

1. Introduce the event writer behind existing store calls (dual-write).
2. Move each projection (runs, workflows, trust, observability) to fold from events one at a time.
3. Retire the bespoke ledgers once their projection is event-sourced.

This is deliberately staged so the system keeps shipping while the substrate is swapped underneath it — the same discipline applied everywhere in this codebase.

## Ambiguous destructive intent clarification

The supervisor now fails closed before agent or workflow execution when a
destructive request refers only to a vague target, such as an old or previous
project. Explicit direct or durable strategy selection cannot override this
clarification route. The authenticated conversation stores the bounded
clarification and appends `intent.clarification_requested` with the initiating
actor, executing agent, correlation and causation IDs, a closed reason code,
empty target/tool selections, and zero effects; it does not persist the raw
request in the event payload.

## Structured claim support probe

The claim/evidence foundation now includes a bounded deterministic evaluator
for structured subject/predicate/object propositions. A candidate citation ID
does not establish support: the link must resolve to an explicitly authorized
evidence unit whose assertion exactly matches the complete proposition.
Material coverage is derived from the declared claim set, unauthorized linked
evidence is counted and excluded, and duplicate claim or evidence identities
fail closed. The P0.5 observer uses this runtime adapter for both the
wrong-claim and complete-material-support regressions without network, model,
database, or external effects.

## Half-open temporal fact selection

Memory validity now uses one shared half-open interval rule:
`validFrom <= asOf < validTo`. A bounded as-of selector returns every fact that
is valid at the requested instant and reports no match or overlap instead of
choosing an arbitrary answer. The same predicate now filters live active
memory and drives the P0.5 temporal regression, where the selected answer keeps
its exact evidence ID and uncertainty state without invoking a model or tool.

## Transactional source-page fault probe

The source-sync harness now has a bounded all-or-nothing page transaction
model. A fault injected after any item discards the staged item set and keeps
the original cursor; a later attempt commits the complete unique manifest and
next cursor together. Duplicate page identities and invalid retry budgets fail
closed. P0.5 now measures the mid-page failure/retry invariant without touching
a connector, database, clock, or external provider.

## Deterministic saved-procedure resolution

The supervisor can now resolve an explicitly supplied bounded registry of
saved procedures by normalized whole-phrase aliases. One match binds the
canonical workflow ID and declared required tool IDs to a durable decision;
multiple matching procedures fail closed with an
`ambiguous_known_procedure` clarification that execution strategy overrides
cannot bypass. Duplicate workflow IDs and malformed identifiers are rejected.
The resolver performs no lookup, model call, tool invocation, or effect.

The P0.5 intent observer supplies only the synthetic fixture's workflow ID and
aliases, so it now truthfully observes durable workflow resolution while
leaving the procedure's required GitHub trigger binding empty. The case
therefore remains red until a real tenant-scoped saved-procedure/tool binding
is available; no expected tool ID is inferred from the fixture assertion.

## Actor/grant memory access selector

A bounded, side-effect-free memory descriptor selector now denies disclosure
unless a record is in the execution tenant and is either private to the
initiating actor or names an exact context grant carried by the execution
scope. Unknown visibility forms, malformed descriptors, and absent actor
ownership fail closed; conflicting duplicate record identities are rejected.
The selector sees only access metadata, never memory content.

P0.5 now exercises this runtime policy against own, explicitly shared,
sibling-private, and other-tenant synthetic descriptors. This closes the
policy regression without activating the dormant database enrollment or
claiming that legacy unattributed production rows have been migrated; that
cutover still requires authoritative owner attribution and coordinated RLS
activation.

## Exact approval material binding

Approval comparison now uses a canonical digest over both the target digest
and input digest, followed by an exact constant-time SHA-256 comparison.
Malformed or non-canonical digests fail closed. A changed target or input is
classified as `material_binding_changed`, remains `waiting_approval`, and
cannot produce an effect.

P0.5 now observes both the changed-binding denial and exact-binding admission
through this runtime policy. Exact admission selects the governed executor but
still records no synthetic calendar effect or receipt, so the positive effect
case remains red until a real connector mutation is reconciled and verified.

## Lost-acknowledgement reconciliation probe

The idempotent-delivery harness now models the failure where a provider accepts
a mutation but the acknowledgement is lost. A later scheduler attempt must
perform read-after-write reconciliation against the exact material binding
before considering another delivery. A matching observation emits one bounded
receipt and preserves one provider effect; a missing or mismatched observation
cannot verify completion. Retry counts and binding digests are strictly
validated.

P0.5 uses this side-effect-free fault probe for the calendar-shaped lost-ack
case. It proves the retry ordering and receipt invariant without claiming that
a live calendar write connector exists or touching a provider.

## Explicit evidence ID resolution

Explicit saved-context selection now has a separate exact-ID resolver. It
intersects the normalized user allowlist with independently authorized IDs in
the user's original order and never substitutes higher-scoring semantic
candidates. Empty selection remains an authoritative request for no saved
context, and malformed or unauthorized IDs are excluded.

P0.5 exercises this policy without loading evidence content. Live context-pack
integration remains gated on actor-aware exact-ID retrieval, so the selector
does not broaden the current tenant-only memory store or bypass its dormant
database access cutover.

## Generic provider effect receipt v2

The additive `EffectReceiptV2` contract extends effect evidence beyond the
frozen memory-only v1 meaning without loosening historical receipts. It binds
direct or workflow execution, complete scope/principal and plan identity,
generic governed tool and target IDs, tool/input/idempotency digests, exact
approval material, provider acknowledgement class, and read-after-write state.
False verified combinations, partial workflow bindings, malformed approval
state, body tampering, and unknown fields fail closed.

Its event builder emits only allowlisted IDs, hashes, booleans, and enums and
omits provider request identity. This slice registers no adapter, changes no
executor path, performs no effect, and grants no authority; it is the stable
contract required before a connector-specific acknowledgement and verifier can
be activated.

`EffectIntentV2` now supplies the matching pre-effect half of that boundary.
It deterministically binds the full execution/scope/plan/tool/approval/input/
idempotency/target identity and expected state before any provider fields
exist. The finalizer revalidates the immutable intent and accepts only bounded
acknowledgement and verification evidence, preventing post-effect rebinding.
The audit store now persists it behind the exact execution-claim token, checks
tenant/actor/principal, tool contract, input, and preapproved material binding,
and emits `tool.effect_intent.recorded` atomically with the private database
record. The private intent and approval evidence are removed from public tool
records, and stale-claim recovery cannot replay the bound effect. It still has
no executor or provider-adapter call site, so an intent object alone cannot
cause or authorize an effect.
