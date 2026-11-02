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

Coding admits up to sixteen tool rounds for inspection, edits, checks and a
checkpoint within the existing direct-run token, cost, call and time limits.
An explicit lower run limit remains binding. Approved continuations retain
their saved limits; historical grants are not expanded. When the harness reserves
a final answer or exhausts a limit, the model receives the actual budget reason
and must distinguish completed work from actions that did not run.

Installed Next.js guides can be read by topic through the same bounded,
read-only Builder tool. It resolves the actual installed path, refuses ambiguous
matches and never exposes package docs as editable project files.

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

### Local projects on Mac

In the Mac Assistant, choose **Coding → Open folder** and select an existing
checkout. Asael uses the selected folder and its existing Git configuration;
the branch, configured remotes, changed files and file previews appear without
cloning, fetching, initializing Git or changing credentials. Linked worktrees,
subfolders, unborn branches and detached HEAD are supported. Remote URLs shown
in the inspector omit credentials. This detects a connection; it does not claim
that a remote sign-in, fetch or push has succeeded.

The folder is remembered with that conversation in owner-scoped local storage.
Choosing another folder for an existing conversation starts a new conversation
and preserves the unsent draft. Files & changes opens beside the conversation
above 1060 px, or as a dialog in narrower windows. Inspection is read-only and
bounded, runs away from the UI thread and disables Git hooks, filesystem monitors,
external diffs and configured content filters. A moved or revoked folder must be
selected again. A non-Git folder is still available to the local command runner.

Contract v64 adds the optional `localWorkspaceId` to Mac turns, queue targets
and continuous-voice context. The server verifies that it belongs to the exact
actor/device session and advertises only that folder to the agent. An immutable
session event keeps later commands, queue dispatch and approval resumes attached
to the selection; selecting a different folder cannot retarget accepted work.
Commands continue through the existing governed tool executor and signed command
helper. Selecting a location does not grant a new execution policy. Mobile and
web retain their cloud project workspaces; they do not acquire Mac filesystem
access through a synced conversation.

Assistant keeps the conversation and composer visible. History, settings, files
and detailed activity open on demand. On a wide Mac window, Conversations opens
as an optional sidebar; narrower windows use a sheet. Search filters the loaded
recent conversation titles, without starting an agent or fetching unrelated
history. New conversation and Files & changes stay directly accessible.

Working notes open automatically while a response is being prepared, then
collapse when it finishes unless the user has chosen otherwise. They display
public status notes, tool outcomes and specialist updates beside the response.
Approval waits and proposed specialist results remain distinct from execution
and accepted results. The actual run lifecycle owns the headline; source-quality
advisories remain separately accessible. This view does not expose private model
reasoning or turn raw tool payloads into a reasoning transcript. Poppins is
bundled locally on every client, with Regular body text and Medium controls.

For this behavior, retain the native Git fixture, focused folder/queue/voice
tests, the real PostgreSQL folder-binding scenario and responsive interaction
checks. Use the read-only command-catalog staged probe to verify the deployed
client contract and context selection, then verify folder detection and one
bounded local task on the installed Mac. Retain the earlier three-mode cloud
workflow evidence when those execution paths have not changed.
Keep physical Android and remote Git authentication claims separate from these
checks. No database migration is needed for v64.

### Project repositories

In Coding, select the project and open **Files & changes**. A new project can
choose **Connect a GitHub repository**, which creates a source workspace and
opens repository selection. **Manage access on GitHub** opens the private App's
selected-repository flow; return and refresh to see newly granted access. Choose
a repository, **Connect to this project**, then **Open repository files**. The
import names the exact revision and saves a recovery checkpoint first.

Each actor/project has its own durable workspace and repository binding. Opening
another project does not move that connection. An explicit choice that disappears
after refresh stays unavailable, rather than selecting the next repository.
The single configured GitHub installation belongs to the owner's Asael workspace;
additional Asael logins need their own connection. GitLab, Bitbucket and arbitrary
SSH remotes are not supported by this GitHub flow.

Source workspaces can import non-Node repositories for inspection and editing.
A root `package.json` retains the existing dependency installation with lifecycle
scripts disabled. Without one, import records the source baseline and skips Node
installation. Neither case launches an application preview in source mode. The
available checks still require the repository's toolchain; opening Flutter or
Python source is not evidence that a Flutter or Python build ran. The existing
interactive workspace remains available for the supported web-app preview.

For repository changes, retain focused broker/grant, actor/project binding,
source import and native selection checks. Exercise live repository discovery in
staging and read it again after promotion; no repeated paid Assistant task is
needed for this connection flow.
Use `OMNIAGENT_RELEASE_FEATURE_PROBE=project_repositories_v1`, a new
`SMOKE_PROJECT_REPOSITORIES_EVIDENCE_FILE`, and
`SMOKE_PROJECT_REPOSITORIES_PROJECT_IDS` containing one or two existing owned
project IDs as JSON. The probe signs in, reads each project's repository list,
checks the published contract and read-only receipt, and signs out. It does not
start a sandbox, run an agent, or change GitHub access.

### Assistant mode workflow

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
