# ADR 002: JSON file fallback storage with Postgres as the durable backend

Status: Accepted · 2026-06-10

## Context

Local development and demos should work with zero infrastructure, but production needs durability, tenant isolation, and vector search.

## Decision

Every store implements two branches: Neon Postgres (with forced RLS and pgvector) when `DATABASE_URL` is set, otherwise JSON ledgers under `.omniagent/` (local) or `/tmp` (hosted). File stores use per-file write locks and quarantine corrupt files (`src/lib/storage/json.ts`). Hosted ephemeral mode displays a persistent warning banner.

## Consequences

- Zero-setup local development; schema bootstraps itself in Postgres on first use.
- Dual code paths must be maintained per store; unit tests target the file branch, production smoke targets Postgres.
- No ORM/migration framework: schema lives in `src/lib/db/client.ts` bootstrap DDL. Revisit only if migration complexity grows.
