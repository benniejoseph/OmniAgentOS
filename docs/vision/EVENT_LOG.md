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
