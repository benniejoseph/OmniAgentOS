# Architecture Decision Records

| # | Decision | Status |
|---|---|---|
| [001](001-openai-only.md) | OpenAI as the only model provider | Accepted |
| [002](002-storage-fallback.md) | JSON file fallback storage with Postgres as the durable backend | Accepted |
| [003](003-daily-cron.md) | Daily Vercel cron + opportunistic drains for the workflow queue | Accepted |
| [004](004-first-party-auth.md) | First-party identity instead of an auth provider | Accepted |
| [005](005-canonical-truth.md) | Canonical truth and projection authority | Accepted |
| [006](006-agent-identity.md) | Separate agent definition from security principal | Accepted |
| [007](007-object-storage.md) | Tenant-scoped object storage plane | Accepted |
| [008](008-a2a-boundary.md) | Internal delegation authority with an external A2A boundary | Accepted |
| [009](009-ap2-boundary.md) | Deterministic AP2 payment boundary | Accepted |
| [010](010-workspace-model.md) | Workspace, project, and work-item model | Accepted |
| [011](011-native-api.md) | Versioned, server-authoritative native API | Accepted |
