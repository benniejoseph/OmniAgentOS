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
bounded notice/evidence identifiers. Version 1 grants and revocations must be
self-decisions. Events cannot contain consent text or memory content, and a
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
projects existing definitions into an inspectable Arsenal catalog and gates
all assignment and mutation affordances with explicit capability booleans;
bare list clients and every execution or write path remain exact-owner. The
Mission UI also omits an unchanged nonselectable historical assignee instead
of rewriting it. No Agent, task, run, approval, receipt, or external system is
mutated by the compatibility read itself, so later runtime or canonical-write
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

In Postgres, the receipt on `omni_tool_executions` and its typed event append
commit in one transaction. File fallback updates the tool ledger before a
separate best-effort event append and remains a development compatibility
path, not an atomic audit guarantee. Legacy records, dry runs, and other tools
remain unchanged. P1.3 can project the ID of a strictly bound, verified canary
receipt as additive evidence, while its evaluation remains `posthoc` and
cannot emit `succeeded`; full P1.4 remains open.

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
