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
entitlement-management authority is a later dependency and is not modeled or
granted by v56.

The following membership-management contract-only slice also does not extend
`ExecutionScope`. Its frozen record exactly mirrors the v56 tenant, subject,
grantee, authority ID/generation, lifecycle state/revision, and all lifecycle
actor/timestamp fields. Its stable
`memory.membership_management_authority.{held,activated,revoked}` payload adds a
required opaque `governanceDecisionId` beside the exact record identity and
state-specific decision attribution. Structural equality with a held, active,
or revoked record is evidence only; neither that equality nor any scope field
proves approval or mutation authority. V56 has no governance-decision column,
so the helper validates the opaque ID's shape but cannot bind or authenticate
it.

Bootstrap governance remains a separate unmodeled prerequisite. The pure slice
has no database or event-store import, writer, event append, serving import or
call site, scope installer, grant, or row mutation. The v56 activation hold,
restrictive RLS, owner-only ACLs, zero-row state, and all v45 and v48-v55 holds
remain unchanged.

Migration v57 does not turn bootstrap governance into an `ExecutionScope`
field or permission. Its empty persistent, owner-only-as-installed
`omni_membership_management_bootstrap_decisions` table holds at most evidence
coordinates for a held revision-0 decision: the exact tenant, database
identity, subject, grantee, management-authority ID, and generation; the fixed
action `create_held_membership_management_authority`; ceremony-policy
coordinates;
trust-manifest, nonce, evidence, and decision SHA-256 digests; a nonempty
validity window capped at 15 minutes; and operational recording attribution.
The trigger authors `recorded_at` inside the half-open interval
`[not_before, expires_at)`.
The tenant/subject/grantee/authority tuple mirrors the target v56 row while the
database identity binds the ceremony to logical database lineage. Restore
preserves that ID, so it cannot prevent replay into a clone by itself. The
authority row remains absent, and verification, consumption, and revocation
attribution remains null.

The empty `omni_membership_management_bootstrap_attestations` table reserves
only the `organization_custodian` and `independent_reviewer` slots with
distinct key IDs, the fixed `ed25519` algorithm, an exact parent decision
digest, a canonical 86-character unpadded base64url signature ending in
`[AQgw]`, and caller-supplied `attested_at`. The insert guard requires both the
claimed time and the database statement time to fall in the half-open interval
`[not_before, expires_at)`, but does not prove when signing occurred. These
checks are structural evidence only. It does not require the pair, authenticate
a signature, or establish governance.
`trust_manifest_sha256` is only a digest; trust anchors stay outside the
database. Actor foreign keys prove canonical identities only, not signer trust
or same-tenant authority. Neither table stores raw or private evidence,
narrative approval, private keys, or credentials.

Forced RLS and owner-only ACLs preserve the hold. V57 seeds no rows, grants no
serving access, emits no event, and adds no route, writer, runtime import, call
site, or scope installer. It leaves v56 empty and active-forbidden and all
earlier holds unchanged. Broad development permission is not a signed
bootstrap-governance decision; administrator roles, authenticated sessions,
system scope, database-owner status, and other scope coordinates are not trust
roots. External human approval and the two signatures, an externally anchored
verifier, governed atomic writer/event integration, reviewed least-privilege
cutover, and a separate v56 activation migration remain future gates.

The following bootstrap-governance contract does not add a scope coordinate or
permission. It serializes the exact signed decision coordinates with a
versioned domain and fixed-order uint32-big-endian UTF-8 framing, recomputes a
SHA-256 digest, structurally binds each attestation to its decision/window, and
forms the two fixed slots in stable order with distinct key IDs. Operational
recording attribution and lifecycle placeholders are deliberately unsigned;
future Ed25519 verification targets the exact preimage bytes, not the hex
digest or a second hash.

These are content-free equality checks, not Ed25519 verification, trust-anchor
resolution, human-independence proof, same-tenant authority, clock validation,
or clone-replay protection. The pure module imports no database, auth,
event-store, serving, or key registry and has no route, writer, event append,
scope installer, or runtime call site. It leaves v57 empty, v56
active-forbidden, and every earlier hold unchanged.
