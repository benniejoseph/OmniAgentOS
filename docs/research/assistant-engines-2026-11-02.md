# Assistant engines: product and integration research

Researched 2 November 2026. This is a research record and implementation proposal,
not a claim that the integrations are installed in Asael.

Owner clarification, 2 November 2026: build Asael's own Assistant interface for
Chat, Cowork, and Coding on Mac, mobile, and web. Codex, Claude Code/Cowork, and
Cursor are product references. Installing or delegating execution to those
applications is not the requested direction. Asael's agents, models, tools, and
execution system perform the work.

The provider-interface research below is retained as background. Its proposed
external-engine integration is superseded by the owner's clarification; it is
not an implementation requirement.

## Findings from official documentation

| Product | Local work | Cloud work | Supported integration relevant to Asael |
| --- | --- | --- | --- |
| Codex | A session works in a project directory or a separate Git worktree. A worktree is still local execution. | Cloud tasks use published environments and their own working files. Local browser sessions, processes, and private connectivity do not transfer automatically. | App Server exposes persistent threads, turns, streamed items, approvals, interruption, and authentication. |
| Claude Code | Its agent loop reads files, uses tools, edits code, and runs verification through the CLI or Agent SDK. | Claude Code also offers repository-based cloud sessions. Separately, Managed Agents provides a hosted programmable harness. These are distinct integration surfaces. | The Agent SDK is the documented way to embed the Claude Code agent, with sessions, permissions, hooks, and structured events. |
| Claude Cowork | Existing desktop tasks can use local execution. Connected desktop folders and tools provide device access. | Current documentation describes new Cowork sessions as cloud-first, with an isolated sandbox and an online desktop bridge for permitted local access. | The reviewed Cowork pages describe the user product, not a public API for embedding that entire product. Asael should provide its own Work experience using supported agent/tool interfaces. |
| Cursor | Agent searches, edits, and runs commands; Ask is read-only. Review and checkpoints expose changes. | Cloud Agents use isolated development VMs, including repository/environment setup and background execution. | ACP supports custom local clients over JSON-RPC. Cloud Agents API v1 provides durable agents, per-prompt runs, and resumable event streams; it is in public beta. |

Sources: [Codex environments](https://learn.chatgpt.com/docs/environments/modes),
[Codex App Server](https://learn.chatgpt.com/docs/app-server),
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview),
[Claude Code cloud](https://support.claude.com/en/articles/12618689-use-claude-code-in-the-cloud),
[Cowork architecture](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview),
[Cursor Agent](https://prod.cursor.com/help/ai-features/agent),
[Cursor Cloud Agents](https://cursor.com/docs/cloud-agent),
[Cursor ACP](https://cursor.com/docs/cli/acp), and
[Cursor Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints).

## What the products have in common

The useful abstraction is a persistent work session: messages, an execution
environment, tools, observable progress, permission decisions, and reviewable
outputs. Chat is one interface to that session. Model selection alone does not
provide an agent runtime, file isolation, resumability, or completed work.

Three independent questions must remain visible:

1. **What kind of work?** Conversation, software development, or a practical deliverable.
2. **Which engine?** Codex, Claude Code, or Cursor.
3. **Where will its tools run?** This Mac or a named cloud environment.

Local execution does not mean offline inference. A cloud task also cannot use a
Mac folder or signed-in browser merely because the user selected the same project.

## Provider interfaces studied (not the selected implementation)

### Codex

Use the stable App Server client protocol, not terminal-window automation. Keep
Asael's session identity separate from the provider's thread and turn identities.
Handle initialization, notifications, approval requests, errors, and interruption
explicitly. The documentation identifies App Server as a surface for custom rich
clients; there is no need to recreate Codex's inner tool loop.

Reference: [App Server](https://learn.chatgpt.com/docs/app-server).

### Claude Code and Work

Use the Agent SDK for embedded sessions and approval callbacks. A CLI print call
is useful for bounded automation, but is insufficient by itself for an interactive
workspace with questions and decisions. Keep public progress and tool outcomes;
do not surface private reasoning blocks.

Anthropic's SDK documentation requires third-party products to use its documented
API-key authentication unless previously approved to offer claude.ai login or
subscription limits. An installed Claude subscription must not be represented as
automatic authorization or billing for Asael's embedded SDK.

References: [SDK overview and authentication](https://code.claude.com/docs/en/agent-sdk/overview),
[approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input),
and [programmatic CLI use](https://code.claude.com/docs/en/headless).

### Cursor

Use ACP for a supported local CLI version. It provides session creation/loading,
streamed updates, cancellation, permission requests, and read-only modes. Reply to
blocking permission and question requests; an unhandled callback must become a
visible recoverable state rather than an indefinite spinner.

Use the published Cloud Agents API for provider-hosted Cursor work. Preserve the
agent/run distinction and event cursor, and reconcile terminal state when a stream
expires. Pin the supported API version and advertise only verified capabilities.

References: [ACP](https://cursor.com/docs/cli/acp) and
[Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints).

## What was verified on this Mac

These are compatibility observations, not end-to-end execution results:

- The Homebrew/npm `codex` entry currently fails because its platform executable
  is missing. No package or global configuration was changed during this research.
- The Codex binary bundled with ChatGPT reports `0.166.0-alpha.5.1`.
  A separate process accepted `initialize` and `account/read` through App Server.
  An account configuration was present. This does not prove a billable model
  request would succeed. The probe started no thread, turn, or AI task.
- Claude Code `2.1.282` starts and advertises programmatic output, session,
  permission, and cloud options. No Claude task or authentication flow was started.
- Cursor's installed CLI reports `2026.01.28-fd13201`. Its help advertises
  structured output and resume, but does not advertise ACP. That build cannot be
  assumed compatible with today's ACP documentation; verify or upgrade before
  enabling the adapter.

Production setup should discover a supported, installed engine and verify its
protocol. The successful bundled-binary probe is evidence of feasibility, not a
reason to hardcode a private application-bundle path as the only installation path.

## Asael's current gaps

- Web Assistant is composed in `src/components/agent-runs-workspace.tsx`, currently
  7,163 lines. Native talk models, controller, and UI share
  `apps/flutter/lib/features/talk/talk.dart`, currently 10,511 lines.
  New engine state should live in focused modules, not additional conditionals in
  those files.
- The existing selection of Asael / This Mac / This phone controls computer-use
  access. It is not an external-agent engine selector or a cloud-runtime selector.
- `src/lib/local-computer/contracts.ts` caps command execution at 300 seconds
  and persisted terminal output at a bounded size. Its action set has no external
  agent session lifecycle.
- `src/lib/local-computer/command-program-policy.json` does not list Codex,
  Claude, or Cursor. Adding their executable names alone would not provide
  structured sessions, callbacks, cancellation, or recovery.
- The existing local command workspace constrains the working directory; the
  architecture explicitly says it is not a filesystem sandbox. The new experience
  must not relabel that existing guarantee as isolation.
- Asael already has useful project scope, authenticated clients, typed events,
  durable queues, approval decisions, artifacts, voice context, and Mac helpers.
  Reuse those boundaries rather than introducing a parallel product-wide task system.

## Corrected recommendation

Build one Asael Assistant with Chat, Cowork, and Coding experiences across all
three clients. Reuse Atlas, Asael specialists, the governed executor, durable
workflows, project context, coding workspaces, and artifact delivery. Keep the
user's task mode separate from the location where tools execute. The products
above inform interaction design and recovery behavior; their applications are
not dependencies.

The corrected product and delivery contract is in
[the Assistant workspace brief](../../.design/assistant-workspace/BRIEF.md).
