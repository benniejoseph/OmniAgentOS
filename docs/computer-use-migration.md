# Computer Use targets

Status: additive dual-target implementation; release proof pending · 2026-09-17

## Decision

Computer Use has two deliberately separate execution targets:

- **Isolated browser** runs in Asael's tenant-, actor-, and run-scoped
  Playwright MCP service on Fly. It is the remote private browser; it does not
  control the owner's macOS desktop.
- **This Mac** operates the Mac on which the authenticated Asael app is
  installed. It uses the native-v11 device courier and a separately signed,
  credential-free helper spawned on demand by Asael.

Native Talk defaults to **Asael only**, which grants no local computer-control
target. Current native requests select **This Mac** or **Isolated browser**
explicitly, and preserve that target through prompt queueing and retry. Legacy
browser-intent inference can select only the isolated browser; **This Mac** is
never inferred from prompt text. A failed local session never falls back to
Playwright, and a browser request never widens into local desktop control.

The selected target changes only the runtime that performs a governed action.
The `computer_use` model assignment remains tenant-configurable, and every
action still enters the governed tool executor. A model, Agent persona, screen,
web page, or tool result cannot grant tools, credentials, budget, or approval
authority.

## Isolated browser

The remote target retains the existing Playwright security boundary:

- one opaque tenant, actor, and run scope with a bounded session lifetime;
- independent connector credentials and optional encrypted browser profiles;
- governed browser actions with the existing risk and approval policy;
- untrusted page, download, accessibility, and screenshot content; and
- owner/run-scoped observation evidence and private frame delivery.

The Browser Use connector remains a rollback-compatible connector during its
separate removal gate. It is not an implementation of **This Mac**.

## This Mac

### Device courier

Only an authenticated macOS client on native contract v11 or later may publish
a local-device readiness lease, claim a command, return its completion receipt,
or stop the device. The Flutter app holds the native bearer. The helper receives
neither that bearer nor any server, connector, model, App Group, or Keychain
credential.

The server binds each local session to the exact tenant, actor, native device,
mobile session, and agent-run correlation ID. Three forced-RLS tables retain
device leases, local sessions, and command routing metadata. A governed tool
execution supplies the command identity and sealed input; a claim reopens that
exact audit input and verifies its digest before sending it to the Mac.
Completion uses a device-bound, expiring claim token and an idempotent receipt.
Expired uncertain mutations are not replayed.

Screen and Accessibility observations are bounded, untrusted, one-turn model
input. They may exist briefly in the command row while the requesting executor
is waiting, but the consumer strips them immediately; tool records,
conversations, approval continuations, and typed events retain only bounded
public metadata and digests.

Only the primary Flutter engine claims commands. Auxiliary workspace windows
may display status and stop local control, but cannot race the primary window
for device commands.

### Local helper

The private packager builds `AsaelComputerUseHelper.app` separately, embeds it
under `Contents/Helpers`, and signs it independently before signing the host.
The host launches it as a direct child over stdin/stdout pipes with a minimal
environment. At startup the helper verifies the parent process, parent bundle
containment, signing identifiers, code validity, team identity when present,
and matching signing certificates. It exposes no socket, HTTP, shell, XPC,
filesystem, Apple Events, or credential interface.

The helper uses:

- ScreenCaptureKit for a bounded screenshot of an active display;
- macOS Accessibility APIs for a bounded, redacted element snapshot and exact
  element presses;
- `NSWorkspace` only to list and activate an already-running visible app; and
- Quartz events for bounded clicks, text, keys, and scrolling.

Every effect after observation must carry the exact current snapshot revision.
Element actions use an exact element identifier when available. Changing the
frontmost app, focused window, or display layout makes the observation stale
and causes the helper to refuse the action.

### First-slice restrictions

This slice intentionally has no authority to:

- operate Terminal, iTerm, Warp, other supported terminal applications, or
  System Settings;
- run shell commands, arbitrary AppleScript, or general filesystem actions;
- read or type into a secure field or continue while Secure Event Input is
  active;
- install software, change macOS security settings, or silently acquire a new
  permission; or
- accept an arbitrary local tool or unbounded key/mouse operation.

The agent-visible allowlist is `observe`, `list_apps`, `activate_app`, `press`,
`click`, `type`, `key`, and `scroll`. Observation and listing are read-only;
press, click, type, and key remain risk-two and approval-gated. Accessibility
and Screen Recording must both be granted by the user in macOS before the
server accepts the Mac as ready.

Enabling local control creates a persistent menu-bar indicator. It distinguishes
ready from actively controlling. **Stop Asael Computer Use** immediately
terminates the helper and cancels pending local work; sign-out, app exit,
or the server stop route also stop locally and attempt the device-bound server
stop. Permission loss makes the short device lease ineligible immediately, so
the Mac cannot claim another command; any already queued work expires without
execution.

## Release gate

The source implementation is additive and reversible. It is not a production
or installed-Mac proof by itself. Complete these steps in order:

1. apply schema migration 179 and publish native contract v11 plus the courier
   routes;
2. build and strictly verify the host and embedded helper with stable signing;
3. install that exact build and grant Accessibility and Screen Recording to the
   helper when macOS prompts;
4. prove status, observation, app activation, approval pause/resume, one bounded
   input action, stale-observation refusal, secure-input refusal, stop, timeout,
   reconnect, and idempotent completion on the owner's Mac; and
5. confirm that local failures never switch to the isolated browser and that
   neither local observation bytes nor credentials enter durable tool/event
   projections.

Until those checks pass, documentation must describe **This Mac** as implemented
in source but not deployed, installed, or canary-proven.
