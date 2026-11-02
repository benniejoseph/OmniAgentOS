# Assistant: Chat, Cowork, and Coding

The web and Flutter Assistant share one conversation model, Atlas, the governed
tool executor, and existing specialist workflows. The mode describes the work;
it does not select an external coding product or grant additional authority.

| Mode | Behavior | Workspace |
| --- | --- | --- |
| Chat | Read sources, answer questions, compare options, and propose plans. Effectful tools, automatic workflow routing, and Council execution are withheld. | Conversation and sources |
| Cowork | Produce documents, research, and authorized connected-app outcomes, delegating where useful. | Conversation, public progress, and results |
| Coding | Inspect an authorized project, make focused source changes, and report actual checks and changes. | Conversation and the existing project Builder's files, checks, checkpoints, and preview |

The mode selector preserves the draft and applies to the next submission. An
accepted or queued run retains its exact mode, authority, and project. Historical
`orchestrate`, `research`, `execute`, and `learn` records remain readable; opening
an old Knowledge conversation starts its next turn in Chat. Detailed Research
remains available within Cowork.

A conversation's project is fixed when its first turn is accepted. Opening
history restores that binding, including clearing a prior project's context for
an unbound conversation. Choose another project in a new conversation. The
server verifies membership and actor ownership again; a client selector is not
an authorization boundary.

The coding workspace opens from **Files & changes**. On mobile it fills the
screen; on wider clients it opens over the preserved conversation. The native
workspace flushes its encrypted local file draft before closing and stays open
if storage fails. Web closing asks before discarding an unsaved source edit.
An unprovisioned, disconnected, or unavailable workspace reports that state.
Cloud work does not imply access to local Mac files or browser sessions.

Voice, queue submission, recovery, and portable history use the same mode
vocabulary. Native contract v63 adds the three values. Older supported native
versions receive historical aliases for display-only harness events; reading a
queue containing a new mode requires an update instead of rewriting its immutable
execution pin. Existing approval holds, device authority, idempotency, and
consent-based memory remain independent of the mode.

## Focused release verification

Migration 267 changes only the queue's mode CHECK constraint, retaining its
ownership, RLS, and immutable payload protections. Apply it under the existing
backup and quiescence procedure before the paired web/worker rollout. Install
the native v63 clients after the compatible service is live.

Select `OMNIAGENT_RELEASE_FEATURE_PROBE=assistant_workspace_v1` and a fresh
`SMOKE_ASSISTANT_WORKSPACE_EVIDENCE_FILE` in the paired runner. Its staged
scenario makes exactly three user turns in one fictional project: a source-backed
Chat answer, one saved Cowork brief, and one Coding heading edit with an actual
typecheck and checkpoint. The script verifies governed receipts, file hashes,
the saved document, and shared history, then stops its temporary sandbox.
Each turn has explicit token, tool, cost, and time bounds; the exercise has no
automatic retries. Canonical verification reads the same results without new
agent work. A failed or existing evidence file cannot be reused for another
exercise. This scenario does not certify arbitrary repositories or local-device
execution.

Retain focused server/queue/database tests and responsive web/native interaction
checks. Simulated Fold sizes establish layout behavior, not physical hinge,
keyboard, microphone, push-notification, or accessibility certification. Record
the actual installed client versions and live revision separately from builds.
