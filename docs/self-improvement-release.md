# Self-improvement release controller

Asael owns observation, daily scheduling, Atlas delegation, sandbox changes,
candidate validation, review and the release queue. The local controller reads
that queue and performs the credentialed release. It does not start improvement
cycles, change their schedule or nominate work. Its one-minute poll only finds
already authorized candidates. When the Mac is offline or its saved credentials
are unavailable, publication waits; remote analysis can still finish.

## macOS is the primary workspace

Mac app 1.40.0 (116) provides **Self-improvement** in the native sidebar. The
native workspace uses the same owner-scoped services as the web: daily schedule
and spending settings, Run now, pause/resume, cycle history, agent work, validation
evidence, exact candidate review, and recorded release outcomes. An improvement
notice opens its exact cycle inside Asael. Browser code comparisons are optional;
using the workspace does not require a browser session.

The Mac publisher is installed once as the independent trusted background service
described below. Closing or quitting Asael does not stop it. **Pause schedule**
stops future improvement work after server confirmation; an already claimed release
must finish or roll back. Signing out of the app does not revoke the publisher's
separate saved authorization. An offline or failed control stays unconfirmed and
is not queued for automatic replay.

Publisher connection is its last reported server heartbeat, not proof that a local
installation or credential is usable now. The UI keeps disconnected, held, and
unknown outcomes visible. Schedule-only edits retain the admitted policy. Changes
to budget, automatic-release or notification policy require the trusted publisher
to admit the new exact policy before it can publish another candidate.

Native API v62 publishes the read and owner-control operations while retaining
v61 compatibility. The native client cannot advance execution phases or access
the credentialed release-controller API. An ordinary Mac feature repair can
produce a signed app update after one exact owner approval. The installed
publisher owns signing and replacement; generated code never receives that
authority or its credentials.

The maintained implementation is `scripts/self-improvement/controller.py`.
Installation copies reviewed controller code outside the editable repository,
pins every Python source and the owner configuration by SHA-256, and produces a
launchd definition. A candidate cannot change that installed policy or its source
pins. The controller admits only one active local process and one attempt per
cycle/candidate. A crash or uncertain outcome requires reconciliation, not a
second deployment.

## Signed Mac improvements

Atlas selects a concrete Dart feature defect or a small, testable enhancement
with `releaseTarget: "macos_app"`. Forge writes a regression first. The Mac
publisher claims its sealed source snapshot, verifies the exact source bytes,
and runs that test against the unchanged application. Only a recorded failure
for the intended behavior permits implementation. The repaired snapshot then
receives focused analysis, the regression, an existing adjacent test, and an
actual unsigned arm64 Mac build. Sentinel independently reviews the source and
recorded results before Asael opens the exact package for owner review.

The fixed `asael_macos_feature_v1` profile allows ordinary files under
`apps/flutter/lib/features` and Dart tests. It excludes authentication,
self-improvement, security/settings/command authority, core services,
navigation, platform brokers, native helpers, dependencies, build controls and
the voice activity guard. It does not currently support generated Swift
changes. Those surfaces require a reviewed operator release. An approval does
not broaden the profile or permit a candidate to edit its validator.

Validation uses a separately installed, pinned toolchain and dependency set.
The copied Flutter test adapter admits one controller-reserved loopback port
because Flutter's own test driver needs that socket. Test concurrency is one;
DDS is disabled. Other network access, Keychain, private credentials and writes
outside the isolated build paths are denied. The shared Flutter SDK is not
patched. Changing dependencies or the installed toolchain requires a new
reviewed provisioning step, rather than downloading packages in a candidate.
The pinned cache includes Flutter's generated local Swift packages. The final
build starts from a fresh copy of the sealed source and reviewed dependencies,
so generated files left by tests cannot become part of the signed application.

Native validation has its own exact claim and completion receipts. It does
not run extra model turns while waiting for the Mac. A dead controller becomes
an explicit hold only after both its lease and request expire. **Stop check**
cancels that held cycle without erasing evidence or replaying work, and is
available only when no live claim or unsettled paid phase remains. Unchanged
waiting is quiet; a current held request can produce one actionable notice.

**Approve Mac update** binds the candidate, validation, unsigned artifact,
installed app baseline and policy. The publisher then verifies the exact merge,
signs the retained build with the existing enrolled identity, waits for the app
to be idle, and replaces it using a recoverable installation journal. Voice,
capture, local helper work and unsaved drafts prevent replacement. The candidate
starts in a short protected check state. Its signed source resource, compiled
snapshot, restored owner session and rendered improvement workspace must match
before normal interaction resumes. If startup fails while that protected state
is still proved, the installer restores the retained app. An unknown or busy
process is held for reconciliation; it is never force-closed on an assumption.

A Mac-only update leaves Vercel and Fly serving the same verified pair. The
source repository may consequently be ahead of that pair. Before a subsequent
web release, the server and independent publisher prove that every intervening
change is confined to the allowed native paths. The sealed `pairedBaseline`
records the actual server revision and manifest separately from the Git merge
parent, so a web rollback restores the correct serving pair.

The first 1.40.0 installation is supervised because earlier apps do not have
the protected update handshake. For that package, set
`ASAEL_MACOS_RELEASE_PROVENANCE_FILE` to a strict JSON object containing
`protocol: 1`, exact `sourceRevision`, `sourceSnapshotSha256`, `version`, and
integer `build`. The existing operator packager compiles the snapshot identity
and uses the publisher's shared writer to embed
`Contents/Resources/asael-native-release.json` before signing. Subsequent
approved updates use the independent publisher's fixed signing transform;
they never execute a candidate-controlled packaging script with signing keys.

## Exact request and release protocol

The canonical origin is fixed to `https://asael.bennierichard.com`. Requests use
an actual owner session obtained from the saved login Keychain item, with the
trusted Origin header, bounded responses and no redirects. The password and
session cookie are never written to receipts or sent into a Builder sandbox.
The controller keeps one session in memory while polling and refreshes it after
30 minutes. Failed connectivity backs off; it does not repeatedly prompt for a
password. It signs out on an orderly stop.

`GET /api/self-improvement/release-controller` returns at most ten actor-private
requests. Each request carries `cycleId`, `policyId`, `tenantId`, `ownerActorId`,
`policySha256`, `previousRevision`, `candidateRevision`, `validationSha256`,
`pullRequestUrl`, `repository`, the sealed `policy`, sealed `candidate`, sealed
`validation`, and an optional exact owner `approval` receipt.
The installed configuration must independently admit that policy digest.

The controller checks recorded focused/adjacent regressions, typecheck and
independent review, including actual case counts, exact source/workspace,
timestamps and source hashes. It fetches the exact commit from the configured
repository and verifies every changed file's bytes and Git mode. It refuses
symlinks, unclassified surfaces and protected control-plane edits. The local
checkout must be clean. Production must still serve the expected previous web
and worker revision (or the independently proved `pairedBaseline`). Recovery
evidence must match the logical database and the
complete current schema, meet its recovery objective and remain within the
installed maximum age.

A larger ordinary application change, a declared major architecture change or
a policy with automatic release disabled requires one current owner approval.
Its hash, owner, policy, candidate and validation bindings must all match.
Approval cannot authorize edits to the controller, release, authentication,
native authority or migration controls: those require a trusted operator release/install
handoff. Both the app and the independently installed controller enforce this
boundary.

The following POST actions use the same endpoint and an idempotency key derived
from their exact body:

1. `claim`: `{action, cycleId, candidateRevision, controllerId}` returns
   `{claim:{leaseToken, expiresAt, request, releaseBudget:{phaseId,reservedUsd}}}`. The returned request must exactly
   equal the one checked. No deployment credential has been loaded yet.
2. `heartbeat`: `{action, cycleId, leaseToken, controllerId}` renews the app's
   active release claim and rotates its token. The controller sends one every 30 seconds; heartbeat, prepare, completion and hold share one lock so a rotation cannot race a mutation.
3. The controller merges the exact PR with `--match-head-commit`, then proves
   that its squash commit has the observed base as its parent, its tree equals
   the validated source tree, and it is still the current remote `main` tip.
   `prepare`: `{action, cycleId, leaseToken, controllerId, mergedRevision,
   sourceTree, mergedTree}` returns a sealed `releaseBinding`. The server
   independently verifies the merge through its GitHub provider. Both tree
   fields are 40-character Git object IDs, not SHA-256 hashes. The binding keeps
   the source candidate separate from the actual merged release SHA.
4. `complete`: `{action, cycleId, leaseToken, controllerId, receipt, releaseUsage}` records
   the exact binding, outcome, web/worker revisions, manifest/health/behavior/
   release evidence hashes and timestamp. A web release requires both serving
   revisions to equal the actual merged commit. A Mac release instead requires
   the unchanged server pair and its exact signed installation/startup receipt.
   Rollback identifies the explicitly restored server pair or native bundle.
5. `hold` records a fixed category, occurrence time and any claimed release usage.
   `status` records controller presence separately; GET queue reads are inert.
   Unknown spend or ambiguous deployment keeps the release claim held.

A sealed policy separates `dailyBudgetUsd` (the owner-wide UTC spending ceiling)
from `maxCycleBudgetUsd` (the allowance reserved for one admitted repair). New
policies default to the smaller of $10 and the daily ceiling. Old policies omit
the field and retain their original daily-sized cycle allowance and exact hash.
Every ordinary admission counts its full reservation against the saved UTC day;
unused allowance is not refunded by pausing, changing settings, or finishing a
cycle. One cycle remains active at a time. Additional owner-requested cycles
can use remaining daily capacity; they do not change the natural daily schedule.
Paid-phase admission also counts settled cost and unresolved work carried over
from earlier days against the daily ceiling. A cycle can never spend more than
its own admitted allowance.

Claim atomically reserves up to 10% of the admitted cycle allowance before merge,
limited by the remaining cycle budget,
also checking the owner-wide daily paid-work limit.
The two existing paid checks (staging and production) each receive half of that
reservation as an enforced `/api/agent` budget, with one model turn, no tools,
fan-out or retries. The verifier reconciles streamed known model cost against
its persisted trajectory model receipt and emits a private receipt. Completion/hold settles
`releaseUsage:{phaseId,actualUsd,evidenceSha256}`. Missing usage is `null`, never
zero. It prevents an automatic repeat and retains the reservation. No third
paid check can start from this reservation. A native-only publication reserves
zero additional model cost: its focused tests, build and startup checks run
locally and its server observation is read-only.

The controller never treats a nonzero process exit as proof of rollback. The
paired runner optionally writes a private `OMNIAGENT_RELEASE_CONTROLLER_RECEIPT_FILE`
with its actual outcome. A timeout, missing receipt, split pair, expired session
or uncertain merge stays held. Local immutable attempt files retain the request,
claim, merge, deploy start, runner result, evidence and callback receipt. If the
callback fails after a successful release, replay only the saved receipt after
reconciliation; do not run the deployment again.

For a completed native installation whose callback was interrupted, the
publisher's explicit `--reconcile-native-completion <attempt-digest>` path
rechecks the terminal journal, actual signed app, owner startup and server pair.
The server's `recover_native_completion` action accepts only the exact latest
expired native release token and persists completion-only authority. It cannot
prepare another release. A terminal exact receipt replay is read-only; a changed
receipt, lost token or uncertain installation remains held. This recovery never
merges, signs or installs again.

Actual deployments also acquire `~/.asael/production-release.lock`, shared by
operator releases and the controller across worktrees. Read-only probes do not
acquire it. The existing per-broker attempt lock is separate. A crash leaves
this lock in place; reconcile actual paired health before an operator clears it.

## Build and credential boundary

Unattended owner-live releases set
`OMNIAGENT_RELEASE_ISOLATED_BUILD=required`. The paired runner uses a clean build
environment, temporary HOME/npm configuration and macOS `sandbox-exec` for its
existing typecheck and build. The sandbox allows source/dependency reads and
specific build outputs. It denies network access, dotenv files, Git credentials,
Keychain services, release credential directories and writes to source or
dependencies. `build-isolation.test.mjs` exercises those actual OS boundaries.
The ordinary paired runner also removes release secrets from local build envs.

The credentialed parts are the independently protected scripts and installed
hosting CLIs. Dependency locks, package scripts, Next/build configuration,
release scripts, CI, authentication, tenant isolation, tool execution and the
self-improvement controller cannot be changed by this automatic lane, including
when the app contains an owner approval. Updating those parts requires a new
reviewed controller installation. Native authority changes and migrations also
use the separate operator release procedure; ordinary Dart feature updates use
the fixed signed Mac lane above.

The deployed application naturally retains its normal runtime secrets on its
hosting platform. This controller keeps *release credentials* out of the coding
sandbox and local candidate build; it does not claim that deployed application
code cannot access its own configured runtime services.

This installation is a boundary against remote Builder-generated code. It is
not an OS security boundary against a malicious process already running as the
Mac owner. A separately administered release user/host is required for that
stronger isolation. Do not give app computer-control tools access to the
controller's installation, private state, credentials or launchd definition.

## Recovery evidence without maintenance pauses

`recovery.py` reuses a fresh, private, hash-pinned successful restore receipt for
the same logical database/schema. Otherwise it invokes the existing
`db-backup.mjs` and `db-restore-drill.mjs` against a newly created loopback-only
PostgreSQL cluster with TLS, SCRAM and a random local credential. The configured
PostgreSQL installation must provide pgvector. Restored grant roles are NOLOGIN,
NOSUPERUSER and NOBYPASSRLS. Only the exact freshly created cluster is stopped
and removed; a failed stop retains its private marker for operator cleanup.

The encrypted backup and evidence remain outside Git. Production is only read
for this backup; the controller does not pause Vercel, stop the production worker,
change cron or migrate the database. The existing backup tools enforce a
dedicated backup role and isolated restore target. A missing backup route,
encryption key, PostgreSQL extension or disk space holds publication.

## Installation and required local configuration

Before installation, deploy the consolidated feature with the ordinary paired
procedure and verify its app-owned candidate flow. Use a **dedicated clean clone**
for `checkoutDirectory`, with Node 24/npm 11 dependencies already installed from
the reviewed lockfile. Do not use a human's working checkout or a Builder sandbox.
The checkout must contain the installed baseline revision. Stage the existing
authorized TradingView dependency through its ordinary trusted setup.

Create one owner-only JSON configuration outside Git. The required fields are:

| Field | Meaning |
|---|---|
| `controllerId` | Stable identifier registered in Asael's release claim |
| `checkoutDirectory`, `stateDirectory` | Dedicated checkout and private state on Extreme Pro |
| `executablePath` | Fixed PATH for installed gh/vercel/fly CLIs; controller prepends `/opt/homebrew/opt/node@24/bin` and checks Node major 24 |
| `allowedPolicySha256` | Owner-installed list of exact app policy digests |
| `verificationMode` | `owner-authorized-live` or `use-hosted-verification` |
| `ownerLiveReason` | Standing owner's bounded reason for build/live mode; no historical-budget exception |
| `databaseIdentity` | Existing logical `omniDatabaseId` from verified recovery evidence |
| `maximumValidationAgeSeconds` | Focused evidence maximum age; default 86400 |
| `maximumRecoveryAgeSeconds` | Backup/restore maximum age; default 86400 |
| `recoveryEvidence` | Optional `{path,sha256}` for an existing matching restore receipt |
| `releaseAuth.email` | Existing Asael release login email |
| `releaseAuth.loginHelper` | `{path,sha256}` for the installed saved-Keychain `keychain_credentials.py` |
| `releaseAuth.vercelExecutable` | Existing installed Vercel CLI absolute path |
| `releaseAuth.vercelAuthFile` | Private existing Vercel auth JSON reference |
| `releaseAuth.signingKeyFile` | Existing owner-only release signing key path |
| `releaseAuth.gateway`, `releaseAuth.vercelBypass` | Existing Keychain `{service,account}` references |
| `recovery.encryptionKey` | Existing private `{path}` or Keychain `{service,account}` reference |
| `recovery.sourceCa` | Owner-only `{path,sha256}` pin for the source PostgreSQL CA certificate |
| `recovery.postgresBin` | Existing PostgreSQL 17 binary directory with pgvector |
| `recovery.opensslExecutable` | Existing OpenSSL binary absolute path |

The Vercel production configuration must contain the same owner email,
`OMNIAGENT_BACKUP_DATABASE_URL` and internal smoke secret. If the hosting pull API intentionally omits the runtime `DATABASE_URL`, the dedicated backup connection also performs the read-only identity check; its logical database ID must still match the installed pin. No
secret is copied into the configuration. The saved Keychain login eliminates
routine password typing; an unavailable or locked item remains an explicit hold.

From the reviewed clean release commit run:

```sh
/opt/homebrew/opt/python@3.14/bin/python3.14 scripts/self-improvement/install.py \
  --configuration '/absolute/private/controller-input.json' \
  --destination '/absolute/private/controller-<reviewed-revision>' \
  --python '/opt/homebrew/opt/python@3.14/bin/python3.14'
```

This is inert with respect to production: it copies sources, creates their pins,
checks the installed configuration without loading credentials and writes a
launchd plist. It reports `installed_not_started`. The operator then places that
plist under their LaunchAgents directory and uses `launchctl bootstrap` for the
current GUI user. Starting the reviewed controller is a real operational step;
do it only after the app endpoint and a bounded candidate flow have been verified.
The Release Timeline remains stopped.

Use the verified Homebrew Python 3.14 runtime for its configured certificate trust; the older Framework Python installation on this Mac could not verify the canonical host. TLS verification is never disabled. PostgreSQL uses the installed CA pin and `verify-full`.

The generated launch agent runs `controller.py --watch`. A `PAUSED` file in the
private state directory stops new local work; pause the app policy to stop new
cycles as well. A build/release already in flight is allowed to finish its
existing rollback path. Do not kill a paired release to pause future work.

Hosted CI deployment is not configured by this feature. Moving the controller
to a protected always-on host requires provisioning its independent credentials,
trusted runner and isolated build environment. Until then, availability of the
Mac, Extreme Pro, login Keychain, hosting CLI sessions and local PostgreSQL is a
real dependency and should be visible in the app.

## Focused validation

```sh
/opt/homebrew/opt/python@3.14/bin/python3.14 -B -m unittest discover -s scripts/self-improvement -p 'test_*.py'
/opt/homebrew/opt/node@24/bin/node --test scripts/self-improvement/build-isolation.test.mjs scripts/self-improvement/runner-receipt.test.mjs scripts/self-improvement/deploy-lock.test.mjs scripts/self-improvement/release-budget.test.mjs
/opt/homebrew/opt/node@24/bin/node --check scripts/deploy-production.mjs
```

These checks cover authority/hash binding, changed validation, protected paths,
old evidence, owner scope, receipt immutability, rollback classification and the
actual macOS build boundary. They do not prove live credentials, GitHub merge,
backup/restore, the app controller API or deployment. Record those separately
during the consolidated feature's bounded live validation.

## Notification and device compatibility

Actual transitions to `succeeded`, `failed`, `rolled_back`, `review_required`,
and exact `self_improvement.release.held` or
`self_improvement.native_validation.held` events produce notifications.
The release hold must still match the saved controller category and occurrence
time; a native hold must match the active request, request hash and category.
No-change and intermediate work stay
quiet. The exact typed cycle event identifies one durable disposition; the
existing transaction co-commits its Inbox item and mobile/browser outboxes.
Quiet hours defer the disposition, and the existing tenant tick retries only
that occurrence when due. A superseded review is not delivered later as fresh
work. Registration/session ownership is rechecked by the existing transports.

Browser alerts open `/app/improvement`. Native contract v62 understands the new
Inbox kind and opens the exact cycle in the native **Self-improvement** workspace.
The Mac workspace does not require a separate browser sign-in.
Native clients below v62 are filtered before listing limits/bulk mutations and
do not receive an unsupported push payload. Actual notification receipt/tap
requires a compatible installed device and is distinct from provider acceptance.

## Local candidate proof

`mac_credentials.candidate_environment` supplies existing model/pricing and
GitHub App credentials plus explicit Vercel Sandbox credentials to a bounded
local worker process. It refuses a database other than the disposable loopback
`127.0.0.1:55439/asael_self_improvement_candidate` and a non-loopback app origin.
It does not copy the production database, owner login, internal-auth or release
signing secrets. These credentials stay in the app worker; Builder-generated
code and dependency installation receive none. Keep the private candidate
receipt and measured spend, and clear the environment after the process exits.

Vercel intentionally returns empty values for sensitive environment fields.
The loader does not claim that such values can be exported. If GitHub App
credentials are available only inside the existing hosted runtime, a local
candidate proof must wait for an existing legitimate credential reference or
use a separately reviewed hosted validation path. Do not export runtime secrets
through a new application route or substitute a general GitHub personal token.

## Staged application-owned feature proof

For the initial feature release, the paired runner supports
`OMNIAGENT_RELEASE_FEATURE_PROBE=self_improvement_v1`,
`LIVE_VERIFY_SELF_IMPROVEMENT=CONFIRMED`, and a new private
`SMOKE_SELF_IMPROVEMENT_EVIDENCE_FILE`. The maintained
`scripts/smoke-self-improvement.mjs` uses the real staged application and its
existing hosted GitHub App and Sandbox configuration. It does not export those
credentials. The ordinary signed-in owner creates one retained verification
project and a $10 routine-auto policy with `notifyOutcomes: false`, then queues
one cycle and retains its exact operation-job identity. The staged Fly worker
remains release-held. The probe uses the existing authenticated owner `advance`
operation to execute the same application-owned phase handler, one exact current
cycle revision at a time. Atlas, Forge and Sentinel perform the work through
their normal governed tools; the probe does not implement the repair. Evidence
labels this execution mode `staged_owner_advance`, not autonomous scheduling.
It records actual app-service receipts and observed phase/revision timestamps,
allows at most 21 bounded advances within 45 minutes, and never retries an
uncertain request or replays paid work. Active execution leases are respected.
It never forces a tenant tick, approves a candidate, merges a PR or deploys the
repair. The queued job must remain unclaimed throughout staged verification.

The notification preference is part of the immutable sealed policy. Keep it
false through the initial trial and its first repair release: the original
rollback predecessor cannot parse the new Inbox notification kind. No Inbox,
disposition or delivery outbox should be created for that policy, including
held-release and quiet-replay paths. Improvement records and release evidence
remain visible in the workspace. Global notification preferences are unchanged.
Only after that cycle is terminal may normal $100 enrollment enable
`notifyOutcomes: true`, when the rollback predecessor includes the new reader.
The installed controller must admit that exact normal policy digest as well.

The staged gate requires completed Atlas, Forge and Sentinel runs, an actual
failing baseline reproduction, passing focused/adjacent/typecheck/review
receipts bound to the exact source/workspace, known spend within the $10 cycle
reservation, and a confirmed GitHub PR. A no-change decision is recorded but
does not prove a repair. Failure, timeout and unknown usage stop promotion; the
probe does not create a replacement attempt. Existing repository enrollment is
never overwritten. The initial controller must remain uninstalled during this
proof so an eligible routine candidate cannot publish before the feature itself.

A successful candidate retains its policy generation for later publication by
the installed controller. Its active cycle prevents another concurrent cycle.
Failed or no-change verification pauses only its own configuration. Canonical
verification permits only reads and authentication, and compares the exact
staged candidate, validation, agent, policy and delivery evidence. The retained
PR and receipts remain available for inspection. This initial $10 feature proof
is separate from the controller's two bounded paid release checks.

After canonical activation and the normal active-worker checks, the paired
runner performs `queue_readback` with its actual activation timestamp in
`SMOKE_SELF_IMPROVEMENT_ACTIVATED_AT`. For up to five minutes it reads only the
retained owner-scoped operation job and the same candidate evidence. It requires
that exact job to complete once after activation with the same cycle ID and
ready/review stage, while candidate proof remains unchanged. Because the cycle
already finished coding during staging, this establishes **normal queue no-op
dispatch**, not unattended AI execution. The probe never advances or enqueues
work during either canonical readback.

Full daily autonomy remains unproven until a later naturally due Asael cycle
runs through its normal queue. Keep that limitation in release evidence. After
the initial repair becomes terminal, normal enrollment uses the owner's chosen
schedule (initially 07:00 Asia/Kolkata), within the UTC daily
budget. Report the saved `nextDueAt`; do not assume it is tomorrow, force a tick,
or add a Codex automation to stand in for Asael's scheduler.
