# Cloud development inside Asael

Research date: 2026-10-07. Code inspected at `f9325046fd7fecd30b3254e05abe7ccf492de580` on `codex/today-memory-atlas`. This is a source-based feasibility report, not a live provider readiness check. No infrastructure, credentials, tests, builds, or deployments were changed.

## Answer and recommendation

**Yes: Asael can become the place where the owner develops Asael and other selected repositories from a phone, tablet, or browser, without this Mac running.** Much of the cloud workspace and delivery foundation already exists. The missing product is a durable, independently resumable coding task with a Codex/Claude runtime, clear diffs and approvals, and an appropriate release pipeline.

Reuse the existing Vercel Sandbox and governed builder services. Start with one Codex runner and one task-owned workspace/branch; add Claude through the same interface after that path works. Keep Forge/Sentinel available. Do not begin by migrating sandbox providers or allowing a coding agent to deploy Asael directly.

## What the repository actually has

| Capability | Evidence and current boundary |
| --- | --- |
| Cloud workspace | `src/lib/app-builder/sandbox.ts` creates a persistent Node 24 Vercel Sandbox with 2 vCPUs, a 30-minute session timeout, 30-day snapshots, and npm-registry-only egress. It does not execute on the Mac. |
| Governed editing | `src/lib/tools/app-registry.ts`, `src/lib/app-services/app-builder.ts`, and `src/lib/app-builder/contracts.ts` expose scoped tree/search/read/update/delete, exact file hashes, session revisions, checkpoint/restore and typed receipts. Shell access is a fixed npm command family, not a general terminal. |
| Real UI | `src/components/app-builder-studio.tsx` is mounted in Projects → Build. `apps/flutter/lib/features/builder/` implements the native client; generated native contracts publish `workspaces.builder.get/update`. Provider configuration and current device enrollment still determine usability. |
| Existing coding agents | `src/lib/app-builder/agent-request.ts` sends project-scoped Forge/Sentinel requests through Asael's `/api/agent`. This is Asael's own governed loop; neither the Codex SDK nor Claude Agent SDK is integrated. |
| Private previews and verification | The sandbox preview uses actor/project/session-bound access. `src/lib/app-builder/verification.ts` now uses deterministic checks and deployment route/build evidence. Browser screenshots are **retired historical fields**, despite older descriptions in the earlier builder research document. |
| Repository import and PRs | `src/lib/app-builder/github.ts` uses an allowlisted GitHub App installation and exact default-branch SHA; it imports a tar archive and delivers a reviewed diff to a new branch/draft PR. Git credentials stay in the broker. This is not a full Git worktree with branch switching, rebase or merge. |
| Preview and release | `src/lib/app-builder/vercel.ts`, deployment/release stores and services implement Vercel preview and separate digest-bound production review. Declared migrations block generic production release; rollback metadata records a prior deployment. This is not Asael's paired release system. |
| Durable foundations | Builder sessions/checkpoints/events live in Postgres with tenant/actor/project scope. `src/lib/operations/job-queue.ts` already has leases, retries, quarantine, `agent.execute` and `agent.resume`; these are reusable foundations, not an existing vendor coding-process supervisor. |

The historical `IN_APP_AGENT_APP_BUILDER.md` records earlier sandbox canaries, but also calls GitHub/Vercel credentials operational gates. This research did not inspect secrets or claim that repository delivery works in the current production configuration.

Important current limits: one builder session per tenant/actor/project (`store.ts` uniqueness), root `package.json` required, npm installs ignore lifecycle scripts, 8-minute command timeout versus a 300-second HTTP route, bounded file reads, a 25 MB repository archive, and 500 changed files/8 MB delivery limits. Large repositories, monorepos, long builds, arbitrary languages and simultaneous writers need explicit accommodation. A persistent filesystem does not by itself guarantee that an agent turn survives closing the browser or a worker restart.

## Coding runtime choices

| Choice | Fit for Asael | Main tradeoff |
| --- | --- | --- |
| Existing Forge + governed tools | Fastest way to expose useful cloud editing using present code | Smaller command/repository boundary; not the Codex or Claude coding harness |
| **Codex app-server / SDK** | Recommended first vendor adapter. SDK is useful for task execution; app-server better fits interactive approvals, streamed events and follow-up turns | Requires a hosted process, state persistence and a bridge into Asael governance |
| Claude Agent SDK | Second adapter for independent Claude implementation/review tasks | Separate process/runtime and API billing; permission hooks, settings and session persistence need deliberate integration |
| Vendor-hosted cloud agents | Potential later alternative to operating the execution process | Different harness/API/entitlements; evaluate separately rather than treating a desktop login or consumer cloud UI as an embeddable API |

OpenAI's TypeScript SDK starts/resumes local Codex threads server-side on Node 18+. Here “local” means local to our cloud runner, not this Mac. `codex exec --json` supports structured execution events and explicit workspace permissions. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode).

For a Codex-like UI, app-server exposes conversation history, streamed events and command/file approval requests with thread/turn identities. Store those identities and reconnect through Asael rather than exposing a raw app-server port publicly. [Codex app-server](https://learn.chatgpt.com/docs/app-server).

Claude's Agent SDK runs the Claude Code binary from TypeScript/Python; `claude -p` offers headless JSON/stream output. Its permissions and hooks must map to Asael decisions. Use reviewed explicit settings instead of auto-loading arbitrary repository hooks/MCP configuration. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [programmatic execution](https://code.claude.com/docs/en/headless).

**Authentication:** provider API credentials and usage billing are the dependable initial path. OpenAI separately documents ChatGPT plan usage for open-source/local apps, but directs paid or remotely hosted app integrations to an interest form; eligibility for hosted Asael is unconfirmed. Anthropic says third-party apps must use API authentication unless previously approved to offer claude.ai login/rate limits. Do not copy this Mac's login/session files into a shared service or promise that existing subscriptions cover Asael usage. [OpenAI authentication](https://learn.chatgpt.com/docs/auth), [ChatGPT plan usage scope](https://developers.openai.com/siwc/token-sharing-open-source), [Claude integration policy](https://code.claude.com/docs/en/agent-sdk/overview).

## Hosting and cost

Published USD rates below were read on the research date; taxes, model tokens, production hosting and region differences are excluded. These are comparisons, not a quote for the owner's current accounts.

| Runtime | Relevant published pricing | Decision |
| --- | --- | --- |
| **Vercel Sandbox, existing integration** | `iad1`: active CPU $0.128/hour, provisioned memory $0.0212/GB-hour, snapshots $0.08/GB-month. Pro Sandbox consumption draws from the shared $20 monthly credit, then usage billing. | Lowest integration effort; retain initially |
| Modal Sandbox | $0.00003942/physical-core-second and $0.00000667/GiB-second; one physical core is described as 2 vCPUs. Starter includes $30/month compute credit. Sandbox rates differ from cheaper Modal Function rates. | Viable alternative if measured workloads justify a new adapter; not automatically cheaper |
| E2B | 2 vCPU + 4 GiB costs $0.000046/second ($0.1656/hour). Hobby has $100 **one-time** credit and one-hour sessions; Pro adds $150/month plus usage for longer sessions. | Useful pause/resume semantics; fixed Pro cost unattractive for an initial single-owner rollout |

Sources: [Vercel pricing](https://vercel.com/docs/sandbox/pricing), [Modal pricing](https://modal.com/pricing), [E2B pricing](https://e2b.dev/pricing).

Illustration, calculated from those rates: a 30-minute Vercel task at the existing 2 vCPU/4 GB size is about **$0.055** if both CPUs average 10% active utilization, or **$0.170** at full CPU utilization. One hundred such tasks are approximately **$5.52–$17.04** in compute before credits, storage and tokens. Equivalent requested Modal Sandbox resources are approximately $0.119 per 30 minutes; E2B is $0.0828 before any plan fee. These are not performance-equivalent benchmarks. Repeated model context and reasoning can cost more than the VM; meter provider usage per task and set explicit token/dollar, time and concurrency budgets.

Vercel persists the filesystem and boots a fresh session on resume; application processes need restarting. E2B can preserve memory as well as filesystem when paused. Neither replaces a durable task ledger or resolves a partially completed external action. Claude transcripts need a SessionStore or equivalent protected persistence; working files need their own snapshots/artifacts. [Vercel persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes), [E2B persistence](https://docs.e2b.dev/sandbox/persistence), [Claude hosting](https://code.claude.com/docs/en/agent-sdk/hosting).

## Minimal implementation path

1. **Prove the existing boundary:** an owner-selected disposable repository, create/import/edit/checkpoint/preview/draft PR, then resume on a second device. Check configured provider access through safe status APIs. This establishes what is usable now without assuming configuration from code.
2. **Add a durable coding task:** bind tenant, actor, project, repository ID, base SHA, provider/model, workspace, branch, budget, lease/fencing token and idempotency key. Persist observable actions, usage, pending decisions and artifacts. A cloud worker owns the task; the browser observes/reconnects. Reuse the queue/receipt primitives rather than making the HTTP request the process lifetime.
3. **Integrate Codex, then Claude:** pin reviewed runtime images/SDK versions; route model access through a scoped credential proxy and deliberately allow required egress. Never expose deployment/GitHub/production credentials to repository scripts. Map tool authorization before execution into the governed executor; observing vendor tool events afterward is insufficient. Prove callback coverage for built-in shell/file tools, or expose only approved tools through the adapter. This is a feasibility gate, not a setting to disable approvals.
4. **Persist resumable state:** save transcripts separately from UI messages, immutable diff/checkpoint artifacts and current process/run identity. Bound retention and restart at known checkpoints. Reconcile uncertain PR/deployment outcomes before retrying; never infer success from a disconnected stream.
5. **Parallel development:** give every task/provider its own sandbox and branch, e.g. `codex/<task>` and `claude/<task>`, with a pinned common base. One writer/lease per workspace. Assign disjoint module ownership where possible; a coordinator rebases/integrates PRs sequentially and resolves conflicts. Separate branches prevent filesystem interference, not semantic merge conflicts.
6. **Any-device interface:** extend existing Build UI with running/waiting/completed/failed states, follow-up/stop/resume, exact diffs, preview, cost and reviewable approval cards. Reuse the native builder; publish any new native API operations through the established contract/version process. Browser-first delivery is enough to remove the Mac dependency.

## Asael changing and releasing itself

Treat Asael's repository as a selected development target with additional release policy. Coding tasks can propose a PR and preview using isolated data. Review the exact commit and evidence, merge through the source broker, then dispatch a **separate trusted release job**. That job must preserve the existing Vercel + Fly revision pairing, database migration/backup procedures, health gates and compatible rollback behavior described in `docs/deployment.md` and `docs/production-rollout.md`.

Keep a recoverable release controller outside the Asael version being changed so a broken UI cannot strand rollback. The coding sandbox must not rewrite that controller or acquire its release secrets. Database rollback is not automatically accomplished by restoring an old application image. macOS/iOS packaging needs a separate macOS CI runner and signing setup; Linux coding sandboxes can edit native source but do not replace the Apple build/signing environment. Current `.github/workflows/native.yml` includes macOS policy checks, not a complete cloud distribution pipeline.

## Effort estimate and first deliverable

Estimates are engineering days for an engineer familiar with this repository, with a selected Node repository, working provider credentials and existing stores reused. They include future focused verification; none was run for this research. Auth approval waiting and unrelated release work are excluded.

| Increment | Estimated effort | Exit result |
| --- | --- | --- |
| Existing builder readiness and one real repository path | 1–3 days | Clear usable-now boundary and provider configuration gaps |
| Durable single-provider Codex task + reconnect/diff/approval UI | 5–10 additional days | Start a change from phone/browser; close device; return to a reviewable PR |
| Claude adapter + independent parallel task/branch integration | 3–6 additional days | Both providers work independently with bounded budgets |
| Asael-specific trusted cloud release/rollback handoff | 4–8 additional days | Reviewed self-change can ship without this Mac |
| Native packaging/signing in cloud | 3–7 additional days | Distribution path independent of the Mac, subject to Apple setup |

The first useful milestone is **one cloud Codex task producing a recoverable, reviewable PR from inside Asael**. Do not promise full Codex feature parity, arbitrary repositories or unattended self-deployment in that milestone. The largest uncertainty is fitting vendor tool execution and credential handling to Asael's existing governed boundary; resolve that with a narrow adapter proof before expanding scope.
