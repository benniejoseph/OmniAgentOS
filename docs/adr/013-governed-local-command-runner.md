# ADR 013: Governed local command runner for the owner Mac

Status: Accepted · 2026-09-24

## Context

ADR 012 deliberately keeps Asael's visual Computer Use helper free of shell and
general filesystem authority. That boundary remains correct: Accessibility,
ScreenCaptureKit, pointer input, and keyboard input should not silently become a
terminal. Asael nevertheless needs to run development and productivity commands
on the Mac where its private desktop application is installed.

A raw shell string would be too broad for the Agent tool surface. It obscures the
program and arguments being approved, permits shell expansion and redirection,
inherits ambient configuration, and is difficult to bind to one local workspace.
Driving Terminal, iTerm, or another terminal application through Accessibility
would have the same problems while also making the effect dependent on visual
state.

## Decision

Add a second, separately signed, credential-free local helper dedicated to
governed commands. It does not weaken or replace `AsaelComputerUseHelper.app`.
The product continues to expose one explicit execution target, **This Mac**,
while routing visual actions and local commands to different native helpers.

The Agent-visible operation is `local.macos.command.run`. It always enters the
governed tool executor as a risk-two action and always pauses for one exact human
approval. Its input is structured:

- an owner-selected workspace grant ID;
- one executable, never a shell command string;
- a bounded argument array;
- a relative working directory inside the selected workspace; and
- a bounded timeout.

The native host resolves the opaque workspace grant locally. Server and model see
only its ID and display name, never the security-scoped bookmark or absolute root.
The command helper canonicalizes both workspace and working directory, rejects
escape through `..` or symlinks, resolves programs only through its closed direct-
execution policy, and refuses privilege escalation, shell interpreters,
AppleScript, LaunchServices, Keychain/security administration, and system-control
programs. It receives no Asael bearer, connector credential, App Group authority,
or inherited application environment.

The existing actor/device/session/run/execution courier remains authoritative.
Every command is bound to the exact sealed tool input, approval decision, native
contract, device lease, workspace inventory, claim token, and idempotency identity.
An uncertain or expired command is never replayed. **Stop Asael Computer Use**
terminates active local helpers and makes outstanding work ineligible.

Standard output and standard error are bounded, sanitized, and treated as
untrusted one-turn evidence. They may be held briefly in native memory for the
Conversation artifact rail and passed once to the assigned model. Durable stores
retain only exit state, byte counts, truncation flags, hashes, timing, and the
ordinary governed execution receipt. Raw command output is removed when consumed
and is not restored after relaunch.

Native contract v27 introduces the command-runner capability while retaining v26
as the rollback contract. A v26 client can continue visual Computer Use but cannot
claim a v27 command.

## Workspace grants

The owner chooses command workspaces from the macOS application. The host stores
the corresponding security-scoped bookmarks locally and publishes only a bounded
ID/name inventory with its short readiness lease. Removing a workspace revokes it
for new commands immediately. The server rechecks that the exact ID is advertised
by the exact active device in the same transaction that enqueues a command.

Workspace selection grants location, not action. It does not bypass approval,
tool policy, execution budgets, or program restrictions.

## Consequences

- Natural-language work can invoke local development commands without teaching
  the user tool names or opening a terminal application.
- Visual Computer Use retains its closed no-shell contract and smaller blast
  radius.
- Complex pipelines must be expressed as multiple reviewed direct commands or a
  separately designed deterministic workflow; shell composition is not accepted.
- Commands that need ambient credentials or interactive input fail explicitly.
- The private owner-Mac package must compile, embed, separately sign, and verify
  both local helpers before signing the host.

## Rollback

Disable discovery of `local.macos.command.run`, stop advertising command-runner
readiness, and roll the native client back to supported contract v26. Existing
metadata-only execution history remains auditable. Workspace bookmarks stay local
and may be removed by the owner; no server-side path or bookmark must be recovered.

