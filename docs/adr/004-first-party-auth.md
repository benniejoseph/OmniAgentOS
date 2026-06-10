# ADR 004: First-party identity instead of an auth provider

Status: Accepted · 2026-06-10

## Context

The control plane needs tenants, users, memberships, role-derived security contexts, and session revocation — and must work in both Postgres and file storage modes without external dependencies.

## Decision

Implement identity in-repo (`src/lib/auth/`): scrypt password hashes, opaque session tokens stored as SHA-256 digests, HttpOnly/Secure/SameSite=Lax cookies, bootstrap admin via env vars. Auth enforcement is unconditional in production runtimes. Internal callers (smoke tests) authenticate with a timing-safe-compared shared secret header.

## Consequences

- No third-party dependency, full control over tenancy and roles, works offline.
- No SSO/OIDC, MFA, or password reset flows yet — acceptable for the current operator audience; an enterprise SSO integration would slot in at `resolveSecurityContext` without disturbing RBAC.
- Crypto and session logic carry unit tests (`src/lib/auth/crypto.test.ts`).
