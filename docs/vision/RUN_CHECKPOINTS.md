# RunCheckpoint v1

**Status:** P1.6 approval-boundary shadow chain and canary-ready resume fence

**Runtime effect:** Approval shadow writes are active; fenced resume requires a separate canary rollout

`RunCheckpointV1` defines the immutable metadata and reference boundary that a
future durable run must record before work can be resumed safely. Migration
v68 creates forced-RLS, append-only checkpoint and state-reference tables. A
transaction-only writer verifies the exact scope, locks and validates the
parent, stores the immutable record and reference index, and appends a
metadata-only `run.checkpoint.recorded` event in the same caller-owned
transaction. The approval shadow call sites use that writer, but nothing loads
referenced state, claims a resume, or grants resume authority. The legacy
continuation remains authoritative.

New agent runs capture an exact active `agent_run_checkpoints` shadow rollout
pin after their resolved run contract is built. If such a run pauses on its
first governed tool approval, the canonical continuation transaction also
records a metadata-only waiting checkpoint. The writer re-verifies the stored
run, governed tool request, immutable tool-scope binding, contract hashes, and
observable resource counters. File-mode, preclaimed, unenrolled, mismatched,
and already-checkpointed runs keep legacy behavior. A run with an earlier
external effect is not admitted at this late genesis boundary; broader model
and tool boundary coverage must establish its checkpoint chain earlier.

When that approval is accepted or rejected, the same governed approval
transaction records the exact decision successor. An approved successor is
persisted before the claimed tool can execute; a rejected successor is
terminal. Both preserve the parent's effect counter because approval itself
cannot claim an external effect. Each waiting and decision record also emits a
strict `run.checkpoint.shadow_compared` receipt after its chain, references,
scope, tool state, decision event, and counters have been validated. These
receipts describe the shadow write only and always declare
`resumeAuthorityGranted: false`.

The bounded `scripts/check-run-checkpoint-shadows.ts` operator check rereads a
tenant's stored checkpoint rows, exact reference indexes, recorded/comparison
events, decision successor, governed tool state, and any effect receipt. It
returns closed mismatch codes without loading continuation contents. An empty
sample is `no_sample`, not a successful comparison, and the command exits
nonzero for both empty and mismatched samples.

Migration v69 adds the checkpoint resume-claim store. One active claim
per tenant/run is bound by an exact checkpoint ID and digest foreign key,
operation job, hashed token and owner, monotonic lease generation, and expiry.
Only an expired generation can be reclaimed; heartbeat and completion require
the exact unexpired generation and token. Claim acquisition revalidates the
latest resumable checkpoint, its full execution scope, the exact active live
rollout pin, waiting run, approved terminal risk-0 tool, decision reference,
and absence of an external effect in one caller-owned transaction. Raw lease
credentials never enter storage or events. Claim events remain metadata-only
and explicitly set `resumeAuthorityGranted: false`.

The resume queue calls this store only for a separately pinned, active canary
generation whose dedicated configuration limits execution to risk-0,
read-only, no-effect work. Shadow pins remain legacy-authoritative. The binder
co-commits the fence and change from `waiting_approval` (or an exactly fenced
interrupted `resuming` run) to `resuming`. It stores only
checkpoint/job/generation metadata in the continuation and emits
`run.checkpoint.resume_authorized`; the raw token remains process-local. The
same token and generation fence every worker heartbeat and terminal/next-wait
run write, so a stale worker cannot commit canonical completion.

## Why this precedes resume

The current agent approval continuation is useful compatibility state, but it
contains provider-shaped conversation data and is interpreted by current
runtime code. Interrupted claimed resumes deliberately fail rather than risk
repeating an external effect. Generic recovery cannot become authoritative
until the system can prove which exact engine and contract created the state,
which boundary was crossed, which durable references it owns, and which tool
intent or effect receipt already exists.

A checkpoint is therefore evidence about resumable state, not the state bytes
themselves and not permission to execute.

## Contract boundary

One checkpoint binds:

- the exact tenant, initiating actor, executing principal, run, correlation,
  causation, purpose, target scope, and context/capability grant sets;
- one boundary kind and phase (`before`, `waiting`, or `after`) for model,
  tool, approval, delegation, or verifier work, with invalid combinations
  rejected;
- a positive sequence and the exact preceding checkpoint ID and digest, with
  the first checkpoint explicitly declaring no parent;
- non-null engine, checkpoint-contract, configuration, rollout mode,
  generation, active lifecycle status and revision, harness, and run-envelope
  pins;
- canonical references to sealed or separately scoped state, never embedded
  prompts, messages, provider continuation data, tool input/output, evidence,
  credentials, or private reasoning;
- the five existing run-budget consumption dimensions;
- closed lifecycle and continuation-disposition states; and
- for tool mutations, the exact tool execution, persisted intent,
  idempotency digest, and effect receipt required by the boundary.

The checkpoint ID and digest are domain-separated hashes of the complete
allowlisted body. Outputs are deeply frozen. Public parsing rejects unknown,
non-plain, accessor-backed, sparse, oversized, non-canonical, or digest-mismatched
input before it can be treated as resumable state.

## Side-effect rule

Read-only and no-effect boundaries cannot carry mutation intent, idempotency,
or effect-receipt references. A mutation checkpoint immediately before a tool
effect must prove that the governed execution intent and idempotency identity
were already persisted. A mutation checkpoint after the tool boundary must
also bind the effect receipt. A checkpoint never treats a model assertion,
tool result string, or missing receipt as proof that an effect happened.

These bindings enable later reconciliation. They do not themselves execute,
retry, compensate, or verify an effect.

## Compatibility decision

Resume compatibility is a pure decision made before state references are
opened. It requires the supported checkpoint schema, exact engine, contract,
configuration, rollout generation and lifecycle pins, an `active` rollout,
and an activation-eligible `canary` or `enabled` mode. Shadow, registered,
paused, superseded, or mismatched pins produce a closed safe-pause decision;
the worker never falls back to its current engine or interprets newer state
with an older contract.

Compatibility is not authorization. A later resume worker must independently
revalidate the live rollout, execution scope, grants, approval, tool/effect
state, lease, and cancellation state inside the same transaction used to claim
the continuation.

## Remaining P1.6 activation gates

The remaining slices must proceed in this order:

1. accumulate a non-empty production approval-boundary sample and pass the
   stored chain/reference/resource reconciliation operator check before
   registering or activating the canary generation;
2. activate the implemented risk-0, read-only, no-effect canary and prove an
   interrupted resume without a duplicate effect; and
3. expand separately to model, tool, delegation, and verifier boundaries.

P1.6 remains open until all required boundaries checkpoint durably and an
interrupted run resumes without duplicate side effects. Replay, fork, and user
correction are P1.7 concerns and are intentionally absent from v1.
