# ADR 011: Versioned, server-authoritative native API

Status: Accepted · 2026-09-05

## Context

Web, mobile, and macOS clients need the same work, conversation, notification, approval, upload, voice, and continuation capabilities. Reimplementing domain or security rules in each client would create inconsistent authority and make safe contract evolution impossible.

Native delivery also adds long-lived installations, offline intervals, platform minimums, bearer-token storage, lost devices, reinstalls, and remote revocation. Device telemetry is useful for rollout observation but is not identity or authorization.

## Decision

Publish generated, versioned API and event contracts from server-owned schemas. Web, mobile, and macOS consume those same contracts and fixtures. Server services remain authoritative for domain state, validation, authorization, status transitions, approvals, scheduling, idempotency, and governed effects; clients implement presentation, transport, bounded local caching, and platform integration only.

The server supports the current and immediately prior contract versions during a rollout window. Contract negotiation distinguishes app version, build, client-contract version, server minimum, platform minimum, and device lifecycle state. Unknown, future, or below-minimum versions fail explicitly and never imply readiness. Historical contract-v0 observations remain readable in telemetry, and any already-existing v0 compatibility route retains only its frozen, route-specific behavior; v0 is not negotiated for a new versioned native API, cannot use generic native mutation surfaces, and never counts toward rollout readiness.

A native device receives a stable random device identifier and a server-side registration bound to its actor and permitted tenant scope. The identifier is not an actor, membership, principal, grant, or trust decision. Native access tokens are short-lived; refresh tokens rotate as a replay-detecting family and can be revoked per session, device, actor, tenant change, logout, loss, reinstall, or remote wipe.

Offline mutations are only local intents. On reconnect the server revalidates contract version, identity, membership, authorization, approval, idempotency, and current domain state before accepting them. A client never reports a consequential effect as successful without a server-verified receipt.

## Canonical authority and compatibility

Server stores, typed events, and the selected server projection generation define authority under ADR 005. Client caches, push payloads, operating-system state, and provider UI state are non-authoritative and rebuildable.

The prior supported contract preserves its documented semantics through the compatibility window; it is not silently reinterpreted as the new version. Additive adapters translate at the server boundary and retain canonical actor, tenant, workspace, correlation, causation, and idempotency coordinates. An older client cannot interpret a newer checkpoint or event payload.

Rollout readiness is server-observed and version-specific. It measures both latest registered devices and active refreshable session families so a recent installation cannot hide an older active session. Version or device observations alone never activate a held mutation surface, enroll an agent, or grant authority.

## Migration and cutover

1. Stabilize the canonical Workspace model, authentication and device lifecycle, checkpoint continuation, uploads, notifications, and realtime voice contracts.
2. Generate versioned schemas, SDK types, event shapes, conformance fixtures, and server compatibility adapters.
3. Add the new version without removing or changing the prior supported version.
4. Shadow-validate web and native requests and responses against the shared contract.
5. Canary device cohorts and observe errors, active session families, minimum-version adoption, replay, revocation, and parity.
6. Persist server-owned platform minimums and the selected API generation before broadening rollout.
7. Maintain the prior version through the rollback window; remove it only after its sessions are expired or explicitly migrated in a later change.

Generic native mutations and agent enrollment remain held until their separate authorization and adoption gates are proven. Shipping a client does not itself cut over server authority.

## Rollback

Rollback routes eligible clients to the prior supported contract and last proven server projection generation. The server may pause the new contract or require an upgrade; it does not let clients downgrade authorization semantics or reinterpret newer queued intents.

Device and session revocations, token-family replay findings, tenant changes, tombstones, receipts, and audit history survive rollback. Incompatible offline intents remain quarantined or rejected rather than being coerced into an older contract.

## Permanent security floors

- The server authenticates and authorizes every request with explicit tenant, actor, device or session, Workspace, and resource scope; native transport does not bypass RBAC or RLS.
- Browser credentials remain protected by the browser session contract. Native tokens live only in Keychain or Keystore-class secure storage, never logs, URLs, analytics, source code, or ordinary preferences.
- Access tokens are short-lived; refresh families rotate, detect replay, and support immediate server-side revocation. Biometric gates protect local release of credentials but do not replace server authorization.
- Remote wipe immediately revokes the relevant server sessions. It requests local sensitive-state and key erasure when the device is reachable; until then, short-lived token expiry, rotating refresh-family revocation, secure storage, and encryption-key lifecycle bound residual risk. The product never reports local erasure as complete without device acknowledgement. Reinstall, device loss, logout, membership removal, and tenant switching have explicit lifecycle handling.
- Untrusted API content, push payloads, deep links, uploads, model output, and cached data cannot become instructions or expand authority.
- Consequential actions use the same governed tool executor, approval, idempotency, and verified-outcome controls as web requests.

## Consequences

- Web, mobile, and macOS can evolve from one testable contract without maintaining client-specific business-rule forks.
- Supporting two versions, generated fixtures, device lifecycle state, and compatibility telemetry adds server and test complexity.
- Native release waits for stable core contracts and proof of secure device/session behavior; UI completeness alone is not a readiness signal.
