# Build Tasks: OmniAgent Flutter App

Generated from `.design/flutter-app/DESIGN_BRIEF.md` on 2026-08-27.

## Foundation

- [ ] **Native session vertical slice**: Add secure mobile device sessions, bootstrap DTO, uniform errors, and Flutter login/session gate. _Creates backend mobile auth and Flutter core/auth._
- [ ] **Precision-instrument shell**: Build the adaptive role-aware shell, theme modes, resource states, command palette, notification badges, and accessibility foundations. _Creates shared Flutter components from existing web tokens._
- [ ] **Contract and transport layer**: Add typed DTO fixtures, Dio interceptors, secure session persistence, request/idempotency IDs, SSE parser, multipart/binary support, pagination, and offline cache. _Creates shared infrastructure._

## Core Workspace

- [ ] **Today**: Brief generation, priorities, schedule preferences, focus items, agenda, active work, recent resources, refresh and partial errors. _Creates feature/today._
- [ ] **Talk**: Threads, modes, agents, five-stage execution, context/plan preview, SSE streaming, cancel/resume, tools, approval waits, speech, citations, trajectories and evidence. _Creates feature/talk._
- [ ] **Capture**: Text/share target, files, camera, audio transcription, image generation, tags, offline outbox, source sync and recent indexing. _Creates feature/capture._
- [ ] **Missions**: Create/list/detail, statuses, tasks/attempts, capabilities, cursor events, follow-up, artifacts, attention and proof. _Creates feature/missions._
- [ ] **Projects**: Planning, tasks, modes/lanes, execution controls, assignments, artifacts, feedback and memory promotion. _Creates feature/projects._
- [ ] **Results**: Aggregate runs, workflows, evaluations and release evidence with filters, drill-down, downloads and verification. _Creates feature/results._

## Governance and Knowledge

- [ ] **Inbox**: Tool/workflow/SLO approvals, quorum, trust state, access requests, notifications, alerts, continuation and failure states. _Creates feature/inbox._
- [ ] **Agents and skills**: Roster/map, custom agent and skill builders, assignment, model/memory/authority policy, launch and performance. _Creates feature/agents._
- [ ] **Knowledge and memory**: Search, filters, list/graph, inspector, add/correct/contradict/forget, provenance and retrieval traces. _Creates feature/knowledge._

## Automation and Administration

- [ ] **Workflows**: Plan preview, idempotent start, executions, signals, tick, recovery, triggers and operations. _Creates feature/automation._
- [ ] **Integrations**: Google sources, MCP lifecycle, OpenAPI lifecycle, catalog, secret references, destructive purge, governed test. _Creates feature/integrations._
- [ ] **Tools**: Catalog, risk model, dry/live execution, web search and audit history. _Creates feature/tools._
- [ ] **Quality**: Evaluations, safety lanes, reports, signed verification, release gates and isolation. _Creates feature/quality._
- [ ] **Monitoring**: Timeline, SLOs/policies, incidents/actions, alerts and diagnostics. _Creates feature/monitoring._
- [ ] **Security**: RBAC/context, audits, signed export/verification, isolation and retention. _Creates feature/security._
- [ ] **Settings**: Account, appearance, notifications, readiness, identity control plane, data export/restore, health and release metadata. _Creates feature/settings._

## Platform Hardening

- [ ] **Mobile OAuth and deep links**: PKCE one-time code exchange, universal/app links, safe callback recovery. _Modifies backend OAuth and Flutter auth._
- [ ] **Push and telemetry**: Add consented APNs/FCM delivery, crash/performance monitoring, device registration and notification deep links. _Optional Firebase edge services only._
- [ ] **Media transport**: Replace large base64 payloads with tenant-scoped binary/object delivery where required. _Modifies backend media and Flutter cache._
- [ ] **Offline and lifecycle**: Background-aware polling, cursor resumption, safe drafts/cache, bounded encrypted storage and mutation conflict recovery. _Modifies shared infrastructure._

## Responsive, Quality, and Release

- [ ] **Full state coverage**: Loading, empty, stale, partial, forbidden, offline, validation, conflict, approval-waiting, retry and destructive confirmation in every feature. _Modifies all features._
- [ ] **Accessibility and responsive pass**: Phone/tablet/desktop, dynamic type, keyboard, semantics, high contrast and reduced motion. _Modifies all UI._
- [ ] **Automated verification**: Unit, widget, golden, contract, integration, performance, security and tenant-isolation suites. _Creates all test layers._
- [ ] **Design review**: Capture and review every primary surface and critical state against the brief. _Creates design review evidence._
- [ ] **Release**: Signed internal iOS/Android builds, version gating, staged rollout, SLO monitoring, then desktop/web validation. _Creates release automation._
