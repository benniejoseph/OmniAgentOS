# Studio brand projects

## User need

One owner creates image and video content for several accounts: Fashion,
Trading, and AI/Tech. They need to find the right flows, reuse a working
structure, and retain each brand's audience and creative direction without
re-entering the same brief for every run.

The owner confirmed these are content brands within the current Asael login.
Platform and handle details are optional owner-entered metadata;
they do not establish an authenticated social connection.

## Product decision

Use existing Asael Projects as the only grouping layer. Add a Studio brand
profile to a project, rather than introducing another account, tenant, or
campaign hierarchy. Existing projects and unassigned flows remain available.

The main path is: choose project, choose or create a flow, refine the idea,
review generation, run. Secondary actions manage brand details, assign a
flow, and reuse a flow in another project.

## Scope

- A project selector with All flows and Unassigned views.
- New project setup with editable Fashion, Trading, AI/Tech, or Custom choices.
- Saved brand name, audience, content pillars, voice, visual direction,
  guidelines, and optional channel names/handles/links.
- New flows inherit an explicit brand-context snapshot.
- Existing flows offer Apply latest brand details; profile changes never
  silently rewrite a flow or an admitted run.
- Copy to another project applies that destination's context, excludes run
  history, clears generated-output selections, and clears reference assets
  by default unless the owner deliberately retains them.
- Project-aware navigation, persistence, recovery, and bounded listings.

Keep the recently simplified Studio layout, shared semantic tokens, keyboard
access, and phone composition. Brand details belong in a secondary panel;
the canvas and saved-flow library remain the primary surfaces.

## Observable acceptance

1. Create two synthetic projects with visibly different profiles.
2. Create a flow in each, refresh, and switch projects without mixing lists or
   reopening another project's previous flow.
3. Confirm the effective prompt contains only the selected saved context,
   exactly once, and that changing it affects generation freshness.
4. Edit a profile and explicitly apply it to one flow. Existing accepted run
   snapshots and their results remain unchanged.
5. Copy a flow into the other project and verify destination context,
   reference handling, empty paid history, and preserved source flow.
6. Reject foreign-owner project/profile/flow requests and stale revisions;
   recover repeated creation without duplicate projects or flows.
7. Exercise a bounded Demo generation through durable queue/storage, using
   no new paid media generation.
8. Verify desktop and phone navigation, dialog focus, labels, error recovery,
   and the Back path before the paired release.

## Boundaries

This work does not add social publishing, social OAuth, a second billing
account, native canvas implementations, or autonomous execution on project
creation. Existing authentication, actor scope, provider configuration,
generation review, and release checks remain authoritative.
