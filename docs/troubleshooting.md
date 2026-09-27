# Troubleshooting

## Runtime or install fails

- Confirm `node --version` is 24.x and `npm --version` is 11.x. The repository intentionally rejects other major lines through `engines`.
- Run `npm ci` from a clean checkout. If the lockfile and manifest disagree, do not hand-edit the lockfile; run `npm install` with the reviewed package versions.
- `npm run audit:production` gates high/critical production advisories. A development-only advisory must still be reported, but it does not represent the deployed dependency graph.

## Production shows “database required”

`DATABASE_URL` is missing or blank. Set a TLS Postgres URL and redeploy. `OMNIAGENT_ALLOW_DEMO_STORAGE=true` bypasses the guard only for disposable demos and must not be used as a production recovery measure.

If `/api/health` returns 503, inspect server logs for TLS, credentials, extension privileges, migration, or RLS errors. Verify connectivity from the deployment network before rotating credentials.

## Schema startup fails

- Inspect `omni_schema_version` and compare it with the versions in `databaseSchemaMigrations`.
- Ensure only one application identity owns migrations and that it can create/alter tables, functions, policies, and indexes.
- The advisory lock serializes migrations; a long wait can mean another deployment is migrating or a transaction is stuck.
- Restore into an isolated database before repairing a failed migration. Do not delete version rows to force a rerun without reviewing the idempotency of that migration.

If pgvector is unavailable, set `OMNIAGENT_LOG_PGVECTOR_FAILURES=true` temporarily. The app can use JSON embeddings, but vector-index status remains not ready until the extension, columns, dimensions, and HNSW indexes match.

If system diagnostics reports OpenAI as degraded with
`failureKind=authentication`, the environment contains a key but the
authenticated model-readiness probe failed. Rotate or correct the deployment
credential; a nonempty environment variable is not provider health. Provider
error text and credential material are not persisted in the health record.

## Login does not work

- Call `GET /api/auth/session` and inspect `authEnabled`, `bootstrapConfigured`, and `authenticated`.
- For first boot, set both bootstrap email and password before the first auth-store request.
- Production auth cannot be disabled. Local auth follows `OMNIAGENT_AUTH_ENABLED`.
- A 429 response means the in-process IP or account login limit was reached; honor `Retry-After`.
- After a successful login, verify the `__Host-asael_session` cookie is present in production (`asael_session` locally) and that HTTPS deployments receive the `Secure` attribute.

## Protected API returns 401 or 403

401 means no valid browser session or internal secret was supplied. 403 means the identity is valid but its role lacks the requested action. Confirm tenant membership and role instead of weakening the route policy.

For internal calls, the secret and identity headers must be sent together. Never enable unsigned identity headers in production.

## Worker is running but jobs do not advance

- Check the startup JSON record for base URL, interval, limit, SLO, and alert settings.
- Check tick records for HTTP status, duration, leased/completed/failed/requeued counts, and errors.
- Confirm the worker and web deployment share `OMNIAGENT_INTERNAL_AUTH_SECRET`.
- Probe the configured web `/api/health` from the worker network.
- Compare the interval with queue lease duration; too many replicas or a short interval can increase contention.
- On Fly, inspect machine health and restart count. The container health probe uses only the public health endpoint and never sends the internal secret.

## A queued workflow run waits, or one tenant's workflows stop

- `workflow_queue_tenant_failed` with a `tenantId`: that tenant's workflow queue threw during a fast pass, usually on a database error. The logged error is redacted, and the same text is in that tenant's `tenantResults` entry of the tick response. The other tenants' ticks still ran, and the failed tenant is tried again on the next pass.
- A queued run with no tick waiting or running gets a new tick on the next fast pass. A run whose tick is waiting out a retry backoff is left alone until the backoff ends; its tick keeps its attempt count and last error.
- A tick that the pass's deadline stopped before it started, or cut short after another tick in the same pass had run, keeps its place in the queue. A tick that had the pass to itself and still did not finish becomes due one second later, behind the work already waiting. If one run's tick does that on every pass, its step takes longer than the pass budget: check the planner, executor, and verifier timeouts in `docs/deployment.md`.
- A run waiting on durable specialist tasks: its `workflow.tick` job's last error is `Waiting for durable specialist tasks to finish.`, and `specialistWaits` in its payload counts the waits so far. The tick comes back after 15 seconds, doubling to five minutes, and runs at once when the specialist worker finishes the last task or one of them fails. The run's events show `workflow.specialists.pending` each time the set of tasks it waits on changes, not on every check. If the tasks ended without the specialist worker, nothing wakes the tick, and it is picked up when its current delay ends, within five minutes.

## A scheduled workflow did not run, or ran late

- Start with the schedule's history in Automation Studio. `…so it was skipped, as the schedule's missed-run setting asks.` means the occurrence came due more than 15 minutes before the scheduler reached it, usually because the worker was down, a release held it, or the schedule was paused. With the default `skip` setting, a missed occurrence is recorded and never runs. With `run_once`, only the latest missed occurrence runs, in place of the rest. Resuming a paused schedule applies the same setting to the occurrences it missed while paused.
- The log line `workflow_schedule.occurrence_missed` records each of those decisions with the tenant, trigger, `scheduledFor`, `outcome` (`missed_skipped` or `missed_run_once`), and `occurrencesConsumed`. Warnings outside a known outage, release hold, or pause mean fast passes stopped reaching the schedule; check the worker section above.
- Tick audit metadata counts each pass's schedule work: `scheduleOccurrencesClaimed`, `scheduleOccurrencesEnqueued`, `scheduleOccurrencesSkipped`, `scheduleOccurrencesMissed`, `scheduleOccurrencesFailed`, `scheduleOccurrencesReconciled`, `scheduleShadowOccurrencesEvaluated`, `scheduleOwnerFailures`, and `schedulePassFailures`. A pass whose only schedule result was a failure is idle and writes no audit row, so look for that failure in the logs.
- `workflow_schedule.owner_failed` with a `tenantId`: one owner's schedules threw. The other owners still ran, and this owner is retried on every pass until the cause is fixed.
- `workflow_schedules_failed`: the fast pass could not list due schedules, usually because the database was unavailable. Queued work was still dispatched, and each tenant's maintenance pass still runs its schedules.
- An occurrence that failed with `procedure_changed`, `agent_identity_changed`, `agent_policy_changed`, `occurrence_budget_changed`, or `mutation_policy_changed`: something the schedule pinned at review has changed, so the occurrence failed closed instead of running under different authority.
- A schedule paused with `Scheduled read-only canary circuit opened after repeated failures.`: its failure limit of consecutive failed occurrences was reached. Fix the cause, then resume it, which closes the circuit.

## A canceled run keeps going, or its approval returns 409

- The process executing a run notices a cancel on its next status check, about every two seconds. A model turn or tool call already under way receives the abort signal. A tool that ignores the signal finishes, but no further turn or tool call starts.
- `Agent run <id> is canceled, so the action was not started.` (code `agent_run_not_active`): the run was canceled, finished, or deleted before the tool effect was recorded. Nothing was claimed or executed.
- `409 Tool approval record is not pending.` with `status: "rejected"` and the reason `Withdrawn: the agent run was canceled before this action was approved.`: the approval belonged to a canceled run. Start a new run to perform the action.
- The log line `Canceled run approvals could not be withdrawn.`: the cancel stands, but the run's approvals stayed pending. An approval bound to the run is still withdrawn instead of executed when someone who can read the run approves it. Reject the run's other pending approvals by hand.
- Approvals recorded before the run binding existed carry no run ID. Canceling their run withdraws only the approval its continuation waits on, and approving any other one still executes it.

## A stopped tool call shows as interrupted, or a retry runs it again

- A failed tool execution with the reason `The tool call was interrupted before it started.` or `The tool call was interrupted while it was running.`, and `interrupted` set to `before_start` or `in_flight` in its output: the caller stopped the call, for example by canceling the run. The tool did not fail on its own, so the call does not count against the tool's trust record.
- A retry with the same idempotency key runs a failed call again only when the failure changed nothing: a read, whatever stopped it, or any call interrupted before its tool started. The retry keeps the execution ID and first-attempt time. Current policy decides it again, so it can ask for approval and it uses autonomy and rate budget again. A write that failed on its own error, or that was stopped while it was running, is returned as it is. Check its target before you repeat it with a new key.
- A tool execution left `executing` after a stop: the call's effect may have happened, so its claim stays open. That covers a mutation whose tool had started, a provider or workflow effect whose intent was recorded (even if the stop came first), and an approved call. An effect-bound call reconciles through its intent, and an uncertain provider delivery is never replayed automatically. Any other claim fails with `Execution claim expired before a terminal result was recorded; outcome may be unknown.` once it is five minutes old; an approved read goes back to pending approvals then instead.
- A retry that returns the failure instead of running: This Mac tools never run again, because the Mac keys each command by its execution ID and would hand back the old command. A replay that carries a schedule's policy lease, a dry run, a call with an effect receipt, and a replay under another role than the one the execution was bound to never run again either.
- A workflow node whose pass was stopped while its tool call ran goes back to pending instead of failing the workflow.

## A model turn fails because a tool call has no result

- A run that fails with `1 tool call(s) from the model's last turn have no result.` (or another count), `A tool result answers no open tool call from the model's last turn.`, or `A tool result names a different tool than the call it answers.`: before it sends a turn, the gateway checks the tool results against the calls that ended the model's last turn, and each call needs exactly one result. The error has kind `invalid_request`, so nothing is sent, the gateway does not retry, and no other provider is tried. A result was lost, repeated, or renamed on its way back from the tools; the provider did not fail.
- A turn in which the model called more than five tools: the calls past the per-turn cap do not run, and each gets the result `Per-turn tool call limit reached; call skipped.` The cap is one call per turn when the run drives This Mac.

## Structured output fails on a Claude model

- A feature that asks the model for structured output (a workflow or project plan, for example) and fails on Claude with `Claude returned no structured tool result.`: the model did not call the tool that carries the result. Claude Opus 5.5, Claude Fable 5.1 and Claude Mythos 5.1 reject a forced tool call. On those models, and on any Claude model id not listed in `src/lib/models/anthropic-capabilities.ts`, the instructions ask for the call instead of forcing it. A model that answers in text gets one more turn asking for the call, and that turn's usage is added to the first. An answer cut off by the output token limit gets no second turn.
- A 400 from Anthropic with `tool_choice: type "tool" and "any" are not supported for this model.`: a forced call reached a model that rejects it. Remove that model's family from the list in `src/lib/models/anthropic-capabilities.ts`.

## A workflow plan step starts over, or its plan was built without the model

- A plan step with `step.reset` (reason `interrupted`), `step.interrupted`, and the run error `Workflow execution was interrupted and safely requeued.`: the queue pass ran out of time, or its worker lost the run's lease, while the model was planning. No plan was saved, and the step plans again on a later pass. Each attempt uses a model call from the run's budget, so a run interrupted this way again and again ends with `workflow.budget_exhausted`.
- A plan whose `model` is `fallback-after-model-error`, with the risk `Model planner fallback used: <error>`: the model call failed or ran past its timeout, so the run continued on a deterministic plan. The timeout is `OMNIAGENT_WORKFLOW_PLANNER_TIMEOUT_MS` (45 seconds by default). Inside a queue pass it is shortened so the fallback is saved two seconds before the pass's deadline, but never below 30 seconds.
- The next time that run is planned (a retried plan step, `POST /api/workflows/plan`, or the `workflows.plan` tool), the model is asked again instead of reusing the fallback. A plan built while no planner model was configured (`model: "fallback"`) is still reused.

## An approved run fails as interrupted, or resumes late

- `Approved run resume was interrupted; side effects were not replayed.`: the process resuming the run stopped before it finished, and its resume-job lease (two minutes) lapsed. A worker then fails the run rather than replay its effects. When an approved This Mac step returned an observation, the approving request does the resume, so look for that request hitting the approvals route's 300-second limit or crashing. Start a new run to continue.
- `Ephemeral local observation resume failed; the durable queue will reconcile the run without raw observation data.`: the approving request could not resume the run with its This Mac observation. The worker resumes it from the stored result instead, so the model does not see that step's screenshot.
- A run still `waiting_approval` after its approval was decided: the decision wakes the run's resume job at once. If that wake was lost, the job's backstop re-check finds the decision within five minutes.

## A retried command returns 409 or 503, or replays instead of running

- `409` with `code: "request_id_reused"`: this account already used the `requestId` or `Idempotency-Key` for a different request body: another message, Agent, strategy, history, context selection, or budget. Nothing ran. The Command workspace starts a new ID when the message changes; an API client must send a new ID for new work.
- A retry that shows the earlier attempt's steps instead of running again: the first attempt's run is still going, so the retry follows it from its event log and ends on its outcome. The same happens when the Command workspace shows `Reconnecting`: the stream dropped, the run kept executing, and the workspace follows it from the last event it saw for up to ten minutes. Closing the page does not stop a started run; use Stop, which cancels it through `DELETE /api/runs/:id`. A run left `running` by a crashed process is followed until stale-run repair fails it, which happens on the first maintenance pass after the run is seven minutes old; the stream then ends on that failure. If the workspace gives up first, check Activity.
- `503` with `Request replay protection is unavailable.` and `Retry-After: 30`: the request's binding could not be read or written, usually because the event store is unavailable. Nothing ran. Retry after the delay with the same ID.
- A retry streams `canceled` with `This request stopped before it finished, so it was not run again.`: the first attempt was canceled. Send the message again; the workspace uses a new ID after a cancellation.
- A retry streams a `Replayed` status and the earlier answer: the first attempt finished, so its recorded outcome was returned instead of running the work again. To run it again on purpose, send it with a new ID.

## Memory forget or the deletion scrub fails

- `Database schema is behind (pending versions: 207)`: run migration v207 before serving the release. See [deployment.md](deployment.md#memory-forget-lineage-closure-v207).
- `permission denied for function omni_memory_deletion_manifest_v1`: the serving role did not exist when the migration ran, or has another name. Grant it `EXECUTE` as the deployment note shows.
- `42501 Memory deletion manifests are tenant-scoped`: the session's `omni.tenant_id` is not the memory's tenant. Served requests set it; a manual call must set it too.
- `409` from `DELETE /api/memory/:id` after a preview: the lineage changed after the review, for example because another actor derived a memory, trace, or graph row from it. Preview again and submit the new digest.
- The tick logs `memory_deletion_scrub_failed`: the physical scrub failed and the rest of maintenance continued. Its receipts stay leasable, so the next tick retries them.

## Capture file extraction fails

Files are parsed by the contained document parser described in the [security model](architecture.md#security-model). The API response, or for background processing the asset's failed extraction receipt, carries the code:

- `413 archive_too_large`: a DOCX, spreadsheet, presentation, OpenDocument, or EPUB file expands past 12 MB or holds more than 1,000 entries. The file is the problem; export a smaller document.
- `413 extraction_resource_limit`: the parse reached its time, heap, or process-memory limit. The log line `Document parser stopped at a resource limit.` names which one (`timeout`, `heap`, or `rss`). Do not raise a limit for one file; the limits bound what a hostile file can cost.
- `503 extraction_unavailable` with `PDF extraction is temporarily unavailable.` while other formats still work: the deployment lacks the `@napi-rs/canvas` native binding pdf.js needs. See [deployment.md](deployment.md#capture-document-extraction).
- `503 extraction_unavailable` for every format, logged as `Document parser worker could not start.`: the function could not start a worker thread.
- `503 ocr_not_configured`: a scanned PDF or an image needs OCR and no vision runtime is configured.
- `400 extraction_failed`: the parser rejected the file. `Document parser could not read this document.` logs only the error name: `PasswordException` is an encrypted PDF and `InvalidPDFException` or `FormatError` a damaged one, while a `ReferenceError` or `TypeError` points at the deployment or a parser defect rather than the file.

Background processing (`capture.asset.process`) makes three attempts with backoff and records the failed extraction receipt only after the last one, so even a deterministic 413 appears only after the third attempt.

## Connector discovery or execution is blocked

- Use an HTTPS hostname with public DNS; private, loopback, link-local, metadata, embedded-credential, and unsafe redirect targets are rejected.
- Store a connector credential in an `OMNIAGENT_CONNECTOR_*` variable and reference its name. Do not paste the value into connector metadata.
- Platform secrets remain blocked even if a connector attempts to reference them. Keep the explicit allowlist narrow.
- Re-import or rediscover only after reviewing vendor schema/tool changes and their risk levels.
- A successful import does not bypass approvals for side effects.

## Production smoke fails

- Preflight: set an explicit HTTPS `BASE_URL`, all three smoke credentials, and `RELEASE_EVIDENCE_OUTPUT`.
- Revision: scheduled GitHub runs resolve the currently served exact SHA from `/api/health`; manual canary checks must pass the intended `expected_revision`. A supplied mismatch is a deployment failure and is never replaced by discovery.
- Timeout: inspect the failing method/path and `SMOKE_REQUEST_TIMEOUT_MS`; fix the slow dependency before increasing the bound.
- Security: confirm anonymous protected routes return 401 and the admin cookie is secure.
- Tenant/eval: confirm the internal secret is deployed and database RLS/evaluation state is current.
- Release: inspect gate reasons and warnings in the bounded JSON artifact.
- Artifact: the release step must create a non-empty file below `RELEASE_EVIDENCE_MAX_BYTES`; skipped or missing evidence is a failure.

Synthetic smoke requests carry correlation IDs and are marked SLO-excluded. Search those IDs in observability when diagnosing a gate.

## macOS packaging stops at the hardened runtime guard

`build_macos_private_release.sh` checks every architecture slice it signed before creating the DMG. A slice of a universal binary is named with its architecture in parentheses.

- `… is not signed with the hardened runtime.`: the signing arguments lost `--options runtime`, or something changed the code after the packager signed it. Keep `--options runtime` in the base `task_codesign_args` for every signing mode.
- `… carries com.apple.security.get-task-allow, which defeats the hardened runtime.` (or a debugger, dyld-environment, JIT, unsigned-memory, or page-protection key): remove the key from the entitlement file or build setting that added it. No Asael process may carry one, even if its entitlement file lists it.
- `… disables library validation, which only the owner-only host may do.`: only the self-signed host signed with `LocalRelease.entitlements` may carry `com.apple.security.cs.disable-library-validation`. An Apple-signed host, a helper, or the Share Extension must not.
- `… is signed with unexpected entitlements.`: the host or the Share Extension does not match its entitlement file exactly, or other nested code carries entitlements at all. Compare the output of `codesign -d --entitlements - <path>` with the file.
- `Cannot read the code signature of …`: the path is unsigned or no longer exists.

`apps/flutter/tool/test/macos_hardened_runtime_guard_test.sh` exercises these checks on ad-hoc signed copies of a system executable.

After installing a hardened owner-only build:

- If Asael quits at launch and the crash report says `mapped file has no Team ID and is not a platform binary`, the host lost `com.apple.security.cs.disable-library-validation`.
- If voice never prompts for the microphone and records nothing, the host lost `com.apple.security.device.audio-input`. The Hardened Runtime denies the microphone without that entitlement.

## Web presentation regression

Run the focused component or contract test for the changed surface, followed by
`npm run build`. For installed-Mac Computer Use, use the signed native canary and
verify the governed command receipt rather than adding a browser-automation test
runtime back to the repository.
