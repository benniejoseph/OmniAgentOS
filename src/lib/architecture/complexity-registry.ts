/**
 * Every shadow, canary, legacy, versioned and retired path the product still
 * carries, with the area that owns its removal, the measurement that lets it
 * go, and the date it must be decided by. A repository test fails when such a
 * path, flag, capability or retired route is missing here, when an entry
 * names something that no longer exists, and from an entry's expiry date.
 */

export type ComplexityKind =
  // Observes a live decision without changing it.
  | "shadow"
  // Runs a new path for enrolled tenants only.
  | "canary"
  // Keeps an old shape or behavior while data or callers move.
  | "legacy"
  // Keeps a versioned contract beside its successor.
  | "version"
  // Tells old callers that a feature is gone.
  | "retired";

export type ComplexityEntry = Readonly<{
  id: string;
  kind: ComplexityKind;
  /** The area that owns the decision to promote or delete the path. */
  owner: string;
  summary: string;
  /** What must be measured, and what follows, before the path can go. */
  exitMetric: string;
  /** Calendar dates, YYYY-MM-DD. The ratchet fails from `expiresOn`. */
  reviewedOn: string;
  expiresOn: string;
  /** Repository files, or directories ending in "/". */
  paths: readonly string[];
  /** Environment variables. */
  flags?: readonly string[];
  /** Tenant capability rollout ids. */
  capabilities?: readonly string[];
}>;

/** The longest an entry may go between its review and its expiry. */
export const COMPLEXITY_REVIEW_WINDOW_DAYS = 180;

const REVIEWED_ON = "2026-09-29";
const EXPIRES_ON = "2026-12-28";
// Thirty days after the isolated browser was retired on 2026-09-17. The
// migrations POST was retired earlier, on 2026-08-22.
const RETIRED_ROUTES_EXPIRE_ON = "2026-10-17";

export const COMPLEXITY_REGISTRY: readonly ComplexityEntry[] = Object.freeze((
  [
    {
      id: "run-checkpoint-shadow",
      kind: "shadow",
      owner: "runs",
      summary:
        "Run checkpoints are written beside the live run state at approval, tool, council and boundary points, and never resume a run.",
      exitMetric:
        "The daily run_checkpoint.shadow_reconciled event reports matchedDays of 30 or more on both tenants; then give checkpoints resume authority, or delete the shadow writers and the capability.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: [
        "src/lib/runs/approval-checkpoint-shadow.ts",
        "src/lib/runs/boundary-checkpoint-shadow.ts",
        "src/lib/runs/council-checkpoint-shadow.ts",
        "src/lib/runs/tool-checkpoint-shadow.ts",
        "src/lib/runs/checkpoint-shadow-reconciliation.ts",
        "scripts/check-run-checkpoint-shadows.ts",
        "scripts/interrupt-checkpoint-canary.mjs",
        "scripts/smoke-expanded-checkpoints.mjs",
      ],
      flags: ["CHECKPOINT_RECOVERY_CANARY"],
      capabilities: ["agent_run_checkpoints"],
    },
    {
      id: "agent-loop-v2",
      kind: "canary",
      owner: "orchestration",
      summary:
        "The transition-checkpointed agent loop runs read-only, model-text and context-text canaries for enrolled tenants beside the production loop.",
      exitMetric:
        "The interruption recovery suite passes its release gate (99% eligible recovery, zero duplicate effects) and enrolled runs record no recovery failure for 30 days; then make it the production loop, or delete the canary, its evaluation and its three capabilities.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: [
        "src/lib/orchestration/loop-v2.ts",
        "src/lib/orchestration/loop-v2-context-contract.ts",
        "src/lib/orchestration/loop-v2-context-runtime.ts",
        "src/lib/orchestration/loop-v2-model-text-runtime.ts",
        "src/lib/orchestration/loop-v2-outcome.ts",
        "src/lib/orchestration/loop-v2-recovery.ts",
        "src/lib/orchestration/loop-v2-runtime.ts",
        "src/lib/orchestration/loop-v2-store.ts",
        "src/lib/evals2/loop-v2-recovery.ts",
        "src/app/api/evaluations/loop-v2-recovery/route.ts",
      ],
      capabilities: [
        "agent_loop_v2",
        "agent_loop_v2_model_text",
        "agent_loop_v2_context_text",
      ],
    },
    {
      id: "semantic-memory-shadow",
      kind: "shadow",
      owner: "memory",
      summary:
        "Semantic memory ranking is scored against adjudicated, content-free shadow observations; a passing report only unlocks activation.",
      exitMetric:
        "The shadow report passes its thresholds (24 adjudicated cases across 6 threads) and the rank probe passes on its 24-item minimum corpus; then enable semantic ranking, or delete the collector, review queue and probe.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: [
        "src/lib/evals2/semantic-memory-shadow.ts",
        "src/lib/evals2/semantic-memory-shadow-review.ts",
        "src/lib/evals2/semantic-memory-shadow-rank-probe.ts",
        "src/app/api/memory/semantic-shadow/route.ts",
        "src/app/api/memory/semantic-shadow/rank-probe/route.ts",
        "src/components/semantic-shadow-collector.tsx",
        "src/components/semantic-shadow-review-queue.tsx",
        "src/components/semantic-shadow-review-queue.module.css",
        "scripts/check-semantic-memory-shadow.ts",
      ],
    },
    {
      id: "semantic-decision-routing-shadow",
      kind: "shadow",
      owner: "semantic-decisions",
      summary:
        "An advisory classifier runs after the live route is chosen; its result is observed only and cannot change the route, risk, approvals or tools.",
      exitMetric:
        "The advisory classification agrees with the live route on at least 95% of observed turns over 30 days and never lowers risk; then let it choose the route, or delete the shadow and its kill switch.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: ["src/lib/semantic-decisions/routing-shadow.ts"],
      flags: ["OMNIAGENT_SEMANTIC_DECISION_SHADOW_DISABLED"],
    },
    {
      id: "google-drive-canonical-metadata",
      kind: "shadow",
      owner: "connectors",
      summary:
        "Drive metadata is read into a hash-only shadow manifest beside the legacy connector cursor, and the canonical metadata path is enrolled per tenant.",
      exitMetric:
        "Both accounts are enrolled in the canonical path and 14 consecutive daily syncs match the shadow manifest; then delete the legacy cursor, the shadow and the capability gate.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: ["src/lib/connectors/google-drive-shadow.ts"],
      capabilities: ["source.google-drive.canonical-metadata"],
    },
    {
      id: "context-compiler-v2",
      kind: "version",
      owner: "rag",
      summary:
        "The second context compiler runs in shadow, canary and automatic modes beside the context engine's first selection.",
      exitMetric:
        "Automatic mode serves every context request on both tenants for 30 days with no fallback to the first selection; then delete the first selection and the mode switch.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: ["src/lib/rag/context-compiler-v2.ts"],
    },
    {
      id: "effect-receipts-v2",
      kind: "version",
      owner: "tools",
      summary:
        "Version-2 effect intents and receipts are written beside the version-1 receipts that the executor still builds and the audit store still parses.",
      exitMetric:
        "Every governed tool writes a version-2 receipt and no stored execution holds a version-1 receipt; then delete the version-1 builder and parser.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: [
        "src/lib/tools/effect-intent-v2.ts",
        "src/lib/tools/effect-receipt-v2.ts",
      ],
    },
    {
      id: "memory-authority-resolution-canary",
      kind: "canary",
      owner: "memory",
      summary:
        "The dormant memory-authority tables are resolved and observed without ever authorizing a memory access.",
      exitMetric:
        "The canary reaches the same decision as the live memory access check on every observed access for 30 days; then make the tables the access check, or delete them and the canary.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: ["src/lib/memory/authority-resolution-canary.ts"],
    },
    {
      id: "memory-legacy-ownership",
      kind: "legacy",
      owner: "memory",
      summary:
        "Durable memories written before per-user ownership are previewed and migrated to an owner.",
      exitMetric:
        "The preview reports no unowned durable memory on either tenant; then delete the migration.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: ["src/lib/memory/legacy-ownership.ts"],
    },
    {
      id: "workspace-legacy-projection",
      kind: "legacy",
      owner: "workspaces",
      summary:
        "Legacy projects, missions and tasks are projected into the canonical work model through compatibility mappings.",
      exitMetric:
        "No active compatibility mapping remains because every legacy project, mission and task has a canonical record; then delete the projection and the mappings.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: ["src/lib/workspaces/legacy-projection.ts"],
    },
    {
      id: "market-forward-shadow",
      kind: "shadow",
      owner: "market-research",
      summary:
        "Market forecasts are recorded and scored against the windows that later close, and are never shown as advice.",
      exitMetric:
        "Scored forecasts beat the event baselines across 90 days of closed windows; then show them as a feature, or delete the shadow agent and store.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: [
        "src/lib/market-research/forward-shadow.ts",
        "src/lib/market-research/forward-shadow-agent.ts",
        "src/lib/market-research/forward-shadow-store.ts",
      ],
    },
    {
      id: "mobile-push-canary",
      kind: "canary",
      owner: "mobile",
      summary:
        "The owner sends one test notification to a registered device and waits for its delivery receipt.",
      exitMetric:
        "Production pushes record a delivery receipt for 30 days; then keep the test send as a settings diagnostic under a plain name, or delete it.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: [
        "src/app/api/mobile/push/canary/route.ts",
        "src/components/settings/push-canary-panel.tsx",
        "src/components/settings/push-canary-panel.module.css",
      ],
    },
    {
      id: "connector-legacy-system-secrets",
      kind: "legacy",
      owner: "connectors",
      summary:
        "With this flag on, a connector may read a deployment-wide secret instead of its tenant-bound secret.",
      exitMetric:
        "The flag is off in every environment for 30 days; then delete it and the system-secret fallback.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: [],
      flags: ["OMNIAGENT_CONNECTOR_ALLOW_LEGACY_SYSTEM_SECRETS"],
    },
    {
      id: "internal-auth-raw-secret",
      kind: "legacy",
      owner: "security",
      summary:
        "Trusted identity headers are accepted with the raw deployment secret as well as with a signed, five-minute identity token, because the release scripts also verify the release being replaced.",
      exitMetric:
        "The promoted release accepts identity tokens; then make every release script sign its requests, and refuse the raw secret in x-omni-internal-auth.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: ["src/lib/security/internal-auth.ts", "scripts/internal-identity-token.mjs"],
    },
    {
      id: "model-route-deployment-fallback",
      kind: "legacy",
      owner: "models",
      summary:
        "With this flag on, a model route that cannot resolve its tenant setting keeps the deployment's environment routing instead of stopping.",
      exitMetric:
        "The flag is off in every environment and no deployment_environment degradation is recorded for 30 days; then delete the flag.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: [],
      flags: ["OMNIAGENT_MODEL_ROUTE_ALLOW_DEPLOYMENT_FALLBACK"],
    },
    {
      id: "asset-object-read",
      kind: "canary",
      owner: "storage",
      summary:
        "Asset bytes move from database rows to object storage, and object reads are enrolled per tenant.",
      exitMetric:
        "The latest migration on both tenants has verified every asset and object reads have served for 30 days; then read only from object storage and delete the database byte path.",
      reviewedOn: REVIEWED_ON,
      expiresOn: EXPIRES_ON,
      paths: [],
      capabilities: ["asset-object-read-v1"],
    },
    {
      id: "isolated-browser-retired-routes",
      kind: "retired",
      owner: "runs",
      summary:
        "The retired isolated-browser takeover, activity and profile endpoints answer 410 isolated_browser_retired.",
      exitMetric:
        "No request reaches these routes in the 30 days after retirement; then delete them.",
      reviewedOn: REVIEWED_ON,
      expiresOn: RETIRED_ROUTES_EXPIRE_ON,
      paths: [
        "src/app/api/runs/[id]/takeover/route.ts",
        "src/app/api/runs/[id]/activity/route.ts",
        "src/app/api/runs/[id]/activity/stream/route.ts",
        "src/app/api/runs/[id]/activity/snapshots/[snapshotId]/route.ts",
        "src/app/api/runs/[id]/activity/frames/[frameId]/route.ts",
        "src/app/api/browser/profiles/route.ts",
        "src/app/api/browser/profiles/[id]/route.ts",
      ],
    },
    {
      id: "isolated-browser-retired-targets",
      kind: "retired",
      owner: "orchestration",
      summary:
        "The agent route answers the retired isolated_browser target, and connector discovery and review answer the retired remote browser connector, with 410.",
      exitMetric:
        "No request names the isolated browser in the 30 days after retirement; then drop the target and connector kind so they fail validation like any unknown value.",
      reviewedOn: REVIEWED_ON,
      expiresOn: RETIRED_ROUTES_EXPIRE_ON,
      paths: [
        "src/app/api/agent/route.ts",
        "src/app/api/connectors/[id]/discover/route.ts",
        "src/app/api/connectors/[id]/review/route.ts",
      ],
    },
    {
      id: "request-bound-migrations-retired",
      kind: "retired",
      owner: "platform",
      summary:
        "POST on the migrations route answers 410; migrations run only from the release migrator.",
      exitMetric:
        "No POST reaches the route for 30 days; then delete the handler and let the framework answer 405.",
      reviewedOn: REVIEWED_ON,
      expiresOn: RETIRED_ROUTES_EXPIRE_ON,
      paths: ["src/app/api/system/migrations/route.ts"],
    },
  ] satisfies ComplexityEntry[]
).map((entry) => Object.freeze(entry)));

const MARKED_PATH =
  /shadow|legacy|canary|compat|dormant|deprecat|retired|-v[2-9]/i;
const TEST_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__(?:tests|mocks)__\//;

/** A non-test file whose name marks it as transitional. */
export function isComplexityMarkedPath(file: string) {
  return MARKED_PATH.test(file) && !TEST_PATH.test(file);
}

const ENVIRONMENT_READ =
  /\b(?:process\.env|env|environment)(?:\.|\[\s*["'`])([A-Z][A-Z0-9_]*)|["'`](OMNIAGENT_[A-Z0-9_]+)["'`]/g;
const TRANSITIONAL_FLAG =
  /(?:^|_)(?:SHADOW|CANARY|LEGACY|COMPAT|FALLBACK|DORMANT|DEPRECAT|RETIRED)/;

/** Environment variables the source reads whose names mark them transitional. */
export function transitionalFlagsIn(source: string) {
  const flags = new Set<string>();
  for (const match of source.matchAll(ENVIRONMENT_READ)) {
    const flag = match[1] ?? match[2];
    if (TRANSITIONAL_FLAG.test(flag)) flags.add(flag);
  }
  return [...flags];
}

const CAPABILITY_ID =
  /\bexport\s+const\s+[A-Z0-9_]*CAPABILITY_ID\s*=\s*["'`]([^"'`]+)["'`]/g;

/** Tenant capability rollout ids the source exports. */
export function capabilityIdsIn(source: string) {
  return [...new Set([...source.matchAll(CAPABILITY_ID)].map((match) => match[1]))];
}

/** The route answers 410 Gone on some path. */
export function answersGone(source: string) {
  return /\bstatus:\s*410\b/.test(source);
}

export type ComplexityInventory = Readonly<{
  /** Every file the entries may name. */
  files: readonly string[];
  /** Files whose names mark them as transitional. */
  markedFiles: readonly string[];
  flags: readonly string[];
  capabilities: readonly string[];
  /** Route files that answer 410. */
  retiredRoutes: readonly string[];
}>;

export type ComplexityViolation = Readonly<{
  rule: "duplicate" | "incomplete" | "expired" | "unregistered" | "stale";
  subject: string;
  message: string;
}>;

const DAY_MS = 86_400_000;

function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString().slice(0, 10) === value ? time : undefined;
}

/**
 * Everything wrong with the registry against the repository inventory, on
 * the given UTC calendar date. An empty list passes.
 */
export function checkComplexityRegistry(input: {
  registry: readonly ComplexityEntry[];
  inventory: ComplexityInventory;
  today: string;
}): ComplexityViolation[] {
  const violations: ComplexityViolation[] = [];
  const report = (
    rule: ComplexityViolation["rule"],
    subject: string,
    message: string,
  ) => violations.push({ rule, subject, message });
  const today = calendarDate(input.today);
  if (today === undefined) throw new Error(`Invalid date: ${input.today}`);

  const owners = {
    id: new Map<string, string>(),
    path: new Map<string, string>(),
    flag: new Map<string, string>(),
    capability: new Map<string, string>(),
  };
  const claim = (kind: keyof typeof owners, value: string, id: string) => {
    const existing = owners[kind].get(value);
    if (existing === undefined) {
      owners[kind].set(value, id);
      return;
    }
    report(
      "duplicate",
      value,
      kind === "id"
        ? `Two entries use the id ${value}.`
        : `The ${kind} ${value} is registered by both ${existing} and ${id}.`,
    );
  };

  for (const entry of input.registry) {
    claim("id", entry.id, entry.id);
    for (const file of entry.paths) claim("path", file, entry.id);
    for (const flag of entry.flags ?? []) claim("flag", flag, entry.id);
    for (const capability of entry.capabilities ?? []) {
      claim("capability", capability, entry.id);
    }

    for (const field of ["owner", "summary", "exitMetric"] as const) {
      if (!entry[field].trim()) {
        report("incomplete", entry.id, `${entry.id} has no ${field}.`);
      }
    }
    if (!entry.paths.length && !entry.flags?.length && !entry.capabilities?.length) {
      report("incomplete", entry.id, `${entry.id} names no path, flag or capability.`);
    }
    const reviewedOn = calendarDate(entry.reviewedOn);
    const expiresOn = calendarDate(entry.expiresOn);
    if (reviewedOn === undefined || expiresOn === undefined) {
      report("incomplete", entry.id, `${entry.id} needs YYYY-MM-DD review and expiry dates.`);
      continue;
    }
    if (
      expiresOn <= reviewedOn ||
      expiresOn - reviewedOn > COMPLEXITY_REVIEW_WINDOW_DAYS * DAY_MS
    ) {
      report(
        "incomplete",
        entry.id,
        `${entry.id} must expire within ${COMPLEXITY_REVIEW_WINDOW_DAYS} days after its review.`,
      );
    }
    if (today >= expiresOn) {
      report(
        "expired",
        entry.id,
        `${entry.id} expired on ${entry.expiresOn}: meet its exit metric and delete the path, or review it and set a new expiry.`,
      );
    }
  }

  const registered = input.registry.flatMap((entry) =>
    entry.paths.map((file) => ({ file, entry })));
  const coveringEntry = (file: string) =>
    registered.find(({ file: path }) =>
      path.endsWith("/") ? file.startsWith(path) : file === path)?.entry;

  for (const file of input.inventory.markedFiles) {
    if (!coveringEntry(file)) {
      report("unregistered", file, `${file} is a transitional path with no registry entry.`);
    }
  }
  for (const file of input.inventory.retiredRoutes) {
    if (coveringEntry(file)?.kind !== "retired") {
      report("unregistered", file, `${file} answers 410 but no retired entry covers it.`);
    }
  }
  const files = new Set(input.inventory.files);
  for (const { file, entry } of registered) {
    const exists = file.endsWith("/")
      ? input.inventory.files.some((candidate) => candidate.startsWith(file))
      : files.has(file);
    if (!exists) report("stale", file, `${entry.id} names ${file}, which no longer exists.`);
  }

  for (const [kind, found] of [
    ["flag", input.inventory.flags],
    ["capability", input.inventory.capabilities],
  ] as const) {
    const present = new Set(found);
    for (const value of present) {
      if (!owners[kind].has(value)) {
        report("unregistered", value, `The ${kind} ${value} has no registry entry.`);
      }
    }
    for (const [value, id] of owners[kind]) {
      if (!present.has(value)) {
        report("stale", value, `${id} names the ${kind} ${value}, which is no longer read.`);
      }
    }
  }

  return violations;
}
