# ADR 009: Deterministic AP2 payment boundary

Status: Accepted · 2026-09-05

## Context

Agent-performed payments require cryptographic evidence and deterministic
verification outside the model. The official [tagged Agentic Payment Protocol
specification](https://github.com/google-agentic-commerce/AP2/blob/v0.2.0/docs/ap2/specification.md)
defines AP2 v0.2, Shopping Agent, Trusted Surface, Credential Provider,
Merchant, and Merchant Payment Processor responsibilities, and human-present
and human-not-present flows. AP2 evidence must complement rather than replace
Asael's governed executor, approval, outcome, event, and reconciliation
authorities.

## Decision

Pin the first adapter to the official [AP2 v0.2.0
release](https://github.com/google-agentic-commerce/AP2/releases/tag/v0.2.0) at
immutable commit
[`b4587ac1d055888a73b4b21750973cffba961793`](https://github.com/google-agentic-commerce/AP2/commit/b4587ac1d055888a73b4b21750973cffba961793).
That tagged specification and commit, not mutable `main`, are the normative
source. An implementation manifest must name every consumed specification and
schema file at that commit, and each enabled adapter rollout must pin one exact,
reviewed adapter release and its artifact SHA-256 digest. This ADR enables no
adapter release or payment provider: the accepted release-and-digest set is
empty until a reviewed rollout records both exact values. Match mandate `vct`
values exactly, including their schema suffixes:

- closed Checkout Mandate: `mandate.checkout.1`;
- open Checkout Mandate: `mandate.checkout.open.1`;
- closed Payment Mandate: `mandate.payment.1`;
- open Payment Mandate: `mandate.payment.open.1`.

Unknown values, aliases, prefix matches, omitted suffixes, and future versions
fail closed until a separately reviewed adapter version supports them.

Asael and its delegated agents act only as the Shopping Agent. The Asael web UI
or native client acts as the Trusted Surface and must be deterministic and
non-agentic: no mandate display, consent capture, signing, or verification is
delegated to an LLM. Credential Providers, Merchants, and Merchant Payment
Processors remain external roles with separately authenticated endpoints and
explicit verification responsibilities. Combining roles requires an explicit
review and never collapses their checks.

The Trusted Surface requires a user-bound credential that satisfies a configured
non-exportability and hardware-backed assurance policy. On the web, a WebAuthn
credential is accepted for this signer profile only when registration evidence,
authenticator data, backup-eligibility state, and the reviewed attestation/trust
policy establish those properties; a backup-eligible or multi-device credential
does not satisfy the strict hardware-backed profile merely because it uses
WebAuthn. Native clients use an attested Secure Enclave-, StrongBox-, or
equivalent hardware-backed platform key. If the required assurance cannot be
established, payment enablement fails closed pending a separately reviewed
assurance profile.

After displaying the exact terms, the surface obtains an authenticator assertion
whose challenge binds the canonical mandate digest. An isolated, deterministic,
HSM-backed AP2 issuer may package and sign the protocol artifact only after it
verifies that assertion and the same digest; the Shopping Agent cannot invoke
the issuer without that proof. Verification trusts only a versioned,
operator-reviewed registry containing the user credential and issuer trust
anchors, key IDs, algorithms, validity, assurance evidence, backup state, and
revocation state. Rotation creates new key versions, revocation prevents new
signatures, and historical verification uses the key state and trusted time
applicable when the mandate was signed.

Begin with the human-present flow. The user reviews the exact closed Checkout
and Payment Mandates on the Trusted Surface and provides the user-bound
authorization required for their signatures before any payment credential is
requested or payment is submitted. Material changes to merchant, items,
quantity, price, currency, tax, shipping, payee, instrument constraints, expiry,
or transaction binding require fresh display, approval, and signatures.

## Canonical authority and compatibility

This ADR creates no current payment authority. After a separately reviewed
payment-domain implementation and persisted cutover, Asael's versioned intent,
approval, governed-execution record, payment ledger, typed events, and
reconciled external receipts are authoritative for what the system requested
and may report. AP2 mandates and receipts are cryptographic evidence subject to
deterministic verification; model output, browser state, and a remote success
string are never payment authority or proof of settlement.

The adapter preserves the exact protocol version, `vct`, participant roles,
key authority, checkout and payment bindings, nonce, expiry, signatures,
verification results, and provider references. It does not reinterpret legacy
approvals as mandates or infer a signed mandate from a free-form instruction.
Neither an account session nor possession of an actor ID substitutes for the
user-bound signing credential and its current trust-registry entry.

## Migration and cutover

Implement versioned mandate and receipt contracts, a deterministic parser and
verifier, and a non-agentic Trusted Surface before connecting a live payment
credential. Start with test credentials and allowlisted human-present
transactions. Prove that displayed terms, signed bytes, Checkout and Payment
bindings, credential scope, executor idempotency, provider acknowledgement,
receipts, and reconciliation match exactly. Conformance also covers signer
attestation, trust-anchor pinning, rotation, revocation, lost authenticators,
and historical receipt verification.

Enable one tenant and payment adapter generation at a time only after explicit
security review. Persist each accepted transition and typed event atomically or
through the transactional outbox. Human-not-present payments remain disabled
until the human-present flow, credential isolation, mandate and receipt
verification, reconciliation, revocation, kill switch, merchant and purpose
allowlists, transaction and period limits, and transaction-specific risk gates
are proven.

## Rollback

Disable new payment initiation for the affected tenant or adapter generation,
revoke scoped payment tokens, and retain mandates, receipts, ledger state, and
reconciliation evidence. Outstanding authorizations, captures, refunds,
disputes, and fulfillment continue through deterministic reconciliation rather
than model judgment. Rollback cannot erase payment history, expose credentials,
reuse a mandate, report an unverified terminal state, or enable autonomous
payment authority. Compromised signing credentials are revoked in the trust
registry and are never restored by application rollback.

## Permanent security floors

- Raw payment credentials and private signing keys never enter model prompts or
  output, agent or subagent context, memory, ordinary logs or events, MCP tools,
  browser pages, or general-purpose storage. Those surfaces receive only opaque
  references or narrowly scoped tokens.
- The Trusted Surface is deterministic and non-agentic. A Shopping Agent cannot
  sign as the user, approve its own material changes, or perform verification.
- User authorization keys must satisfy the registered non-exportability,
  hardware-backed assurance, attestation, and backup-state policy; WebAuthn by
  itself is not proof of those properties. AP2 issuer keys remain in an isolated
  HSM. Versioned public trust anchors, validity, rotation, and revocation are
  checked independently of the Shopping Agent and ordinary application session.
- Mandate, signature, receipt, checkout-binding, credential-scope, expiry,
  nonce, amount, merchant, currency, and reconciliation checks run in
  deterministic code outside the model and fail closed.
- Every external effect re-enters the governed executor with explicit tenant,
  actor, principal, target, approval, idempotency, and receipt bindings.
- Human-present authorization is proven first. Autonomous payments remain
  unavailable until every master-plan gate is independently satisfied.

## Consequences

AP2 provides inspectable evidence for user consent, checkout integrity, payment
authorization, and disputes without trusting an agent assertion. Asael must
maintain a dedicated Trusted Surface, isolated credential boundary, strict
protocol and mandate version adapters, durable receipt reconciliation, and
payment-specific incident and revocation procedures. Supporting a newer AP2
specification or mandate schema requires a new reviewed contract and rollout;
it is not an automatic compatibility upgrade.
