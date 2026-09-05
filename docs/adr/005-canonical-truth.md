# ADR 005: Canonical truth and projection authority

Status: Accepted · 2026-09-05

## Context

Asael currently persists useful domain state in several bespoke stores. `omni_events` records only part of that state and is not yet a complete source of truth. Declaring the event log or a new projection authoritative before writes, replay, lineage, and compatibility are proven would create split-brain state and make false-success or deletion-resurrection failures possible.

The target evidence chain is: source revision, user assertion, or verified action → evidence → versioned claim → projection → context → governed action → verified receipt. Each link has different authority. Model prose, retrieval traces, provider UI state, and graph co-occurrence cannot substitute for evidence or a verified effect.

## Decision

Canonical truth is defined per bounded domain, not by one database table:

- Captured facts retain an immutable source revision and exact evidence coordinate. Corrections and deletions create lineage-preserving revisions or tombstones rather than rewriting history.
- Claims are versioned assertions whose provenance, validity, verification state, and supersession are explicit.
- Domain mutations and their typed event/outbox records commit atomically. A privacy- or security-relevant mutation must not use a best-effort event write.
- Events contain tenant, actor or principal, scope, contract version, correlation, causation, idempotency coordinates, hashes, counts, and the minimum metadata needed to replay the mutation. They do not duplicate private content, credentials, arbitrary provider payloads, or private chain-of-thought.
- Projections are deterministic, disposable read models. They may serve canonical reads only after full replay parity is proven and a persisted cutover selects that projection generation.
- Receipts prove the attempted effect and observed outcome; they are not, by themselves, authority for unrelated domain state.

Generated prose and model output are untrusted proposals or artifacts, never evidence for their own truth. External provider identifiers, including Salesforce identifiers, remain references to external systems and do not make those systems Asael's internal source of truth.

## Canonical authority and compatibility

Until a bounded domain completes cutover, its existing bespoke store remains authoritative and existing APIs continue to read it. An event, shadow table, backfill, or projection does not silently supersede that authority.

After cutover, the atomically committed canonical record and typed event history are the replay authority, while the selected projection generation is the served read authority. Compatibility adapters preserve existing identifiers and response contracts without creating a second writable truth. Ambiguous legacy records are excluded from ordinary reads, projections, retrieval, and model context. They are available only through an explicitly authorized repair path whose tenant boundary and initiating actor are established independently; a record whose tenant cannot be established remains accessible only to a named, purpose-bound system repair principal under an operator-controlled procedure. Repair never guesses tenant, actor, scope, or lineage.

In-flight runs remain pinned to the contract and projection generation with which they started. Older workers must fail closed rather than interpret a newer checkpoint or event shape.

## Migration and cutover

Each domain follows the same bounded sequence:

1. Publish versioned contracts and invariants.
2. Add canonical storage, typed event/outbox support, and compatibility adapters without changing reads.
3. Atomically dual-write the existing authority and candidate authority.
4. Backfill resumably; record provenance and quarantine ambiguous records.
5. Replay from zero and require complete parity for records, corrections, deletions, and tombstones.
6. Canary new work for selected tenants while existing work stays version-pinned.
7. Persist the selected authority and projection generation before changing reads.
8. Observe through a defined rollback window.
9. Retire legacy writes and storage only in a later, separately reviewed change.

A cutover stops on a scope leak, unapproved effect, duplicate effect, false success, deletion resurrection, or corrupt projection.

## Rollback

Rollback changes the persisted reader/projection generation to the last proven authority. Candidate writes may be disabled only when the prior authority has remained atomically current; otherwise affected writes stop rather than split truth.

Rollback never erases committed events, receipts, corrections, tombstones, or audit history. Replay and repair remain resumable, and in-flight work continues under its pinned contract unless explicitly and safely terminated.

## Permanent security floors

- Tenant, human actor, agent principal, workspace, and execution scope stay explicit on every canonical write, event, projection, and receipt.
- Authorization, RLS, governed tool execution, approval, idempotency, and verified-outcome requirements cannot be bypassed by an adapter or projection.
- Revocation, isolation, deletion tombstones, and redaction lineage survive migration and rollback.
- Retrieved content, provider metadata, model output, and tool output remain untrusted data.
- Secrets, credentials, raw private content, and private chain-of-thought never enter general event metadata, logs, or projections.

## Consequences

- Asael gains deterministic replay, traceable lineage, and one explicit authority per domain after cutover.
- Migrations require temporary dual operation, parity evidence, compatibility adapters, and storage overhead.
- A projection can be rebuilt or rolled back without rewriting history, but an incomplete event stream cannot be promoted merely because its UI appears correct.
