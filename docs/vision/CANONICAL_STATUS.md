# Canonical status projection (P0.4)

OmniAgent exposes a versioned, display-only status projection alongside the
existing domain status. Version 1 uses these meanings:

| Status | Meaning |
|---|---|
| `preview` | A plan, draft, or dry run exists, but live work has not completed. |
| `running` | Work is actively executing or resuming. |
| `waiting` | Work is queued, paused, under review, or waiting for approval/input. |
| `blocked` | A dependency, conflict, policy, or other external condition prevents progress. |
| `partial` | Useful progress exists, but the represented work is incomplete. |
| `unverified` | A result or completion claim exists without a verified terminal receipt, or the source state is unknown. |
| `failed` | Required work or verification failed. |
| `canceled` | An authorized rejection or stop ended the work. |
| `succeeded` | Every required outcome is explicitly verified by a valid outcome-evaluator terminal receipt. |

`src/lib/status/canonical.ts` is deliberately client-safe and pure. Its
projection records `schemaVersion`, canonical `status`, `domain`, translation
`basis`, `source`, the original `sourceStatus`, and `verificationState`.
Existing API fields such as `status` remain unchanged. Public agent-run and
mission adapters and approval-queue items add the projection as
`canonicalStatus`.

## Safety boundary

The projection is read-only compatibility data. Stores, state machines,
controls, pollers, retry logic, approval checks, and mutation inputs continue
to use their authoritative domain status. A canonical projection must never
authorize an action or manufacture a state transition.

All legacy adapters exclude `succeeded` at the type level. Legacy values such
as `completed`, `executed`, `succeeded`, `done`, `verified`, `applied`,
`provisioned`, and `ready` therefore project to `unverified`, not
`succeeded`. Unknown, missing, or newly introduced source values also fail
closed to `unverified`.

`canonicalStatusForTerminalReceipt` is the sole success path. It returns
`succeeded` only when all of the following are explicit:

1. `disposition` is `succeeded`;
2. `executionMode` is `live`;
3. `source` is `outcome_evaluator`; and
4. `verificationState` is `verified`.

Callers must validate the complete `TerminalReceiptV1` schema before exposing
that projection. A legacy-adapter receipt, a model assertion, a dry run, or a
missing/partial verification state cannot produce canonical success.

## Legacy translation table

| Domain | Source values | Canonical result |
|---|---|---|
| Agent run | `queued`, `waiting_approval` | `waiting` |
| Agent run | `running`, `resuming` | `running` |
| Agent run | `completed` | `unverified` |
| Tool execution | `dry_run` | `preview` |
| Tool execution | `executing` | `running` |
| Tool execution | `approval_required` | `waiting` |
| Tool execution | `executed` | `unverified` |
| Tool execution | `blocked` | `blocked` |
| Tool execution | `rejected` | `canceled` |
| Workflow run | `queued`, `waiting_approval`, `paused` | `waiting` |
| Workflow run | `running` | `running` |
| Workflow run | `completed` | `unverified` |
| Workflow step/node | `pending`, `waiting_approval` | `waiting` |
| Workflow step/node | `running` | `running` |
| Workflow step/node | `completed` | `unverified` |
| Workflow step/node | `skipped` | `unverified` |
| Workflow node | completed with `dry_run` policy | `preview` |
| Workflow plan | `planned` | `preview` |
| Mission | `draft` | `preview` |
| Mission/task/attempt | queued, pending, triage, review, or waiting states | `waiting` |
| Mission/task/attempt | `running` | `running` |
| Mission/task/attempt | legacy `succeeded` | `unverified` |
| Mission task | `blocked` | `blocked` |
| Project | `draft` | `preview` |
| Project | active and idle, paused, or waiting for approval | `waiting` |
| Project | `running` | `running` |
| Project | legacy completed or archived states | `unverified` |
| Project task | `open` or queued workflow | `waiting` |
| Project task | `doing`, dispatching, or running workflow | `running` |
| Project task | `done` or completed workflow | `unverified` |
| Project task | completed workflow with a non-done task | `partial` |
| Project artifact | `verified` | `unverified` |
| Agent profile | `ready`, `watching`, or `paused` | `waiting` |
| Agent profile | `learning` | `unverified` |
| Approval | pending/review/required states | `waiting` |
| Approval | `approved`, `applied`, or `provisioned` | `unverified` |
| Approval | `rejected` or `declined` | `canceled` |
| SLO policy change | `conflicted` | `blocked` |
| Access request | `provisioning_pending` | `running` |

For every domain, explicit `failed` and `canceled` states retain those
meanings. Any source value not listed by its adapter becomes `unverified`.

## Composite precedence

Project execution status takes precedence over project lifecycle status except
that an idle project falls back to its lifecycle (`draft` remains `preview`).
A linked workflow is the strongest current signal for a project task. If a
composite contains an unknown explicit child status, the adapter returns
`unverified` instead of guessing from the parent.

This is the shadow/expand stage. It intentionally does not reinterpret legacy
fields or change user-interface presentation; later rollout work can compare
the additive projection with existing surfaces before serving it.
