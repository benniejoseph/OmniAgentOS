# In-app agent app builder — feasibility and recommended architecture

Status: Phase A implemented on 2026-09-14. GitHub delivery and app deployment authority remain intentionally unavailable.

## Decision

Asael now has the safe first slice of a private app-building environment: a Build mode inside Projects can create one reviewed TypeScript web-app template in an actor- and project-bound Vercel Sandbox, inspect and digest-fence files, run a fixed check family, and serve an authenticated live preview. Forge can use the same governed operations with its independently configured `code_builder` model assignment. Iterative snapshot recovery, independent Sentinel verification, GitHub branches and pull requests, and app deployment remain later phases. Production deployment remains an explicit reviewed action.

Do not make browser or computer use the primary coding interface. Code should be read, patched, tested and versioned through typed repository and sandbox tools. Computer use is useful later for visual QA of the running preview.

## What Asael already provides

| Capability | Current state | Reuse |
| --- | --- | --- |
| Goal decomposition | Projects can generate dependency-aware work items | Reuse |
| Specialist delegation | Atlas can assign Scout, Forge, Sentinel and Mnemosyne | Reuse |
| Durable execution | Project work items dispatch into resumable workflows | Reuse |
| Governance | Tool policy, approvals, idempotency, execution scope and receipts exist | Reuse |
| Model routing | Models and providers resolve from actor Settings assignments, including `code_builder` | Reused and extended |
| Artifacts | Project results and evidence can be retained and reviewed | Extend for file manifests, diffs, builds and previews |
| Workspace mutation | Governed tree/read and exact-SHA file update operations exist for the isolated template workspace; Git is unavailable | Phase A delivered; Git pending |
| Isolated execution | Actor/project/session-scoped Vercel Sandbox with bounded resources and registry-only install access | Phase A delivered |
| Build verification | Fixed lint, type-check, test, build and live-preview commands with bounded output and typed activity | Phase A delivered |
| Deployment | Authenticated sandbox preview exists; GitHub, Vercel app preview deployment and production release are unavailable | Phases C/D pending |

Forge now receives the governed Phase A builder tool family and resolves its model through the actor's `code_builder` Settings assignment. It may truthfully report only file and command effects represented by builder receipts. It cannot claim Git, pull-request or application-deployment effects because those tools do not exist yet.

## Recommended runtime

Use three explicit boundaries:

1. **Asael control plane** — owns the App Project, brief, work items, agent identities, model assignments, approvals, budgets, events and immutable result receipts.
2. **Ephemeral build plane** — one actor/project/build-session-scoped Vercel Sandbox with a reviewed base image, bounded CPU/time/storage, network deny-by-default policy and no production credentials.
3. **Source and delivery plane** — a least-privilege GitHub App for selected repositories and Vercel preview deployment APIs. Tokens are short-lived, opened by a credential broker for one exact operation and never placed in model context, logs, files or memory.

Vercel Sandbox is the best initial fit because Asael already runs on Vercel, the product supports isolated microVMs, file and command APIs, live development servers, persistence/snapshots and programmatic authentication. Retain a provider-neutral `CodeSandboxAdapter` so another isolated runtime can replace it later.

The coding harness should also be replaceable:

- A native Asael model loop can call the typed build tools and remain fully provider configurable.
- The Codex SDK can be an optional high-capability `CodingHarness` implementation for complex repository work.
- Neither the model vendor nor model name may be hard-coded. Resolve the effective provider/model from the proposed `code_builder` Settings assignment and bind it to the immutable run manifest.

## User experience

Make this a focused **Build** mode inside Projects instead of adding another unrelated workspace. A Build Project should show:

- Brief and conversation on the left.
- Live preview as the primary canvas.
- Files and inspectable diffs in a secondary panel.
- Work-item and agent activity with real command/test/build states.
- A Problems panel with compiler, test and runtime failures.
- Clear checkpoints: save version, create branch/PR, open preview and request production deployment.

The normal flow is:

`brief -> reviewed template -> sandbox -> plan -> patch -> focused checks -> live preview -> visual QA -> diff review -> branch/PR -> preview deployment -> explicit production approval`

Follow-up prompts continue the same build session where safe. A session may be stopped and resumed from a trusted snapshot, while Git remains the durable source of truth.

## Required governed tools

Every tool must bind tenant, actor, App Project, work item, run, build session, repository revision and idempotency identity.

Read tools:

- `app_builder.templates.list`
- `app_builder.repository.tree`
- `app_builder.file.read`
- `app_builder.diff.show`
- `app_builder.command.status`
- `app_builder.preview.status`
- `app_builder.checks.list`

Mutation tools:

- `app_builder.session.create|stop|resume`
- `app_builder.repository.checkout`
- `app_builder.patch.apply`
- `app_builder.command.run`
- `app_builder.preview.start|stop`
- `app_builder.git.branch|commit|push`
- `app_builder.pull_request.create|update`
- `app_builder.deployment.preview`
- `app_builder.deployment.production`

Patch application is preferable to unrestricted file writes because it creates an inspectable proposed effect. Command execution should accept a typed command intent and reviewed allowlist rather than arbitrary shell by default. Git push, pull-request creation, external resource creation and deployment are consequential effects and require policy review; production deployment always requires explicit approval.

## Security and correctness floors

- Run generated code only in an isolated sandbox, never inside the Vercel web function or Fly worker host.
- Give each build session a clean or exact-revision checkout; never mount Asael's production filesystem.
- Do not copy production environment variables into build sessions. Use synthetic fixtures and separately approved preview-only credentials.
- Keep outbound network disabled by default. Grant exact host/protocol access for package registries, GitHub or preview dependencies with bounded receipts.
- Treat repository content, package output, compiler errors, web pages and preview UI as untrusted input.
- Enforce command, time, token, cost, process, storage and network budgets plus cancellation and orphan cleanup.
- Secret-scan proposed diffs and artifacts before Git push or deployment.
- Require deterministic checks appropriate to the affected files. A model's statement that tests passed is never sufficient evidence.
- Store command metadata, exit status, bounded logs, file/diff digests, commit SHA, preview deployment ID and verifier outcome as typed events. Do not store private reasoning.
- Preserve manual edits and detect revision drift before applying an agent patch.
- Default to a branch and preview. Never let an agent push directly to a protected production branch.

## Delivery order

### Phase A — safe prototype

- [x] Add Build Project contracts and a `code_builder` Settings assignment.
- [x] Start one Vercel Sandbox from a pinned Node 24 runtime.
- [x] Create an app only from a reviewed, dependency-pinned local template.
- [x] Add tree/read/exact-SHA update and a narrow install, lint, type-check, test, build and preview command family.
- [x] Stream bounded activity and serve one HMAC-authenticated live preview.
- [x] Keep GitHub push and app deployment unavailable.

Exit gate: the same brief produces an inspectable diff, focused checks and a working preview without accessing any production secret.

Implementation evidence: the workspace receives no production environment variables, package installation is restricted to the npm registry and ignores lifecycle scripts, preview access is bound to actor/project/session, every service access revalidates Project ownership, and builder session/activity records are protected by exact-actor forced RLS. Focused contract, registry, model-assignment and database checks pass with affected lint and TypeScript. Wide-monitor and phone browser checks show the Build surface and preview without document-level horizontal overflow. A disposable provider canary on Vercel's current Node 24 image installed the template, exposed nine source files, passed type-check, served the authenticated preview with HTTP 200, and was stopped afterward.

### Phase B — iterative builder

- Persist safe sandbox identity/snapshot metadata.
- Continue follow-up edits against the same exact revision.
- Add browser/computer-use visual QA only against the session preview.
- Add Forge implementation and Sentinel verification handoff with independent evidence.

Exit gate: interruption, retry and agent handoff cannot duplicate effects or lose the reviewed diff.

### Phase C — GitHub delivery

- Register a private GitHub App with selected-repository access and minimum Contents/Pull Requests/Checks permissions.
- Add exact-revision checkout, branch, commit, push and pull-request tools.
- Secret-scan and require passing checks before proposing delivery.

Exit gate: Asael can create a reviewable PR without obtaining general account credentials or writing the default branch.

### Phase D — preview and release

- Create a Vercel preview deployment and bind its logs, URL and revision to the Build Project.
- Add visual and route smoke checks against the exact preview.
- Add an explicit production-release approval with health, migration and rollback evidence.

Exit gate: a human can inspect the app and its evidence before the separately governed production effect.

## Scope recommendation

Begin with new TypeScript web applications using one curated Next.js template and no arbitrary infrastructure creation. Do not start by allowing the in-app agent to modify Asael itself, create mobile binaries, provision databases, rotate secrets or deploy to production. Once the isolated new-app workflow has reliable build and verification receipts, repository import and broader stacks can be added deliberately.
