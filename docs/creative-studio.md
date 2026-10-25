# Visual Studio

Visual Studio lives at `/app/studio` inside the authenticated Asael workspace. The existing Capture screen retains its quick image/video tools and links to saved flows. Flows can be associated with an existing project. Existing workspace permissions, account identity, provider connections and private Capture assets remain authoritative.

## Working with a flow

Start with Image to video, Product scene, or Two creative directions. Add Prompt, Reference, Generate Image, Generate Video, Output or Note nodes. Connect named, compatible ports. A connected Prompt replaces a generator's local primary text; its optional local instruction is appended once, separated by a blank line. The inspector shows the effective text before execution.

An image generator exposes Selected image and All images. When a model produces multiple variations, run it first and select one result before using Selected image downstream. All images is an explicit collection for a gallery, not an instruction to multiply video jobs. Reference order and roles remain explicit. A note is non-executing.

- **Run node** executes the selected node using ready assets and matching successful upstream results.
- **Run to here** includes the selected node's required upstream work.
- **Run flow** includes enabled generation/output nodes and their dependencies.
- **Regenerate** deliberately creates new work; it does not overwrite previous assets or history.

Review validation, the generation count, reusable work and the cost estimate before submitting. Unknown cost remains unknown. A model-derived maximum is a bound under published rates and limits, not an account-level provider spending cap. No extra credits or checkout system is introduced.

A run can create at most eight outputs, with at most two active Studio runs per account. Admission also respects the existing workspace daily AI allowance across owners. Studio conservatively reserves the quoted maximum for a rolling 24 hours, including uncertain, canceled, or pre-submission failed work; actual reported provider usage is recorded separately in Asael's existing usage ledger. The reservation is an allowance hold, not an invoice or a promise of a refund.

The graph autosaves with a revision check. Another tab's newer revision produces a conflict instead of silently overwriting either draft. Node positions and the viewport do not change generation freshness. Prompt, reference, model, settings, selected input and connection changes mark affected downstream results stale while retaining them for inspection. Undo/redo edits the graph only; it never reverses or repeats generation.

## Persistence and execution

Migration261 adds actor-private flow, run and attempt state to the existing PostgreSQL schema. Run admission stores an immutable graph snapshot and queues a durable operation in the same transaction. Work continues through Asael's existing worker after the browser closes. Local fixture verification can use the development storage fallback; production requires the configured database. Media follows Capture's existing protected storage rollout: durable PostgreSQL bytes remain authoritative in its legacy mode, with object delivery used when configured and enabled.

Provider submission and media ingestion are separate. An attempt is checkpointed before a request is sent. A returned provider request ID is saved before polling. An ambiguous submission with no ID is marked uncertain and is not automatically submitted again. Reopening the page reads the same attempt rather than creating another paid request.

When generation completes, its output descriptor is saved before original media is copied into Capture. Failed output persistence can retry the same provider result. Successful branches survive failure elsewhere; only dependent work is blocked. Cancellation stops unsent work and asks supported providers to cancel active work. Completion can win the race; cancellation never implies a refund.

Generated and uploaded media use existing private Capture asset IDs and original download routes. Removing a node or archiving a flow does not delete media or run history. Content integrity, owner/workspace access and current authority are checked on the server and worker. Provider credentials and remote result locators are never sent to the canvas.

## Providers and demonstration mode

See [provider setup and verified contracts](studio-providers.md). The provider registry exposes only documented controls for the selected operation and the current account's available model routes. Unknown assignments remain unavailable with a recovery message. No website-only capability is assumed to be available through the API.

The Demo provider supplies owned, fixed image/video fixtures, visibly labelled as simulated results. Prompts and controls do not synthesize new images in Demo mode. It still uses durable runs, queue delivery, Capture storage and authorized downloads. This permits a complete deterministic acceptance flow without provider credentials or charges.

## Operations

Use the normal migration and paired release procedure, including database ownership/RLS verification and rollback evidence. The existing `npm run worker` process drains Studio work along with other bounded background jobs; no parallel daemon, cron schedule or worker account is needed. Existing health/authentication/provenance and release gates remain required.

Focused local verification:

```sh
npm run test:unit -- src/lib/studio src/components/studio
npm run typecheck
```

The opt-in PostgreSQL scenario uses a disposable, fully migrated local database:

```sh
ASAEL_STUDIO_CANDIDATE_DATABASE=1 \
ASAEL_STUDIO_CANDIDATE_DATABASE_URL='<isolated migration-owner connection>' \
npm run test:integration -- tests/integration/studio-execution.integration.test.ts
node --test scripts/smoke-studio-flow.test.mjs
```

Never point the candidate test at production. It creates synthetic tenants and a restricted runtime role, exercises the existing queue and media store, and checks cross-owner access, authority revocation, immutable snapshots, tenant budget concurrency, and inherited function-grant normalization. The paired live release scenario is documented in [Studio provider verification](studio-providers.md#selected-release-scenario).

Run only the relevant database candidate scenarios and changed-file lint, followed by a production build for release. Browser acceptance must exercise the actual saved canvas and queue/storage path; mocked provider contracts alone are not live provider acceptance. See the dated release evidence for which demo/live paths were exercised.

## First-release boundaries

The desktop canvas is the primary editing surface. Narrow screens provide a node list, inspector and media results. There is no multiplayer editor, arbitrary code/loop node, timeline compositor, voice cloning, ad scraping or social publisher. Models without a documented parameter do not receive a pretend control. Fixture success is never reported as live AI generation. A queued job, a provider request accepted, and a durably stored playable result are distinct states.
