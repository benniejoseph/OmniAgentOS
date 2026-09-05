# Versioned Run Contracts (P0.2)

`src/lib/runs/contracts.ts` defines the version-1 metadata contracts for an
agent run. The module is a pure validation layer: it does not read or write a
run, emit an event, generate an ID, or hash private input. Runtime code supplies
opaque IDs and lowercase hexadecimal SHA-256 digests, and the builders return
strictly validated objects.

## Contract set

| Contract | Purpose |
|---|---|
| `AgentPrincipalV1` | Snapshots the executing authority, owner, scope, delegation chain, grants, and budgets independently from the agent's persona or presentation. |
| `IntentSpecV1` | Binds a request and requested-outcome digest to target, exclusion, constraint, ambiguity, risk, and interaction metadata. |
| `OutcomeContractV1` | Declares machine-checkable criteria, artifact requirements, live-effect requirements, and their verifier methods. |
| `ContextManifestV1` | Records one model turn's query digest, scope decision, selected/rejected references, reason codes, scores, freshness, conflicts, allocation counts, disclosure boundary, and compiler/model/policy versions. |
| `HarnessManifestV1` | Pins the engine, prompt contract, model route, initial context, tool/skill/policy contracts, budgets, grants, and contract digests used by the run. |
| `TerminalReceiptV1` | Records the evaluated terminal disposition and ID-only verification results. |
| `RunContractEnvelopeV1` | Binds the six contracts to one run and checks their cross-references. |

Every object has `schemaVersion: 1`, rejects unknown properties, bounds strings
and arrays, and requires every version-1 field. A known absence is represented
inside an envelope with `null`, `[]`, zero counts, or an explicit `unassessed`
enum. Optional version-1 properties are intentionally not part of the wire
contract.

## Privacy boundary

These contracts may contain only:

- opaque tenant, actor, run, turn, contract, grant, evidence, requirement,
  receipt, verifier, target, and version IDs;
- lowercase hexadecimal SHA-256 digests;
- bounded counts, basis-point scores, and enumerated states.

They must never contain raw prompts or responses, retrieved context, tool input
or output, connector metadata, persona or skill instructions, private
reasoning, credentials, or error text. Hash sensitive values before calling a
builder. Do not add a generic metadata bag or spread another runtime object
into a contract. Timestamps and event attribution remain on the scoped domain
event instead of being copied into the envelope.

Redaction cannot make arbitrary content safe enough for this layer. The safety
property comes from the schema's allowlisted structure; redaction remains a
defense in depth at the event boundary.

## Construction and compatibility

Use the versioned builders instead of assembling wire objects directly:

```ts
import {
  buildLegacyTerminalReceiptV1,
  buildRunContractEnvelopeV1,
  buildRunContractEventPayloadV1,
  parseRunContractEnvelopeV1,
} from "@/lib/runs/contracts";
```

The individual `buildAgentPrincipalV1`, `buildIntentSpecV1`,
`buildOutcomeContractV1`, `buildContextManifestV1`, `buildHarnessManifestV1`,
and `buildTerminalReceiptV1` functions inject the schema version. Builders for
outcomes, context manifests, harness manifests, and terminal receipts also
derive their required count fields so callers cannot supply divergent counts.
They do not generate IDs or digests.

An active new-run envelope has all six contract sections and
`terminalReceipt: null`. The shadow runtime builds and validates that full
object, then persists its compact event projection. Approval-paused runs keep
the active envelope only in their private continuation; when work stops, the
runtime rebuilds a terminal envelope with the receipt and emits a digest of
that exact object. `buildRunContractEnvelopeV1` verifies run and contract
bindings and caps the serialized envelope at 256,000 UTF-8 bytes.

If a scoped record owns a full envelope now or in a later cutover, only an
absent envelope property is legacy compatibility:

```ts
const envelope = parseRunContractEnvelopeV1(record.runContractEnvelope);
// undefined means the record predates P0.2. A malformed present value throws.
```

Do not create an empty version-1 envelope for a historical record and do not
infer unknown owners, grants, requirements, or verification. This keeps
absence distinguishable from a new contract whose explicit state is
`unassessed`.

## Terminal truth

`TerminalReceiptV1.disposition` is exactly:

```text
succeeded | partial | waiting_approval | blocked | unverified | failed | canceled
```

`succeeded` is accepted only for an `outcome_evaluator` receipt with a bound
outcome contract, `verified` state, at least one required result, all required
results verified, no unmet/approval/blocker references, and a strong verifier
method. Both the harness and receipt must declare `executionMode: live`. The
envelope additionally checks those result IDs and methods against the declared
outcome. A required live effect must have `effectMode: live`.

The following methods are metadata but are never sufficient for success:
`model_assertion`, `generated_summary`, `citation_id_match`, `none`, and
`unassessed`. A preview or dry run also cannot satisfy a required live effect.

`buildLegacyTerminalReceiptV1` preserves the original legacy state. In
particular, legacy `completed` always becomes:

```ts
{
  source: "legacy_adapter",
  legacyStatus: "completed",
  disposition: "unverified",
  executionMode: "unassessed",
  verificationState: "unassessed",
  reasonCode: "legacy_completed_without_verification",
}
```

It can never produce `succeeded`. The receipt disposition is not the broader
UI lifecycle vocabulary: for example, terminal `waiting_approval` projects to
canonical UI `waiting`, while active `running` and `preview` remain projection
states rather than terminal dispositions.

### Workflow shadow evaluation

P1.3 reuses `OutcomeContractV1` and `TerminalReceiptV1` for completed workflow
runs. The evaluator derives opaque requirement IDs from the persisted plan,
binds the contract and receipt with SHA-256 digests, and stores the validated
evaluation under the workflow result. During this initial display-only slice,
legacy `status` remains authoritative for execution behavior.

The derived workflow contract carries `outcomeContractBindingState: "posthoc"`.
Its source plan existed before execution, but the exact outcome-contract object
and digest were not pre-bound. That qualifier is preserved in the private
evaluation, compact event, and public outcome projection. A posthoc contract is
never eligible for `succeeded`.

Current workflow verification can include model assertions and generated
summaries, which are evidence metadata but are not strong verifier methods.
Consequently, the evaluator may report waiting, blocked, partial, failed, or
unverified, but it must not claim `succeeded` until later effect-receipt and
strong-verifier slices provide the required live evidence. A malformed stored
evaluation is ignored at the public boundary and falls back to the truthful
legacy canonical projection.

### P1.4 effect-receipt canary

The first P1.4 canary adds a separate `EffectReceiptV1` only for a live
`memory.write` executed as a single-tool plan node by an approved workflow with
explicit tenant and initiating-actor scope. The memory target is deterministic from the tenant,
tool execution, persisted execution-time plan and node, input digest, and
idempotency digest. The receipt binds those identities
plus the initiating actor, executing principal, and tool-contract digest. It
records a first-party store-commit acknowledgement and the result of a
tenant-scoped read-after-write comparison.

The executing intent persists hash-only input, plan, target, idempotency, and
tool-contract bindings before the side effect. Stale canary intents are not
collapsed into ordinary failures: a same-key retry reconciles the deterministic
target and can reclaim the execution only after timeout with the same tenant,
actor, input, plan, target, idempotency, and tool contract. An unfinished
cross-release contract mismatch stays pending rather than being relabeled or
replanned; an immutable receipt finalized under the earlier contract remains
historical authority.

The receipt and its event projection are strict metadata/hash-only contracts:
they contain opaque IDs, SHA-256 digests, and closed enums, never raw memory,
plan, tool input/output, or idempotency keys. Legacy executions, dry runs,
direct tool calls, system-triggered workflows without an initiating actor, and
every other tool retain their existing behavior and do not receive this receipt.

The P1.3 evaluator projects the ID only when this canary receipt is live,
verified, and strictly bound to the approved workflow plus its execution-time
plan, node, tenant, and tool execution. The current approval timestamp does not
cryptographically bind that exact plan digest. This additive evidence therefore
does not satisfy an outcome requirement:
the workflow contract remains `posthoc` and still cannot project `succeeded`.
External providers, additional tools, and pre-execution requirement binding
remain later P1.4 work.

### Generic provider effect receipt v2

`EffectReceiptV2` preserves v1 unchanged while defining the strict metadata
contract needed by later first-party and external-provider mutations. It binds
direct or workflow execution, tenant, actor, executing principal, complete
workflow plan identity when present, generic governed tool and target IDs,
tool/input/idempotency digests, and an exact approval-binding digest when
approval was required. Acknowledgement and read-after-write states use closed
enums; verified state is possible only when observed and expected target
digests match exactly.

The builder derives a deterministic receipt ID and body digest. Its compact
event projection omits the provider request ID and cannot contain tool input,
provider output, credentials, or an extensible metadata bag. The audit store
now accepts a v2 receipt only when it exactly finalizes the claimed record's
persisted v2 intent, preserves it immutably, and appends the compact receipt
event in the same database transaction. This is not yet a serving adapter or
permission: unregistered tools still receive no v2 receipt and no external
effect is authorized by constructing one.

Before a v2 effect can run, `EffectIntentV2` records the same immutable
execution, scope, plan, tool, approval, input, idempotency, target, and expected
state bindings without provider outcome fields. Its ID and body digest are
deterministic. Finalization accepts only provider acknowledgement and
read-after-write evidence, re-parses the persisted intent, and copies every
material binding into the receipt; a caller cannot replace a target, input,
approval, or plan during finalization. The tool audit store can now attach the
intent only to the matching live execution claim, preserve it immutably on the
private record, and append its scoped event in the same database transaction.
File mode documents its non-atomic event boundary and repairs by deterministic
event ID. Stale recovery will not replay an intent-bound effect. Executor and
provider-adapter activation remain separate gates. The compact event projection
carries only the exact allowlisted IDs, hashes, booleans, and enums needed to
audit that pre-effect binding; it contains no provider outcome or raw input.

## Event payloads

Keep a full envelope only on its intended private scoped record or active
continuation. For the event log, call
`buildRunContractEventPayloadV1({ envelope, envelopeSha256 })`. The helper
does not spread contracts; it emits a payload capped at 16,000 UTF-8 bytes with
only:

- envelope and component IDs/digests;
- context, tool, skill, policy, and requirement counts;
- terminal source, legacy state, disposition, verification, and reason enums.

Append that projection through the strict scoped event writer so tenant,
actor, correlation, and causation come from the trusted `ExecutionScope`.
Never emit a full envelope as an event payload and never use best-effort event
append for a new canonical mutation.

## Evolution rules

- Add a new schema version for any field or semantic change; do not loosen v1.
- Keep in-flight work pinned to the version that created it.
- Validate a present persisted envelope on read; do not silently coerce it.
- Preserve legacy fields during the expansion/shadow period and expose new
  contracts additively.
- A future outcome evaluator may add receipts, but no adapter may upgrade a
  legacy completion without verifying the declared requirements and effects.
