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
- a separately reviewed local Computer Use helper only if Phase 13.3 remains needed.

The Swift-to-Flutter channel carries a small allowlisted intent contract, such as
opening Today, Command, Capture, or Inbox. It carries no bearer credentials, domain
objects, connector content, tool requests, or authority. Native intents invoke the
same Flutter routes and server services as every other client surface.

The macOS client first enrolled on native contract v8 and advances through ADR 011's
current/previous discovery window. The platform identifier is `macos`.
The ordinary macOS Keychain protects native session credentials without a shared
access group. Server membership, device/session
state, exact native mutation capabilities, approvals, idempotency, and governed tool
execution remain authoritative on every request.

## Sandbox and local permission boundary

The application remains sandboxed. Its initial entitlement floor is outbound network,
Keychain, user-selected read-only files, and microphone input. Access is requested
only at the point of use, explained in product language, and remains visible and
revocable in macOS System Settings. The app receives no broad filesystem, screen
recording, automation, or Accessibility permission for ordinary product operation.

Quick Entry uses Command-Shift-Space through a registered system hot key that does
not require Accessibility permission. Its native-to-Flutter route contains only an
allowlisted route string and opens a shell-free command surface. File intake begins
with user selection, drag-and-drop, or a Share
Extension. A future Computer Use helper must be separately signed and isolated, show
an active-use indicator, enforce domain/action allowlists and a kill switch, and send
every effect through Asael's governed executor. It cannot inherit the application's
ordinary credential store or silently widen the main app's sandbox.

## State, offline behavior, and convergence

The server and its typed event projections remain canonical. macOS may retain an
encrypted, tenant-and-actor-bound projection cache and the existing bounded Capture
intent outbox. Cached content is labelled with freshness and never grants authority.
Only explicitly supported offline intents may queue. Reconnect revalidates contract,
identity, membership, capability, approval, idempotency, and current domain state;
conflicts are presented for recovery instead of being silently overwritten.

## Distribution and updates

Asael is a private application and does not require Mac App Store publication.
Development builds run from Flutter/Xcode. Private releases use the existing bundle
identity, Hardened Runtime, an Apple Development or Developer ID signature as
appropriate, notarization for distribution to additional Macs, and a signed update
feed with an explicit rollback path. The matching Firebase Apple application
configuration is bundled; push remains configuration-required until Apple
Developer signing and APNs credentials are proven.

The first release does not claim native payment signing, unrestricted local computer
control, or background data access that has not been separately reviewed and proven.

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
2. Prove sandboxed network access, login, token rotation, Keychain restoration,
   biometric lock, remote wipe, and desktop window lifecycle.
3. Deliver menu-bar Today, global Quick Entry, bulk file/microphone Capture,
   drag/drop, Share Extension intake, and notification actions through allowlisted
   native intents.
4. Complete the high-use Today, Command, Inbox, Capture, Projects, and Memory desktop
   journeys before widening administrative parity.
5. Add an encrypted projection cache and explicit reconnect/conflict presentation.
6. Sign, notarize, package, and privately install only after focused release checks.

## Rollback

The server may hold a current macOS contract or raise the macOS minimum version without
weakening authorization. A client rollback uses the still-supported previous contract
only where that frozen contract permits it; `macos` sessions themselves require v8 or later and therefore
fail explicitly rather than impersonating iOS or Android. Revocation, wipe, queued
intent quarantine, audit history, and server canonical state survive a client rollback.

## Consequences

- macOS, Android, and later iOS remain interaction surfaces over one Asael core.
- Shared Flutter work improves native clients together while AppKit-specific code stays
  small and auditable.
- Desktop quality still requires deliberate adaptive layouts, keyboard behavior,
  pointer states, accessibility, and focused macOS tests; route presence alone is not
  feature parity.
- Apple signing, APNs, notarization, and a complete Xcode toolchain remain external
  release prerequisites rather than reasons to fork the product architecture.
