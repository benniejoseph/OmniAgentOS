# Information Architecture: OmniAgent Flutter

## Site Map

- Authentication `/login`
- Today `/today`
- Talk `/talk` and `/talk/:threadId`
- Capture `/capture`
- Work `/work`
  - Missions `/missions`, `/missions/:id`
  - Projects `/projects`, `/projects/:id`
  - Results `/results`, `/results/:type/:id`
- Inbox `/inbox`
  - Approvals `/inbox/approvals/:id`
  - Notifications `/inbox/notifications`
  - Alerts `/inbox/alerts`
- Agents `/agents`, `/agents/:id`, `/skills/:id`
- Knowledge `/knowledge`
  - Memory `/memory`, `/memory/:id`, `/memory/graph`
- Automation `/automation`
  - Workflows `/workflows`, `/workflows/:id`
  - Triggers `/triggers`
  - Operations `/operations`
- Integrations `/integrations`
  - Personal sources `/integrations/personal`
  - MCP `/integrations/mcp/:id`
  - OpenAPI `/integrations/openapi/:id`
- Tools `/tools`, `/tools/:id`
- Quality `/quality`, `/quality/evaluations/:id`
- Monitoring `/monitoring`
  - SLOs, incidents, alerts, diagnostics
- Security `/security`
  - Audits, isolation, retention
- Settings `/settings`
  - Account, appearance, notifications, data, identity, readiness
- Help, privacy, terms, about `/help/*`

## Navigation Model

- **Phone primary**: Today, Talk, Capture, Work, Inbox.
- **Phone secondary**: drawer exposes Agents, Knowledge, Automation, Integrations, Tools, Quality, Monitoring, Security, Settings according to permission.
- **Tablet/desktop primary**: grouped rail/sidebar: Workspace, Automation, Review, System.
- **Utility**: global search/command palette, notifications, readiness, tenant/role, appearance, account.
- **Context**: tabs within a domain; sheets on phone and persistent inspectors at wide breakpoints.

## Content Hierarchy

### Today
1. Current brief and priorities
2. Focus tasks and agenda
3. Active work and approval count
4. Recent conversations, projects, and memory

### Talk
1. Current objective and composer
2. Live stage, response, and tool activity
3. Plan/context preview and approval state
4. Evidence, citations, trajectory, and history

### Capture
1. Capture input and modality
2. Metadata and destination
3. Upload/indexing progress
4. Recent and queued captures

### Work
1. Active and attention-required items
2. State, next action, and progress
3. Task graph/artifacts
4. Evidence and history

### Inbox
1. Approval and alert urgency
2. Risk, requested action, and requester
3. Trust/quorum evidence
4. Resolved history

### Administration
1. Current health/readiness
2. Searchable resource list
3. Selected resource configuration and actions
4. Audit/evidence history

## Critical User Flows

### Start and supervise agent work
1. Open Talk or an agent deep link.
2. Enter goal, mode, and optional agent.
3. Review context/plan when durable execution is recommended.
4. Start and observe buffered SSE events.
5. If approval is required, move to Inbox and decide with risk evidence.
6. Return to resumed run and inspect final citations/trajectory.

### Capture anywhere
1. Open Capture or OS share target.
2. Add text, URL, document, scan, image, or voice.
3. Add title/tags and save.
4. If offline, retain in encrypted bounded outbox; flush idempotently on reconnect.
5. Open indexed knowledge with provenance.

### Manage durable work
1. Open Work and filter attention/active/completed.
2. Create or select Mission/Project.
3. Inspect tasks, attempts, capabilities, artifacts, and live events.
4. Continue, pause, retry, approve, or provide feedback as permitted.
5. Verify result evidence.

### Administer a governed integration
1. Open Integrations and choose OAuth, MCP, or OpenAPI.
2. Register/import without exposing credentials.
3. Discover and review contract/tool risk.
4. Activate and run a governed test.
5. Resolve approval if required and inspect audit evidence.

## Naming Conventions

| Concept | Label in UI | Notes |
| --- | --- | --- |
| Conversational execution | Talk | Matches the everyday workspace. |
| Autonomous durable objective | Mission | Primary outcome model. |
| Legacy structured outcome | Project | Preserved for full parity. |
| Human decision queue | Inbox | Includes approvals, access, alerts, notifications. |
| Agent and skill management | Agents | "Arsenal" may remain as a branded subtitle. |
| Stored organizational context | Knowledge | Memory is its structured subdomain. |
| Proof attached to an action | Evidence | Used consistently across runs, artifacts, audits, evaluations. |

## Component Reuse Map

| Component | Used on | Behavior differences |
| --- | --- | --- |
| AdaptiveShell | All authenticated routes | Bottom nav, rail, or sidebar by width. |
| ResourceScaffold | All data routes | Loading/empty/stale/error/forbidden/offline. |
| SearchFilterBar | Lists | Domain-specific filters and saved views. |
| StateRail | Runs, missions, workflows, projects | Domain-specific state machine labels. |
| EvidenceInspector | Talk, Work, Results, Quality, Security | Typed evidence renderers. |
| RiskDecisionSheet | Inbox, tools, workflows, integrations | Quorum and break-glass variants. |
| ResponsiveMasterDetail | Most admin/list domains | Route drill-down on phone, split pane on wide screens. |

## Content Growth Plan

All ledgers use cursor pagination, filtering, search, and virtualized lists. Active work is separated from archive. Graphs load bounded neighborhoods. Reports and media use lazy detail retrieval. Dashboard aggregates use stale-while-revalidate caches.

## URL Strategy

- Flutter named routes mirror domain nouns and opaque resource IDs.
- Deep links support missions, projects, threads, runs, approvals, notifications, OAuth completion, and shared capture.
- Filters use query parameters; sensitive state and session material never appears in links.
