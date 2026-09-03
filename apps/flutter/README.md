# Asael Flutter client

The mobile and desktop command center for Asael. Production builds use
`https://asael.bennierichard.com` by default. Override `API_BASE_URL` with a
Dart define when developing against another environment.

```bash
flutter run --dart-define=API_BASE_URL=http://localhost:3000
```

## Compatibility identifiers

The client writes the canonical `asael.session_token` secure-storage key and
migrates the legacy key on first read. Installed application identifiers rooted
at `app.omniagent.omniagent` and desktop executable names remain unchanged so
existing builds upgrade in place. These legacy identifiers are implementation
contracts, not user-facing product names.
