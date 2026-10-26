# Information Architecture: Studio brand projects

## Site map

- Visual Studio `/app/studio`
  - All flows
  - Unassigned flows
  - Selected project `/app/studio?project=<id>`
    - Brand details (secondary dialog/panel)
    - New flow or template
    - Saved flow `/app/studio?project=<id>&flow=<id>`
      - Canvas, inspector, generation review, results and history
      - Apply latest brand details
      - Use in another project
- Existing project details remain in the Work/Projects experience.

## Navigation model

Retain the app's primary navigation. Studio adds one project selector above
its existing template and saved-flow content. Do not add profile, channel,
campaign and workspace selectors at the same level. Mobile uses the same
selection with touch-sized controls and focused dialogs.

## Content hierarchy

### Landing

1. Selected project and its readable brand name.
2. Create/open a flow.
3. Relevant starting points and saved flows, with search.
4. Brand details and project setup behind explicit actions.

### Flow editor

1. Flow title and current project.
2. Working canvas or phone step list.
3. Current selection and effective prompt in the inspector.
4. Generation review, results and history.
5. Brand update/copy controls as secondary actions.

## User flows

### First brand project

New project → choose starter or Custom → edit name and brief → save →
selected project's empty library → choose flow starter → edit → review/run.
Saving a project or flow does not generate media.

### Daily use

Choose project → open saved flow → refine the idea → review generation →
run → inspect results → Back returns to that project's library.

### Reuse across brands

Open source flow → Use in another project → choose authorized destination →
decide whether to retain reference assets → save copy with destination brief →
inspect and run the new flow. The source flow and history remain unchanged.

### Update brand details

Edit project brand details → save revision → an older flow shows an update is
available → Apply latest brand details → effective prompt and freshness
update. Earlier accepted run snapshots retain their original context.

## Naming conventions

| Concept | UI label | Meaning |
| --- | --- | --- |
| Grouping | Project | Existing Asael project; no new login or tenant |
| Reusable creative context | Brand details | The saved audience, style, voice and guidelines |
| Social identity metadata | Channels | Owner-entered platform, handle or link |
| DAG | Flow | Saved creative steps and references |
| Cross-project duplication | Use in another project | New flow with destination context |
| Snapshot refresh | Apply latest brand details | Explicit change to this flow's future work |

## Component reuse and growth

Reuse Studio transport, permission checks, pending request recovery, dynamic
canvas loading, template builders and semantic styles. Filter authorized
projects/flows before applying bounded list limits. Keep a complete bounded
flow inventory consistent with the enforced creation cap; do not silently
drop older projects after the newest 100 flows. Avoid loading the canvas or
media previews just to select a project.

## URL and saved-state rules

Project and flow IDs are validated opaque references, not authority. Server
ownership checks remain required. Normalize supported project aliases and
preserve project context on Back and refresh. Scope last-flow state by owner
and project; clear old owner state during account changes. Async responses
must not overwrite the newly selected project or actor.
