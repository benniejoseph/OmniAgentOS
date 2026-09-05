# ADR 008: Internal delegation authority with an external A2A boundary

Status: Accepted · 2026-09-05

## Context

Asael needs one stable internal delegation model even as external agent
protocols evolve. The [A2A Protocol 1.0 specification](https://a2a-protocol.org/v1.0.0/specification)
defines discovery, tasks, messages, artifacts, streaming, cancellation, and
explicit protocol-version negotiation. Those transport contracts do not replace
Asael's tenant scope, authority grants, governed execution, evidence, or outcome
verification. External agent cards, messages, artifacts, and metadata are
untrusted data.

## Decision

Adopt the versioned Asael `DelegationContract` as the target canonical contract
for internal delegation. It owns parent and child identity, tenant and actor
scope, executing principal, purpose, context and capability grants, budgets,
causation and correlation, idempotency, acceptance, progress, cancellation,
artifacts, verification, and terminal outcome. After its persisted cutover,
internal agents communicate through the orchestrator and delegation broker, not
through A2A.

A boundary adapter maps that contract to external A2A. The first adapter pins
the protocol `Major.Minor` to `1.0`; patch versions do not change negotiated
compatibility. Every binding carries the service parameter value `1.0` through
that binding's specified mechanism, and the selected Agent Card interface must
declare `protocolVersion: "1.0"`. Under the 1.0 specification, a missing or empty
service parameter is interpreted as `0.3`; this adapter therefore rejects it as
unsupported rather than treating absence as 1.0. Other unsupported versions
also fail closed. There is no silent downgrade, automatic fallback to 0.3, or
acceptance based only on an endpoint's claim. Each enabled rollout also pins one
exact, reviewed Asael adapter release and its artifact SHA-256 digest. Wire
compatibility with `1.0` never authorizes an unreviewed adapter build or a
mutable `latest` release. This ADR enables no adapter release or peer: the
accepted release-and-digest set is empty until a reviewed rollout records both
exact values.

Every external action that can affect Asael or another system re-enters the
governed tool executor with approvals and idempotency intact. Remote agents
receive only scoped references or short-lived tokens whose audience is an
Asael-controlled, governed-executor gateway. They never receive a provider
credential, direct third-party mutation token, ambient tenant access, or a
transferable parent grant. Until that gateway and its verification gates are
implemented, external A2A tasks are proposal- and artifact-only and cannot
perform consequential effects.

## Canonical authority and compatibility

Until the bounded delegation migration completes, existing orchestrator,
workflow, and run records retain their present authority. After persisted
cutover under ADR 005, Asael's delegation ledger and typed events are
authoritative for internal task state, scope, causation, cancellation, budgets,
accepted artifacts, and outcome. External task and context IDs are mapped
references, not replacements for internal IDs. A remote completed state is an
observation until Asael verifies the required artifact or effect independently.

The adapter may preserve compatible A2A messages, task updates, and artifacts,
but it labels and validates them as untrusted input. A2A remains the
agent-to-agent task boundary; MCP remains the tool and data boundary. Neither
protocol creates authority in the other.

## Migration and cutover

Define and prove the internal delegation contract, broker, scoped token model,
causation, cancellation, idempotency, and verifier before enabling an external
peer. Add the A2A adapter behind a persisted per-tenant and per-peer rollout,
beginning with allowlisted shadow exchanges and non-consequential tasks. Record
the exact interface, protocol version, adapter release and digest, mapping, and
remote task identity.

Cut over a peer only after discovery authentication, version negotiation,
scope-narrowing, reconnect, retry, cancellation, malformed-artifact, and
independent-verification fixtures pass. Peer-to-peer delegation remains disabled
until orchestrator-mediated delegation and its scope, causation, cancellation,
and acceptance gates are proven.

## Rollback

Disable the adapter for the affected tenant or peer, revoke its delegated
tokens, and stop creating remote tasks. Preserve internal tasks, mappings,
events, and received evidence; cancel or expire outstanding remote work where
the negotiated protocol permits. Internal execution continues through the
canonical broker. Rollback never falls through to an unversioned or direct
peer-to-peer path.

## Permanent security floors

- Tenant, initiating actor, executing principal, purpose, grants, budgets,
  correlation, and causation stay explicit across every boundary.
- External content is untrusted and cannot become system instruction, a grant,
  a verified result, or durable truth merely because an agent supplied it.
- All effects use the governed executor; A2A cannot bypass approval,
  idempotency, policy, receipt, or read-after-write verification.
- Delegated tokens are narrow, short-lived, audience-bound, revocable, and
  accepted only by an Asael governed-executor gateway. They cannot be used
  directly against a provider, broadened, or redelegated unless the parent
  contract explicitly permits it.
- Secrets, private reasoning, and raw credentials are never placed in Agent
  Cards, messages, artifacts, ordinary events, or delegated context.
- Direct peer-to-peer A2A stays disabled until the master-plan gates are met.

## Consequences

Asael can interoperate with A2A peers without creating a second delegation or
security model. The adapter must maintain strict version mappings, reconcile
asynchronous remote state, preserve cancellation and retry semantics, and
independently verify results. Protocol upgrades require a separately reviewed
mapping and rollout generation rather than an in-place semantic change.
