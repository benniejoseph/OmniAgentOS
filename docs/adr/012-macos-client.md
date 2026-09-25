# ADR 012: Shared Flutter macOS client with a thin native host

Status: Accepted · 2026-09-16

## Context

Asael already has a Flutter client that consumes the versioned, server-authoritative
native API from ADR 011. It contains the product navigation, Daybook visual system,
secure session storage, encrypted Capture outbox, realtime Conversation transport,
and most daily workspaces. The generated macOS runner exists, but it has no macOS
authentication contract, usable sandbox policy, desktop lifecycle, menu-bar entry,
or native capture bridge.

A separate Swift product would duplicate presentation and transport work and would
make domain, authorization, and release behavior more likely to diverge. A webview
wrapper would inherit browser-session assumptions and would not provide the scoped
file, microphone, notification, menu-bar, offline, and Keychain integrations required
by Phase 13.

## Decision

Build Asael for macOS from the existing Flutter application. Flutter owns shared
product presentation, navigation, API transport, version negotiation, actor/tenant
state, bounded local caching, and the Daybook design system. A deliberately thin
Swift host owns only capabilities that require AppKit or operating-system lifecycle
integration:

- application and window lifecycle;
- the menu-bar surface and system commands;
- a registered global Quick Entry shortcut plus explicit menu-bar Capture;
- notification actions and deep-link delivery;
- Share Extension and App Group transfer when that slice is introduced;
- scoped file and microphone permission integration;
- update, signing, and notarization plumbing; and
- a separately signed, credential-free local Computer Use helper for the
  explicitly selected **This Mac** target; and
- a different separately signed, credential-free command helper for exact,
  approval-gated direct-executable work inside an owner-selected workspace.

The ordinary desktop Swift-to-Flutter channel carries a small allowlisted intent
contract, such as opening Today, Command, Capture, or Inbox. The local execution
channel carries only status, permission, stop, workspace-grant inventory, and one
exact expiring visual-action or structured command envelope between Flutter and the
appropriate helper. Flutter retains the authenticated native bearer and uses the
same server-authoritative services as every other client; neither helper receives a
bearer, connector content, domain object, or credential.

The macOS client first enrolled on native contract v8 and advances through ADR 011's
current/previous discovery window. The platform identifier is `macos`. Production
now advertises native contract v29 as current and retains frozen v28 as the only
supported previous version. V11 introduced the device readiness, claim, completion,
and stop courier; v12 added exact run/execution screenshot presentation; v13 added
governed Chrome URL delivery and snapshot-bound `screenshot_pixel` coordinates;
v27 added the governed command-runner capability and workspace inventory; and v28
added the read-only scope-correct Command model catalog, strict explicit-selection
envelope, and content-free effective-model receipt. V29 adds the authenticated
Ambient Voice realtime session and versioned speech stream. A v28 client keeps
visual Computer Use, governed commands, and explicit selection but cannot claim the
v29 voice capabilities.
The ordinary file-based macOS Keychain protects native session credentials under a
stable Asael service namespace without a shared access group. Every Keychain
operation is bounded so an operating-system authorization stall cannot hold the
application bootstrap indefinitely. An owner-only signing update may require a
one-time macOS reauthorization of existing items; the UI reports that securing state
and retries remain bounded. Server membership, device/session state, exact native
mutation capabilities, approvals, idempotency, and governed tool execution remain
authoritative on every request.

## Sandbox and local permission boundary

The Apple-issued Release path remains App Sandbox enabled with outbound network,
App Group, user-selected read-only files, and microphone entitlements. The private
owner-Mac `LocalRelease.entitlements` path is different: because the self-signed
identity has no Apple Team Identifier, the current private package intentionally
omits `com.apple.security.app-sandbox` and Hardened Runtime and retains only its App
Group entitlement. Earlier statements that this private build remained sandboxed
were incorrect. TCC still protects microphone, Screen Recording, and Accessibility,
but the owner-only host must not be treated as sandbox-confined.

Ordinary product operation does not request Accessibility or Screen Recording. Those
permissions belong only to the explicitly enabled local Computer Use path, are
requested at point of use, and remain visible and revocable in macOS System Settings.
The separate helpers are also not App Sandbox boundaries in the owner-only package;
their narrower authority comes from small reviewed executables, stable separate
signatures, verified signed parents, stripped environments, child-only pipes, lack
of credentials or network/server interfaces, TCC for the visual helper, and closed
per-helper operation contracts.

Quick Entry uses Command-Shift-Space through a registered system hot key that does
not require Accessibility permission. Its native-to-Flutter route contains only an
allowlisted route string and opens a shell-free command surface. File intake begins
with user selection, drag-and-drop, or a Share Extension.

Local Computer Use is a separate capability. Talk defaults to no computer control
and requires the user to select **This Mac** explicitly. The remote **Isolated
browser** target is retired; transition-compatible requests fail closed and never
redirect to the Mac. Target selection persists through queue and retry. The helper is spawned on demand as a
direct child, verifies the host's bundle containment and matching signing identity,
and uses ScreenCaptureKit, Accessibility, `NSWorkspace`, and Quartz only through the
closed `observe`, `list_apps`, `activate_app`, `open_url`, `press`, `click`, `type`,
`key`, and `scroll` contract. `open_url` accepts only a credential-free absolute
HTTP(S) URL for allowlisted Chrome and returns a fresh observation plus a closed
effect verdict without claiming page-load success. Image clicks use only coordinates
inside the exact current screenshot, declared as `screenshot_pixel`; raw macOS global
coordinates are rejected.

Terminal applications and System Settings are refused by the visual helper. It has no shell,
arbitrary AppleScript, general filesystem, Apple Events, or credential interface;
secure fields and Secure Event Input fail closed. Every state-changing action is
bound to the latest exact Accessibility/screen observation, and governed risk-two
press, click, type, and key actions require approval. A persistent menu-bar indicator
shows ready versus active use, and its stop command terminates the helper immediately.
Server stop disables the device and cancels queued or claimed commands; sign-out and
app exit stop locally and make a best-effort server stop. Permission loss makes the
short readiness lease ineligible, preventing any new claim while queued work expires.

The command helper is a separate capability defined by ADR 013. The model can request
only `local.macos.command.run` with an opaque owner-selected workspace grant ID, one
executable basename, a bounded argument array, an in-workspace relative directory,
and a timeout of at most 30 seconds. Every request is risk two and requires a fresh
exact approval. `AsaelCommandRunnerHelper.app` invokes the program directly without a
shell and refuses shell interpreters, privilege escalation, AppleScript, security or
Keychain administration, LaunchServices, and system-control programs. The workspace
grant constrains the working directory; it is not a filesystem sandbox, so the UI
states that the approved executable otherwise has the authority of the owner's macOS
account. Bounded stdout and stderr are untrusted, one-turn evidence: the temporary
artifact rail and assigned model may see them once, while durable records retain only
exit metadata, byte counts, truncation flags, hashes, timing, and governed receipts.

## State, offline behavior, and convergence

The server and its typed event projections remain canonical. macOS may retain an
encrypted, tenant-and-actor-bound projection cache and the existing bounded Capture
intent outbox. Cached content is labelled with freshness and never grants authority.
Only explicitly supported offline intents may queue. Reconnect revalidates contract,
identity, membership, capability, approval, idempotency, and current domain state;
conflicts are presented for recovery instead of being silently overwritten.

## Distribution and updates

Asael is a private application and does not require Mac App Store publication.
Development builds run from Flutter/Xcode. The owner's Mac may use the dedicated
user-only self-signed Asael identity stored in a private keychain. That identity
does not alter system trust, grant Apple distribution authority, or authorize
installation elsewhere. Because a self-signed identity has no Apple Team Identifier,
the local packager omits Hardened Runtime so nested Flutter libraries remain loadable;
the main owner-only application is not sandboxed. The packager compiles and embeds
both execution helpers under `Contents/Helpers`, signs nested code and each helper
before the host, and verifies the result strictly.

Distribution to another Mac uses the existing bundle identity, Hardened Runtime, an
Apple Development or Developer ID signature as appropriate, notarization, and a
signed update feed with an explicit rollback path. The matching Firebase Apple
application configuration is bundled; push remains configuration-required until
Apple Developer signing and APNs credentials are proven.

The release does not claim native payment signing, unrestricted local computer
control, or background data access that has not been separately reviewed and proven.
The visual helper is a bounded Computer Use slice, and the command helper is a bounded
direct-executable runner; neither grants unrestricted control.

## Alternatives considered

### Full Swift rewrite

Rejected. It would duplicate mature Flutter work and create a second presentation and
transport implementation without improving the server-authoritative security model.
Swift remains appropriate for the narrow operating-system boundary.

### Webview or packaged website

Rejected. It would preserve browser cookie and lifecycle assumptions, provide weak
desktop integration, and make scoped offline Capture and secure native-device behavior
harder to prove.

### Catalyst or another cross-platform shell

Rejected. There is no existing Catalyst client to reuse, while the Flutter client and
its generated native contracts are already the supported shared-client foundation.

## Rollout

1. Add `macos` to native contract v8, authentication policy, session storage schema,
   push registration boundary, and focused compatibility fixtures while preserving v7.
2. Prove the Apple-issued sandbox policy and document the owner-only self-signed
   exception, plus login, Keychain restoration, and desktop window lifecycle; retain
   token rotation and remote wipe through the shared native session contract.
3. Deliver menu-bar Today, global Quick Entry, bulk file/microphone Capture,
   drag/drop, Share Extension intake, and notification actions through allowlisted
   native intents.
4. Complete the high-use Today, Command, Inbox, Capture, Projects, and Memory desktop
   journeys before widening administrative parity.
5. Add an encrypted projection cache and explicit reconnect/conflict presentation.
6. Add native-v11 device courier routes and the separately signed local helper;
   require explicit target selection, stable signing, local permissions, governed
   tools, approvals, idempotent receipts, a visible indicator, and an immediate stop.
7. Bind local sessions to their exact run in migration 180; publish native v13/v12,
   governed Chrome URL delivery, screenshot presentation, and snapshot-pixel mapping.
8. Retire the product Playwright runtime: fail closed for transition-compatible
   isolated-browser requests, preserve historical evidence as read-only, apply
   migration 181 to revoke profiles/takeovers and scrub known connector credentials,
   then decommission the separate Fly browser service after rollback capture.
9. Add migration 205 and native v27/v26 for owner-selected command workspaces,
   exact structured direct execution, mandatory per-command approval, a separately
   signed command helper, ephemeral output, and metadata-only durable receipts.
10. Publish native v28/v27 for scope-correct Settings catalogs and strict explicit
   Model/Thinking selection; clear stale selection when Agent or target changes,
   force explicit choices onto direct execution, and reject durable conflicts.
11. Privately sign, package, and install on the owner's Mac only after focused release
   checks; require Apple-issued signing and notarization before distributing to
   another Mac.

## Rollback

The server may hold a current macOS contract or raise the macOS minimum version without
weakening authorization. A client rollback uses the still-supported previous contract
only where that frozen contract permits it; `macos` sessions themselves require v8 or later and therefore
fail explicitly rather than impersonating iOS or Android. Revocation, wipe, queued
intent quarantine, audit history, and server canonical state survive a client rollback.
For the current window, v27 preserves visual Computer Use and the command-runner
action with Automatic routing but cannot send v28's explicit model-selection
envelope. Disabling either governed tool still removes its execution authority
without weakening the older visual boundary.

## Consequences

- macOS, Android, and later iOS remain interaction surfaces over one Asael core.
- Shared Flutter work improves native clients together while AppKit-specific code stays
  small and auditable.
- Desktop quality still requires deliberate adaptive layouts, keyboard behavior,
  pointer states, accessibility, and focused macOS tests; route presence alone is not
  feature parity.
- Xcode and owner-Mac private signing are proven; Apple Developer signing, APNs, and
  notarization remain external distribution prerequisites rather than reasons to
  fork the product architecture.
- Native v11, migration 179, stable-signed installation, TCC grants, and the bounded
  owner-Mac activation/read canary are proven for Asael `1.6.1` build `8`; exact
  release and run evidence is retained in the
  [Computer Use target decision](../computer-use-migration.md). That read-only
  canary does not imply a consequential edit occurred.
- The native-only v13/v12 source cutover adds migration 180 run binding, governed
  Chrome URL delivery, screenshot-pixel mapping, configurable tools-and-vision model
  resolution, and deterministic App Builder readiness without product browser
  automation. The later migration-181/native-v14 release, matching signed client,
  local navigation/screenshot canary, and Fly browser-service decommission are
  retained as completed historical release evidence.
- Migration 205, production native v27/v26, and signed Asael `1.19.0` build `30`
  complete the governed command-runner release. The installed positive canary ran
  `git status --short --branch --untracked-files=all` in the approved OmniAgent
  workspace, returned the expected branch and one user-owned untracked research file,
  and let the assigned agent use that ephemeral output. A separate request to run
  `sudo whoami` failed closed before approval or execution. No raw stdout or stderr
  was retained as durable conversation, approval, tool, command, or event state.
- Production native v28/v27 and signed Asael `1.22.0` build `34` complete the
  scope-correct Command model-selection release. The installed direct canary returned
  `SCOPE_V28_ULTRA_OK` through `openai · gpt-6-astra · Ultra thinking`; **This Mac**
  cleared the explicit selection, and Forge preserved the specialist while loading
  its validated Settings scope with Automatic selection.
  Explicit choices are direct-only, durable conflicts fail closed, and the observable
  receipt retains effective metadata rather than private model reasoning.
- The repository carries no browser-automation dependency, CI job, benchmark, or
  visual-smoke runtime. Focused component/contract tests cover web behavior and the
  signed native canary verifies installed-Mac control.
