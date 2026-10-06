# Current work: shape Asael one slice at a time

Updated **6 October 2026 (IST)**. This is the small current queue; the large
[implementation plan](../IMPLEMENTATION_PLAN.md) retains historical release
evidence. This queue does not supersede security, compatibility, or release gates.

## What can be used now

Production UI and ATLAS, native connector management and the paired worker are
on revision `70b1522a`, schema 245, native contract 47/46 and Mac build 69
(`1.23.33+69`). Web and gateway health were rechecked during this audit. The
[tool catalog](agent-tool-catalog.md) distinguishes implemented capabilities,
account/device prerequisites, and missing renderers. A healthy endpoint is not
a claim that every integration has credentials or every journey was retested.

The [local live canvas](http://127.0.0.1:47868/) shows task owners, evidence,
dependencies and elapsed time while its local server runs. It preserves the
completed 18-step release history separately from this work. It is an operator
view, not a production feature or an autonomous implementation service.

## Foundation completed in this pass

| Result | Evidence and delivery state |
| --- | --- |
| Worktree/source inventory | [Audit](repository-audit.md), [read-only script](../../scripts/inventory-worktrees.mjs); initial 31-worktree snapshot, divergent work retained |
| Shared checkout brought current | Primary `main` fast-forwarded from `32da7e8f` to deployed `70b1522a`; implementation remains on its separate foundation branch |
| Shared Codex/Claude agreement | [Working agreement](parallel-agent-workflow.md); separate worktrees, explicit ownership, cross-review and one release owner |
| Tool inventory and current free options | [Catalog](agent-tool-catalog.md); no duplicate dependencies installed or new providers activated |
| Live provider baseline | [Usage/error/access review](provider-usage-audit.md); billing and errors separated by window/revision |
| Build-cost control prepared | [Builds on demand](build-cost-controls.md); validated local config, adoption/savings still pending |
| Current documentation entry point | README/AGENTS link here; stale Neon topology corrected; historical release notes labeled |
| First cleanup batch preserved | Mac builds 62/63 and matching symbols plus modified generated package copies preserved privately; two generated Swift caches removed and both managed build worktrees archived (29 remain) |

Foundation files are on `codex/app-shaping-foundation`. A local validated change,
a merged PR, an adopted configuration and a verified production behavior are
different milestones. Record each explicitly.

## Ordered next slices

Estimates are focused engineering effort **after prerequisites are available**,
not promises of unattended completion or a single full-app deadline. Wider
cleanup remains unsized until each module is reviewed.

| Priority / ID | Bounded outcome | Initial owner / reviewer | Estimate | Done when |
| --- | --- | --- | --- | --- |
| P0 / OPS-01 | Supabase API/ACL boundary hardening | Codex / Claude review | 0.5–1 day after consumer review; rollout window separate | Intended callers preserved, unintended grants/defaults closed, isolated restore and guarded release verified |
| P1 / OPS-02 | Adopt build-on-demand config; trace stale tick caller | Codex / Claude review | 1–3 hours; external caller access may add delay | Git pushes stop redundant Vercel builds, explicit release works, stale unauthorized polling stops without relaxing auth |
| P1 / OPS-03 | Protect `main` and establish one merge/release owner | Codex / owner review | 30–60 minutes after confirming required check names | Platform rules enforce current CI, bypass policy documented, governed release remains sole promotion path |
| P1 / HYG-02 | Reconcile remaining worktrees and ignored artifacts | Codex / Claude read-only review | 2–4 hours per small batch | Unique work/evidence preserved, retired checkouts archived, inventory shows the result |
| P1 / UX-01 | One capability/readiness view and clear navigation to existing tools | Claude in its own worktree / Codex review | 0.5–1 day | Ready, needs connection/device, quota exhausted, and unimplemented states match real contracts |
| P2 / TOOLS-01 | One capped basic-search adapter | Either assigned author / other reviewer | 1–2 days | Governed search, citations, limits and permitted fallback verified; explicit account setup before live use |
| P2 / TOOLS-02 | Downloadable DOCX artifact | Other disjoint author / assigned reviewer | 1–2 days | Private bounded renderer, idempotent artifact lifecycle, editable sample and download verified |
| P2 / COST-02 | Image quality/cost visibility and interval DB profile | Codex / Claude review | 0.5–1 day each | Pricing uncertainty visible; current query deltas justify any subsequent tuning |

Start OPS-01 before adding services. UX-01 can proceed independently once shared
shell/contract ownership is fixed. Search and DOCX share the tool registry and
possibly dependencies: serialize those files even when renderer/adapter work is
parallel. Review Command, Today/Inbox, Connections, then Library/Artifacts as
separate user journeys; do not call every built module complete from code volume.

## Working rules

One brief per slice: outcome, owner/reviewer, exact worktree/base, owned files,
shared-file exclusions, dependency, acceptance and estimate. Use
`planned → active → review → merged → adopted/deployed → verified`.
Credentials, customer content and raw provider logs stay outside the queue and
Git. Update the canvas on a meaningful state change. For measured time, retain
real timestamps; leave unrecorded history explicitly unknown.

Use Desktop Codex now. Claude Code is installed; the global Codex CLI's platform
binary needs a separate repair before terminal-only Codex work. This working
agreement does not mean an independent Claude implementation has been launched.
