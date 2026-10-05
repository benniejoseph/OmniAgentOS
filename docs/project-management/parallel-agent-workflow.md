# Codex and Claude Code working agreement

Use two separate worktrees and branches, one shared set of repository rules, and
one integration/deployment owner. This reduces conflicting edits; it cannot
guarantee that independently correct changes compose without review.

## Shared rules and current setup

Both tools follow root `AGENTS.md`, including the installed Next.js guides and
the tenant, approval, idempotency, and typed-event boundaries. `CLAUDE.md` already
contains `@AGENTS.md`; keep it as the thin import instead of maintaining a second
copy of the rules. Codex loads `AGENTS.md`; Claude supports the existing `@` import.
See [OpenAI instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [Claude imports](https://code.claude.com/docs/en/memory#import-additional-files).

As of 6 October 2026, Codex desktop works and Claude Code `2.1.282` runs locally.
The global npm-installed Codex CLI is missing its platform binary. Use the
desktop app until that separate installation issue is repaired and verified.

The current foundation branch is `codex/app-shaping-foundation`, based on
`70b1522a886383775636377864e378cab08c78a8`, in the `atlas-production-release`
worktree. That checkout belongs to the current Codex integrator. Claude must not
open it for writes. These paths are a dated snapshot, not permanent branch names.

## Start a task

1. The integrator records a small task with an ID, outcome, owner, branch/base
   commit, exact owned files/directories, excluded shared files, dependencies,
   acceptance checks, and estimate. Keep one active implementation slice per
   tool; reviewers may read other areas without modifying them.
2. Start both worktrees from the same reviewed main commit. Fetch/refresh main
   from the integration checkout before creating the task branches. Do not base
   fresh work on the stale primary checkout simply because it is open.
3. Codex uses a managed worktree with a `codex/<task>` branch. Claude uses its own
   worktree and branch, for example `claude/<task>`. Each checkout owns its own
   dependencies, `.next`, Flutter outputs, local configuration, and dev server.
4. Assign ports explicitly, for example Codex `3100` and Claude `3200`. Use
   separate disposable test databases or schemas. Neither agent runs migrations
   or integration tests against the production database while developing.
5. Before writing, each agent reports `pwd`, branch, base commit, and owned scope.
   Any required edit outside that scope is handed back to the integrator for a
   new assignment; it is not silently added to both branches.

Codex's [worktree workflow](https://learn.chatgpt.com/docs/environments/git-worktrees)
supports isolated checkouts. Claude's documented command is
`claude --worktree <task-name>`; alternatively, launch `claude` from a separately
prepared Git worktree with the exact selected base. Verify its actual branch and
HEAD after creation. See [Claude parallel worktrees](https://code.claude.com/docs/en/common-workflows#run-parallel-sessions-with-worktrees).
Worktrees isolate files; Git refs and infrastructure accounts remain shared.

## Ownership and merge order

| Area | Default owner and rule |
| --- | --- |
| Operations, release, schema and compatibility | Codex integrator initially. Claude may review or investigate read-only. |
| One assigned UI journey or tool adapter | Either Codex or Claude, with disjoint files and a concrete acceptance result. |
| Cross-review | The other tool reviews the diff; the author fixes findings in its own checkout. |
| Queue and live canvas | Integrator records accepted status; canvas owner presents those updates. Neither implementation agent claims a deployment from a merged PR alone. |
| Production changes | One named deployment owner, one release window, paired release runner only. |

Serialize changes to `package.json`/lockfiles, `schema-migrations.json`,
`supabase/migrations/`, database initialization/shared identity code,
`src/lib/mobile/contracts.ts`, generated native contracts/SDKs, shared types,
global design tokens/app shell, CI, deployment configuration, and release scripts.
Separate branches do not make simultaneous edits to those interfaces independent.
An API/contract owner lands the interface first; consumers update from that
commit. Never let both agents generate the same contract or lockfile concurrently.

For each slice: author opens a small PR, reviewer checks scope and behavior,
integrator merges the dependency first, then the next author updates from main
and reruns checks affected by the combined diff. Do not copy an entire checkout
over another, force-push another agent's branch, or overwrite conflicts with
“ours/theirs” without reviewing the actual behavior.

Only the integrator deploys the clean, reviewed main commit through
`npm run deploy:production`; the hosted-verification mode still requires the
repository's required green checks and paired health/revision gates. See
[production rollout](../production-rollout.md). Deferring redundant local tests
does not turn unverified work into a completed or deployed release.

## Task brief and handoff

```text
Task ID and user-visible result:
Owner / reviewer:
Worktree / branch / base SHA:
Owned files and shared files excluded:
Dependency PRs and merge order:
Acceptance checks:
Estimate and next update:
```

The handoff adds changed files, commit/PR, checks actually run, checks deferred,
known limitations, and any deployment/migration requirement. Use
`planned → active → review → merged → deployed → verified`, with `blocked` and a
specific dependency when necessary. A documentation-only task can finish at
merged; implementation completion, production deployment, and verified user
behavior must remain distinguishable.

Update the canvas when a task starts, changes scope, finds a blocker, completes
a review/build, or deploys. Record actual start/end timestamps, owner, evidence,
elapsed time, and a range for the next step. Do not invent historical durations
or a percentage when only task counts are known. The canvas is a view of the
current queue and recorded evidence, not another competing implementation plan.

## Retire a task

After its PR is integrated, record the outcome, stop task servers, and review
the worktree for unique commits, dirty files, and needed ignored artifacts.
Archive managed worktrees through their owning application only after preserving
those artifacts. Run [the repository inventory](repository-audit.md) before
batching archive decisions. Keep credentials in their authorized stores, outside
Git and task handoff text.
