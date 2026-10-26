# Explicit recovery from a rejected workspace setup

An authenticated configured owner may request one new cycle after a narrowly
proved setup rejection. This does not reopen the failed cycle, delete its
reservation, resume the schedule, or automatically retry an uncertain effect.

`POST /api/self-improvement` accepts `action: "retry"` and an input containing
`configurationId`, `expectedGeneration`, `failedCycleId`, and `expectedRevision`.
The caller must be an administrator using a session or mobile authentication.
Agents and the scheduler cannot invoke this operation. A paused configuration
must be explicitly resumed first through the existing pause operation.

Admission requires the same owner, project, repository and immutable policy,
and an unchanged GitHub repository identity/default branch. The new cycle uses
the current exact repository revision; the original baseline remains recorded
on the failed cycle.

The parent must have failed in `setup/create`, have known zero AI spend, no
paid-phase rows, agent runs, Builder session, engineering signal, candidate or
release, and no controller claim. Its deterministic governed Builder-create
receipt must record the exact pre-effect `Project was not found.` rejection,
with matching owner, project, input hash, execution scope, cycle correlation
and causation. The project must still have no Builder session. A missing
session ID or a generic failure message alone is insufficient.

The existing owner/day lock serializes admission. A server-derived identity
permits only one child per immutable failed parent. The child's typed started
event preserves the parent revision, snapshot hash and tool-receipt hash;
children of retries cannot themselves use this exception. The response keeps
the ordinary `outcome`, `cycle` and `operationJob` fields, with `retryOf` holding
`cycleId`, `revision`, `cycleSha256`, `toolExecutionId` and `toolReceiptSha256`.

The original reservation remains immutable. This same-UTC-day recovery counts
only that precisely proved zero-cost parent as available admission capacity.
Both reservation rows are still inserted/retained, the database's $100 gross
reservation ceiling remains in force, and the unchanged paid-phase limit still
enforces the saved daily AI limit including carried-over work. Therefore a $10
trial can have one explicit setup retry without raising its $10 AI limit. A
$100 reservation does not gain another $100 admission through this narrow path.
Ordinary manual and scheduled admission retain their existing calculations.

The owner's state response exposes `setupRetryAvailable` only after the saved
evidence qualifies and no child already exists. The UI requires a fresh state
and explicit **Retry setup once** action. Repeat requests converge on the same
child; a changed request or uncertain paid work must be reconciled instead.

Focused PostgreSQL checks cover concurrent admission, unchanged parent/history,
retry-chain rejection, policy/day drift, existing resources, paid history and
uncertain errors. An optional captured-receipt replay checks the real failed
tool/scope/admission hashes and runtime, then remaps identities into isolated
fixture rows. It performs no production operation or provider call.
