# Computer Use targets

Status: native-only source, data-plane, web, signed owner-Mac, live canary,
durable privacy inspection, and Fly browser-service decommission are complete
· 2026-09-17

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

Migration 181 is installed in production with checksum
`2d8bfc80ac843fe49ca79024022b873f5046a68822892ace7ff78d393025cf4d`.
It revoked active profiles and takeovers, disabled known remote-browser
connectors, scrubbed their sealed credentials and credential metadata, and
limited the historical profile/takeover tables to read-only access for runtime
roles. The post-install aggregate found zero active profile, takeover,
connector, or remote-browser tool authority. Historical audit rows remain.

The complete Playwright development and deployed product runtime is also gone:
no tracked or installed Playwright package, executable test suite, CI job,
benchmark, visual-smoke script, product proxy, connector preset, container
definition, Fly source definition, or live Fly browser resource remains.
The release operator removed Fly app `omniagent-os-browser`, machine
`287920db963048`, persistent volume `vol_vz8x9p55j9876djv`, and both remaining
Playwright secrets after the native canary and rollback checks passed. The
separate `omniagent-os-worker` service remains healthy at version `v335`.

The browser-automation development dependency, CI job, benchmark, and visual-smoke
scripts are removed as well. Focused component/contract tests and the production
build cover web changes; the signed native canary covers installed-Mac control.

## This Mac

### Device courier

Only an authenticated compatible macOS client (current v14 or previous v13) may publish
a local-device readiness lease, claim a command, return its completion receipt,
or stop the device. The Flutter app holds the native bearer. The helper receives
neither that bearer nor any server, connector, model, App Group, or Keychain
credential.

The browser URL action was added in v13 and remains in v14. It requires the
exact active device and native login session to attest a compatible contract in
the same transaction that enqueues it. V14 removes the retired remote-frame
read from the native surface while retaining local `open_url`, screenshot
presentation, and snapshot-bound pixel coordinates; v13 is the one supported
rollback contract.

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
A v13-or-v14 image click instead carries `coordinateSpace: "screenshot_pixel"` and a
point inside the exact bounded screenshot. The observation privately binds that
image's width, height, captured display, logical bounds, scale, and revision;
the helper maps from top-left image pixels to current macOS global logical
coordinates only after revalidating the display. It rejects raw global,
out-of-bounds, stale, display-drifted, and secure-target coordinates. Changing
the frontmost app, focused window, or display layout also makes the observation
stale and causes the helper to refuse the action.

### Credential continuity broker

The owner-only release uses a second, separately signed helper,
`AsaelCredentialBroker.app`, solely to keep the Keychain owner stable across
private app rebuilds. It is distinct from `AsaelComputerUseHelper.app` and
grants no Computer Use authority. Broker v1.0.0 build 1 is provisioned once as
an owner-local frozen artifact and embedded byte-for-byte only after its source,
bundle, executable, Info.plist, signing requirement, certificate, architecture,
and code hashes verify.

The frozen broker is universal (`x86_64` and `arm64`) with CDHash
`056b6bc5ce0709b430fd48dfb38f8d7d01b380e0` and signing-certificate SHA-256
`ccf2035e163285b723bf1196cf57abc5a304d9580ab42d5f089ddd0dfbdd455e`.
It accepts only the closed Asael credential-key/action contract over direct
parent-child pipes, validates the parent and matching signing certificate, and
has no network, shell, general Keychain, Computer Use, or arbitrary-storage
interface. Ordinary startup is non-interactive and bounded. The explicit
one-time legacy migration copies, reads back, and marks every broker-owned value
before deleting only its verified legacy source; disagreement or an unknown key
fails closed and preserves the source. The installed broker artifact is
verified. Commit `0f5477a` adds the exact versioned, monotonic cutover receipt;
the installed 1.6.8+15 restart proof confirmed that the broker target stays
canonical without repeating legacy migration or transferring Computer Use
authority to the credential broker.

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
evidence that the later native-only v14 cutover has been released:

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

The completed native-only release is newer and does not replace that historical
canary:

1. migrations 181-182 are installed. The isolated-browser authority audit is
   zero while read-only history remains; `open_url` is the sole addition to the
   validated local command-action constraint. The migration-182 pre-change
   logical backup is 137,605,166 bytes with SHA-256
   `a51ef0adf76a0cf50540991d27175746fc1a1ce6e778ed7e9c7dd28a669e81bd`;
2. commit `590b213a5d869273476c3aeee89ddf7e8493c23f` is canonical through
   Vercel deployment `dpl_4fwASuVj564h5rLdipRWWT3kkwWN`; contract discovery
   reports v14 current and v13 previous, and retired product routes return
   `410`;
3. cutover fix `0f5477a` persists and reuses the exact credential-broker
   migration receipt, while screenshot/natural-open fix `590b213` carries the
   explicit screenshot request through governed `open_url` and presents the
   fresh post-navigation image;
4. signed owner-only Asael `1.6.8` build `15` is installed at
   `/Applications/Asael.app`. Its package
   `apps/flutter/build/distribution/macos/Asael-1.6.8-15-macOS.dmg` has SHA-256
   `c92c10a56ad09d1f006f9cbf33f2160aaa314431f46f1c4e7555627ff89858d2`;
   the installed host CDHash is `b8ba3feb5edf66e0b3eadd68e47ab3398fdd5027`
   and its embedded frozen broker retains CDHash
   `056b6bc5ce0709b430fd48dfb38f8d7d01b380e0`;
5. live runs `122ff0d5-b208-4152-a0f6-3b4be6c99e0a` and
   `1a105c0c-d1b2-42be-8ba5-2c2de599d499` successfully exercised the explicit
   **This Mac** path, credential continuity/restart, and the natural-language
   Chrome open → fresh screenshot → grounded response flow through governed
   approval;
6. the post-canary durable privacy inspection found no retained screenshot bytes
   or Accessibility snapshot content in command, tool, run, approval, event, or
   conversation records. Only the permitted bounded public metadata and digests
   remain; and
7. the release operator removed Fly app `omniagent-os-browser`, machine
   `287920db963048`, persistent volume `vol_vz8x9p55j9876djv`, and both remaining
   Playwright secrets. The independent worker/OpenAI egress app
   `omniagent-os-worker` remains healthy at version `v335`.

Deleting the Fly app, machine, persistent volume, and encrypted profile snapshot
lineage is irreversible. That deletion removed the executable browser/profile
state only; migration-181 database audit rows and historical effect receipts
remain under their existing retention policy.

## Native-only release gate

The native-only P13.3 gate is complete. Source/runtime Playwright removal,
migrations 181-182, canonical v14/v13, signed Asael 1.6.8+15, broker restart,
natural-language Chrome screenshot canaries, durable screenshot/Accessibility
privacy inspection, and removal of the obsolete Fly app/machine/volume/secrets
are all proven together. The surviving worker/OpenAI egress service is healthy.

This closes only the P13.3 Computer Use cutover. It does not claim that the
separate real provider-delivered APNs receipt is complete; that P13.2 operational
proof remains open.
