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
- Automation Studio `/automation`
  - Overview `/automation?view=overview`
  - Automations `/automation?view=automations`
    - Runs `/workflows`, `/workflows/:id`
    - Triggers `/triggers`
  - Skills `/automation?view=skills`, `/skills/:id`
  - Connections `/automation?view=connections`
    - Personal sources `/integrations/personal`
    - External MCP servers `/integrations/mcp/:id`
    - REST APIs `/integrations/openapi/:id`
  - Plugins `/automation?view=plugins`, `/plugins/:id`
  - Advanced capability audit `/automation?view=advanced`
    - Tools `/tools`, `/tools/:id`
    - Operations `/operations`
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
- **Tablet/desktop primary**: grouped rail/sidebar: Workspace, Extend & Automate, Review, System. Automation Studio is the primary entry; legacy Workflow, Integration, and Tool routes remain deep links rather than competing mental models.
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

### Automation Studio
1. Plain-language capability map and items needing attention
2. Automations, Skills, Connections, MCP servers, and Plugins by user intent
3. Exact permissions, versions, connection health, and recent execution state
4. Advanced tool registry, queue, recovery, and audit evidence

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
1. Open Automation Studio → Connections and choose an account, MCP server, or REST API.
2. Register/import without exposing credentials.
3. Discover and review contract/tool risk.
4. Activate and run a governed test.
5. Resolve approval if required and inspect audit evidence.

### Install a declarative plugin
1. Open Automation Studio → Plugins and inspect the publisher, version, integrity digest, and included resources.
2. Review requested Skills, external MCP requirements, automation templates, and effective permissions.
3. Confirm the exact installation preview; credentials are never carried in the plugin manifest.
4. Install the pinned manifest. Skills remain actor-owned, connections still require their normal credential and contract review, and every resulting tool remains governed.
5. Disable, upgrade, or remove the plugin without bypassing the existing resource lifecycle or audit ledger.

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
| Reusable agent instructions | Skill | Teaches an Agent how to perform a kind of work; never grants authority. |
| External protocol connection | MCP server | Supplies tools or resources to Asael. “Asael MCP server” is reserved for the opposite direction in Settings. |
| Single callable operation | Tool | The governed action an Agent can request. Kept under Advanced for most users. |
| Triggered repeatable procedure | Automation | A reusable procedure plus schedule/event trigger and its run history. |
| Versioned extension bundle | Plugin | Declarative package of Skills, connection requirements, and automation templates; never arbitrary server code. |
| Account, source, or API authorization | Connection | Replaces the broad “Integration” label in primary navigation. |

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
| AutomationStudio | Automation overview and its six views | Tabs on wide screens; compact view menu on narrow screens; advanced operational controls stay disclosed. |

## Content Growth Plan

All ledgers use cursor pagination, filtering, search, and virtualized lists. Active work is separated from archive. Graphs load bounded neighborhoods. Reports and media use lazy detail retrieval. Dashboard aggregates use stale-while-revalidate caches. Plugin installations pin an exact manifest version and digest; catalog growth uses publisher/category filters and never auto-enables newly added permissions.

## URL Strategy

- Flutter named routes mirror domain nouns and opaque resource IDs.
- Web uses `/app/automation?view=<view>` as the canonical Automation Studio URL while legacy `/app/workflows`, `/app/connectors`, and `/app/tools` remain compatible deep links.
- Deep links support missions, projects, threads, runs, approvals, notifications, OAuth completion, and shared capture.
- Filters use query parameters; sensitive state and session material never appears in links.
