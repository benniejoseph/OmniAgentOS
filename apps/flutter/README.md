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

The default Debug/Profile and owner-only LocalRelease builds intentionally omit
the restricted APNs entitlement, so a local or self-signed build cannot claim
authority that its signature does not have. To test sandbox APNs, sign an
explicit opt-in Debug build with an Apple team whose App ID and provisioning
profile enable Push Notifications:

```bash
flutter build macos --debug --config-only
xcodebuild \
  -workspace macos/Runner.xcworkspace \
  -scheme Runner \
  -configuration Debug \
  -destination 'platform=macOS' \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$ASAEL_APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  ASAEL_MACOS_DEBUG_ENTITLEMENTS=Runner/DebugApns.entitlements \
  build
```

`ASAEL_APPLE_TEAM_ID` is supplied only in the operator environment. Do not put a
team, certificate, provisioning profile, or APNs provider key in this repository.
The production packager requires `Release.entitlements` plus a matching embedded
production profile and fails closed if either authorization is missing.

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
