# In-app agent app builder — feasibility and recommended architecture

Status: research only. No repository, sandbox, GitHub or deployment authority is added by this document.

## Decision

Asael can become an effective private app-building environment, but the current product is not yet an end-to-end coding runtime. The recommended first scope is to create and iteratively edit new web applications from reviewed templates in an isolated Vercel Sandbox, with GitHub App-backed branches and pull requests and Vercel preview deployments. Production deployment remains an explicit reviewed action.

Do not make browser or computer use the primary coding interface. Code should be read, patched, tested and versioned through typed repository and sandbox tools. Computer use is useful later for visual QA of the running preview.

## What Asael already provides

| Capability | Current state | Reuse |
| --- | --- | --- |
| Goal decomposition | Projects can generate dependency-aware work items | Reuse |
| Specialist delegation | Atlas can assign Scout, Forge, Sentinel and Mnemosyne | Reuse |
| Durable execution | Project work items dispatch into resumable workflows | Reuse |
| Governance | Tool policy, approvals, idempotency, execution scope and receipts exist | Reuse |
| Model routing | Models and providers resolve from actor Settings assignments | Reuse; add a `code_builder` scope |
| Artifacts | Project results and evidence can be retained and reviewed | Extend for file manifests, diffs, builds and previews |
| Repository mutation | No agent-visible checkout, file-read, patch, Git or pull-request tools | Build |
| Isolated execution | No project-owned code sandbox or command runtime | Build |
| Build verification | No typed command, test, build or preview receipt | Build |
| Deployment | No governed app-builder preview or production deployment path | Build |

The current Forge persona declares a code-workspace capability, but its built-in Skill exposes only knowledge search and approved public HTTP requests. Project artifacts are text records. Therefore a current Project may plan an app and produce implementation-ready content, but cannot truthfully claim that it edited, built, tested or deployed an application.

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

- Add Build Project contracts and a `code_builder` Settings assignment.
- Start one Vercel Sandbox from a pinned web-app image.
- Create an app only from a reviewed local template.
- Add tree/read/patch and a narrow `npm install`, lint, type-check, test and build command family.
- Stream bounded activity and serve one authenticated live preview.
- No GitHub push and no deployment.

Exit gate: the same brief produces an inspectable diff, focused checks and a working preview without accessing any production secret.

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
