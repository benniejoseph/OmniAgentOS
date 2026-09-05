# Execution Scope Ownership Inventory (P0.1)

`ExecutionScope` is the immutable authority envelope carried across one
operation. It records tenant, initiating actor, executing principal, optional
workspace/project/mission/delegation, correlation and causation, context and
capability grants, and purpose. It is attribution and attenuation metadata; it
does not replace authentication, RBAC, RLS, tool policy, or approval checks.

## Boundary inventory

| Boundary | Scope entry point | Durable evidence | Compatibility behavior |
|---|---|---|---|
| Memory and RAG | `MemoryAccessContext` created from the authenticated or delegated scope | scoped run harness and retrieval/run events | P0.1 keeps existing tenant-only retrieval results; actor/project filtering is an additive P3/P4 migration |
| Agent runs | scope supplied by the request boundary and bound before execution | `run.scope_bound` plus scoped `run.*` events | pre-P0.1 streams remain readable without a binding |
| Delegation | child scope derived from the parent with grants narrowed | child run/delegation events | a child cannot widen parent grants |
| Governed tools | tool scope derived from the active run/workflow scope | `tool.scope_bound`, tool audit and scoped events | approval and idempotency remain authoritative |
| Workflows | request/trigger scope bound before a worker can claim work | `workflow.scope_bound` plus scoped workflow events | in-flight legacy workflows resume through their persisted authority adapter |
| MCP connectors | authenticated user scope at configuration routes; active run scope for execution-side health mutations | connector binding and versioned mutation events | legacy records stay readable; every new mutation needs explicit authority |
| OpenAPI connectors | authenticated user scope at configuration routes; active run scope for execution-side health mutations | connector binding and versioned mutation events | legacy records stay readable; every new mutation needs explicit authority |
| Capture assets and recordings | authenticated capture scope, governed browser scope, or an explicitly named internal job scope | asset/recording/segment binding and versioned mutation events | existing records stay readable; new writes cannot silently invent an actor |
| Event log | `appendScopedDomainEvent` for new scoped mutations | `_executionScope` in the bounded, redacted event payload | the legacy writer remains only for stores not yet migrated |
| Projections | scope folded only from immutable `*.scope_bound` events | additive `scopeBinding` with bound/invalid/conflict state | domain status and legacy reads are unchanged |

## Invariants

1. The scope tenant must match the authorized/store tenant.
2. A named initiating actor must match the owner for actor-owned writes.
3. Derived scopes preserve the root tenant, actor, and correlation ID.
4. Context and capability grants may be narrowed, never widened.
5. Binding and mutation events contain IDs, hashes, counts, state, and contract
   versions—not credentials, captured content, model reasoning, or raw tool
   output.
6. Missing or conflicting scope on a new mutation fails closed. Historical
   unscoped records remain readable and are never upgraded by guessing an
   owner.

## Rollout boundary

P0.1 is deliberately additive. It does not change memory retrieval ranking,
connector execution policy, capture limits, approval behavior, or UI status.
The P0.2 versioned run-contract envelope and P0.4 canonical status adapter are
present in shadow mode: they add scoped metadata events and a compatibility
projection without reinterpreting existing store state, controls, or UI status.

P3.1 now also has a held database-memory envelope constructor and
transaction-local installer. It does not extend `ExecutionScope` v1: the
canonical memory purpose ID is supplied separately, while the existing
free-form purpose remains optional audit text. Database function grants,
membership resolution, row enrollment, and every serving call site remain
held for one atomic activation. Migration v45 adds an ungranted authorization
hook that always denies until actor, principal, target, purpose, consent, and
capability authorities can be resolved and locked in that same transaction.
Migration v46 and its pure code accessor now define a stable authenticated-user
actor projection, but `ExecutionScope` v1 still carries the historical actor
unchanged and does not infer or persist that projection.
Migration v54 adds an empty, owner-only tenant-actor membership-epoch shadow.
It grants no scope, enrolls no current membership, changes no session or role,
and remains behind a validated activation hold plus restrictive RLS. A future
authority writer and typed event must establish an epoch before the memory
authorization hook can use it; `ExecutionScope` cannot substitute for that
membership decision.
Migration v55 adds empty, issuance-held informed-notice contracts and
tenant/actor acknowledgement receipts, then requires the exact receipt and
membership epoch in the still-empty standing-consent contract. These references
grant no execution scope and do not authorize memory access. A future resolver
must live-lock and validate the active authorities for the current request;
`ExecutionScope` fields or a stored receipt alone cannot substitute for current
membership, entitlement, consent, or revocation state.

The denial-only memory-authority canary may consume an exact database memory
scope and a frozen canonical request-actor binding only to inspect the future
lock order. It first proves that tenant scope matches and that system scope and
any previously installed memory scope are absent. A legacy request actor is
never returned and is reported only as the coarse `canonical_scope_actor`
prerequisite. The canary never installs the scope, calls the v45 hook, or turns
`ExecutionScope` principal, context-grant, capability-grant, target, or purpose
fields into authority. Its only result is `deny / activation_held`; export and
forget additionally require a separate request-bound data-right authority.
`FOR SHARE` row locks are transient observations, not permission or a durable
mutation.

Migration v56 adds the empty, owner-only
`omni_tenant_actor_membership_management_authorities` shadow, not a new
`ExecutionScope` field or grant. Each generation binds a canonical grantee to
one exact canonical membership subject and tenant, remains behind a validated
activation hold and restrictive tenant RLS, and is absent at postflight. The
migration installs no serving reader, writer, runtime privilege, event,
bootstrap inference, or authority row and preserves the v45 and v48-v55 holds.
Neither `initiatingActorId`, principal identity, role, context/capability grant
IDs, nor any other scope coordinate can manufacture or replace that
subject-bound authority.

A separately reviewed bootstrap-governance decision and activation/ACL/RLS
cutover must precede a future atomic management-grant writer under a separately
versioned event contract. Only after that exact grant is active may a separate
v54 lifecycle writer lock its canonical grantee and subject and commit the
membership-epoch transition with its typed event. Distinct
entitlement-management authority is a later
dependency and is not modeled or granted by v56.
