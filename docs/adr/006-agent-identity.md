# ADR 006: Separate agent definition from security principal

Status: Accepted · 2026-09-05

## Context

An agent's name, persona, voice, model preferences, and skills describe behavior, but they do not establish security authority. Storing those properties with ownership, grants, delegation, or tenant scope invites a persona edit to become an accidental privilege change and makes historical runs impossible to reproduce.

Human actor identity, active tenant membership, workspace membership, agent identity, and system authority are separate facts. None may be inferred from another.

## Decision

Represent agent identity with two independently versioned contracts:

- `AgentDefinition` contains the logical and display identity, persona, charter, operating style, voice, visual identity, allowed subject domains, escalation behavior, success measures, model policy, declared skills, and definition version.
- `AgentPrincipal` contains the security identity, owner, tenant and actor scope, delegation chain, context and capability grants, budgets, expiry, revocation state, and principal version.

An `AgentDefinition` is untrusted configuration at every execution boundary. Its declared skills, domains, or model policy describe intended behavior but confer no tool, data, approval, or delegation authority. Only the authenticated `AgentPrincipal` and current server-side policy determine authority.

Every run manifest pins the exact agent-definition, persona, model, skill, tool-contract, policy, and principal versions used to start it. Editing a mascot, name, voice, prompt, or definition never mutates the principal, grants, or an in-flight manifest.

## Canonical authority and compatibility

After the split-record cutover, the principal and its server-side grant records are authoritative for security decisions. The definition is authoritative only for the versioned behavioral configuration presented to the bounded agent loop. System policy and governed tool contracts override conflicting definition content.

Existing combined agent records remain authoritative until their bounded migration completes. Compatibility adapters expose their current API shape while mapping definition fields and principal fields to explicit versioned records. Missing or ambiguous authority is not inferred from the persona, owner label, tenant record, or historical tool use.

Private agent memory is scoped to its principal and purpose. Sharing memory creates a new, provenance-preserving artifact with an explicit recipient scope; it does not expose the originating private store.

## Migration and cutover

1. Publish the definition, principal, grant, and run-manifest schemas.
2. Add versioned records and a stable compatibility mapping for each existing agent.
3. Atomically dual-write legacy edits to the appropriate definition or principal record and emit typed events.
4. Backfill historical versions without inventing grants; quarantine ambiguous ownership or scope.
5. Shadow-resolve run manifests and require parity with existing allowed behavior.
6. Canary creation and edits by tenant, then persist the selected contract generation.
7. Move reads and execution to the split records while retaining the adapter through the rollback window.
8. Retire the combined writable record only in a later reviewed change.

Existing and in-flight runs remain pinned to their original manifest. A definition update affects only subsequently created manifests unless a governed migration explicitly creates a new run.

## Rollback

Rollback may restore the prior definition projection, editor, or compatibility adapter. It cannot merge principal authority back into persona fields, resurrect expired or revoked grants, widen a delegation, or rewrite an in-flight manifest.

If split-record resolution is uncertain, new execution stops closed while historical run evidence remains readable under its pinned versions.

## Permanent security floors

- Grants are default-deny and explicitly bound to tenant, actor or principal, purpose, targets, operations, budget, expiry, and revocation state.
- A delegated principal can only attenuate its parent's authority and budget; an agent cannot create, widen, renew, or approve its own grants.
- Active tenant membership does not imply workspace membership, private-memory access, or agent ownership.
- Persona text, retrieved content, memories, model output, and skill metadata remain untrusted input and cannot override system policy.
- All consequential actions pass through the governed tool executor with approval, idempotency, and verified-outcome controls.
- Credentials and private context are never embedded in a definition, prompt, event, or transferable memory artifact.

## Consequences

- Persona and visual identity can evolve without changing security authority.
- Historical runs become reproducible because behavioral and security inputs are version-pinned independently.
- Editors, APIs, stores, and tests must handle two lifecycles and explicit compatibility mappings instead of one convenient combined record.
