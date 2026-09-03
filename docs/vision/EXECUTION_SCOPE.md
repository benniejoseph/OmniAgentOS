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
The next slice adds versioned run contracts and canonical status adapters in
shadow mode before any existing status is reinterpreted.
