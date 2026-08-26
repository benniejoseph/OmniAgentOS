#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

class ReadinessAccessError extends Error {
  constructor(status) {
    super(`Readiness access denied with HTTP ${status}.`);
    this.name = "ReadinessAccessError";
    this.status = status;
  }
}

class GatewayReadinessAccessError extends Error {
  constructor(status) {
    super(`Gateway readiness access denied with HTTP ${status}.`);
    this.name = "GatewayReadinessAccessError";
    this.status = status;
  }
}

const VERCEL_ORG_ID = "team_hFIwf5wwfzIn2I1WDZwY8pAv";
const VERCEL_PROJECT_ID = "prj_BF3Uy9PhUUitqFAeA0g0LafaL4co";
const VERCEL_SCOPE = "benniejosephs-projects";
const PRODUCTION_BASE_URL = "https://omniagent-os.vercel.app";
const VERCEL_DEPLOYMENT_HOST_PATTERN =
  /^omniagent-[a-z0-9]+-benniejosephs-projects\.vercel\.app$/;
const OPENAI_GATEWAY_SERVICE = "asael-openai-egress";
const OPENAI_GATEWAY_REGION = "iad";
const OPENAI_GATEWAY_PROTOCOL = "1";
const OPENAI_GATEWAY_URL = "https://omniagent-os-worker.fly.dev/v1";
const OPENAI_GATEWAY_TOKEN_ENV = "OMNIAGENT_OPENAI_GATEWAY_TOKEN";
const OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV =
  "OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN";
const OPENAI_GATEWAY_INITIAL_CUTOVER_ENV =
  "OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER";
const PAID_INFERENCE_SENTINEL = "ASAEL_RELEASE_OK";
const PAID_INFERENCE_MAX_OUTPUT_TOKENS = 16;
const WORKER_PID_FILE = "/tmp/asael-worker.pid";
const WORKER_RELEASE_ACTIVATION_FILE =
  "/tmp/asael-worker-release-activated";
const dryRun = process.argv.includes("--dry-run");
const configurationProbe = process.argv.includes("--configuration-probe");
const readinessProbeIndex = process.argv.indexOf("--readiness-probe");
const gatewayReadinessProbeIndex = process.argv.indexOf(
  "--gateway-readiness-probe",
);
const gatewayPaidProbeIndex = process.argv.indexOf("--gateway-paid-probe");
const flyApp = process.env.FLY_APP?.trim() || "omniagent-os-worker";
const revision =
  process.env.OMNIAGENT_RELEASE_SHA?.trim() ||
  await capture("git", ["rev-parse", "HEAD"]);
const readinessTimeoutMs = boundedInteger(
  process.env.OMNIAGENT_DEPLOY_READINESS_TIMEOUT_MS,
  180_000,
  1_000,
  300_000,
);
const readinessPollIntervalMs = boundedInteger(
  process.env.OMNIAGENT_DEPLOY_READINESS_POLL_MS,
  2_000,
  100,
  10_000,
);
const readinessRequestTimeoutMs = boundedInteger(
  process.env.OMNIAGENT_DEPLOY_READINESS_REQUEST_TIMEOUT_MS,
  10_000,
  500,
  30_000,
);
const gatewayReadinessTimeoutMs = boundedInteger(
  process.env.OMNIAGENT_DEPLOY_GATEWAY_READINESS_TIMEOUT_MS,
  120_000,
  1_000,
  300_000,
);
const gatewayReadinessPollIntervalMs = boundedInteger(
  process.env.OMNIAGENT_DEPLOY_GATEWAY_READINESS_POLL_MS,
  1_000,
  100,
  10_000,
);
const gatewayReadinessRequestTimeoutMs = boundedInteger(
  process.env.OMNIAGENT_DEPLOY_GATEWAY_READINESS_REQUEST_TIMEOUT_MS,
  5_000,
  500,
  30_000,
);
const paidInferenceTimeoutMs = boundedInteger(
  process.env.OMNIAGENT_DEPLOY_PAID_INFERENCE_TIMEOUT_MS,
  60_000,
  5_000,
  120_000,
);
const paidInferenceModel = normalizeModelIdentifier(
  process.env.OMNIAGENT_DEPLOY_OPENAI_SMOKE_MODEL ||
    process.env.OPENAI_FAST_MODEL ||
    "gpt-4o-mini",
);
const workerStartupSettleMs = boundedInteger(
  process.env.OMNIAGENT_DEPLOY_WORKER_STARTUP_SETTLE_MS,
  75_000,
  0,
  180_000,
);
const vercelEnvironment = {
  VERCEL_ORG_ID,
  VERCEL_PROJECT_ID,
};
const smokeEnvironment = {
  SMOKE_EXPECTED_REVISION: revision,
  BENCHMARK_ENFORCE: "true",
  OMNIAGENT_RELEASE_SHA: revision,
};

if (readinessProbeIndex >= 0) {
  const probeUrl = normalizeReadinessProbeUrl(
    process.argv[readinessProbeIndex + 1],
  );
  const expectedRevision = normalizeExpectedRevision(
    process.argv[readinessProbeIndex + 2],
  );
  await waitForDeploymentReadiness(probeUrl, expectedRevision, {
    label: "Readiness probe",
    useDeploymentBypass: false,
  }).catch((error) => fail(errorMessage(error)));
  process.exit(0);
}

if (gatewayReadinessProbeIndex >= 0) {
  const gateway = validateOpenAIGatewayConfiguration({
    configuredUrl: process.argv[gatewayReadinessProbeIndex + 1],
    configuredToken: process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN,
    required: true,
    allowLoopbackHttp: true,
  });
  const previousToken = validateOptionalGatewayToken(
    process.env.OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN,
    OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV,
  );
  const expectedRevision = normalizeExpectedRevision(
    process.argv[gatewayReadinessProbeIndex + 2],
  );
  await waitForOpenAIGatewayTokenPair(
    withPreviousGatewayToken(gateway, previousToken),
    expectedRevision,
    {
      label: "Gateway readiness probe",
    },
  ).catch((error) => fail(errorMessage(error)));
  process.exit(0);
}

if (gatewayPaidProbeIndex >= 0) {
  const gateway = validateOpenAIGatewayConfiguration({
    configuredUrl: process.argv[gatewayPaidProbeIndex + 1],
    configuredToken: process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN,
    required: true,
    allowLoopbackHttp: true,
  });
  const expectedRevision = normalizeExpectedRevision(
    process.argv[gatewayPaidProbeIndex + 2],
  );
  const openAIKey = validateOpenAIKey(process.env.OPENAI_API_KEY, true);
  const readiness = await waitForOpenAIGatewayReadiness(
    gateway,
    expectedRevision,
    { label: "Gateway paid probe" },
  ).catch((error) => fail(errorMessage(error)));
  await runPaidOpenAIGatewayInference({
    gateway,
    openAIKey,
    expectedRevision,
    readiness,
    label: "Gateway paid probe",
  }).catch((error) => fail(errorMessage(error)));
  process.exit(0);
}

if (configurationProbe) {
  validateReleaseConfiguration();
  console.log("Production release configuration is valid.");
  process.exit(0);
}

if (dryRun) {
  printDryRun(
    "npm",
    ["run", "smoke:release"],
    { BASE_URL: PRODUCTION_BASE_URL },
  );
  printDryRun("npm", ["run", "verify"]);
  printDryRun(
    "vercel",
    ["deploy", "--prod", "--skip-domain", "--yes", "--scope", VERCEL_SCOPE],
    vercelEnvironment,
  );
  const staged = "https://staged-deployment.example";
  printDryRunReadinessWait("staged web", staged, revision);
  printDryRunGatewayTokenStage("candidate gateway overlap");
  printDryRun(
    "fly",
    workerDeployArgs(staged, PRODUCTION_BASE_URL),
  );
  printDryRunGatewayPairReadiness("staged gateway", revision);
  printDryRunWorkerStartupWait("staged worker");
  printDryRunPaidAgentVerification(staged, revision);
  printVerificationCommands(staged);
  printDryRun(
    "vercel",
    ["promote", staged, "--yes", "--scope", VERCEL_SCOPE],
    vercelEnvironment,
  );
  printDryRunReadinessWait(
    "canonical web",
    PRODUCTION_BASE_URL,
    revision,
  );
  printDryRun("fly", workerCanonicalTargetArgs());
  printDryRunGatewayPairReadiness("canonical gateway", revision);
  printDryRunWorkerStartupWait("canonical worker");
  printDryRunPaidAgentVerification(PRODUCTION_BASE_URL, revision);
  printVerificationCommands(PRODUCTION_BASE_URL);
  printDryRun("fly", workerReleaseActivationArgs());
  printDryRunWorkerStartupWait("activated canonical worker");
  printPostActivationVerification(
    PRODUCTION_BASE_URL,
    "<activation-started-at>",
  );
  process.exit(0);
}

const releaseConfiguration = validateReleaseConfiguration();
const productionBaseUrl = releaseConfiguration.baseUrl;
const openAIGateway = releaseConfiguration.openAIGateway;
const initialOpenAIGatewayCutover =
  releaseConfiguration.initialOpenAIGatewayCutover;
const worktreeChanges = await capture("git", [
  "status",
  "--porcelain",
]);
if (worktreeChanges) {
  fail(
    "Production deployment requires a clean working tree so Vercel and Fly receive the same reviewed release.",
  );
}
const previousWorkerImage = await getCurrentWorkerImage();
const previousVercelDeployment = await getCurrentVercelDeployment(
  productionBaseUrl,
);
const previousHealthRevision = await getCurrentHealthRevision(
  productionBaseUrl,
);
const rollbackOpenAIGateway = openAIGateway && !initialOpenAIGatewayCutover
  ? createRollbackGatewayConfiguration(openAIGateway)
  : undefined;
if (initialOpenAIGatewayCutover) {
  console.log(
    "Initial OpenAI gateway cutover confirmed: prior-gateway preflight is skipped and rollback uses the pre-gateway worker topology.",
  );
}
if (rollbackOpenAIGateway) {
  // Prove the token used by the currently promoted Vercel release still
  // reaches the current Fly revision before either platform is mutated.
  await waitForOpenAIGatewayReadiness(
    rollbackOpenAIGateway,
    previousHealthRevision,
    { label: "Rollback gateway preflight" },
  ).catch((error) => fail(errorMessage(error)));
}

let workerMutationStarted = false;
let vercelPromoted = false;
try {
  await run("npm", ["run", "smoke:release"], {
    environment: {
      BASE_URL: productionBaseUrl,
      // Release evidence intentionally performs ordered database, worker, SLO,
      // and provider checks. Its normal cold path can exceed the generic 15s
      // HTTP smoke deadline without indicating an unhealthy deployment.
      SMOKE_REQUEST_TIMEOUT_MS: "60000",
    },
  });
  await run("npm", ["run", "verify"]);
  const deploymentOutput = await capture(
    "vercel",
    ["deploy", "--prod", "--skip-domain", "--yes", "--scope", VERCEL_SCOPE],
    { environment: vercelEnvironment, echo: true },
  );
  const stagedBaseUrl = deploymentUrlFromOutput(deploymentOutput);
  await waitForDeploymentReadiness(stagedBaseUrl, revision, {
    label: "Staged web",
  });
  workerMutationStarted = true;
  if (openAIGateway) {
    await stageFlyGatewayTokenOverlap(openAIGateway, {
      label: "Candidate gateway overlap",
    });
  }
  await run("fly", workerDeployArgs(stagedBaseUrl, productionBaseUrl));
  if (openAIGateway) {
    await waitForOpenAIGatewayTokenPair(
      openAIGateway,
      revision,
      {
        label: "Staged gateway",
      },
    );
  }
  await waitForWorkerStartupWindow("Staged worker");
  await runPaidAgentVerification(stagedBaseUrl);
  await runVerificationCommands(stagedBaseUrl);

  // Only expose the web release after the exact staged web/worker pair passes.
  // Protected deployments are reached with VERCEL_AUTOMATION_BYPASS_SECRET.
  vercelPromoted = true;
  await run(
    "vercel",
    ["promote", stagedBaseUrl, "--yes", "--scope", VERCEL_SCOPE],
    { environment: vercelEnvironment },
  );
  await waitForDeploymentReadiness(productionBaseUrl, revision, {
    label: "Canonical web",
  });
  // Rebind the already-running worker in place. A second Fly deploy would
  // restart the co-hosted OpenAI gateway on the single production machine.
  await run("fly", workerCanonicalTargetArgs());
  if (openAIGateway) {
    await waitForOpenAIGatewayTokenPair(
      openAIGateway,
      revision,
      {
        label: "Canonical gateway",
      },
    );
  }
  await waitForWorkerStartupWindow("Canonical worker");
  await runPaidAgentVerification(productionBaseUrl);
  await runVerificationCommands(productionBaseUrl);
  const workerActivationStartedAt = new Date().toISOString();
  await run("fly", workerReleaseActivationArgs());
  await waitForWorkerStartupWindow("Activated canonical worker");
  await runPostActivationVerification(
    productionBaseUrl,
    workerActivationStartedAt,
  );
} catch (error) {
  const rollbackErrors = [];
  let workerRollbackSucceeded = !workerMutationStarted;
  if (workerMutationStarted) {
    let gatewaySecretsRestored = true;
    if (rollbackOpenAIGateway) {
      await stageFlyGatewayTokenOverlap(rollbackOpenAIGateway, {
        label: "Rollback gateway overlap",
      }).catch((rollbackError) => {
        gatewaySecretsRestored = false;
        rollbackErrors.push(
          `Fly rollback gateway secret staging failed: ${errorMessage(rollbackError)}`,
        );
      });
    }
    if (gatewaySecretsRestored) {
      await run(
        "fly",
        workerRollbackArgs(
          previousWorkerImage,
          productionBaseUrl,
          initialOpenAIGatewayCutover,
        ),
      ).then(() => {
        workerRollbackSucceeded = true;
      }).catch((rollbackError) => {
        rollbackErrors.push(`Fly rollback failed: ${errorMessage(rollbackError)}`);
      });
    }
  }
  if (vercelPromoted && workerRollbackSucceeded) {
    await run(
      "vercel",
      [
        "promote",
        previousVercelDeployment,
        "--yes",
        "--scope",
        VERCEL_SCOPE,
      ],
      { environment: vercelEnvironment },
    ).catch((rollbackError) => {
      rollbackErrors.push(`Vercel rollback failed: ${errorMessage(rollbackError)}`);
    });
  } else if (vercelPromoted) {
    rollbackErrors.push(
      "Vercel rollback was skipped because the active worker could not be safely rolled back first.",
    );
  }
  if (!rollbackErrors.length && (vercelPromoted || workerMutationStarted)) {
    await runRollbackVerification(
      productionBaseUrl,
      previousHealthRevision,
      rollbackOpenAIGateway,
    ).catch((rollbackError) => {
      rollbackErrors.push(
        `Rollback verification failed: ${errorMessage(rollbackError)}`,
      );
    });
  }
  fail(
    [
      `Production deployment failed: ${errorMessage(error)}`,
      ...rollbackErrors,
    ].join("\n"),
  );
}

console.log(
  `Production release ${revision} passed canonical smoke and performance budgets with rollback-safe gateway token overlap.`,
);

function validateReleaseConfiguration() {
  const singaporeTopology = configuredVercelRegions().includes("sin1");
  const required = [
    ["BASE_URL", process.env.BASE_URL],
    [
      "internal smoke secret",
      process.env.SMOKE_INTERNAL_AUTH_SECRET ||
        process.env.OMNIAGENT_INTERNAL_AUTH_SECRET,
    ],
    ["RELEASE_EVIDENCE_OUTPUT", process.env.RELEASE_EVIDENCE_OUTPUT],
  ];
  const missing = required
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length) {
    fail(`Production release configuration is missing: ${missing.join(", ")}.`);
  }
  const smokeEmail = process.env.SMOKE_ADMIN_EMAIL || process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
  const smokePassword = process.env.SMOKE_ADMIN_PASSWORD || process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
  if (Boolean(smokeEmail) !== Boolean(smokePassword)) {
    fail("Administrator smoke credentials must be supplied as a complete email/password pair.");
  }
  const configuredBaseUrl = String(process.env.BASE_URL || "").trim();
  let url;
  try {
    url = new URL(configuredBaseUrl);
  } catch {
    fail(`BASE_URL must be exactly ${PRODUCTION_BASE_URL}.`);
  }
  if (
    (configuredBaseUrl !== PRODUCTION_BASE_URL &&
      configuredBaseUrl !== `${PRODUCTION_BASE_URL}/`) ||
    url.origin !== PRODUCTION_BASE_URL ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    fail(`BASE_URL must be exactly ${PRODUCTION_BASE_URL}.`);
  }
  const productionOrigin = PRODUCTION_BASE_URL;
  const evidencePath = path.resolve(process.env.RELEASE_EVIDENCE_OUTPUT);
  const temporaryRoot = path.resolve(tmpdir());
  if (
    !evidencePath.startsWith(`${temporaryRoot}${path.sep}`) ||
    !path.basename(evidencePath).startsWith("asael-release-evidence-") ||
    path.extname(evidencePath) !== ".json"
  ) {
    fail(
      "RELEASE_EVIDENCE_OUTPUT must be a unique asael-release-evidence-*.json file inside the system temporary directory.",
    );
  }
  const baseUrl = PRODUCTION_BASE_URL;
  const openAIGateway = validateOpenAIGatewayConfiguration({
    configuredUrl: process.env.OMNIAGENT_OPENAI_GATEWAY_URL,
    configuredToken: process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN,
    required: singaporeTopology,
  });
  const previousToken = validateOptionalGatewayToken(
    process.env.OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN,
    OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV,
  );
  const initialOpenAIGatewayCutover = validateInitialOpenAIGatewayCutover({
    value: process.env.OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER,
    gateway: openAIGateway,
    previousToken,
  });
  if (openAIGateway && openAIGateway.baseUrl.origin === productionOrigin) {
    fail("OMNIAGENT_OPENAI_GATEWAY_URL must use a separate gateway origin.");
  }
  return {
    baseUrl,
    initialOpenAIGatewayCutover,
    openAIGateway: openAIGateway
      ? withPreviousGatewayToken(openAIGateway, previousToken)
      : undefined,
  };
}

function configuredVercelRegions() {
  let configuration;
  try {
    configuration = JSON.parse(
      readFileSync(path.resolve("vercel.json"), "utf8"),
    );
  } catch {
    fail("vercel.json must be readable before a production release.");
  }
  if (!Array.isArray(configuration?.regions)) return [];
  return configuration.regions.filter(
    (region) => typeof region === "string",
  );
}

function validateOpenAIGatewayConfiguration({
  configuredUrl,
  configuredToken,
  required,
  allowLoopbackHttp = false,
}) {
  const rawUrl = String(configuredUrl || "").trim();
  const token = String(configuredToken || "").trim();
  if (!rawUrl && !token && !required) return undefined;
  if (!rawUrl || !token) {
    fail(
      "Singapore releases require OMNIAGENT_OPENAI_GATEWAY_URL and OMNIAGENT_OPENAI_GATEWAY_TOKEN.",
    );
  }
  validateRequiredGatewayToken(token, OPENAI_GATEWAY_TOKEN_ENV);

  let baseUrl;
  try {
    baseUrl = new URL(rawUrl);
  } catch {
    fail("OMNIAGENT_OPENAI_GATEWAY_URL must be a valid absolute URL.");
  }
  const loopbackHttp =
    allowLoopbackHttp &&
    baseUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname);
  const safeCommonShape =
    !baseUrl.username &&
    !baseUrl.password &&
    !baseUrl.search &&
    !baseUrl.hash;
  const pathname = baseUrl.pathname;
  const safePath = pathname === "/v1" || pathname === "/v1/";
  const pinnedProductionGateway =
    baseUrl.protocol === "https:" &&
    baseUrl.hostname === "omniagent-os-worker.fly.dev" &&
    !baseUrl.port &&
    safePath;
  if (!safeCommonShape || (!loopbackHttp && !pinnedProductionGateway)) {
    fail(
      `OMNIAGENT_OPENAI_GATEWAY_URL must be exactly ${OPENAI_GATEWAY_URL}; an explicit :443 and one trailing slash are accepted.`,
    );
  }
  if (loopbackHttp && !safePath) {
    fail("Loopback gateway readiness probes must use the exact /v1 path.");
  }
  baseUrl.pathname = "/v1";
  if (pinnedProductionGateway) {
    baseUrl.port = "";
  }
  return { baseUrl, token };
}

function validateRequiredGatewayToken(value, environmentName) {
  const token = String(value || "").trim();
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)) {
    fail(`${environmentName} must be a 32-256 character URL-safe secret.`);
  }
  return token;
}

function validateOptionalGatewayToken(value, environmentName) {
  const token = String(value || "").trim();
  return token ? validateRequiredGatewayToken(token, environmentName) : undefined;
}

function validateOpenAIKey(value, required) {
  const key = String(value || "").trim();
  if (!key && !required) return undefined;
  if (!/^[\x21-\x7e]{20,512}$/.test(key)) {
    fail(
      "OPENAI_API_KEY must be a 20-512 character printable secret for the paid release probe.",
    );
  }
  return key;
}

function validateInitialOpenAIGatewayCutover({
  value,
  gateway,
  previousToken,
}) {
  const confirmation = String(value || "").trim();
  if (!confirmation) return false;
  if (confirmation !== "CONFIRMED") {
    fail(`${OPENAI_GATEWAY_INITIAL_CUTOVER_ENV} must equal CONFIRMED.`);
  }
  if (!gateway) {
    fail(
      `${OPENAI_GATEWAY_INITIAL_CUTOVER_ENV} requires a complete OpenAI gateway configuration.`,
    );
  }
  if (previousToken) {
    fail(
      `${OPENAI_GATEWAY_INITIAL_CUTOVER_ENV} cannot be used with ${OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV}.`,
    );
  }
  let rollbackConfig;
  try {
    rollbackConfig = readFileSync(
      path.resolve("fly.initial-cutover-rollback.toml"),
      "utf8",
    );
  } catch {
    fail(
      `${OPENAI_GATEWAY_INITIAL_CUTOVER_ENV} requires fly.initial-cutover-rollback.toml.`,
    );
  }
  if (
    rollbackConfig.includes("[http_service]") ||
    !rollbackConfig.includes('strategy = "immediate"')
  ) {
    fail(
      "The initial-cutover rollback config must be service-free and use the immediate strategy.",
    );
  }
  return true;
}

function withPreviousGatewayToken(gateway, previousToken) {
  if (previousToken && previousToken === gateway.token) {
    fail(
      `${OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV} must differ from ${OPENAI_GATEWAY_TOKEN_ENV}; omit it when no rotation is in progress.`,
    );
  }
  return { ...gateway, previousToken };
}

function createRollbackGatewayConfiguration(gateway) {
  return {
    ...gateway,
    token: gateway.previousToken || gateway.token,
    previousToken: gateway.previousToken ? gateway.token : undefined,
  };
}

function workerDeployArgs(baseUrl, canonicalBaseUrl) {
  if (canonicalBaseUrl !== PRODUCTION_BASE_URL) {
    fail(
      `The worker canonical target must be exactly ${PRODUCTION_BASE_URL}.`,
    );
  }
  return [
    "deploy",
    "--app",
    flyApp,
    "--build-arg",
    `OMNIAGENT_RELEASE_SHA=${revision}`,
    ...(baseUrl
      ? ["--env", `OMNIAGENT_WORKER_BASE_URL=${baseUrl}`]
      : []),
    ...(canonicalBaseUrl
      ? [
          "--env",
          `OMNIAGENT_WORKER_CANONICAL_BASE_URL=${canonicalBaseUrl}`,
        ]
      : []),
    "--env",
    "OMNIAGENT_WORKER_RELEASE_HOLD=true",
    "--strategy",
    "bluegreen",
    "--yes",
  ];
}

function workerCanonicalTargetArgs() {
  return [
    "ssh",
    "console",
    "--app",
    flyApp,
    "--command",
    `read worker_pid < ${WORKER_PID_FILE} && kill -HUP "$worker_pid"`,
  ];
}

function workerReleaseActivationArgs() {
  const expectedRevision = normalizeExpectedRevision(revision);
  return [
    "ssh",
    "console",
    "--app",
    flyApp,
    "--command",
    [
      "set -eu",
      `expected_revision='${expectedRevision}'`,
      `read worker_pid < ${WORKER_PID_FILE}`,
      'case "$worker_pid" in ""|*[!0-9]*) exit 1;; esac',
      'kill -0 "$worker_pid"',
      'kill -USR1 "$worker_pid"',
      "attempt=0",
      `while [ "$attempt" -lt 20 ]; do marker_revision=""; if IFS= read -r marker_revision < ${WORKER_RELEASE_ACTIVATION_FILE} && [ "$marker_revision" = "$expected_revision" ] && kill -0 "$worker_pid"; then exit 0; fi; attempt=$((attempt + 1)); sleep 1; done`,
      "exit 1",
    ].join("; "),
  ];
}

function workerRollbackArgs(image, baseUrl, initialCutover) {
  if (baseUrl !== PRODUCTION_BASE_URL) {
    fail(
      `The worker rollback target must be exactly ${PRODUCTION_BASE_URL}.`,
    );
  }
  return [
    "deploy",
    "--app",
    flyApp,
    ...(initialCutover
      ? [
          "--config",
          "fly.initial-cutover-rollback.toml",
          "--strategy",
          "immediate",
        ]
      : ["--strategy", "bluegreen"]),
    "--image",
    image,
    "--env",
    `OMNIAGENT_WORKER_BASE_URL=${baseUrl}`,
    "--env",
    `OMNIAGENT_WORKER_CANONICAL_BASE_URL=${baseUrl}`,
    "--env",
    "OMNIAGENT_WORKER_RELEASE_HOLD=false",
    "--yes",
  ];
}

async function stageFlyGatewayTokenOverlap(gateway, { label }) {
  const removePreviousToken =
    !gateway.previousToken &&
    await flySecretExists(OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV);
  const secretInput = [
    `${OPENAI_GATEWAY_TOKEN_ENV}=${gateway.token}`,
    ...(gateway.previousToken
      ? [`${OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV}=${gateway.previousToken}`]
      : []),
    "",
  ].join("\n");
  await runWithSensitiveStdin(
    "fly",
    ["secrets", "import", "--app", flyApp, "--stage"],
    secretInput,
  );
  if (removePreviousToken) {
    // A previous token is valid only during an active rotation. Explicitly
    // stage its removal so a completed overlap is not retained indefinitely.
    await run("fly", [
      "secrets",
      "unset",
      OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV,
      "--app",
      flyApp,
      "--stage",
    ]);
  }
  console.log(
    `${label} staged on Fly with ${gateway.previousToken ? "two accepted tokens" : "one accepted token"}; secret values were not written to output.`,
  );
}

async function flySecretExists(secretName) {
  const output = await capture("fly", [
    "secrets",
    "list",
    "--app",
    flyApp,
    "--json",
  ]);
  let secrets;
  try {
    secrets = JSON.parse(output);
  } catch {
    throw new Error("Unable to inspect Fly gateway secret names safely.");
  }
  if (!Array.isArray(secrets)) {
    throw new Error("Fly gateway secret inventory was not an array.");
  }
  return secrets.some((secret) =>
    [secret?.name, secret?.Name].some((name) => name === secretName),
  );
}

async function getCurrentWorkerImage() {
  const output = await capture("fly", [
    "releases",
    "--app",
    flyApp,
    "--image",
    "--json",
  ]);
  let releases;
  try {
    const parsed = JSON.parse(output);
    releases = Array.isArray(parsed) ? parsed : parsed.releases;
  } catch {
    fail("Unable to parse the current Fly release for rollback preflight.");
  }
  if (!Array.isArray(releases)) {
    fail("The current Fly release inventory was not an array.");
  }
  const eligibleReleases = releases
    .map((candidate) => {
      const image =
        candidate?.imageRef || candidate?.image_ref || candidate?.ImageRef;
      const status = String(
        candidate?.status ?? candidate?.Status ?? "",
      ).toLowerCase();
      const version = Number(
        candidate?.version ?? candidate?.Version,
      );
      return {
        candidate,
        image,
        status,
        version,
      };
    })
    .filter(
      ({ image, status, version }) =>
        typeof image === "string" &&
        image.trim() &&
        status === "complete" &&
        Number.isSafeInteger(version) &&
        version >= 0,
    )
    .sort((left, right) => right.version - left.version);
  const release = eligibleReleases[0]?.candidate;
  const image =
    release?.imageRef || release?.image_ref || release?.ImageRef;
  if (!image) {
    fail("A current Fly worker image is required for rollback preflight.");
  }
  return image;
}

async function getCurrentVercelDeployment(productionBaseUrl) {
  const output = await capture(
    "vercel",
    [
      "inspect",
      productionBaseUrl,
      "--format=json",
      "--scope",
      VERCEL_SCOPE,
    ],
    { environment: vercelEnvironment },
  );
  let deployment;
  try {
    deployment = JSON.parse(output);
  } catch {
    fail("Unable to parse the current Vercel deployment for rollback preflight.");
  }
  const url =
    deployment.url ||
    deployment.deployment?.url ||
    deployment.target?.url;
  if (!url) {
    fail("A current Vercel deployment is required for rollback preflight.");
  }
  return normalizeDeploymentUrl(url);
}

async function getCurrentHealthRevision(baseUrl) {
  const headers = {};
  const bypassSecret =
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }
  let response;
  try {
    response = await fetch(`${baseUrl}/api/health`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`Unable to read the current production health revision: ${errorMessage(error)}`);
  }
  if (response.status !== 200) {
    fail(
      `Current production health must be healthy before deployment; received ${response.status}.`,
    );
  }
  const body = await response.json().catch(() => ({}));
  const healthRevision =
    typeof body.revision === "string" ? body.revision.trim() : "";
  if (body.status !== "healthy" || !healthRevision) {
    fail("Current production health is missing a healthy rollback revision.");
  }
  return healthRevision;
}

async function runVerificationCommands(baseUrl) {
  const sessionDirectory = await mkdtemp(
    path.join(tmpdir(), "omniagent-release-session-"),
  );
  const sessionFile = path.join(sessionDirectory, "session-cookie");
  const environment = {
    ...smokeEnvironment,
    BASE_URL: baseUrl,
    BENCHMARK_SESSION_FILE: sessionFile,
    SMOKE_DRIVE_BACKGROUND_QUEUE: "true",
    SMOKE_REQUEST_TIMEOUT_MS: "300000",
    SMOKE_SESSION_OUTPUT: sessionFile,
  };
  try {
    await run("npm", ["run", "test:production-smoke"], { environment });
    await run("npm", ["run", "benchmark:preview"], { environment });
    await run("npm", ["run", "benchmark:dashboard"], { environment });
  } finally {
    await rm(sessionDirectory, { recursive: true, force: true });
  }
}

async function runPaidAgentVerification(baseUrl) {
  await run("npm", ["run", "smoke:paid-agent"], {
    environment: {
      BASE_URL: baseUrl,
      EXPECTED_REVISION: revision,
      LIVE_VERIFY_PAID_OPENAI: "CONFIRMED",
    },
  });
}

async function runPostActivationVerification(baseUrl, activatedAt) {
  const environment = {
    ...smokeEnvironment,
    BASE_URL: baseUrl,
    SMOKE_REQUEST_TIMEOUT_MS: "300000",
    OMNIAGENT_REQUIRE_ACTIVE_WORKER_HEARTBEATS: "true",
    OMNIAGENT_WORKER_HEARTBEAT_NOT_BEFORE: activatedAt,
  };
  await run("npm", ["run", "smoke:security"], { environment });
  await run("npm", ["run", "smoke:release"], { environment });
}

async function runRollbackVerification(
  baseUrl,
  expectedRevision,
  rollbackGateway,
) {
  await waitForDeploymentReadiness(baseUrl, expectedRevision, {
    label: "Rollback web",
  });
  if (rollbackGateway) {
    await waitForOpenAIGatewayTokenPair(
      rollbackGateway,
      expectedRevision,
      { label: "Rollback gateway" },
    );
  }
  await run("npm", ["run", "smoke:preflight"], {
    environment: {
      BASE_URL: baseUrl,
      SMOKE_EXPECTED_REVISION: expectedRevision,
      SMOKE_REQUEST_TIMEOUT_MS: "300000",
    },
  });
}

async function waitForOpenAIGatewayTokenPair(
  gateway,
  expectedRevision,
  { label },
) {
  const readiness = await waitForOpenAIGatewayReadiness(
    gateway,
    expectedRevision,
    { label: `${label} active token` },
  );
  if (!gateway.previousToken) return readiness;
  await waitForOpenAIGatewayReadiness(
    { ...gateway, token: gateway.previousToken, previousToken: undefined },
    expectedRevision,
    { label: `${label} previous token` },
  );
  return readiness;
}

async function waitForDeploymentReadiness(
  baseUrl,
  expectedRevision,
  { label, useDeploymentBypass = true },
) {
  const startedAt = Date.now();
  const deadline = startedAt + readinessTimeoutMs;
  let attempts = 0;
  let lastObservation = "no health response";
  let lastHealthObservation;
  let lastLoggedObservation = "";

  while (Date.now() < deadline) {
    attempts += 1;
    const remainingMs = Math.max(1, deadline - Date.now());
    let response;
    try {
      response = await fetch(`${baseUrl}/api/health`, {
        cache: "no-store",
        headers: readinessHeaders(useDeploymentBypass),
        redirect: "manual",
        signal: AbortSignal.timeout(
          Math.min(readinessRequestTimeoutMs, remainingMs),
        ),
      });
    } catch (error) {
      lastObservation = `request_error=${safeDiagnostic(errorMessage(error))}`;
    }

    if (response) {
      try {
        const observation = await readHealthObservation(response);
        lastObservation = formatHealthObservation(observation);
        lastHealthObservation = lastObservation;
        if (
          observation.httpStatus === 200 &&
          observation.healthStatus === "healthy" &&
          observation.revision === expectedRevision
        ) {
          console.log(
            `${label} became ready at revision ${expectedRevision} after ${attempts} attempt(s) in ${Date.now() - startedAt}ms.`,
          );
          return;
        }
        if (observation.httpStatus === 401 || observation.httpStatus === 403) {
          throw new ReadinessAccessError(observation.httpStatus);
        }
      } catch (error) {
        if (error instanceof ReadinessAccessError) {
          throw new Error(
            `${label} readiness access was denied with HTTP ${error.status}. Configure VERCEL_AUTOMATION_BYPASS_SECRET for protected deployments.`,
          );
        }
        lastObservation = `response_error=${safeDiagnostic(errorMessage(error))}`;
      }
    }

    if (
      attempts === 1 ||
      lastObservation !== lastLoggedObservation ||
      attempts % 10 === 0
    ) {
      console.log(
        `Waiting for ${label} readiness (attempt ${attempts}): ${lastObservation}.`,
      );
      lastLoggedObservation = lastObservation;
    }
    const sleepMs = Math.min(
      readinessPollIntervalMs,
      Math.max(0, deadline - Date.now()),
    );
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  throw new Error(
    `${label} did not become healthy at revision ${expectedRevision} within ${readinessTimeoutMs}ms after ${attempts} attempt(s). Last observation: ${lastHealthObservation || lastObservation}.`,
  );
}

async function waitForOpenAIGatewayReadiness(
  gateway,
  expectedRevision,
  { label },
) {
  if (!gateway) {
    throw new Error(
      `${label} cannot run without a validated OpenAI gateway configuration.`,
    );
  }
  const startedAt = Date.now();
  const deadline = startedAt + gatewayReadinessTimeoutMs;
  const healthUrl = new URL("/healthz", gateway.baseUrl.origin);
  let attempts = 0;
  let lastObservation = "no gateway health response";
  let lastLoggedObservation = "";

  while (Date.now() < deadline) {
    attempts += 1;
    const remainingMs = Math.max(1, deadline - Date.now());
    let response;
    try {
      response = await fetch(healthUrl, {
        cache: "no-store",
        headers: {
          accept: "application/json",
          "x-asael-gateway-token": gateway.token,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(
          Math.min(gatewayReadinessRequestTimeoutMs, remainingMs),
        ),
      });
    } catch (error) {
      lastObservation = `request_error=${safeDiagnostic(errorMessage(error))}`;
    }

    if (response) {
      try {
        const observation = await readGatewayHealthObservation(
          response,
          expectedRevision,
        );
        lastObservation = formatGatewayHealthObservation(observation);
        if (gatewayHealthObservationReady(observation)) {
          const tokenProbeStatus = await probeOpenAIGatewayToken(
            gateway,
            Math.max(1, deadline - Date.now()),
          );
          lastObservation = `${lastObservation} token=${tokenProbeStatus === 400}`;
          if (tokenProbeStatus === 401 || tokenProbeStatus === 403) {
            throw new GatewayReadinessAccessError(tokenProbeStatus);
          }
          if (tokenProbeStatus !== 400) {
            throw new Error("Gateway token probe did not reach the authorization boundary.");
          }
          console.log(
            `${label} became ready for release ${expectedRevision} in ${OPENAI_GATEWAY_REGION} with protocol ${OPENAI_GATEWAY_PROTOCOL} after ${attempts} attempt(s) in ${Date.now() - startedAt}ms.`,
          );
          return observation;
        }
        if (observation.httpStatus === 401 || observation.httpStatus === 403) {
          throw new GatewayReadinessAccessError(observation.httpStatus);
        }
      } catch (error) {
        if (error instanceof GatewayReadinessAccessError) {
          throw new Error(
            `${label} access was denied with HTTP ${error.status}. Verify the shared OMNIAGENT_OPENAI_GATEWAY_TOKEN secret.`,
          );
        }
        lastObservation = "response_error=invalid_gateway_health_response";
      }
    }

    if (
      attempts === 1 ||
      lastObservation !== lastLoggedObservation ||
      attempts % 10 === 0
    ) {
      console.log(
        `Waiting for ${label} readiness (attempt ${attempts}): ${lastObservation}.`,
      );
      lastLoggedObservation = lastObservation;
    }
    const sleepMs = Math.min(
      gatewayReadinessPollIntervalMs,
      Math.max(0, deadline - Date.now()),
    );
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  throw new Error(
    `${label} did not become ready within ${gatewayReadinessTimeoutMs}ms after ${attempts} attempt(s). Last observation: ${lastObservation}.`,
  );
}

async function probeOpenAIGatewayToken(gateway, remainingMs) {
  // This allowlisted model-readiness route checks the gateway token before it
  // checks the OpenAI Authorization header. Deliberately omitting Authorization
  // yields 400 only when the gateway token was accepted and never reaches
  // OpenAI, so pairing is verified without an API key or a paid request.
  const probeUrl = new URL("/v1/models/gpt-5", gateway.baseUrl.origin);
  let response;
  try {
    response = await fetch(probeUrl, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        "x-asael-gateway-token": gateway.token,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(
        Math.min(gatewayReadinessRequestTimeoutMs, remainingMs),
      ),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch {
    return 0;
  }
}

async function runPaidOpenAIGatewayInference({
  gateway,
  openAIKey,
  expectedRevision,
  readiness,
  label,
}) {
  if (
    !readiness ||
    !gatewayHealthObservationReady(readiness) ||
    readiness.revision !== expectedRevision
  ) {
    throw new Error(
      `${label} paid inference requires release-matched gateway readiness.`,
    );
  }
  if (!openAIKey) {
    throw new Error(`${label} paid inference requires OPENAI_API_KEY.`);
  }

  // This synthetic probe calls the gateway directly, so it creates no Asael
  // application rows; store:false also prevents OpenAI response retention.
  const requestBody = JSON.stringify({
    model: paidInferenceModel,
    input:
      `Synthetic Asael release verification. Reply with exactly ${PAID_INFERENCE_SENTINEL}.`,
    max_output_tokens: PAID_INFERENCE_MAX_OUTPUT_TOKENS,
    store: false,
  });
  const inferenceUrl = new URL(
    "responses",
    `${gateway.baseUrl.toString().replace(/\/+$/, "")}/`,
  );
  const idempotencyLabel = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  let response;
  try {
    response = await fetch(inferenceUrl, {
      method: "POST",
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${openAIKey}`,
        "content-type": "application/json",
        "idempotency-key":
          `asael-release-${expectedRevision}-${idempotencyLabel}`.slice(0, 255),
        "x-asael-gateway-token": gateway.token,
      },
      body: requestBody,
      redirect: "manual",
      signal: AbortSignal.timeout(paidInferenceTimeoutMs),
    });
  } catch (error) {
    throw new Error(
      `${label} paid OpenAI inference request failed: ${safeDiagnostic(errorMessage(error))}.`,
    );
  }

  const gatewayRequestId = response.headers.get(
    "x-asael-gateway-request-id",
  );
  const upstreamRequestId = response.headers.get("x-request-id");
  const result = await readResponseTextLimited(response, 262_144);
  let body;
  if (!result.exceeded && result.text) {
    try {
      body = JSON.parse(result.text);
    } catch {
      body = undefined;
    }
  }
  if (response.status !== 200) {
    throw new Error(
      `${label} paid OpenAI inference returned HTTP ${response.status}.`,
    );
  }
  if (result.exceeded || !body || body.object !== "response") {
    throw new Error(`${label} paid OpenAI inference returned an invalid response.`);
  }
  const responseModel =
    typeof body.model === "string" ? body.model : "";
  if (
    responseModel !== paidInferenceModel &&
    !responseModel.startsWith(`${paidInferenceModel}-`)
  ) {
    throw new Error(`${label} paid OpenAI inference used an unexpected model.`);
  }
  if (
    typeof body.id !== "string" ||
    !body.id.startsWith("resp_") ||
    !gatewayRequestId ||
    !upstreamRequestId
  ) {
    throw new Error(
      `${label} paid inference did not prove the OpenAI gateway/provider path.`,
    );
  }
  const inputTokens = positiveIntegerOrZero(body.usage?.input_tokens);
  const outputTokens = positiveIntegerOrZero(body.usage?.output_tokens);
  const totalTokens = positiveIntegerOrZero(body.usage?.total_tokens);
  if (
    inputTokens <= 0 ||
    outputTokens <= 0 ||
    totalTokens < inputTokens + outputTokens
  ) {
    throw new Error(`${label} paid OpenAI inference is missing valid usage.`);
  }
  if (!openAIResponseText(body).includes(PAID_INFERENCE_SENTINEL)) {
    throw new Error(
      `${label} paid OpenAI inference did not return the synthetic sentinel.`,
    );
  }

  console.log(
    `${label} paid inference passed: provider=openai model=${safeDiagnostic(responseModel)} inputTokens=${inputTokens} outputTokens=${outputTokens} totalTokens=${totalTokens} revision=${expectedRevision} store=false appData=none.`,
  );
}

function positiveIntegerOrZero(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function openAIResponseText(body) {
  const fragments = [];
  if (typeof body.output_text === "string") fragments.push(body.output_text);
  if (!Array.isArray(body.output)) return fragments.join("\n");
  for (const item of body.output) {
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (typeof content?.text === "string") fragments.push(content.text);
      if (typeof content?.output_text === "string") {
        fragments.push(content.output_text);
      }
    }
  }
  return fragments.join("\n");
}

async function readGatewayHealthObservation(response, expectedRevision) {
  const result = await readResponseTextLimited(response, 16_384);
  let body;
  if (!result.exceeded && result.text) {
    try {
      body = JSON.parse(result.text);
    } catch {
      body = undefined;
    }
  }
  return {
    httpStatus: response.status,
    bodyState: result.exceeded ? "oversized" : body ? "json" : "invalid",
    revision:
      typeof body?.revision === "string" ? body.revision : undefined,
    healthy: body?.status === "healthy",
    serviceMatches: body?.service === OPENAI_GATEWAY_SERVICE,
    regionMatches: body?.region === OPENAI_GATEWAY_REGION,
    revisionMatches: body?.revision === expectedRevision,
    protocolMatches: body?.protocol === OPENAI_GATEWAY_PROTOCOL,
  };
}

function gatewayHealthObservationReady(observation) {
  return (
    observation.httpStatus === 200 &&
    observation.healthy &&
    observation.serviceMatches &&
    observation.regionMatches &&
    observation.revisionMatches &&
    observation.protocolMatches
  );
}

function formatGatewayHealthObservation(observation) {
  return [
    `http=${observation.httpStatus}`,
    `body=${observation.bodyState}`,
    `healthy=${observation.healthy}`,
    `service=${observation.serviceMatches}`,
    `region=${observation.regionMatches}`,
    `revision=${observation.revisionMatches}`,
    `protocol=${observation.protocolMatches}`,
  ].join(" ");
}

function readinessHeaders(useDeploymentBypass) {
  const bypassSecret = useDeploymentBypass
    ? process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()
    : undefined;
  return {
    accept: "application/json",
    ...(bypassSecret
      ? { "x-vercel-protection-bypass": bypassSecret }
      : {}),
  };
}

async function readHealthObservation(response) {
  const result = await readResponseTextLimited(response, 16_384);
  let body;
  if (!result.exceeded && result.text) {
    try {
      body = JSON.parse(result.text);
    } catch {
      body = undefined;
    }
  }
  const dependencies =
    body?.dependencies && typeof body.dependencies === "object"
      ? body.dependencies
      : {};
  return {
    httpStatus: response.status,
    healthStatus:
      typeof body?.status === "string"
        ? safeDiagnostic(body.status)
        : undefined,
    revision:
      typeof body?.revision === "string"
        ? safeDiagnostic(body.revision)
        : undefined,
    bodyState: result.exceeded
      ? "oversized"
      : body
        ? "json"
        : "invalid",
    dependencies: {
      databaseConfigured: booleanOrUndefined(dependencies.databaseConfigured),
      openAiConfigured: booleanOrUndefined(dependencies.openAiConfigured),
      cronSecretConfigured: booleanOrUndefined(dependencies.cronSecretConfigured),
    },
  };
}

async function readResponseTextLimited(response, maxBytes) {
  if (!response.body) return { text: "", exceeded: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { text: "", exceeded: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, exceeded: false };
}

function formatHealthObservation(observation) {
  const details = [
    `http=${observation.httpStatus}`,
    `body=${observation.bodyState}`,
    observation.healthStatus
      ? `health=${observation.healthStatus}`
      : undefined,
    observation.revision
      ? `revision=${observation.revision}`
      : "revision=missing",
    formatBooleanDiagnostic(
      "database",
      observation.dependencies.databaseConfigured,
    ),
    formatBooleanDiagnostic(
      "openai",
      observation.dependencies.openAiConfigured,
    ),
    formatBooleanDiagnostic(
      "cron",
      observation.dependencies.cronSecretConfigured,
    ),
  ];
  return details.filter(Boolean).join(" ");
}

function formatBooleanDiagnostic(label, value) {
  return value === undefined ? undefined : `${label}=${value}`;
}

function booleanOrUndefined(value) {
  return typeof value === "boolean" ? value : undefined;
}

function safeDiagnostic(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "unknown";
}

function printDryRunReadinessWait(label, baseUrl, expectedRevision) {
  console.log(
    `DRY RUN wait for ${label} readiness at ${baseUrl}/api/health revision=${expectedRevision} timeout=${readinessTimeoutMs}ms`,
  );
}

function printDryRunGatewayPairReadiness(label, expectedRevision) {
  console.log(
    `DRY RUN wait for ${label} active+optional-previous token readiness at /healthz revision=${expectedRevision} region=${OPENAI_GATEWAY_REGION} protocol=${OPENAI_GATEWAY_PROTOCOL} timeout=${gatewayReadinessTimeoutMs}ms`,
  );
}

function printDryRunPaidAgentVerification(baseUrl, expectedRevision) {
  printDryRun("npm", ["run", "smoke:paid-agent"], {
    BASE_URL: baseUrl,
    EXPECTED_REVISION: expectedRevision,
    LIVE_VERIFY_PAID_OPENAI: "CONFIRMED",
  });
}

function printPostActivationVerification(baseUrl, activatedAt) {
  const environment = {
    BASE_URL: baseUrl,
    SMOKE_REQUEST_TIMEOUT_MS: "300000",
    OMNIAGENT_REQUIRE_ACTIVE_WORKER_HEARTBEATS: "true",
    OMNIAGENT_WORKER_HEARTBEAT_NOT_BEFORE: activatedAt,
  };
  printDryRun("npm", ["run", "smoke:security"], environment);
  printDryRun("npm", ["run", "smoke:release"], environment);
}

function printDryRunGatewayTokenStage(label) {
  console.log(
    `DRY RUN stage ${label} on Fly through secret stdin; values redacted`,
  );
}

function printDryRunWorkerStartupWait(label) {
  console.log(
    `DRY RUN wait for ${label} target registration window ${workerStartupSettleMs}ms`,
  );
}

async function waitForWorkerStartupWindow(label) {
  if (workerStartupSettleMs <= 0) return;
  console.log(
    `${label} is settling for ${workerStartupSettleMs}ms before target-specific verification.`,
  );
  await new Promise((resolve) => setTimeout(resolve, workerStartupSettleMs));
}

function normalizeReadinessProbeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("--readiness-probe requires a valid absolute URL.");
  }
  const loopbackHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password) {
    fail("--readiness-probe requires HTTPS or loopback HTTP without embedded credentials.");
  }
  if (url.search || url.hash) {
    fail("--readiness-probe URL must not contain a query string or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function normalizeExpectedRevision(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    fail("--readiness-probe requires a bounded expected revision.");
  }
  return normalized;
}

function normalizeModelIdentifier(value) {
  const normalized = String(value || "").trim();
  if (
    !normalized ||
    normalized.length > 128 ||
    !/^[a-zA-Z0-9._:-]+$/.test(normalized)
  ) {
    fail(
      "OMNIAGENT_DEPLOY_OPENAI_SMOKE_MODEL must be a bounded model identifier.",
    );
  }
  return normalized;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function printVerificationCommands(baseUrl) {
  const sessionFile = "/tmp/omniagent-release-session/session-cookie";
  const environment = {
    ...smokeEnvironment,
    BASE_URL: baseUrl,
    BENCHMARK_SESSION_FILE: sessionFile,
    SMOKE_DRIVE_BACKGROUND_QUEUE: "true",
    SMOKE_REQUEST_TIMEOUT_MS: "300000",
    SMOKE_SESSION_OUTPUT: sessionFile,
  };
  printDryRun("npm", ["run", "test:production-smoke"], environment);
  printDryRun("npm", ["run", "benchmark:preview"], environment);
  printDryRun("npm", ["run", "benchmark:dashboard"], environment);
}

function deploymentUrlFromOutput(output) {
  const urls = output.match(/https:\/\/[a-zA-Z0-9.-]+/g);
  if (!urls?.length) {
    throw new Error("Vercel did not return a staged deployment URL.");
  }
  return normalizeDeploymentUrl(urls.at(-1));
}

function normalizeDeploymentUrl(value) {
  const url = new URL(
    String(value).startsWith("http") ? value : `https://${value}`,
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash ||
    !VERCEL_DEPLOYMENT_HOST_PATTERN.test(url.hostname)
  ) {
    throw new Error(
      "Vercel deployment URL must be an exact deployment origin for the Asael production project.",
    );
  }
  return url.origin;
}

function printDryRun(command, args, environment) {
  const environmentPrefix = environment
    ? `${Object.entries(environment)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")} `
    : "";
  console.log(`DRY RUN ${environmentPrefix}${command} ${args.join(" ")}`);
}

async function capture(command, args, options = {}) {
  let stdout = "";
  await run(command, args, {
    ...options,
    stdout(chunk) {
      stdout += chunk;
      if (options.echo) {
        process.stdout.write(chunk);
      }
    },
  });
  return stdout.trim();
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...options.environment,
      },
      stdio: options.stdout ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    if (options.stdout && child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", options.stdout);
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal || `exit code ${code}`}.`,
        ),
      );
    });
  });
}

function runWithSensitiveStdin(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      // Suppress command output as a defense in depth: secret values are sent
      // only over stdin and cannot be echoed by a verbose CLI or error path.
      stdio: ["pipe", "ignore", "ignore"],
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal || `exit code ${code}`}; sensitive command output was suppressed.`,
        ),
      );
    });
    child.stdin.once("error", (error) => finish(error));
    child.stdin.end(input);
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
