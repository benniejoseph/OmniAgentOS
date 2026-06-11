# Event-Log Substrate — Spec (M1)

> Not yet built. This is the design the next milestone implements. The current
> run ledger, workflow events, observability events, and security audit are four
> partial implementations of this idea; M1 unifies them.

## Principle

One append-only, immutable log is the source of truth. All other state
(run status, workflow position, trust profiles, dashboards) is a **projection**
rebuilt by folding events. Nothing mutates in place.

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
- **Audit**: every decision is already a first-class, queryable, immutable record with causation links — no separate audit subsystem.
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
