# Getting Started

Run OmniAgent OS locally and complete your first agent task in about 10 minutes.

## Prerequisites

- Node.js ≥ 20.9 (`nvm use 20` or newer)
- npm
- Optional: an OpenAI API key (the app runs in a simulated fallback mode without one)
- Optional: a Postgres database (Neon recommended) for durable storage

## 1. Install and run

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000 and click through to the app at `/app`.

## 2. Configure local identity

Local development does not enforce sessions by default. The default role is `viewer` (read-only). To run agents and tools locally, set in `.env.local`:

```bash
OMNIAGENT_DEFAULT_ROLE=operator
```

Alternatively enable real auth locally with `OMNIAGENT_AUTH_ENABLED=true` plus `OMNIAGENT_BOOTSTRAP_EMAIL` / `OMNIAGENT_BOOTSTRAP_PASSWORD`, then sign in at `/login`.

## 3. Add the OpenAI key (recommended)

```bash
OPENAI_API_KEY=sk-...
```

Without it, agent runs stream a clearly labeled simulated response. With it, the agent runs a governed tool-calling loop: it can search memory and knowledge, run live web searches, write memories, ingest knowledge, list runs, and call any active MCP/OpenAPI connector tools below risk level 3.

## 4. Run your first task

1. Open **Run Agent** (`/app/command`).
2. Enter a goal — e.g. *"Search our knowledge for connector setup notes, then summarize what's missing."*
3. Watch the run stream: context retrieval, tool calls (with risk levels), and the final answer.
4. Tool calls that need approval appear in **Approvals** (`/app/approvals`); approving one executes it for real and resumes the same agent run with the approved tool result.
5. Final outputs and evidence land in **Results** (`/app/results`).

Press **⌘K** anywhere in the app to jump between workspaces.

## 5. Make it durable (optional)

Without `DATABASE_URL`, data lives in `.omniagent/` JSON files locally. Hosted production requires Postgres; no-DB hosted mode is blocked unless `OMNIAGENT_ALLOW_DEMO_STORAGE=true` is set for a disposable demo. For real persistence:

```bash
DATABASE_URL=postgres://...
```

The schema, pgvector columns, and HNSW indexes are created automatically on first use.

## 6. Verify your setup

```bash
npm test          # lint + unit tests
npm run build     # production build
```

Next: [deployment.md](deployment.md) for production, [architecture.md](architecture.md) for how it all fits together.
