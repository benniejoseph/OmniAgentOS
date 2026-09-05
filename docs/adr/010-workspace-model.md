# ADR 010: Workspace, project, and work-item model

Status: Accepted · 2026-09-05

## Context

Projects, Missions, Today, Conversation, notifications, and agents currently expose overlapping views of work. Independent ownership and status fields can drift, while tenant membership alone is too broad to define access to a workspace or project.

Asael needs one durable hierarchy for planning and ownership without breaking existing Mission identifiers, history, URLs, or execution flows.

## Decision

The canonical target hierarchy is exactly:

`Workspace → Project → WorkItem`

A Workspace is a collaboration and policy boundary within one tenant. A Project belongs to one Workspace. A WorkItem belongs to one Project and carries its milestones, dependencies, owners, assigned agents, schedules and recurrence, risks, decisions, and artifact references.

A Mission becomes a compatibility and execution view over canonical Projects, WorkItems, governed runs, and verified receipts. It is not a sibling task store and cannot maintain an independent authoritative status. Retaining `missionId` in an execution scope is a compatibility coordinate, not a second work hierarchy.

Each WorkItem has one authoritative status. Projects, Missions, Today, Conversation, notifications, and agents consume projections of that status. Execution state is derived from real governed runs and receipts; opening, viewing, or drafting a Mission cannot manufacture success.

## Canonical authority and compatibility

The hierarchy is the target canonical model, but each current Project or Mission store remains authoritative only for the records and fields its existing contract owns until the relevant cutover satisfies ADR 005. Neither legacy store gains precedence over an overlapping field by name matching or write time. If two candidate mappings disagree about ownership, scope, status, or history, the mapping and candidate WorkItem are quarantined; existing view-specific legacy state remains visibly labeled as legacy/unreconciled, and no canonical WorkItem status or governed effect is inferred until repair. Explicit compatibility records map legacy Project and Mission identifiers, history, and URLs to canonical Workspace, Project, WorkItem, and execution coordinates. Mappings never infer ownership or scope from matching names, creators, tenants, or content.

Known procedures are represented as deterministic workflows or playbooks attached to WorkItems. Open-ended work uses the bounded agent loop. Both routes produce the same governed execution and verified-outcome records.

Workspace and project context may select shared assets and context within their grants. It never broadens access to a user's private memory, an agent's private memory, or another workspace.

## Migration and cutover

1. Publish versioned Workspace, Project, WorkItem, status, membership, and compatibility contracts.
2. Add the hierarchy and mappings without changing existing pages or read authority.
3. Atomically dual-write current Project and Mission changes with typed events/outbox records.
4. Backfill identifiers, ownership, status history, and execution links resumably; quarantine ambiguous relationships.
5. Shadow-project every existing view and require parity for status, history, links, assignments, and deletion behavior.
6. Canary new work for selected tenants while existing work remains pinned to its legacy contract.
7. Persist the selected model and projection generation, then move all views to the same WorkItem status projection.
8. Observe through rollback before retiring overlapping legacy writes in a later change.

The migration does not redesign pages before the canonical projection is proven. Starting assigned work may launch a governed run only after the same authorization and approval checks used elsewhere.

## Rollback

Rollback returns readers to the prior Project and Mission adapters and the last proven projection generation. Stable mappings preserve legacy IDs, URLs, and history, and atomically maintained prior stores remain available during the rollback window.

Rollback never creates another task authority, discards committed execution evidence, resurrects deleted work, widens workspace membership, or rewrites in-flight run scope.

## Permanent security floors

- Tenant membership does not imply Workspace membership; Workspace membership does not imply access to every Project, asset, private memory, or action.
- Tenant, Workspace, Project, WorkItem, human actor, and agent principal coordinates remain explicit in authorization, RLS, events, runs, and receipts.
- Cross-tenant or orphan mappings are invalid, and ambiguous legacy scope is quarantined rather than guessed.
- Asset and context inheritance may preserve or narrow access only.
- Deletion tombstones, revocations, approvals, idempotency, governed tool execution, and verified outcomes survive migration and rollback.

## Consequences

- Every surface can converge on one work status and one execution history without losing familiar Mission entry points.
- Compatibility mapping and dual operation add temporary complexity and require strict parity evidence.
- Workspace membership and asset sharing become explicit policy decisions instead of side effects of tenant, Project, Mission, or agent ownership.
