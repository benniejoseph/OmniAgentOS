# Asael credential broker v2

Credential broker v2 is the immutable Keychain owner for an Asael installation
whose owner-local signing identity has been rotated. It uses the new
`app.omniagent.omniagent.credential-broker.v2` Keychain service and is versioned
as `2.0.0+2`.

The broker never reads, migrates, changes, or deletes v1 credentials. Its first
probe returns `fresh_sign_in_required`; incomplete v2 writes remain unreadable
until a successful fresh sign-in writes `asael.session_token` and commits the
private v2 initialization marker. The old `migrate` command is not part of the
v2 protocol.

The helper has no network, shell, filesystem, or general Keychain interface.
At launch it verifies that it is a direct child inside Asael and that the host
and helper have the same signing certificate chain, signing identifier, and
Team Identifier. Never commit the built app, its manifest, signing certificate,
or signing password.

After installing the rotated signing identity, provision this immutable broker
once with:

```sh
apps/flutter/tool/install_macos_credential_broker_v2.sh
```

The command compiles and signs an owner-local artifact, records an owner-only
verification manifest, and freezes its CDHash. Every later private release
verifies and embeds those exact bytes. A v2 source or protocol change requires
a new Keychain service and broker version; never overwrite or re-sign v2.
