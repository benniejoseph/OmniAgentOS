# Troubleshooting

## Runtime or install fails

- Confirm `node --version` is 24.x and `npm --version` is 11.x. The repository intentionally rejects other major lines through `engines`.
- Run `npm ci` from a clean checkout. If the lockfile and manifest disagree, do not hand-edit the lockfile; run `npm install` with the reviewed package versions.
- `npm run audit:production` gates high/critical production advisories. A development-only advisory must still be reported, but it does not represent the deployed dependency graph.

## Production shows “database required”

`DATABASE_URL` is missing or blank. Set a TLS Postgres URL and redeploy. `OMNIAGENT_ALLOW_DEMO_STORAGE=true` bypasses the guard only for disposable demos and must not be used as a production recovery measure.

If `/api/health` returns 503, inspect server logs for TLS, credentials, extension privileges, migration, or RLS errors. Verify connectivity from the deployment network before rotating credentials.

## Schema startup fails

- Inspect `omni_schema_version` and compare it with the versions in `schema-migrations.json`.
- Ensure only one application identity owns migrations and that it can create/alter tables, functions, policies, and indexes.
- The advisory lock serializes migrations; a long wait can mean another deployment is migrating or a transaction is stuck. A job waits for the lock for up to `OMNIAGENT_MIGRATION_STATEMENT_TIMEOUT_MS`.
- `database_migration_lock_retry` log lines: a migration statement waited longer than `OMNIAGENT_MIGRATION_LOCK_TIMEOUT_MS` for a table lock, or was chosen to break a deadlock, so its transaction rolled back and ran again. A few are normal while the database is busy.
- `… could not get the locks it needed in 5 attempts: …`, after a `database_migration_lock_retries_exhausted` line: every attempt waited too long for a lock, and nothing from that step was recorded. Look in `pg_stat_activity` for old transactions (oldest `xact_start` first), often a session that is `idle in transaction`, end or wait for them, then run the job again. When the step was the pgvector one (`Vector schema maintenance` or `Vector backfill of …`), the job still succeeds: the vector batches already filled stay, and the next run fills the rest.
- Restore into an isolated database before repairing a failed migration. Do not delete version rows to force a rerun without reviewing the idempotency of that migration.
- `Database role omni_runtime does not exist, and the migration role cannot create it`: the migrations grant to `omni_backup`, `omni_maintenance`, and `omni_runtime` by name, and the runner creates a missing one as a role that cannot log in. Create the role yourself (`CREATE ROLE omni_runtime NOLOGIN;` is enough), or migrate as a role with `CREATEROLE`.
- `… records database migrations … together, but only … of them is pending, and the file cannot run in part`: `omni_schema_version` holds some, but not all, of the versions one file writes, which the runner never does on its own. Find out how the rows got there; if the schema cannot be reconciled with the file, restore the pre-rollout backup into an isolated database.
- `… declares migration ledger rows […], but schema-migrations.json expects […]`: the file and its manifest entries come from different releases. The runner stopped before running the file, and the migration transaction rolled back.
- `… wrote migration ledger rows […]`: the file ran but recorded different rows, and the migration transaction rolled back.
- `… statement N (…) failed: …`: statement N of that file, counting its own `BEGIN`, failed with the error that follows, and the migration transaction rolled back.
- `… controls the transaction`, `… changes session state`, `… cannot run inside the migration transaction`, or `… must begin with a plain BEGIN and end with a plain COMMIT, or have neither`: the file breaks one of the rules in [deployment.md](deployment.md#schema-and-migration-rollout). The runner stopped before running it, and the migration transaction rolled back.
- `… has sha256 …, but schema-migrations.json expects …` or `… is not valid UTF-8`: the file is not the one this release recorded. It was edited, or its line endings or encoding changed on the way to this checkout. The runner stopped before running it. Restore the file from the release; make any change in a new migration.
- `Database migration N checksum does not match this release`: the database recorded a different checksum for version N. From v208 on, a version's checksum is the digest of its file, so the file changed after this database ran it. Deploy the release whose file the database ran, and make the change in a new migration.
- `… names … without its sha256`, `… has more than one sha256 in schema-migrations.json`, `… must use the sha256 of … as its checksum`, or `… is a TypeScript step, but every migration from 208 on is a SQL file`: the manifest breaks one of the rules in [deployment.md](deployment.md#schema-and-migration-rollout). Nothing ran.
- `… failed: The policies of … are not its actor policy alone`, from migration 208: after it dropped the table's `omni_tenant_isolation` policy, the table still had another policy, its actor policy differed from the one the migration files create (permissive, every command, `PUBLIC`, the same expression), or its row security was not forced. The migration rolled back, so nothing changed. List the table's rows in `pg_policies` and compare them with the files; find out how each difference got there before you change it by hand, then run the job again.
- `… failed: Constraint … of … is not the expected one`, from migration 208: a CHECK of that name has a different definition than the files give it, for example two CHECKs under each other's names. The migration rolled back. Compare `pg_get_constraintdef` for the table's CHECKs with the definitions in `20260928090000_schema_catalog_convergence.sql`.
- `… failed: omni_mobile_push_registrations still has a constraint the files do not create`: the table has both `omni_mobile_push_registrations_check` and the old runner's `omni_mobile_push_registrations_check1`, so migration 208 could not rename one to the other. Review the second one before dropping it, then run the job again.
- `Schema catalog convergence predecessor is invalid`: migration 208 was run outside `npm run db:migrate` on a database whose latest recorded version is not v207 `memory_forget_lineage_closure_v1` with its release checksum.
- `… failed: omni_mobile_sessions has a refresh rotation column this migration does not add`, from migration 209: the table already had `refresh_rotated_at` or `refresh_rotation_key`, but not as a nullable `timestamptz` or `text` column without a default. The migration rolled back. Find out where the column came from before you change or drop it, then run the job again.
- `Mobile refresh rotation retry predecessor is invalid`: migration 209 was run outside `npm run db:migrate` on a database whose latest recorded version is not v208 `schema_catalog_convergence_v1` with its release checksum.
- `… failed: omni_oauth_grants has a sync backoff column this migration does not add`, from migration 210: the table already had `sync_failure_count` or `sync_retry_at`, but not as an `integer NOT NULL DEFAULT 0` count and a nullable `timestamptz` without a default. The migration rolled back. Find out where the column came from before you change or drop it, then run the job again.
- `OAuth sync backoff predecessor is invalid`: migration 210 was run outside `npm run db:migrate` on a database whose latest recorded version is not v209 `mobile_refresh_rotation_retry_v1` with its release checksum.
- `Database schema contains unknown migration versions`, from `npm run db:verify`: a newer release has migrated this database. A serving release runs on it, but the check after a migration expects this release's versions exactly, so run the job from the release that migrated it.
- `Tenant isolation does not match this release. …`, from `npm run db:verify`: each kind of problem is followed by its tables. A table no isolation class covers is new and unclassified, or was renamed. The others were changed outside the migrations; find out how before you restore them, then run the check again.

If pgvector is unavailable, set `OMNIAGENT_LOG_PGVECTOR_FAILURES=true` temporarily. The app can use JSON embeddings, but vector-index status remains not ready until the extension, columns, dimensions, and HNSW indexes match. The migration fills a row's vector only when its JSON embedding is an array of numbers at least as long as the column; any other embedding stays JSON-only.

If system diagnostics reports OpenAI as degraded with
`failureKind=authentication`, the environment contains a key but the
authenticated model-readiness probe failed. Rotate or correct the deployment
credential; a nonempty environment variable is not provider health. Provider
error text and credential material are not persisted in the health record.

## A tenant's own vector index is missing, or its build failed

The migration gives a tenant its own HNSW index (`omni_memories_tenant_vector_…` or `omni_knowledge_chunks_tenant_vector_…`) once it holds `OMNIAGENT_TENANT_VECTOR_INDEX_MIN_ROWS` vectors in that table, 2,000 by default. Until then, and while its index is missing, the tenant's searches use the shared index and work as before.

- A tenant past the threshold has no index yet: a run builds at most four a table, the largest tenants first, so the next migration run builds the rest. A tenant id with characters outside letters, digits, `_`, `.`, `:` and `-` never gets one.
- `database_tenant_vector_index_failed`, with `table`, `index` and `error`: that drop or build failed and the run went on. A build that stopped part way leaves an index that is not valid (`pg_index.indisvalid = false`); the next run drops it and builds it again. Without `index`, the run could not read the tenant counts or the catalog, and changed nothing for that table.
- A build holds a lock that blocks writes to its table until it finishes. To avoid that for a large tenant, build its index out of band with `CREATE INDEX CONCURRENTLY`, with the name the migration would use and the same definition; the migration then keeps it.

## Login does not work

- Call `GET /api/auth/session` and inspect `authEnabled`, `bootstrapConfigured`, and `authenticated`.
- For first boot, set both bootstrap email and password before the first auth-store request.
- Production auth cannot be disabled. Local auth follows `OMNIAGENT_AUTH_ENABLED`.
- A 429 response means the in-process IP or account login limit was reached; honor `Retry-After`.
- After a successful login, verify the `__Host-asael_session` cookie is present in production (`asael_session` locally) and that HTTPS deployments receive the `Secure` attribute.

## Protected API returns 401 or 403

401 means no valid browser session or internal secret was supplied. 403 means the identity is valid but its role lacks the requested action. Confirm tenant membership and role instead of weakening the route policy.

For internal calls, the identity headers must come with the secret or with the worker's signed token, and the token's tenant, user, role, method and path must all match the request. A worker whose every request gets 401 is running a different secret, or an image newer than a web release that does not verify tokens yet. Never enable unsigned identity headers in production.

A native app that signs out after a refresh answered 401 with `refresh_token_reuse` presented a refresh token that had already been replaced, and the server revoked that session (`revocation_reason = 'refresh_reuse'` in `omni_mobile_sessions`). Within 60 seconds of a rotation, the same device and platform presenting the replaced token get the same pair again instead, which covers a retry after a lost response and a second app engine, such as another macOS window, that still held the old token. The old token still revokes the session after those 60 seconds, from another device, or after a rotation made by a release without migration 209. `invalid_refresh_token` means the token is unknown, expired, revoked, or belongs to another device, or the account's membership changed.

## Worker is running but jobs do not advance

- Check the startup JSON record for base URL, interval, limit, SLO, and alert settings.
- Check tick records for HTTP status, duration, leased/completed/failed/requeued counts, and errors.
- Confirm the worker and web deployment share `OMNIAGENT_INTERNAL_AUTH_SECRET`.
- Probe the configured web `/api/health` from the worker network.
- Compare the interval with queue lease duration; too many replicas or a short interval can increase contention.
- On Fly, inspect machine health and restart count. The container health probe uses only the public health endpoint and never sends the internal secret.
- `GET /api/health/worker` shows which lanes of the deployed revision have worked recently. Every lane `missing` after a release means the worker is still held: it logged one registration per lane and waits for `SIGUSR1`. A restart on the same machine resumes by itself once canonical `/api/health` reports its revision, and logs `Release work resumed from this machine's recorded activation.`; a worker on a new machine stays held until the next activation signal. One `stale` lane has done no work within `OMNIAGENT_WORKER_HEARTBEAT_MAX_AGE_MS`; check that lane's tick records.

## A job is quarantined, or a run waits on a quarantined job

A job is quarantined after its lease lapsed on three deliveries in a row: each time, its worker stopped reporting before the lease ended, which is what a job that crashes or hangs its worker does. Its last error is `Quarantined after 3 deliveries in a row lapsed without an outcome.`, its payload is kept, and nothing runs it again on its own. The Workflows console lists it under Quarantined jobs, and its `operation-job:<id>` event stream shows `operation.job.quarantined`.

- Find why its worker died before deciding. The worker's logs around the job's last three leases usually show an out-of-memory kill, a crash, or a step that hangs past its lease.
- **Release** it once the cause is fixed. It runs again from its first attempt, with its lapse count cleared.
- **Discard** background work that should not run again. The job is canceled and its request dropped.
- A workflow tick or agent job cannot be discarded; the decision returns `409`. Release it, or cancel the run that owns it, which cancels the job. Until then the run waits, and recovery fails a stale workflow whose tick is quarantined, 10 minutes after the run last changed by default.
- A single lapse that was not the job's fault, such as a worker stopped during a deploy, counts too. A completion, failure, or deferral clears the count.

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

## A run shows `tool calls refused`, or fails after its tool step budget

- When a run has used its tool steps, its last turn still declares the same tools, because the conversation holds their calls and results, and asks the model to answer without a call: `tool_choice: {type: "none"}` on Claude, `tool_choice: "none"` on OpenAI, and `generation_config.tool_choice: "none"` on Gemini. Bedrock's Converse API has no such setting, so on Bedrock that request alone ends its last user message with `Answer now in text, without calling a tool, from the information you already have.` The saved turn does not keep that text.
- A status `tool calls refused` on a Claude, Gemini or Bedrock run: the last turn still called tools. None of the calls ran. Each got the result `Tool step budget reached; call not run. Answer in text from the results you already have.`, and the model was asked once more for its answer. That uses one more model turn from the run's budget, so a run with no model turn left fails on its budget instead.
- `<provider> returned tool calls after the governed tool-step budget was exhausted.`: the model called tools again when it was asked once more, and the run failed closed. On OpenAI, including a resumed run, the first such call fails the run, because `tool_choice: "none"` forbids it.
- A run that drives This Mac also asks for at most one tool call per turn: `disable_parallel_tool_use` on Claude and `parallel_tool_calls: false` on OpenAI. Gemini and Bedrock have no such setting, so there the per-turn cap still skips the extra calls.

## A tool call is blocked because it carried the context seal

- A blocked tool execution with the reason `A tool argument carried this workspace's context seal, a marker planted in retrieved context, so retrieved content is steering this run. This call and the run's later tool calls are blocked.`: the agent loop plants the seal at the head of the retrieved context it gives the model. The call's arguments carried it, so something the model read told it to copy that context into a tool call. That could be a document, a message, a web page or a tool result. The tool did not run. The blocked record keeps only how many arguments the call had, because the arguments can hold private context. The tool execution's `tool_execution:<id>` event stream holds `injection.canary_tripped`, with the run ID and how the seal was written: `plain`, `separated`, `hex` or `base64`. Find the item in the run's retrieved context that carried the instruction, then remove or correct it before you repeat the request.
- `An earlier tool call in this run carried this workspace's context seal, so the run's tool calls are blocked.`: the run already carried the seal into a call, so its later calls in that process are blocked without another event. Start a new run after you fix the content.
- The seal is derived from `OMNIAGENT_INTERNAL_AUTH_SECRET`, so rotating the secret changes it. Production refuses to derive it without the secret, which fails the agent run before its first model turn.

## Structured output fails on a Claude model

- A feature that asks the model for structured output (a workflow or project plan, for example) and fails on Claude with `Claude returned no structured tool result.`: the model did not call the tool that carries the result. Claude Opus 5.5, Claude Fable 5.1 and Claude Mythos 5.1 reject a forced tool call. On those models, and on any Claude model id not listed in `src/lib/models/anthropic-capabilities.ts`, the instructions ask for the call instead of forcing it. A model that answers in text gets one more turn asking for the call, and that turn's usage is added to the first. An answer cut off by the output token limit gets no second turn.
- A 400 from Anthropic with `tool_choice: type "tool" and "any" are not supported for this model.`: a forced call reached a model that rejects it. Remove that model's family from the list in `src/lib/models/anthropic-capabilities.ts`.

## A model reply stops at the token limit, or ends for another reason

- `Claude reached the response token limit. Narrow the request or split it into smaller steps.`, `OpenAI reached the response token limit. Narrow the request or split it into smaller steps.`, `Amazon Bedrock reached the response token limit.`, or `Gemini returned an incomplete response, usually because it reached the response token limit.`: the reply stopped at its output token limit (on Gemini, the interaction ended `incomplete` or `budget_exceeded`). Its text and tool calls are not used, because a tool call cut off there can have incomplete input. The error is not retryable, so the gateway tries no other model.
- `Claude reached the end of its context window.`: the reply stopped at `model_context_window_exceeded` and is not used.
- Models that think by default spend the output limit on thinking as well as the answer. A Claude model marked `thinksByDefault` in `src/lib/models/anthropic-capabilities.ts` gets the answer budget plus 4,000 tokens at `low` effort, 8,000 at `medium`, and 16,000 at `high` or when no effort is sent, up to 21,333 tokens, the largest limit Anthropic's SDKs accept without streaming. `xhigh` and `max` get that limit. The same applies to Claude on Bedrock, which sends no effort. Gemini requests get the answer budget plus 16,000 tokens, because Gemini counts thinking toward `max_output_tokens`. OpenAI counts reasoning toward `max_output_tokens` too, so an OpenAI request sent with an effort gets the answer budget plus 4,000 tokens at `low`, 8,000 at `medium`, 16,000 at `high`, and 25,000 at `xhigh` or `max`; at `minimal`, or on a model without an effort, it gets only the answer budget. A Claude model missing from the table gets only the answer budget; add it there if its turns stop at the token limit.
- Claude models listed in `src/lib/models/anthropic-capabilities.ts` get `output_config.effort`, and OpenAI reasoning models get `reasoning.effort`: the effort the caller or the Command selection asked for when the model accepts it, otherwise the nearest level below it that the model accepts, or the model's lowest level when none is below. On OpenAI, `gpt-5` models accept `minimal` to `high`, `gpt-5.1` `low` to `high`, `gpt-5.2` to `gpt-5.5` add `xhigh`, `gpt-5.6` and `gpt-6` models accept `low` to `max`, and `o`-series models `low` to `high`; Asael does not send `none`. Command's Thinking menu shows the levels each model accepts. The agent loop asks for `OMNIAGENT_AGENT_REASONING_EFFORT` (`low` by default).
- `Claude ended the response with stop reason <reason>.`: the reply ended with a stop reason other than `end_turn`, `tool_use`, `max_tokens`, `model_context_window_exceeded` or `refusal`, and it is not used. Anthropic sends `pause_turn` only for its server tools and `stop_sequence` only for stop sequences; these requests send neither.
- `Gemini ended the interaction with status <status>.`: the interaction ended in a status other than `completed`, `requires_action`, `failed`, `incomplete` or `budget_exceeded`.

## Gemini output tokens look higher, or a Gemini key fails as an authentication error

- Gemini reports thinking tokens in `total_thought_tokens`, apart from `total_output_tokens`, and bills them as output. Usage adds them to the output tokens, so usage receipts and the cost estimated from `GEMINI_MODEL_PRICING_JSON` include thinking. Receipts recorded before this change left it out. Gemini and OpenAI receipts also record the thinking alone as `reasoningTokens`.
- Google answers a rejected API key with 400 `INVALID_ARGUMENT` and the reason `API_KEY_INVALID`. That failure is recorded as `authentication`, not `invalid_request`. Neither is retried.

## An estimated model cost looks wrong, or is missing

- A cost is estimated only for a model listed in its provider's `*_MODEL_PRICING_JSON`. A dated snapshot, such as `claude-sonnet-4-5-20250929`, uses the price of the model it snapshots, `claude-sonnet-4-5`, unless the snapshot is listed itself. Any other id that is not listed has no cost.
- Tokens written to a prompt cache are recorded as `cacheWriteInputTokens` and priced at `cacheWrite`. Without it, a Claude write, direct or on Bedrock, costs 1.25 times `input`, and a write on any other model costs `input`. Tokens read from the cache are priced at `cachedInput`, or `input` when it is unset. Receipts recorded before this change priced Claude cache writes as `input`.
- Each receipt's `pricingVersion` changes when the price it used changes. It was computed differently before this change, so receipts recorded before and after it differ even at the same price.

## An agent quality SLO breaches, or is not judged yet

- Five default policies judge a tenant's agents over the last 24 hours. `agent_run_success_rate` is the share of finished runs that completed rather than failed; canceled runs are left out. `agent_tool_failure_rate` is the share of tool calls that ran and failed. `agent_first_output_p95` is how long `/api/agent` took to stream a reply's first text, recorded as `agent.first_output` observability events. `agent_cost_per_run` is a finished run's estimated model spend from its usage receipts; a call with no known price adds nothing. `agent_approval_latency_p95` runs from a tool approval being asked to an operator approving or rejecting it.
- `... is not judged yet: 3 of the 10 finished runs it needs.` or similar: the window holds fewer samples than the policy's `metadata.minimumSamples` (by default 10 runs for success rate and cost, 20 tool calls, 20 replies, and 5 approval decisions). Until it has them, the policy neither breaches nor resolves an incident. Only the database keeps runs, tool calls, and approvals, so without one those four are never judged.
- A breach opens an incident and alerts like any other SLO. Release evidence counts it as advisory: it warns and does not hold a release, because the fix may be the next release and approvals wait on people. The `agent_error_budget` release gate judges a week of runs and tool calls across workspaces instead.
- To find a slow or failed model call, search the egress gateway's logs for the work's correlation ID. The app sends it as `x-omni-correlation-id` on each call through the gateway, and the gateway logs it as `correlationId` on `openai_egress.completed` and `openai_egress.rejected` once the caller's gateway token checks out. An ID that is not 1 to 128 letters, digits, or `:._-` is not logged, and the header is never sent to OpenAI.

## The agent error budget holds a release

- The `agent_error_budget` gate counts the last 7 days of finished work in every workspace with an active member. Agent runs that completed or failed count, and canceled runs do not; 5% may fail. Tool calls that ran or failed count, and blocked, rejected, and dry-run calls do not; 10% may fail. The release smokes run in tenants with no members, so their work never counts.
- The gate does not judge an objective until 20 runs or 20 tool calls finished in the week. Failures at or above the allowed share spend the budget.
- `Agent runs have spent the week's error budget, and the last day still fails faster than the objective allows.`: the release is held. A spent budget holds a release only while the last 24 hours also fail at or above that share. Once the last day is within the objective, or nothing finished in it, the gate passes and says the budget is recovering.
- The gate's details give each objective's `successRate` for the week, `budgetSpent` (1 is the whole budget), and `burnRate` (the last day's failures over what the objective allows; 1 keeps pace). They hold rates only, never counts.
- `The agent error budget could not be read.`: the count query failed, so the gate fails closed. Check the database and the maintenance role.
- On the first upgrade that adds this gate, the currently deployed release has no `agent_error_budget` entry. The release runner uses `smoke:release -- --previous-release` only for its initial check before deploying anything. That check accepts the missing entry, records `previousReleaseCompatibility` in its artifact, and still requires every other gate and an approved report. A present failing budget gate still blocks it. Staged, canonical, post-activation, and nightly checks require the budget gate; the compatibility argument is never passed to them.
- To ship a fix for measured agent-run exhaustion while tool calls are not exhausted, export `OMNIAGENT_RELEASE_ERROR_BUDGET_EXCEPTION="<why this release ships>"` for that one `npm run deploy:production`, then unset it. Unread budget telemetry or exhausted tool calls still block release. The reason is one line of at most 200 characters; the release smoke refuses anything else, and the route answers `400`. The report records the reason and whether it was applied. Each evidence read that applies it records a `release.agent_error_budget.exception_applied` security event with the reason, the actor, and the revision.
- The exception covers only this gate. It never passes a blocking SLO breach, such as the `error_budget` policy for runtime error events in the `observability_slo` gate.
- A split recovery checks the web with `smoke:preflight` before it deploys, and preflight does not read the budget. Set the exception before such a release starts if the budget is held, or the post-activation `smoke:release` fails and the runner rolls the release back.
- While the budget is held, the nightly `Production Smoke` fails its `release` gate too.

### Owner-authorized deployment despite historical error rates

The owner's delivery preference is to deploy implementation changes so they can
verify them live. Historical run or tool failure rates must remain visible, but
an explicitly authorized release can proceed through the paired runner using
`OMNIAGENT_RELEASE_OWNER_ERROR_BUDGET_OVERRIDE`. Supply one JSON object with
exactly `candidateRevision`, `previousRevision`, `reason`, and `expiresAt`.
Revisions are distinct full commit SHAs; the reason is one line of at most 200
characters; the expiry is an ISO timestamp no more than four hours ahead.
Do not combine it with `OMNIAGENT_RELEASE_ERROR_BUDGET_EXCEPTION` or save it in
Vercel, Fly, repository configuration, or an unattended recurring job.

This exception accepts only fresh, measured 95% agent-run and 90% tool-call
objectives, on the pinned previous revision during preflight/rollback and the
pinned candidate during staged/canonical checks. An exhausted budget must be
the sole failed gate, every other gate must pass, and warnings are not waived.
Unread telemetry, changed objectives, missing gates, wrong revisions, expiry,
and any additional failure still stop deployment. Ordinary checks without the
pin keep their existing behavior.

The local release artifact preserves the server's original blocked report and
adds `ownerErrorBudgetOverride` with the bounded reason, revision pair, expiry,
and measured proof. It never rewrites failure history or claims that the
server's reliability gate passed. Keep each release artifact with the owner
authorization, unset the pin afterward, and investigate the recorded failures.

## The provider contract suite fails

- `<provider>/<scenario>: request N was POST <url>, but the fixture expected POST <url>`, or `request N (POST <url>) has no recorded response`: the adapter sent a request that the fixture does not have, such as a new endpoint or an extra turn. The adapter got a 400 `contract_fixture_mismatch` response instead, and the test reports the mismatch rather than the error that response caused. If the adapter changed on purpose, record the scenario again with `npm run test:provider-contract:record` and review the diff.
- `N recorded responses were never requested`: the adapter stopped before the fixture's last exchange. For example, it made fewer retries after a rate limit, or skipped a turn it used to take.
- `There is no <provider> fixture` or `The <provider> fixture has no <scenario> scenario`: restore the fixture from Git, or record it.
- The `truncated` and `rate_limit` scenarios cannot be recorded, so edit their exchanges in the fixture by hand, from the provider's API reference.
- A live run fails where the fixtures pass: the provider's API or the model's behavior has changed. Fix the adapter, then record the scenarios and review the diff before committing it. A live usage total that differs from input plus output tokens means the provider reported a token class that the adapter does not count.
- A live run skips each provider that has no credentials, and fails `has live credentials for at least one provider` when none has any.

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
- `permission denied for function omni_memory_deletion_manifest_v1`: the serving role has another name, or v207 was applied outside `npm run db:migrate` before the role existed. Grant it `EXECUTE` as the deployment note shows.
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

## A Google connection stops syncing on schedule

A connection whose last syncs reached none of its sources waits until `sync_retry_at` in `omni_oauth_grants`, and `sync_failure_count` is how many such syncs ran in a row. The wait starts at five minutes and doubles up to six hours. `sync_error` holds the last sync's error, with each failed source's name before its message, and `source_sync_health` holds each source's failure code.

- Every source failed with `Connected source timed out.` (`provider_unavailable`): Google took longer than 30 seconds to answer a request, or to send its body. Check Google's status and the deployment's egress.
- The sync failed before any source, for example on a refused token refresh: reconnect the account, which clears the wait. A refused refresh keeps retrying about every six hours until then, because a misconfigured OAuth client is refused the same way.
- One source keeps failing while another syncs: the connection is not held back, so the failing source is tried again on every tick.
- A sync stopped with `Connected source was revoked during synchronization.`: the account was disconnected or reconnected, or another sync took the connection over, while this one ran. The sources that finished before then keep their progress, and no later source is read. The source that was running may have indexed part of a page already; its next sync reads that page again without duplicating it.
- A request failed with `The connection was disconnected or reconnected while its access was being refreshed.`: its access token was refreshed while the account was disconnected or reconnected. The refreshed token is discarded and the connection stays as the disconnect or reconnect left it. Try again; after a reconnect it uses the new authorization, and the sources sync from the start.

Run a manual sync to try right away; it does not wait, and its outcome counts like a scheduled one.

## A Google source keeps failing on one item, or an item is set aside

A source that cannot process an item (`processing_failed`) keeps its place, so its next sync reads the same page again. Once the item has failed three times, over at least an hour, the sync sets it aside and the source moves past it. The connection's `connector:<connection id>` event stream shows `connector.source_item.quarantined`, which names the item only by a digest of its id.

- The sync reads a set-aside item again by its id six hours later, then waits twice as long after each failure, up to a week, two items a source each sync. An item its source reports changed or removed comes due at once. Once the item ingests, or its source no longer has it, it leaves the list and `connector.source_item.released` records which.
- Only a failure to process the item counts. A provider failure such as `Connected source returned 429.`, an interruption, or a revoked connection fails the source as before, and never sets an item aside.
- A source keeps at most 20 items set aside. With 20, a failing item holds its source in place as before.
- An embedding outage also fails as `processing_failed`, so it can set aside one item a source each hour it lasts. They are read again as they come due once it is over.
- The list lives in the connection's sealed sync cursor, so reconnecting the account clears it along with the rest of the cursor.

## A Google source started over and removed documents, or stopped checking them

A listing cannot show an item that left, so a Google source that starts over would keep the documents of items that left the account while its place was lost. A source starts over on its first sync after the account connects, and when Google rejects its change position or sync token. When it does, it checks again, by their ids, the documents it held from before: 50 each sync, five at a time, once the source's page has been read. The connection's `connector:<connection id>` event stream shows `connector.source_sweep.finished` once every one is checked, with how many it checked and removed. The event names no document or item.

- A document is removed only when its source answers, for that id, that the item left: Gmail answers 404, or the message is in spam or trash; Calendar answers 404 or 410, or the event is cancelled; Drive answers 404, or the file is trashed or not owned by the account. Any other answer, including an unreadable one or one about another item, keeps the document.
- The sweep stops before it removes anything at a slice that would remove documents while its source confirms none of them still there, when no document it checked before was confirmed either, or when the slice would remove ten or more. `connector.source_sweep.stopped` records how many it would have removed. This keeps a sync that reads another account, or a source that answers 404 for everything, from emptying the account's knowledge. The documents stay indexed. A source whose held documents all left, or that lost ten or more in one slice, stops again the next time it starts over.
- A provider failure while checking, such as `Connected source returned 503.`, keeps the sweep where it was, and the next sync checks the same slice again. Only the sweep waits; the source keeps its own progress. The worker logs `connector.source_sweep.failed`.
- A source that starts over while its sweep runs starts the sweep again. The sweep checks only documents indexed before the source started over, so it never checks what the new listing indexed.
- The sweep's place lives in the connection's sealed sync cursor, so reconnecting the account clears it, and the first sync after the reconnect starts a new one.

## Connector discovery or execution is blocked

- Use an HTTPS hostname with public DNS; private, loopback, link-local, metadata, embedded-credential, and unsafe redirect targets are rejected.
- Store a connector credential in an `OMNIAGENT_CONNECTOR_*` variable and reference its name. Do not paste the value into connector metadata.
- Platform secrets remain blocked even if a connector attempts to reference them. Keep the explicit allowlist narrow.
- Re-import or rediscover only after reviewing vendor schema/tool changes and their risk levels.
- A successful import does not bypass approvals for side effects.

## The tenant isolation report fails a table

`/api/security/isolation-report` lists a table under `missingPolicies` when the table's policies do not match its contract: an actor or actor-scope table has a permissive policy besides its actor policy; any other table's only permissive policy is not `omni_tenant_isolation`, or it lacks the restrictive actor policy that narrows it; or the permissive policy does not cover every command. The release gate's database tenant isolation check fails with it.

- A database the old runner migrated fails 38 actor tables until migration 208 runs, because each also has a permissive `omni_tenant_isolation` policy that admits every actor's rows. Apply every pending migration; [deployment.md](deployment.md#schema-catalog-convergence-v208) has a query that lists these tables.
- Otherwise, list the table's rows in `pg_policies`. A second permissive policy widens the table, because permissive policies combine with OR. Find out where it came from before you drop it.

It lists a table under `unclassifiedTables` when `src/lib/db/schema/tenant-isolation.ts` does not classify it, and the database integration test fails on the same table. Add a table that `omni_tenant_isolation` should protect to `tenantRootPolicyTables` or `tenantChildPolicyTables`, and one whose migration creates its own row security to `migrationScopedTenantTables`. Add a table that holds no tenant's rows to `tenantIsolationExemptTables`, with the reason.

## Production smoke fails

- Preflight: set an explicit HTTPS `BASE_URL`, all three smoke credentials, and `RELEASE_EVIDENCE_OUTPUT`.
- Revision: scheduled GitHub runs resolve the currently served exact SHA from `/api/health`; manual canary checks must pass the intended `expected_revision`. A supplied mismatch is a deployment failure and is never replaced by discovery.
- Timeout: inspect the failing method/path and `SMOKE_REQUEST_TIMEOUT_MS`; fix the slow dependency before increasing the bound.
- Security: confirm anonymous protected routes return 401 and the admin cookie is secure.
- Tenant/eval: confirm the internal secret is deployed and database RLS/evaluation state is current.
- Manifest: see [The signed release manifest gate fails](#the-signed-release-manifest-gate-fails).
- Release: inspect gate reasons and warnings in the bounded JSON artifact.
- Artifact: the release step must create a non-empty file below `RELEASE_EVIDENCE_MAX_BYTES`; skipped or missing evidence is a failure.

Synthetic smoke requests carry correlation IDs and are marked SLO-excluded. Search those IDs in observability when diagnosing a gate.

## The signed release manifest gate fails

- The release runner signs a manifest for each release it makes. It names the revision, the repository and branch, the green checks the runner verified, and the signing time. The runner signs it with the Ed25519 key that `OMNIAGENT_RELEASE_SIGNING_KEY_FILE` names and deploys it as `OMNIAGENT_RELEASE_MANIFEST`, and `/api/health` serves it as `releaseManifest`. `npm run smoke:manifest` checks it against the public keys in `RELEASE_SIGNING_PUBLIC_KEYS` in `scripts/release-manifest.mjs`: on the staged deployment before the worker or production changes, on the canonical domain after promotion, and nightly.
- `the deployment's release manifest is missing.`: the served deployment was not made by the runner, or was made before releases were signed. Replace it with a runner release from `main`.
- `the deployment's release manifest is signed by key <id>, which this repository does not trust.`: the release commit does not carry the public key of the key the runner signed with. Merge the public key that `npm run release:signing-key` printed to `main`, then release from that commit. On the nightly, the key may have been removed from `main` while production still serves a release it signed.
- `the deployment's release manifest carries a signature key <id> did not make.`, or `the release manifest signs <revision>, but the deployment serves <revision>.`: the manifest was changed, or copied from another release. Treat it as an unreviewed production change.
- `OMNIAGENT_RELEASE_SIGNING_KEY_FILE must be readable only by its owner (chmod 600).`, and the probe's other key file errors: fix the file the variable names. The runner never prints the key.
- To rotate the key, create a new key at a new path and add its public key beside the old one. Release with the new key, and remove the old public key only after that release is promoted. If a private key is lost or exposed, remove its public key at once; every deployment it signed then fails the gate until a release replaces it.
- The gate proves that the runner released the revision a deployment serves. It does not prove the deployment runs the code built from that revision: a manifest copied onto another deployment of the same revision still verifies.

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

## Live web search and Research

General Research uses the normal bounded Agent loop, with Scout and the
Evidence research Skill exposing `web.search`, knowledge retrieval, and memory
retrieval where authorized. Markets/Meridian is a separate market-data workspace.
A configured provider key is configuration evidence only; it does not prove a
live search succeeded.

`web.search` requires a completed hosted search, a nonempty answer, and usable
source URLs. Requests preserve `allowedDomains`; a model that rejects domain
filters returns an actionable error instead of widening the search. The
provider request has a 25-second deadline, no hidden SDK retries, and bounded
hosted calls and output. Returned hosted calls determine search usage.

Automatic search resolves the Agent's permitted tools before using the governed
executor. Research keeps that authorized search tool for follow-up questions.
Explicit no-web instructions disable search for the run; selecting Research
alone does not trigger a paid search for an otherwise offline request.

For a bounded authenticated check, provide `BASE_URL`, `EXPECTED_REVISION`,
`SMOKE_PAID_AGENT_EMAIL`, and `SMOKE_PAID_AGENT_PASSWORD` through the operator
environment, then run `npm run smoke:web-research`. Optional
`SMOKE_INTERNAL_AUTH_SECRET` labels synthetic telemetry, and
`VERCEL_AUTOMATION_BYPASS_SECRET` admits a protected staged deployment. The
script never uses those headers as execution identity. It verifies a direct
governed search and a session-only, read-only Research Agent, checks citations,
purges its temporary Agent through exact previews, and signs out. It never
retries a paid POST. `SMOKE_WEB_SEARCH_ONLY=1` limits the check to direct search.

The receipt and stream diagnostics omit answer text and credentials. A passing
receipt applies only to the pinned deployment and queries tested; it is not a
guarantee that every source is correct or every provider request will succeed.
