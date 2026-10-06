# Repository inventory and cleanup

Snapshot: 6 October 2026, against `origin/main` at `70b1522a886383775636377864e378cab08c78a8`.
This is an inventory and a focused review of organization, retained artifacts,
and source size. It is not a full dead-code, dependency, security, or behavior audit.

## What is verified

| Finding | Evidence and implication |
| --- | --- |
| The primary checkout was stale | Initially clean on `main`, 32 commits behind the observed remote main. It was fast-forwarded to `70b1522a` during this pass; new work stays in a separate worktree. |
| Worktrees have accumulated | 31 registered checkouts. At the initial snapshot all had clean tracked and nonignored state. Two are primary/current integration; 16 historical heads are reachable from main; 13 have history not reachable from main. A clean checkout can still hold ignored credentials, builds, or release evidence. |
| Some “unmerged” work is already integrated | `git cherry origin/main <branch>` marks the sole patch on `fix/document-parse-heap-flag`, `codex/release-followups`, and `codex/native-payments-ui-stability` as equivalent to a patch on main. Commit ancestry alone overstates pending functionality. |
| No obvious tracked build garbage | A tracked-path scan found no checked-in dependency trees, `.next`, coverage, logs, or temporary build output. The cognition API directory named `build` is legitimate application source. This does not prove every asset is used. |
| Large contract files are intentional | Native OpenAPI v45/v46/v47 are about 5.3/5.5/5.7 MB. `src/lib/mobile/contracts.test.ts` requires v45/v46 to remain byte-frozen. They are compatibility evidence, not deletion candidates. |
| Documentation status has drifted | Architecture/README entry points still referred to Neon while the current deployment guide specifies Supabase. Deployment prose also describes the released v46/v47 sequence as pending. `IMPLEMENTATION_PLAN.md` is a historical builder log, not the current queue. |
| Several source files deserve bounded extraction | `agent-runs-workspace.tsx`: 7,350 lines; Flutter `talk.dart`: 8,076; schema `identity.ts`: 12,156; database integration suite: 10,584. Size identifies review candidates; it is not evidence that their logic should be deleted. |
| Desktop/CLI setup differs | Claude Code `2.1.282` runs locally. The global `codex --version` failed with a missing platform binary; the active Codex desktop session works. Repair the global CLI independently if terminal Codex is needed. |

## Worktree disposition

Keep the primary checkout and current integration worktree. Review the following
16 historical worktrees for archiving once their owning chat is idle and any
needed ignored artifacts have been preserved:

`adaptive-runtime-canary`, `atlas-power-build`, `native-connector-lifecycle`,
`native-connector-trash`, `native-credential-rotation`, `native-github-upgrade`,
`native-mcp-registration`, `native-registration-release`, `native-rotation-build`,
`provider-acl-forward-fix`, `release-manifest-convergence`, `release-recovery`,
`today-notification-repair`, `v45-dashboard-cold-start`, `OmniAgent-release`,
and Claude's `wonderful-lumiere-703081`.

The other 13 historical checkouts need a patch/content review before disposition:

| Worktree or branch | Initial disposition |
| --- | --- |
| `0176`, `.asael-command-deploy-cb290fd`, `.asael-today-deploy-352839d` | Divergent long histories; preserve until an explicit comparison identifies retained work. |
| `atlas-web-foundation`, `atlas-low-power` | Preserve ATLAS design/measurement history and ignored review artifacts. |
| `dashboard-readiness-contingency` | One non-equivalent patch; compare with current readiness code before adoption or retirement. |
| `native-registration-build` | Detached build history; compare generated outputs and preserve package evidence. |
| `OmniAgent-db-followups`, `OmniAgent-native-followups`, `OmniAgent-script-followups` | Non-equivalent historical follow-ups; inspect whether their intent was superseded before deciding. |
| `native-memory-release`, `OmniAgent-followups`, Claude's `nervous-bell-5dbe9c` | Patch-equivalent to main; review owner/ignored artifacts, then eligible for archive review. |

Use the owning app's recoverable archive for managed worktrees. Do not run a bulk
`git clean`, recursive deletion, branch deletion, or `worktree prune` as a cleanup
shortcut. Do not copy credential files into Git to preserve them. The inventory
does not authorize deletion.

### First retirement completed, 6 October

`native-rotation-build` (`9148f045f210`) and `atlas-power-build`
(`83dedb07b826`) were confirmed attached to the current chat, idle at the process
check, clean, and ancestors of main. Their older macOS app builds `1.23.26+62`
and `1.23.27+63`, plus matching debug symbols, are preserved in private archives
in the private operator release-records directory outside this public repository.
`preservation-manifest.json` records SHA-256, size, source revision, and matching
binary/symbol UUIDs. Archive member inspection verified only the two bundles and
their macOS metadata; each retains twelve symbolic links without dereferencing.
The apps are historical ad-hoc builds, not newly signed distribution packages.

The managed archive operation requires removing embedded dependency Git clones
first. All thirteen Swift checkout repositories in each worktree were clean,
with their heads reachable from cached origin/tag refs and no local-ref-only
commits. A separate copied Firebase package in each cache differed from its
original by one file; both small copies were preserved in private archives with
checksums. After fresh clean-state and process checks, only the exact ignored
`apps/flutter/build/macos/SourcePackages` directory was removed from each of
these two worktrees. `cache-cleanup.json` beside the preservation manifest records
the comparisons and removal results. Both managed worktrees were then archived;
the filesystem and Git worktree inventory confirm their removal. The current
count is 29, including the primary and active integration checkouts.
`native-registration-build` remains retained because its detached head has a
non-equivalent source commit.

## Reproduce the inventory

```sh
node scripts/inventory-worktrees.mjs
git cherry origin/main <branch-under-review>
```

The script reads local Git metadata, status counts, and the presence/type of a
small set of local directories/files. It does not fetch, read environment file
contents, walk dependency trees, follow symlinks, or delete anything. Each Git
operation has a ten-second timeout; the whole inventory has a ninety-second
budget and a hundred-worktree cap. `origin/main` freshness is a separate fetch
decision owned by the integrator. Errors remain explicit instead of becoming
“clean” results. JSON contains local paths; keep detailed output local.

## Small cleanup packages

These are work packages for the current queue, not a second status tracker.
Estimates are focused working time, excluding review, CI queues, and production
observation. Re-estimate after the first package.

| Order | Package / suggested owner | Acceptance | Initial effort |
| --- | --- | --- | --- |
| 1 | Current documentation and ownership / integrator | One queue and workflow entry point; correct production topology/version language; historical logs clearly labeled. | 30–60 min |
| 2 | Worktree archive review / integrator | Each retired checkout has a recorded owner, disposition, and preserved required ignored evidence; unique work retained. | 45–90 min |
| 3 | One user journey at a time / Codex + Claude reviewer | Start with Talk/Work and results: identify confusing states, remove one proven obsolete path, confirm empty/error/loading behavior, review changed behavior. | 1–2 hours per small slice |
| 4 | Dependency and asset usage / Claude + Codex reviewer | Inventory imports, dynamic loads, generated-contract use, and release inputs; remove only a demonstrably unused item with a build check. | 60–120 min |
| 5 | One component extraction / assigned implementation owner | Pick one cohesive boundary in the large Talk/run UI; preserve public behavior and scope checks; focused verification before broader refactoring. | 2–4 hours |
| 6 | Schema/test modularity / integrator-owned separate change | Preserve migration checksums and initialization order; split only after module dependencies and regression coverage are mapped. | Estimate after mapping |

Archive space savings have not been measured. No production rows, migration
files, contract archives, or application dependencies changed in this pass.
The two reviewed generated Swift caches were removed after preserving their
needed artifacts, and the two completed worktrees were recoverably archived.
