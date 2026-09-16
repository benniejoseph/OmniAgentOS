# Asael Flutter client

The mobile and desktop command center for Asael. Production builds use
`https://asael.bennierichard.com` by default. Override `API_BASE_URL` with a
Dart define when developing against another environment.

```bash
flutter run --dart-define=API_BASE_URL=http://localhost:3000
```

## macOS development and private releases

The macOS client uses this same Flutter application and the same Asael API. It
adds a thin AppKit host for the menu bar, window lifecycle, and the global
Control-Option-Space Quick Entry shortcut; AppKit does not receive credentials
or execute agent tools.

Install the full Xcode application, select it as the active developer directory,
and run the shared client:

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
flutter run -d macos
```

For a private DMG, run `tool/build_macos_private_release.sh`. With no signing
environment it packages the local Xcode-signed build for this Mac. Distribution
to another Mac requires `ASAEL_MACOS_SIGNING_IDENTITY` and the Keychain profile
name in `ASAEL_MACOS_NOTARY_PROFILE`; the script signs, notarizes, staples,
verifies, and prints the DMG SHA-256. Signing credentials never belong in the
repository.

## Compatibility identifiers

The client writes the canonical `asael.session_token` secure-storage key and
migrates the legacy key on first read. Installed application identifiers rooted
at `app.omniagent.omniagent` and desktop executable names remain unchanged so
existing builds upgrade in place. These legacy identifiers are implementation
contracts, not user-facing product names.
