# Getting Started

Run Asael locally and complete your first agent task in about 10 minutes. The
canonical production app is [asael.bennierichard.com](https://asael.bennierichard.com).

## Prerequisites

- Node.js 24.x
- npm 11.x
- Optional: an OpenAI API key (the app runs in a simulated fallback mode without one)
- Optional: a Postgres database (Neon recommended) for durable storage

## 1. Install and run

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Use `npm ci` for a clean checkout or CI. Use `npm install` only when intentionally changing dependencies.

Open http://localhost:3000 and click through to the app at `/app`.

## 2. Configure local identity

The example environment sets `OMNIAGENT_AUTH_ENABLED=false` for local development. The default role is `viewer` (read-only). To run agents and tools locally without sessions, set:

```bash
OMNIAGENT_DEFAULT_ROLE=operator
```

To exercise real auth locally, set all three values below and restart the server:

```bash
OMNIAGENT_AUTH_ENABLED=true
OMNIAGENT_BOOTSTRAP_EMAIL=admin@example.test
OMNIAGENT_BOOTSTRAP_PASSWORD=<a-long-local-only-password>
```

Then open `/login`. The bootstrap account is created on first auth-store access. Production ignores attempts to disable auth, so production must have bootstrap credentials before its first request. Rotate or remove bootstrap credentials from the deployment after confirming the persisted administrator account.

## 3. Add the OpenAI key (recommended)

```bash
OPENAI_API_KEY=sk-...
```

Without it, agent runs stream a clearly labeled simulated response. With it, the agent runs a governed tool-calling loop: it can search memory and knowledge, run live web searches, write memories, ingest knowledge, list runs, and call any active MCP/OpenAPI connector tools below risk level 3.

## 4. Run your first task

1. Open **Work** (`/app/command`).
2. Enter a goal — e.g. *"Search our knowledge for connector setup notes, then summarize what's missing."*
3. Watch the run stream: context retrieval, tool calls (with risk levels), and the final answer.
4. Tool calls and workspace-access requests that need a decision appear in **Inbox** (`/app/approvals`); approving a tool call executes it once and resumes the same agent run with the result.
5. Admins provision approved people in **Settings → Create workspace user**. A generated initial password is shown once when no password is supplied.
6. Final outputs and evidence land in **Results** (`/app/results`).

Press **⌘K** (macOS) or **Ctrl+K** (Windows/Linux) anywhere in the app to jump between workspaces.

## 5. Create documents and presentations

Use ordinary language in **Work**; Asael selects the governed creator and keeps
the result attached to the conversation. For example:

- *"Create an eight-slide editable PowerPoint pitch for AIForce in Salesforce
  Service Cloud. Use the aurora theme and include speaker notes."*
- *"Create a collaborative Google Doc proposal from this conversation, with an
  executive summary, recommendations, and action items."*
- *"Create a Google Sheet rollout tracker with columns for phase, owner, due
  date, status, and risk."*
- *"Create a six-slide Google Slides presentation for this client brief."*

Asael-owned PowerPoint files appear inline after the task and in **Results →
Created files**, where web and native clients can download the exact private
version. Native Google Docs, Sheets, and Slides require the owner's connected
Google Workspace account and one approval for the Drive write. Asael verifies
the provider result before showing **Open in Google**; retrying an interrupted
creation repairs or reuses only the exact execution-owned file instead of
creating a duplicate.

Ask in the same conversation to revise an existing Google file. Asael reads its
current revision first and uses the governed digest-bound update tool, so an
out-of-date edit fails instead of overwriting a newer change.

## 6. Make it durable (optional)

Without `DATABASE_URL`, data lives in `.omniagent/` JSON files locally. Hosted production requires Postgres; no-DB hosted mode is blocked unless `OMNIAGENT_ALLOW_DEMO_STORAGE=true` is set for a disposable demo. For real persistence:

```bash
DATABASE_URL=postgres://...
```

The schema, pgvector columns, and HNSW indexes are created automatically on first use.

## 7. Verify your setup

```bash
npm run typecheck
npm run lint
npm run test:unit       # deterministic unit suite
npm run test:coverage
npm run test:integration
npm run build
```

`test:integration` is skipped unless it receives an isolated `DATABASE_URL` and `OMNIAGENT_INTEGRATION_DATABASE_RESET=true`; that guard prevents accidental schema deletion. Web presentation behavior is covered by focused component/contract tests and the production build; installed-Mac Computer Use is verified through its signed native canary.

For a disposable local Postgres instance that has neither TLS nor pgvector, append
`?sslmode=disable` to its URL and set
`OMNIAGENT_INTEGRATION_REQUIRE_PGVECTOR=false`. This exception is accepted only
outside `NODE_ENV=production`; CI and deployed databases still require TLS, and
the CI integration service still verifies pgvector.

Next: [deployment.md](deployment.md) for production, [production-rollout.md](production-rollout.md) for the release checklist, and [architecture.md](architecture.md) for how it all fits together.
