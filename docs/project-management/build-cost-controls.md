# Vercel builds on demand

Prepared **6 October 2026 (IST)**. The repository now sets `git.deploymentEnabled` to `false` in [vercel.json](../../vercel.json). Vercel's Git integration will stop automatically building commits that carry this configuration. A reviewed preview can still be created explicitly through the CLI, and production remains on the existing paired web/worker release procedure.

This change is local until it is merged and reaches Vercel. It does not cancel existing builds, delete deployments, change retention or alter account billing settings. Older branches that do not contain the configuration may still generate automatic deployments; update active branches after merge rather than assuming this is a global account switch.

## Why this is worth doing

The private operations review found repeated automatic preview builds alongside
explicit governed releases. Reducing duplicate build activity is a more direct
first control than guessing at runtime tuning. The billing totals, deployment
counts, account configuration and raw export stay in private operator records.

Build counts and billed usage can cover different windows; neither establishes
a saving per build. Compare matched periods after adoption before reporting a
dollar reduction. The CLI release runner explicitly selects its release target;
this change does not alter the platform's Git production-branch setting.

## Exact behavior

| Action | Result after the commit's configuration is active |
| --- | --- |
| Push a commit or update a PR containing this setting | Vercel Git integration does not automatically create a build/deployment. |
| GitHub Actions on a PR or push to `main` | Existing CI still runs; [.github/workflows/ci.yml](../../.github/workflows/ci.yml) is unchanged. |
| Request one preview for a reviewed revision | An explicit CLI preview deployment remains supported; it incurs normal build/runtime usage. |
| Run the governed production release | [deploy-production.mjs](../../scripts/deploy-production.mjs) still stages with `vercel deploy --prod --skip-domain`, checks the paired release, then uses `vercel promote`. No release checks or runner arguments changed. |
| Browse the current production deployment | Existing deployment, domains, cron schedule and Singapore region are unchanged. |

Vercel documents this Boolean as the way to disable automatic Git deployments. Its separate release guide explicitly uses the same setting with CLI deployments and supports explicit previews. [Git configuration](https://vercel.com/docs/project-configuration/git-configuration), [CLI release guide](https://vercel.com/kb/guide/can-you-deploy-based-on-tags-releases-on-vercel).

The schema annotation points to [Vercel's current JSON schema](https://openapi.vercel.sh/vercel.json). Avoid replacing this setting with an always-failing build command, which introduces unnecessary build behavior and can obscure legitimate failures.

## Verification and activation

Local verification parses the entire JSON file, validates the changed Git object against Vercel's published schema, and checks that `regions`, `crons`, the paired deployment runner and GitHub CI workflows are unchanged. No application build or deployment is needed to establish those local facts. The reviewed schema was fetched on 6 October 2026 IST, with SHA-256 `d1140751c2e6e4aabb8146666519f1c26d5cb60b123e1f92b7280159331db3b3`.

After merge, carry this configuration into active branches and the next normal governed release. Confirm that a subsequent Git commit no longer starts a Vercel build, and that any intentionally requested preview or production release still has its expected receipt. Until then, count savings as pending, not achieved. Compare build CPU usage over matched time windows after adoption.

CI workflow definitions and GitHub-enforced required checks are distinct. Verify
branch-protection/ruleset configuration as a separate operations task. This
change neither creates nor weakens a platform rule.

If automatic previews become useful again, change the Boolean to a deliberate branch map and review its default behavior: unspecified branches are enabled, and a matching `true` rule wins. Prefer an explicit preview request while the team is reducing duplicate builds.
