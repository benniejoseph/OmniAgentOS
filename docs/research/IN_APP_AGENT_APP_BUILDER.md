# In-app agent app builder — feasibility and recommended architecture

Status: Phases A–E implemented through governed code and database schema on 2026-09-15. Live provider use still requires the server-side GitHub App and Vercel credentials described below.

## Decision

Asael now has an iterative private app-building environment: Build mode inside Projects creates one reviewed TypeScript web-app template or replaces it with an exact selected-repository revision in an actor- and project-bound Vercel Sandbox, inspects and digest-fences files, searches bounded source, runs a fixed check family, serves an authenticated live preview, and seals recoverable provider snapshots against exact workspace digests. Forge automatically protects the workspace before a run and seals a completed result against its exact project-bound run. Sentinel independently reads the sealed verification receipt and project files with the actor's configurable `verifier` model assignment. A selected-repository GitHub App can deliver only the repository diff to a new branch and draft pull request. Vercel preview deployment records build, route, and desktop/mobile evidence for starter workspaces. Production requires a separate 15-minute digest-bound review, exact `RELEASE` confirmation, declared migration posture, and a recorded rollback target.

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
| Workspace mutation | Governed tree/search/read/exact-SHA update/delete operations exist for isolated starter and exact-revision repository workspaces; Git credentials remain broker-only | Phases A/E delivered |
| Isolated execution | Actor/project/session-scoped Vercel Sandbox with bounded resources and registry-only install access | Phase A delivered |
| Build verification | Fixed lint, type-check, test, build and live-preview commands with bounded output and typed activity; sealed lint/type-check and private desktop/mobile capture receipts feed an independent Sentinel handoff | Phases A/B delivered |
| Recovery | Immutable 30-day snapshots, exact workspace manifests, optimistic session revisions, automatic pre-restore safety checkpoints and digest-verified restore | Phase B delivered |
| Deployment | Authenticated sandbox preview, selected-repository GitHub delivery, verified Vercel previews, and explicitly reviewed production releases are implemented | Phases C/D delivered; provider credentials/canary still operational gates |

Forge receives the governed builder tool family and resolves its model through the actor's `code_builder` Settings assignment. It may truthfully report only file, command, repository, and deployment effects represented by durable builder receipts. Risk-level-three production release is intentionally withheld from Forge and remains a direct human action.

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

`brief -> reviewed template or exact repository revision -> sandbox -> plan -> search/read/patch -> focused checks -> live preview -> visual QA -> diff review -> branch/PR -> preview deployment -> explicit production approval`

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

- [x] Persist safe sandbox identity/snapshot metadata without exposing provider snapshot identifiers to the client or model.
- [x] Continue follow-up edits against the same exact revision and clear the current seal on every file mutation.
- [x] Add trusted-browser visual capture only against the HMAC-authenticated session preview; persist digests and dimensions rather than pixels or signed URLs.
- [x] Add Forge pre/post checkpoints and a Sentinel verification handoff with independent, checkpoint-bound evidence.

Exit gate: interruption, retry and agent handoff cannot duplicate effects or lose the reviewed diff.

Implementation evidence: migrations 168 and 169 install exact-actor forced-RLS checkpoint and verification ledgers; checkpoint, verification and Sentinel actions use the same governed application-service boundary and typed activity stream. Forge binds completed result seals to an exact project-scoped run. Sentinel resolves from the Settings `verifier` assignment and receives only the safe verification receipt. A disposable live provider canary changed a source-file digest, restored the sealed snapshot, matched both file and workspace digests exactly, returned HTTP 200 from the resumed private preview, and deleted the sandbox and snapshots. Focused contract, registry, visual-evidence redaction, lint and TypeScript checks pass. The production build is healthy at exact revision `0b7025a4b4d42846074a98cf8aa82d32437e6e33`; the final authenticated click-through remains unrecorded because the workstation was locked during release verification.

### Phase C — GitHub delivery

- [x] Add a private GitHub App broker with selected-repository access and minimum Contents/Pull Requests/Checks permissions.
- [x] Add exact-revision binding, branch, commit, push and pull-request tools.
- [x] Secret-scan and require passing checks before proposing delivery.

Operational gate: create/install the private GitHub App once and place its app ID, installation ID, private key, required numeric repository-ID allowlist, and optional slug in the server environment. Install it only on selected repositories with the minimum Contents, Pull Requests, and Checks permissions. The broker-side allowlist excludes unrelated public repositories that GitHub may still enumerate read-only. No general GitHub account token is used.

Exit gate: Asael can create a reviewable PR without obtaining general account credentials or writing the default branch.

### Phase D — preview and release

- [x] Create a Vercel preview deployment and bind its logs, URL and revision to the Build Project.
- [x] Add visual and route smoke checks against the exact preview.
- [x] Add an explicit production-release gate with health, migration and rollback evidence.

Implementation evidence: migrations 171 and 172 install actor-private forced-RLS preview and production ledgers; migration 173 repairs their Vercel-host constraint with a PostgreSQL-safe literal-dot expression. Preview source is secret-scanned and bound to an exact passing checkpoint and verification receipt. `ready` requires captured build logs, passing route smokes, and desktop/mobile captures. Production clones the exact reviewed preview into a fresh production build only after an unexpired digest and literal `RELEASE`; ambiguous provider acknowledgements can be resumed with the same idempotency identity. Generated applications that declare database migrations remain blocked until a separately approved migration/rollback workflow exists. The production tool is risk level 3 and is not exposed to Forge. Live deployment requires `OMNIAGENT_VERCEL_ACCESS_TOKEN` to be a durable account token scoped to the owning project/team; a short-lived Vercel CLI OAuth session token is not an operational credential.

Exit gate: a human can inspect the app and its evidence before the separately governed production effect.

### Phase E — repository workspaces

- [x] Import one exact GitHub commit through the server-side App broker without placing its token in the sandbox, model context, files or logs.
- [x] Seal a recovery checkpoint before replacing the current workspace and record the checkout as a typed actor-private event.
- [x] Raise checkpoint manifests to 10,000 editable source files while retaining the 500-file/8 MB reviewed change-delivery boundary.
- [x] Add bounded source search plus exact-SHA update and deletion operations for Forge.
- [x] Compare the current workspace against the imported baseline and deliver only added, modified or deleted files.

Implementation evidence: migration 174 expands only the checkpoint source-file budget and adds `app_builder.repository.checked_out` to the typed event contract. GitHub archives are commit-fenced, size-bounded, path-inspected, link-rejected and extracted without owner or permission inheritance. Repository lifecycle scripts remain disabled during dependency installation, outbound sandbox access remains npm-registry-only, and source delivery continues to require checkpoint, verification, Sentinel and secret-scan receipts. Direct Vercel source upload remains intentionally limited to starter workspaces until repository commit deployment receives a separate provider contract.

Exit gate: Forge can open OmniAgent's selected GitHub revision, find and change existing source, and propose a minimal reviewable pull request without general GitHub credentials.

## Scope recommendation

Continue with TypeScript/Node repositories that have a root `package.json`; retain the curated Next.js starter for new apps. Broader stacks, repository-commit preview deployment, scoped affected-file test commands and patch-first review can be added deliberately without widening credential or infrastructure authority.
