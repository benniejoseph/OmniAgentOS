# Native mobile authentication API

The Asael Flutter client uses a dedicated opaque-token flow against
`https://asael.bennierichard.com` by default. Browser session cookies and their
CSRF protections are unchanged.

## Endpoints

- `POST /api/mobile/auth/login` accepts `email`, `password`, and `device`. A current device envelope includes stable `id`, `name`, `platform`, normalized `appVersion`, positive `buildNumber`, and positive `clientContractVersion`. The legacy shape with no build/contract remains accepted and is classified as unknown. The response returns a short-lived bearer access token, a rotating refresh token, and the server-owned compatibility projection.
- `POST /api/mobile/auth/refresh` accepts `refreshToken`, the original `deviceId`, and an optional current `client` attestation. Rotation is single-use. Reusing an already consumed refresh token revokes the device session. An attested refresh updates compatibility and last-seen evidence without trusting user/tenant identity from the body.
- `POST /api/mobile/auth/logout` requires the access token in `Authorization: Bearer <token>` and revokes its device session.
- `GET /api/mobile/bootstrap` requires a bearer token and returns the current user, tenant, role, device, granted permission names, API metadata, compatibility status, and the static native-client policy.
- `GET /api/mobile/adoption` requires `read.identity` and durable PostgreSQL. It returns only tenant-aggregated active-session and latest-device compatibility counts. No user, device, session, token, email, or raw-version values are exposed. The result is explicitly held and cannot activate Agent catalog enrollment.

All mobile auth responses are `private, no-store`. Errors use `{ "error": { "code": "...", "message": "..." } }`. Authentication failures intentionally do not disclose whether an email exists.

## Client storage and rotation

Store both tokens only in iOS Keychain or Android Keystore-backed secure storage. Never log or place tokens in analytics, crash metadata, URLs, or ordinary preferences. Refresh proactively 30 seconds before `accessExpiresAt`; this remains strictly below the server's one-minute minimum access lifetime. Serialize refresh calls per device and publish each replacement pair with the new access token last. On any refresh `401`, erase both tokens and return to sign-in. Logout always attempts server revocation before clearing local credentials, but local cleanup still completes if the service is unreachable. The client writes `asael.session_token` and migrates an existing legacy secure-storage entry on first read so installed users remain signed in.

Access and refresh tokens are SHA-256 hashed at rest. A session is bound to one user, tenant, membership, and stable installation/device identifier. Access defaults to 15 minutes and refresh to 30 days; operators may set bounded `OMNIAGENT_MOBILE_ACCESS_TTL_SECONDS` and `OMNIAGENT_MOBILE_REFRESH_TTL_DAYS` values.

Bearer access resolves through the same RBAC, tenant RLS, canonical-request binding, and audit attribution as browser sessions, but carries `source: mobile`. This keeps cookie-only origin enforcement limited to browser sessions while generic native mutations remain explicitly held until a later capability enrollment. Login, refresh, logout, bootstrap, and authorized reads use their bounded native contracts. Supplying any invalid `Authorization` header fails closed and never falls back to a browser cookie.

## Compatibility and rollout

Contract version 1 accepts only stable `major.minor.patch` releases and positive integer builds. `OMNIAGENT_NATIVE_MIN_ANDROID_VERSION` and `OMNIAGENT_NATIVE_MIN_IOS_VERSION` set the server-owned minimums and default to `1.0.0` only when absent or empty. A malformed configured minimum invalidates the policy, makes adoption evidence unavailable, and cannot authorize rollout. Legacy, partial, stale, malformed, or future contract records are `unknown`; older valid contract versions or app releases are `upgrade_required`.

Migration v52 adds structured build/contract/last-seen/attested-at fields without changing legacy `app_version` text. Its version-zero default preserves old writers and rollback compatibility. The Flutter client sends native attestation headers on bootstrap and all ordinary API requests, refreshes access tokens proactively and once after a `401`, and serializes refresh per installation. An observed request without complete attestation intentionally clears structured compatibility back to unknown, so old clients and rolled-back servers cannot leave a false compatible record. Login and refresh retry the immediately previous strict request shape after a schema-level `400`, so application rollback remains usable. Logout revokes the stable server session after any required refresh, rather than targeting a mutable access-token hash. Adoption evidence reports both every refresh-capable session family and one most recently active enrollment per user/device because deduplication alone could hide an older refreshable legacy family. A zero-device population has no adoption percentage. This batch observes compatibility only: bare Agent collection reads, Agent execution, generic native mutations, canonical writes, consent, and membership authority remain unchanged.
