# Native mobile authentication API

The Asael Flutter client uses a dedicated opaque-token flow against
`https://asael.bennierichard.com` by default. Browser session cookies and their
CSRF protections are unchanged.

## Endpoints

- `POST /api/mobile/auth/login` accepts `email`, `password`, and `device` (`id`, `name`, `platform`, optional `appVersion`). It returns a short-lived bearer access token and a rotating refresh token.
- `POST /api/mobile/auth/refresh` accepts `refreshToken` and the original `deviceId`. Rotation is single-use. Reusing an already consumed refresh token revokes the entire device session.
- `POST /api/mobile/auth/logout` requires the access token in `Authorization: Bearer <token>` and revokes its device session.
- `GET /api/mobile/bootstrap` requires a bearer token and returns the current user, tenant, role, device, granted permission names, and API version metadata.

All mobile auth responses are `private, no-store`. Errors use `{ "error": { "code": "...", "message": "..." } }`. Authentication failures intentionally do not disclose whether an email exists.

## Client storage and rotation

Store both tokens only in iOS Keychain or Android Keystore-backed secure storage. Never log or place tokens in analytics, crash metadata, URLs, or ordinary preferences. Refresh proactively shortly before `accessExpiresAt`; serialize refresh calls per device and atomically replace both returned tokens. On any refresh `401`, erase both tokens and return to sign-in. The client writes `asael.session_token` and migrates an existing legacy secure-storage entry on first read so installed users remain signed in.

Access and refresh tokens are SHA-256 hashed at rest. A session is bound to one user, tenant, membership, and stable installation/device identifier. Access defaults to 15 minutes and refresh to 30 days; operators may set bounded `OMNIAGENT_MOBILE_ACCESS_TTL_SECONDS` and `OMNIAGENT_MOBILE_REFRESH_TTL_DAYS` values.

Bearer access resolves through the same `SecurityContext` as browser sessions, so existing RBAC, tenant RLS, and audit attribution remain in force. Supplying any invalid `Authorization` header fails closed and never falls back to a browser cookie.
