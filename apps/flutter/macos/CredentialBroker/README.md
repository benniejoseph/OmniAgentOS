# Asael credential broker v1

This source builds a deliberately frozen, separately signed child process that
owns Asael's macOS Keychain items. Its version and signing identity must not be
changed for ordinary Asael releases. The private release script embeds the
already-signed owner-local artifact byte-for-byte and verifies its recorded
CDHash before and after signing the outer application.

The broker accepts only `probe`, `read`, `write`, `delete`, and the explicit
`migrate` operation for the compile-time key allowlist. It has no network,
shell, filesystem, or general Keychain interface. Never commit the built app,
its manifest, signing certificate, or signing password.

A broker source/protocol change requires a new service and artifact version;
do not overwrite or re-sign the v1 artifact.

Before the first broker-enabled private release on a Mac, run:

```sh
apps/flutter/tool/install_macos_credential_broker.sh
```

That one-time command compiles and signs the owner-local artifact, writes its
owner-only verification manifest, and freezes its CDHash. Every subsequent
private release verifies and embeds those same signed bytes. Ordinary debug
`flutter run` builds deliberately use an isolated debug-only Keychain service
because Xcode does not embed the release artifact; release mode has no such
fallback and debug credentials never overwrite the migratable release session.
