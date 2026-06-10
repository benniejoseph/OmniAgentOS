# ADR 003: Daily Vercel cron + opportunistic drains for the workflow queue

Status: Accepted · 2026-06-10

## Context

Vercel Hobby allows only daily cron jobs. Durable workflows need regular ticks to advance queued work, evaluate SLO policies, and dispatch alerts.

## Decision

`vercel.json` schedules `/api/workflows/tick` daily as a safety net (secured by `CRON_SECRET`). The real cadence comes from opportunistic draining: user-facing actions schedule post-response queue drains via Next.js `after()`, and operators can tick manually from the Run workspace.

## Consequences

- Hobby-tier compatible with zero external dependencies.
- A fully unattended workflow may wait up to 24h; deployments that care should raise the cron cadence (Pro) or add an external pinger (GitHub Actions schedule / QStash). See docs/deployment.md.
- Queue semantics (leases, retries, stale recovery) are designed to tolerate sparse, bursty ticking.
