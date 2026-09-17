# Computer Use targets

Status: native-only cutover is source-ready; migration 181, the v13 release,
Fly browser-service decommission, and the new owner-Mac canary are pending
release evidence · 2026-09-17

## Decision

Computer Use has one product execution target: **This Mac**. It operates the
Mac on which the authenticated Asael app is installed through the compatible
native device courier and a separately signed, credential-free helper spawned
on demand by Asael.

Native Talk defaults to **Asael only**, which grants no local computer-control
target. The user must select **This Mac** explicitly, and the native client
preserves that choice through prompt queueing and retry. Prompt text, historical
connector metadata, and model output never infer local authority. A failed local
session fails explicitly; it never falls back to a browser service.

The `computer_use` model assignment remains tenant-configurable. One configured
runtime must advertise both tool use and vision; neither capability may be
borrowed from a different provider/model fallback. Every action still enters
the governed tool executor. A model, Agent persona, screen, web page, or tool
result cannot grant tools, credentials, budget, or approval authority.

## Retired isolated browser

The Fly Playwright runtime, its product proxy, and the Playwright/Browser Use
connector presets are removed from the source execution path. The
transition-compatible `/api/agent` input still recognizes
`computerUseTarget: "isolated_browser"` only to return
`410 computer_use_target_retired`; saved continuations record a bounded typed
`execution_target_retired` run event and fail without executing or redirecting
to **This Mac**.

The former browser profile, takeover, activity, frame, snapshot, and stream
product routes return `410`. Their retained database rows remain subject to
retention and audit controls, but are not a product read or execution surface.
App Builder's separate legacy browser-evidence fields remain readable on old
records; new readiness uses deterministic lint/typecheck, build-log, and
route-smoke evidence only.

Migration 181 completes the data-plane retirement when installed: it revokes
active profiles and takeovers, disables known remote-browser connectors, scrubs
their sealed credentials and credential metadata, and limits the historical
profile/takeover tables to read-only access for runtime roles. It intentionally
retains audit rows. Applying migration 181, deleting the Fly browser app and its
volume/secrets, promoting the compatible web/native release, and recording a
new local canary are separate release operations and remain pending until their
exact evidence is appended here.

The browser-automation development dependency, CI job, benchmark, and visual-smoke
scripts are removed as well. Focused component/contract tests and the production
build cover web changes; the signed native canary covers installed-Mac control.

## This Mac

### Device courier

Only an authenticated compatible macOS client (current v13 or previous v12) may publish
a local-device readiness lease, claim a command, return its completion receipt,
or stop the device. The Flutter app holds the native bearer. The helper receives
neither that bearer nor any server, connector, model, App Group, or Keychain
credential.

The browser URL action is new in v13 and requires the exact active device and
native login session to attest v13 in the same transaction that enqueues it.
V12 remains compatible for the earlier action set and screenshot-preview
routing, but cannot receive `open_url`.

The server binds each local session to the exact tenant, actor, native device,
mobile session, agent-run correlation ID, and run ID. Migration 180 adds the
run-binding uniqueness fence and bounded observation-expiry index to the three
forced-RLS routing tables. A governed tool execution supplies the command
identity and sealed input; the enqueue transaction resolves the exact active
run-bound native session and a claim reopens that exact audit input and verifies
its digest before sending it to the Mac.
Completion uses a device-bound, expiring claim token and an idempotent receipt.
Expired uncertain mutations are not replayed.

Screen and Accessibility observations are bounded, untrusted, one-turn model
input. They may exist briefly in the command row while the requesting executor
is waiting, but the consumer strips them immediately; after consumption,
command rows, tool records, conversations, approval continuations, and typed
events retain only bounded public metadata and digests. A `local_macos` run does
not fan the private observation out to sibling council members. The assigned
agent reports on the evidence it actually received rather than allowing an
evidence-blind sibling to replace that completed result with an unverified one.

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
- `NSWorkspace` only to list or activate visible apps and to deliver one
  credential-free absolute HTTP(S) URL to allowlisted Chrome; and
- Quartz events for bounded clicks, text, keys, and scrolling.

Every pointer or keyboard effect after observation must carry the exact current
snapshot revision. Element actions use an exact element identifier when available.
A v13 image click instead carries `coordinateSpace: "screenshot_pixel"` and a
point inside the exact bounded screenshot. The observation privately binds that
image's width, height, captured display, logical bounds, scale, and revision;
the helper maps from top-left image pixels to current macOS global logical
coordinates only after revalidating the display. It rejects raw global,
out-of-bounds, stale, display-drifted, and secure-target coordinates. Changing
the frontmost app, focused window, or display layout also makes the observation
stale and causes the helper to refuse the action.

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

The agent-visible allowlist is `observe`, `list_apps`, `activate_app`,
`open_url`, `press`, `click`, `type`, `key`, and `scroll`. Observation and
listing are read-only; browser URL delivery, press, click, type, and key remain
risk-two and approval-gated. `open_url` accepts only allowlisted Chrome and an
absolute HTTP(S) URL without embedded credentials, waits for at most 15 seconds,
then returns a fresh observation and a closed effect verdict without claiming
the page finished loading. Accessibility
and Screen Recording must both be granted by the user in macOS before the
server accepts the Mac as ready.

Enabling local control creates a persistent menu-bar indicator. It distinguishes
ready from actively controlling. **Stop Asael Computer Use** immediately
terminates the helper and cancels pending local work; sign-out, app exit,
or the server stop route also stop locally and attempt the device-bound server
stop. Permission loss makes the short device lease ineligible immediately, so
the Mac cannot claim another command; any already queued work expires without
execution.

## Owner-Mac release evidence

The earlier additive first slice is published and installed for the private
owner-Mac scope. It is historical evidence for the local security boundary, not
evidence that the native-only v13 cutover has been released:

1. migration 179 is installed and production advertises native contract v11
   with frozen v10 compatibility;
2. commit `7a4bd41d0c42abad8f8da0911258ac341e2318f3` is live at the
   canonical origin through Vercel deployment
   `dpl_64Hw4o58FyC1hfB645oo2J6mXGeB`;
3. Asael `1.6.1` build `8` is installed with the separately signed helper. The
   private package is
   `apps/flutter/build/distribution/macos/Asael-1.6.1-8-macOS.dmg`, SHA-256
   `f1df4fc12ee31ecf112df004fdddf0db700b9fadff3fcc1c66b419b6c09568dd`;
4. Accessibility and Screen Recording both report granted, and the local
   command broker reports online; and
5. live run `bc9b0b06-4af3-4de0-b86f-481f724444dc` explicitly selected
   **This Mac**, activated TextEdit, and read the exact synthetic phrase
   `ASAEL INSTALLED MAC CANARY 179`. It made no edit. Post-run inspection found
   no observation payload in durable rows.

The historical release fix keeps that one-turn local evidence with the assigned agent and
bypasses evidence-blind sibling council rewriting for the local run. The helper
also exposes bounded string values from non-secure Accessibility elements, which
made the synthetic TextEdit content readable. Secure elements remain redacted,
and Secure Event Input still fails closed. This live canary is deliberately a
read-only activation and observation proof; it does not claim that this run
performed a risk-two edit, browser navigation, screenshot presentation, or
image-coordinate click.

## Native-only release gate

The source cutover is not operationally complete until release evidence proves
all of the following together:

1. migration 181 is installed after verified migration 180 and reports its exact
   marker/checksum;
2. canonical Vercel advertises immutable v13 current and v12 previous, rejects
   new isolated-browser and retired browser-product routes with `410`, preserves
   database audit rows, and still parses legacy App Builder evidence;
3. the matching signed macOS build reports v13, **This Mac** is explicitly
   enabled, and one natural-language Chrome navigation produces a fresh bounded
   screenshot plus grounded analysis through the governed approval path;
4. durable inspection finds no screenshot bytes, Accessibility content, prompt,
   or private reasoning in command, run, approval, event, or conversation rows;
   and
5. the obsolete Fly browser app, its persistent volume, and its secrets are
   removed only after rollback evidence is captured. The worker/OpenAI egress
   Fly app remains a separate required service.

Until those checks are recorded, migration 181, canonical promotion, Fly
decommission, and the new live canary must be reported as pending rather than
inferred from source readiness.
