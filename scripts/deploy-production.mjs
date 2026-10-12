#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RELEASE_BRANCH,
  RELEASE_REPOSITORY,
  REQUIRED_RELEASE_CHECKS,
  verifyReleaseProvenance,
} from "./release-provenance.mjs";
import {
  RELEASE_MANIFEST_ENV,
  RELEASE_MANIFEST_VERSION,
  OWNER_LIVE_RELEASE_MANIFEST_VERSION,
  RELEASE_SIGNING_KEY_FILE_ENV,
  loadReleaseSigningKey,
  signReleaseManifest,
} from "./release-manifest.mjs";
import {
  parseForwardSchemaRecovery,
  validateForwardSchemaDatabaseVerification,
  validateForwardSchemaPriorArtifact,
} from "./forward-schema-recovery.mjs";
import { readOwnerBudgetOverride } from "./release-owner-budget-override.mjs";
import {
  OWNER_LIVE_AUTHORIZATION_ENV,
  OWNER_LIVE_DEFERRED_COMMANDS,
  OWNER_LIVE_LOCAL_COMMANDS,
  OWNER_LIVE_VERIFICATION_MODE,
  assertOwnerLiveAuthorization,
  readOwnerLiveAuthorization,
} from "./release-owner-live-authorization.mjs";

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
const PRODUCTION_BASE_URL = "https://asael.bennierichard.com";
const VERCEL_DEPLOYMENT_HOST_PATTERN =
  /^omniagent-[a-z0-9]+-benniejosephs-projects\.vercel\.app$/;
const OPENAI_GATEWAY_SERVICE = "asael-openai-egress";
const OPENAI_GATEWAY_REGION = "iad";
const OPENAI_GATEWAY_PROTOCOL = "1";
// A degraded gateway still serves: it is busy, or OpenAI is failing, and
// neither is the release's to fix.
const OPENAI_GATEWAY_SERVING_STATUSES = new Set(["healthy", "degraded"]);
const OPENAI_GATEWAY_URL = "https://omniagent-os-worker.fly.dev/v1";
const OPENAI_GATEWAY_TOKEN_ENV = "OMNIAGENT_OPENAI_GATEWAY_TOKEN";
const OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV =
  "OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN";
const OPENAI_GATEWAY_RECOVERY_TOKEN_ENV = "OMNIAGENT_OPENAI_GATEWAY_RECOVERY_TOKEN";
const OPENAI_GATEWAY_RECOVERY_SELECTOR_ENV = "OMNIAGENT_OPENAI_GATEWAY_USE_RECOVERY_TOKEN";
const OPENAI_GATEWAY_INITIAL_CUTOVER_ENV =
  "OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER";
const RELEASE_SPLIT_RECOVERY_ENV = "OMNIAGENT_RELEASE_SPLIT_RECOVERY";
const RELEASE_FORWARD_SCHEMA_RECOVERY_ENV =
  "OMNIAGENT_RELEASE_FORWARD_SCHEMA_RECOVERY";
const PAID_INFERENCE_SENTINEL = "ASAEL_RELEASE_OK";
const PAID_INFERENCE_MAX_OUTPUT_TOKENS = 16;
// This identifier is never sent to OpenAI. The gateway rejects the request at
// its missing-Authorization boundary after authenticating the gateway token.
const GATEWAY_AUTHORIZATION_PROBE_ID = "authorization-probe";
const WORKER_PID_FILE = "/tmp/asael-worker.pid";
const WORKER_RELEASE_ACTIVATION_FILE =
  "/tmp/asael-worker-release-activated";
const dryRun = process.argv.includes("--dry-run");
const useHostedVerification = process.argv.includes("--use-hosted-verification");
const ownerLiveVerification = process.argv.includes("--owner-authorized-live");
// Consume this before any subprocess starts. The signed, public manifest carries
// its bounded authorization record; the environment pin grants no app authority.
const rawOwnerLiveAuthorization = process.env[OWNER_LIVE_AUTHORIZATION_ENV];
delete process.env[OWNER_LIVE_AUTHORIZATION_ENV];
if (ownerLiveVerification && useHostedVerification) {
  fail("--owner-authorized-live cannot be combined with --use-hosted-verification.");
}
if ((!dryRun && ownerLiveVerification && !rawOwnerLiveAuthorization?.trim()) ||
  (!ownerLiveVerification && rawOwnerLiveAuthorization?.trim())) {
  fail(`${OWNER_LIVE_AUTHORIZATION_ENV} and --owner-authorized-live must be supplied together.`);
}
let ownerLiveAuthorization;
try {
  ownerLiveAuthorization = readOwnerLiveAuthorization({
    [OWNER_LIVE_AUTHORIZATION_ENV]: rawOwnerLiveAuthorization,
  });
} catch (error) { fail(errorMessage(error)); }
// A lost-token recovery keeps the unknown, managed Fly primary untouched.
// The locally supplied token is a fresh secondary, never the prior secret.
const preserveGatewayPrimary = process.argv.includes("--preserve-gateway-primary");
const configurationProbe = process.argv.includes("--configuration-probe");
const provenanceProbe = process.argv.includes("--provenance-probe");
const readinessProbeIndex = process.argv.indexOf("--readiness-probe");
const gatewayReadinessProbeIndex = process.argv.indexOf(
  "--gateway-readiness-probe",
);
const gatewayPaidProbeIndex = process.argv.indexOf("--gateway-paid-probe");
const flyApp = process.env.FLY_APP?.trim() || "omniagent-os-worker";
// The paid agent check signs in with a real account password. Only that check
// receives it; no other command this script starts inherits it.
const paidAgentPassword = process.env.SMOKE_PAID_AGENT_PASSWORD || "";
delete process.env.SMOKE_PAID_AGENT_PASSWORD;
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
  const paidInferenceModel = resolvePaidInferenceModel();
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
    paidInferenceModel,
    label: "Gateway paid probe",
  }).catch((error) => fail(errorMessage(error)));
  process.exit(0);
}

if (configurationProbe) {
  const { signingKey } = validateReleaseConfiguration();
  console.log("Production release configuration is valid.");
  console.log(`Release manifests are signed with key ${signingKey.keyId}.`);
  process.exit(0);
}

if (provenanceProbe) {
  await requireCleanWorkingTree();
  await verifyRunnerProvenance();
  process.exit(0);
}

if (dryRun) {
  printDryRunReleaseProvenance();
  if (preserveGatewayPrimary) {
    console.log("DRY RUN verify deployed Fly secret metadata, immutable compatible rollback image, production-only sensitive Vercel primary, absent recovery alias/selector, and fresh old-deployment provider proof");
    console.log("DRY RUN create owned sensitive recovery alias through stdin; candidate uses only the non-secret recovery selector");
  }
  if (ownerLiveVerification) {
    console.log("DRY RUN require exact previous/candidate SHA authorization with expiry within four hours; defer CI, test/audit suites, and benchmarks without claiming they passed");
    for (const command of OWNER_LIVE_LOCAL_COMMANDS) printDryRun("npm", ["run", command]);
    console.log("DRY RUN recheck clean exact HEAD, GitHub main tip, and authorization before every release mutation boundary; sign v2 with actual local validation and explicit deferrals");
  } else if (useHostedVerification) {
    console.log("DRY RUN use green exact-commit hosted verification; defer the repeated local suite");
  } else {
    printDryRun("npm", ["run", "verify"]);
  }
  if (process.env[RELEASE_FORWARD_SCHEMA_RECOVERY_ENV]?.trim()) {
    printDryRun("npm", ["run", "smoke:preflight"], {
      BASE_URL: PRODUCTION_BASE_URL,
    });
    printDryRun(
      "npm",
      ["run", "smoke:release", "--", "--previous-release"],
      { BASE_URL: PRODUCTION_BASE_URL },
    );
    printDryRun("npm", ["run", "db:verify"]);
    console.log("DRY RUN validate exact prior isolation discrepancy and fresh candidate database verification before any deploy");
  } else {
    printDryRun(
      "npm",
      ["run", "smoke:release", "--", "--previous-release"],
      { BASE_URL: PRODUCTION_BASE_URL },
    );
  }
  printDryRun(
    "vercel",
    [
      "deploy",
      "--prod",
      "--skip-domain",
      "--yes",
      "--scope",
      VERCEL_SCOPE,
      "--env",
      `OMNIAGENT_RELEASE_SHA=${revision}`,
      "--env",
      `${RELEASE_MANIFEST_ENV}=<release manifest signed with ${RELEASE_SIGNING_KEY_FILE_ENV}>`,
      ...(preserveGatewayPrimary ? ["--env", `${OPENAI_GATEWAY_RECOVERY_SELECTOR_ENV}=true`] : []),
    ],
    vercelEnvironment,
  );
  const staged = "https://staged-deployment.example";
  printDryRunReadinessWait("staged web", staged, revision);
  printDryRunManifestVerification(staged);
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
  printDryRunManifestVerification(PRODUCTION_BASE_URL, "<current-production-revision>");
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
  if (preserveGatewayPrimary) {
    console.log("DRY RUN retain Fly primary and secondary through rollback; after every release gate passes, update the sensitive Vercel primary through stdin and remove only the owned recovery alias");
  }
  process.exit(0);
}

const releaseConfiguration = validateReleaseConfiguration();
const productionBaseUrl = releaseConfiguration.baseUrl;
const openAIGateway = releaseConfiguration.openAIGateway;
if (preserveGatewayPrimary) delete process.env[OPENAI_GATEWAY_TOKEN_ENV];
const initialOpenAIGatewayCutover =
  releaseConfiguration.initialOpenAIGatewayCutover;
const splitRecovery = releaseConfiguration.splitRecovery;
const forwardSchemaRecovery = releaseConfiguration.forwardSchemaRecovery;
const signingKey = releaseConfiguration.signingKey;
// The one-time recovery pin is consumed by this runner, never by a candidate
// application, smoke process, or platform CLI.
delete process.env[RELEASE_FORWARD_SCHEMA_RECOVERY_ENV];
// Keep the privileged migration connection out of every child except the
// single read-only database verification in the prior-release check.
const recoveryMigrationDatabaseUrl = forwardSchemaRecovery
  ? process.env.MIGRATION_DATABASE_URL
  : undefined;
if (forwardSchemaRecovery) delete process.env.MIGRATION_DATABASE_URL;
await requireCleanWorkingTree();
// Vercel and Fly build the checked-out tree. Prove exact main provenance before
// local verification; only the explicit owner mode defers hosted CI.
const provenance = await verifyRunnerProvenance();
let ownerLocalValidation;
if (ownerLiveVerification) {
  for (const command of OWNER_LIVE_LOCAL_COMMANDS) {
    await run("npm", ["run", command], {
      environment: { NEXT_PUBLIC_APP_URL: productionBaseUrl },
    }).catch((error) => fail(`Owner-authorized ${command} failed: ${errorMessage(error)}`));
  }
  await requireCleanWorkingTree();
  await verifyRunnerProvenance();
  ownerLocalValidation = {
    revision,
    commands: [...OWNER_LIVE_LOCAL_COMMANDS],
    completedAt: new Date().toISOString(),
  };
  console.log("Local typecheck and build passed; hosted CI, test/audit suites, and benchmarks remain deferred by the owner.");
} else if (useHostedVerification) {
  console.log(`Using verified hosted checks for ${provenance.revision}; the repeated local suite is deferred.`);
} else {
  await run("npm", ["run", "verify"]).catch((error) =>
    fail(`Production verification failed: ${errorMessage(error)}`),
  );
}
let previousWorkerImage = await getCurrentWorkerImage();
const previousVercelDeployment = await getCurrentVercelDeployment(
  productionBaseUrl,
);
const previousHealthRevision = await getCurrentHealthRevision(
  productionBaseUrl,
);
const rollbackOpenAIGateway = openAIGateway && !initialOpenAIGatewayCutover && !preserveGatewayPrimary
  ? createRollbackGatewayConfiguration(openAIGateway)
  : undefined;
// A rollback restores the gateway to the revision it serves now. That is the
// web's revision unless production is split.
const previousGatewayRevision = splitRecovery
  ? await getSplitGatewayRevision(openAIGateway, previousHealthRevision)
  : previousHealthRevision;
if (ownerLiveVerification) {
  if (previousGatewayRevision !== previousHealthRevision) {
    fail("Owner-authorized live release requires one paired previous web and gateway revision.");
  }
  await requireOwnerLiveAdmission(previousHealthRevision);
  await run("npm", ["run", "smoke:manifest"], {
    environment: { BASE_URL: productionBaseUrl, SMOKE_EXPECTED_REVISION: previousHealthRevision },
  });
}
if (forwardSchemaRecovery && (
  forwardSchemaRecovery.previousRevision !== previousHealthRevision ||
  previousGatewayRevision !== previousHealthRevision
)) {
  fail("Forward-schema recovery does not match the currently paired production web and gateway revision.");
}
if (initialOpenAIGatewayCutover) {
  console.log(
    "Initial OpenAI gateway cutover confirmed: prior-gateway preflight is skipped and rollback uses the pre-gateway worker topology.",
  );
}
if (splitRecovery) {
  console.log(
    `Split production recovery confirmed: web ${previousHealthRevision} and gateway ${previousGatewayRevision} are each checked, and restored together on rollback.`,
  );
}
if (rollbackOpenAIGateway) {
  // Prove the token used by the currently promoted Vercel release still
  // reaches the current Fly revision before either platform is mutated.
  await waitForOpenAIGatewayReadiness(
    rollbackOpenAIGateway,
    previousGatewayRevision,
    { label: "Rollback gateway preflight" },
  ).catch((error) => fail(errorMessage(error)));
}

const primaryRecovery = preserveGatewayPrimary
  ? await prepareManagedPrimaryRecovery({
      gateway: openAIGateway,
      previousWorkerImage,
      previousVercelDeployment,
      previousHealthRevision,
    }).catch((error) => fail(errorMessage(error)))
  : undefined;
if (primaryRecovery) previousWorkerImage = primaryRecovery.workerImage;

let workerMutationStarted = false;
let vercelPromoted = false;
let releaseVerified = false;
try {
  if (splitRecovery) {
    // Release evidence fails a split production on its worker and gateway
    // revision gates, so only its health and cron authentication can pass.
    await run("npm", ["run", "smoke:preflight"], {
      environment: {
        BASE_URL: productionBaseUrl,
        SMOKE_EXPECTED_REVISION: previousHealthRevision,
        SMOKE_REQUEST_TIMEOUT_MS: "60000",
      },
    });
  } else if (forwardSchemaRecovery) {
    await runForwardSchemaPriorCheck(
      forwardSchemaRecovery,
      productionBaseUrl,
      previousHealthRevision,
      recoveryMigrationDatabaseUrl,
    );
  } else {
    // The prior release may predate the new agent error budget gate. Only
    // this pre-deployment check permits its absence; all new-release checks
    // require it, and a present failed gate still stops this check.
    await run("npm", ["run", "smoke:release", "--", "--previous-release"], {
      environment: {
        BASE_URL: productionBaseUrl,
        // Release evidence intentionally performs ordered database, worker,
        // SLO, and provider checks. Its normal cold path can exceed the
        // generic 15s HTTP smoke deadline without indicating an unhealthy
        // deployment.
        SMOKE_REQUEST_TIMEOUT_MS: "60000",
      },
    });
  }
  await requireOwnerLiveAdmission(previousHealthRevision);
  // The manifest records provenance and completed local validation. Live checks
  // happen after deployment and are never claimed as already passed here.
  const releaseManifest = signReleaseManifest(
    {
      version: ownerLiveVerification ? OWNER_LIVE_RELEASE_MANIFEST_VERSION : RELEASE_MANIFEST_VERSION,
      revision: provenance.revision,
      repository: RELEASE_REPOSITORY,
      branch: RELEASE_BRANCH,
      checks: provenance.checks,
      signedAt: new Date().toISOString(),
      ...(ownerLiveVerification ? {
        verification: {
          mode: OWNER_LIVE_VERIFICATION_MODE,
          ownerAuthorization: ownerLiveAuthorization,
          localValidation: ownerLocalValidation,
          deferredHostedChecks: [...REQUIRED_RELEASE_CHECKS],
          deferredCommands: [...OWNER_LIVE_DEFERRED_COMMANDS],
        },
      } : {}),
    },
    signingKey,
  );
  console.log(
    `Signed the release manifest for ${provenance.revision} with key ${signingKey.keyId}.`,
  );
  if (primaryRecovery) await createRecoveryAlias(primaryRecovery, openAIGateway.token);
  const deploymentOutput = await capture(
    "vercel",
    [
      "deploy",
      "--prod",
      "--skip-domain",
      "--yes",
      "--scope",
      VERCEL_SCOPE,
      "--env",
      `OMNIAGENT_RELEASE_SHA=${revision}`,
      "--env",
      `${RELEASE_MANIFEST_ENV}=${releaseManifest}`,
      ...(primaryRecovery ? ["--env", `${OPENAI_GATEWAY_RECOVERY_SELECTOR_ENV}=true`] : []),
    ],
    { environment: vercelEnvironment, echo: !primaryRecovery, sensitive: Boolean(primaryRecovery) },
  );
  const stagedBaseUrl = deploymentUrlFromOutput(deploymentOutput);
  await waitForDeploymentReadiness(stagedBaseUrl, revision, {
    label: "Staged web",
  });
  // A key the repository does not trust stops the release here, before
  // anything production runs on has changed.
  await runManifestVerification(stagedBaseUrl, releaseManifest);
  await requireOwnerLiveAdmission(previousHealthRevision);
  workerMutationStarted = true;
  if (primaryRecovery) {
    await stageManagedPrimaryRecovery(primaryRecovery, openAIGateway.token);
  } else if (openAIGateway) {
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
  if (primaryRecovery) await verifyManagedPrimaryPair(primaryRecovery, revision, "Staged recovery overlap");
  await waitForWorkerStartupWindow("Staged worker");
  await runPaidAgentVerification(stagedBaseUrl);
  await runVerificationCommands(stagedBaseUrl);

  // Only expose the web release after the exact staged web/worker pair passes.
  // Protected deployments are reached with VERCEL_AUTOMATION_BYPASS_SECRET.
  await requireOwnerLiveAdmission(previousHealthRevision);
  vercelPromoted = true;
  await run(
    "vercel",
    ["promote", stagedBaseUrl, "--yes", "--scope", VERCEL_SCOPE],
    { environment: vercelEnvironment },
  );
  await waitForDeploymentReadiness(productionBaseUrl, revision, {
    label: "Canonical web",
  });
  await runManifestVerification(productionBaseUrl, releaseManifest, previousHealthRevision);
  // Rebind the already-running worker in place. A second Fly deploy would
  // restart the co-hosted OpenAI gateway on the single production machine.
  await requireOwnerLiveAdmission(previousHealthRevision);
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
  if (primaryRecovery) await verifyManagedPrimaryPair(primaryRecovery, revision, "Canonical recovery overlap");
  await waitForWorkerStartupWindow("Canonical worker");
  await runPaidAgentVerification(productionBaseUrl);
  await runVerificationCommands(productionBaseUrl);
  await requireOwnerLiveAdmission(previousHealthRevision);
  const workerActivationStartedAt = new Date().toISOString();
  await run("fly", workerReleaseActivationArgs());
  await waitForWorkerStartupWindow("Activated canonical worker");
  await runPostActivationVerification(
    productionBaseUrl,
    workerActivationStartedAt,
  );
  releaseVerified = true;
  if (primaryRecovery) {
    // The old project secret is write-only. Change it only after the new
    // deployment has passed every gate; an ambiguous final write must not
    // roll back a verified deployment or claim to reconstruct that secret.
    await synchronizeRecoveryPrimary(primaryRecovery, openAIGateway.token);
    await removeOwnedRecoveryAlias(primaryRecovery);
    console.log("Gateway recovery completed; Fly still retains both tokens through the rollback window.");
  }
} catch (error) {
  if (primaryRecovery && releaseVerified) {
    fail(`Verified production release retained with both Fly tokens. Vercel secret synchronization or alias cleanup needs operator reconciliation; do not rerun recovery blindly. ${errorMessage(error)}`);
  }
  const rollbackErrors = [];
  if (primaryRecovery?.aliasCreationAttempted && !primaryRecovery.aliasId) {
    rollbackErrors.push("Recovery alias creation was not confirmed; reconcile its metadata before retrying. No unowned alias was removed.");
  }
  let workerRollbackSucceeded = !workerMutationStarted;
  if (workerMutationStarted) {
    let gatewaySecretsRestored = true;
    if (primaryRecovery) {
      await verifyRecoverySecretInventory(primaryRecovery, { allowPending: true }).catch((rollbackError) => {
        gatewaySecretsRestored = false;
        rollbackErrors.push(`Retained gateway secret verification failed: ${errorMessage(rollbackError)}`);
      });
    } else if (rollbackOpenAIGateway) {
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
      ).then(async () => {
        if (primaryRecovery) await verifyManagedPrimaryPair(primaryRecovery, previousHealthRevision, "Rollback recovery overlap");
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
      previousGatewayRevision,
    ).catch((rollbackError) => {
      rollbackErrors.push(
        `Rollback verification failed: ${errorMessage(rollbackError)}`,
      );
    });
  }
  if (primaryRecovery?.aliasId && !rollbackErrors.length) {
    await removeOwnedRecoveryAlias(primaryRecovery).catch((cleanupError) => {
      rollbackErrors.push(`Owned recovery alias cleanup failed: ${errorMessage(cleanupError)}`);
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
  ownerLiveVerification
    ? `Production release ${revision} passed local typecheck/build and canonical live health, authenticated paid inference, signed manifest, and paired release gates with rollback-safe gateway token overlap. Hosted CI, test/audit suites, and benchmarks were deferred.`
    : `Production release ${revision} passed canonical smoke and performance budgets with rollback-safe gateway token overlap.`,
);

async function requireOwnerLiveAdmission(previousRevision) {
  if (!ownerLiveVerification) return;
  assertOwnerLiveAuthorization(ownerLiveAuthorization, { candidateRevision: revision, previousRevision });
  // Admission may run after the worker or web changed. Throw into the paired
  // rollback handler here; the pre-deploy helpers call process.exit instead.
  const changes = await capture("git", ["status", "--porcelain"]);
  if (changes) throw new Error("Owner-authorized release checkout changed after validation.");
  const head = await capture("git", ["rev-parse", "HEAD"]);
  if (head !== revision) throw new Error("Owner-authorized release HEAD changed after validation.");
  await verifyReleaseProvenance({ revision, ownerLiveAuthorization });
}

async function requireCleanWorkingTree() {
  const worktreeChanges = await capture("git", [
    "status",
    "--porcelain",
  ]);
  if (worktreeChanges) {
    fail(
      "Production deployment requires a clean working tree so Vercel and Fly receive the same reviewed release.",
    );
  }
}

async function verifyRunnerProvenance() {
  const head = await capture("git", ["rev-parse", "HEAD"]);
  if (revision !== head) {
    fail(
      `OMNIAGENT_RELEASE_SHA ${safeDiagnostic(revision)} does not match HEAD ${safeDiagnostic(head)}. Vercel and Fly build the checked-out tree, so the release revision must be HEAD.`,
    );
  }
  const provenance = await verifyReleaseProvenance({ revision, ownerLiveAuthorization }).catch(
    (error) => fail(`Release provenance check failed: ${errorMessage(error)}`),
  );
  const position = provenance.behindBy
    ? `${provenance.behindBy} commits behind ${RELEASE_BRANCH}`
    : `the tip of ${RELEASE_BRANCH}`;
  console.log(
    ownerLiveVerification
      ? `Release ${revision} is ${position} on ${RELEASE_REPOSITORY}; hosted CI is deferred under the exact owner authorization.`
      : `Release ${revision} is ${position} on ${RELEASE_REPOSITORY} with green checks: ${provenance.checks.join(", ")}.`,
  );
  return provenance;
}

function validateReleaseConfiguration() {
  if (ownerLiveVerification) {
    try { assertOwnerLiveAuthorization(ownerLiveAuthorization, { candidateRevision: revision }); }
    catch (error) { fail(errorMessage(error)); }
  }
  let ownerBudgetPin;
  try { ownerBudgetPin = readOwnerBudgetOverride(); }
  catch (error) { fail(errorMessage(error)); }
  if (ownerBudgetPin && ownerBudgetPin.candidateRevision !== revision) {
    fail("Owner reliability exception candidate must match the exact release revision.");
  }
  const singaporeTopology = configuredVercelRegions().includes("sin1");
  const required = [
    ["BASE_URL", process.env.BASE_URL],
    [
      "internal smoke secret",
      process.env.SMOKE_INTERNAL_AUTH_SECRET ||
        process.env.OMNIAGENT_INTERNAL_AUTH_SECRET,
    ],
    ["RELEASE_EVIDENCE_OUTPUT", process.env.RELEASE_EVIDENCE_OUTPUT],
    [RELEASE_SIGNING_KEY_FILE_ENV, process.env[RELEASE_SIGNING_KEY_FILE_ENV]],
    // The paid agent check signs in as this account, so a release must name
    // it before anything is deployed.
    ["SMOKE_PAID_AGENT_EMAIL", process.env.SMOKE_PAID_AGENT_EMAIL],
    ["SMOKE_PAID_AGENT_PASSWORD", paidAgentPassword],
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
  const splitRecovery = validateSplitRecovery({
    value: process.env[RELEASE_SPLIT_RECOVERY_ENV],
    gateway: openAIGateway,
    previousToken,
    initialOpenAIGatewayCutover,
  });
  if (preserveGatewayPrimary && (
    !openAIGateway || previousToken || initialOpenAIGatewayCutover || splitRecovery ||
    flyApp !== "omniagent-os-worker"
  )) {
    fail("--preserve-gateway-primary requires the production gateway, a fresh local token, no previous token, and no initial-cutover or split-recovery mode.");
  }
  let forwardSchemaRecovery;
  try {
    forwardSchemaRecovery = parseForwardSchemaRecovery(
      process.env[RELEASE_FORWARD_SCHEMA_RECOVERY_ENV],
      {
        candidateRevision: revision,
        manifestPath: path.resolve("schema-migrations.json"),
        repositoryRoot: process.cwd(),
      },
    );
  } catch (error) {
    fail(`Forward-schema recovery configuration failed: ${errorMessage(error)}`);
  }
  if (forwardSchemaRecovery && (splitRecovery || initialOpenAIGatewayCutover)) {
    fail(`${RELEASE_FORWARD_SCHEMA_RECOVERY_ENV} cannot accompany split recovery or initial gateway cutover.`);
  }
  if (forwardSchemaRecovery && !process.env.MIGRATION_DATABASE_URL?.trim()) {
    fail(`${RELEASE_FORWARD_SCHEMA_RECOVERY_ENV} requires MIGRATION_DATABASE_URL for a fresh candidate schema check.`);
  }
  if (openAIGateway && openAIGateway.baseUrl.origin === productionOrigin) {
    fail("OMNIAGENT_OPENAI_GATEWAY_URL must use a separate gateway origin.");
  }
  let signingKey;
  try {
    signingKey = loadReleaseSigningKey();
  } catch (error) {
    fail(errorMessage(error));
  }
  return {
    baseUrl,
    initialOpenAIGatewayCutover,
    splitRecovery,
    forwardSchemaRecovery,
    signingKey,
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

// A release whose web rollback failed leaves the web and the gateway on
// different revisions, and no release can then pass a check of the pair. The
// confirmed flag checks each half at its own revision instead.
function validateSplitRecovery({
  value,
  gateway,
  previousToken,
  initialOpenAIGatewayCutover,
}) {
  const confirmation = String(value || "").trim();
  if (!confirmation) return false;
  if (confirmation !== "CONFIRMED") {
    fail(`${RELEASE_SPLIT_RECOVERY_ENV} must equal CONFIRMED.`);
  }
  if (!gateway) {
    fail(
      `${RELEASE_SPLIT_RECOVERY_ENV} requires a complete OpenAI gateway configuration.`,
    );
  }
  if (previousToken) {
    fail(
      `${RELEASE_SPLIT_RECOVERY_ENV} cannot be used with ${OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV}.`,
    );
  }
  if (initialOpenAIGatewayCutover) {
    fail(
      `${RELEASE_SPLIT_RECOVERY_ENV} cannot be used with ${OPENAI_GATEWAY_INITIAL_CUTOVER_ENV}.`,
    );
  }
  return true;
}

async function getSplitGatewayRevision(gateway, webRevision) {
  let observation;
  try {
    const response = await fetch(new URL("/healthz", gateway.baseUrl.origin), {
      cache: "no-store",
      headers: {
        accept: "application/json",
        "x-asael-gateway-token": gateway.token,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(gatewayReadinessRequestTimeoutMs),
    });
    observation = await readGatewayHealthObservation(response, webRevision);
  } catch (error) {
    fail(
      `Unable to read the current gateway revision: ${safeDiagnostic(errorMessage(error))}`,
    );
  }
  if (
    observation.httpStatus !== 200 ||
    !observation.revision ||
    observation.revision.length > 200 ||
    !/^[a-zA-Z0-9._:-]+$/.test(observation.revision)
  ) {
    fail(
      `The current gateway must report a bounded revision; observed ${formatGatewayHealthObservation(observation)}.`,
    );
  }
  if (observation.revisionMatches) {
    fail(
      `Production web and gateway both serve ${webRevision}; unset ${RELEASE_SPLIT_RECOVERY_ENV}.`,
    );
  }
  return observation.revision;
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
    workerShellCommand([
      "set -eu",
      `worker_pid=$(cat ${WORKER_PID_FILE})`,
      'case "$worker_pid" in ""|*[!0-9]*) exit 1;; esac',
      'kill -0 "$worker_pid"',
      'kill -HUP "$worker_pid"',
    ]),
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
    workerShellCommand([
      "set -eu",
      `expected_revision='${expectedRevision}'`,
      `worker_pid=$(cat ${WORKER_PID_FILE})`,
      'case "$worker_pid" in ""|*[!0-9]*) exit 1;; esac',
      'kill -0 "$worker_pid"',
      'kill -USR1 "$worker_pid"',
      "attempt=0",
      `while [ "$attempt" -lt 20 ]; do marker_revision=""; if [ -r ${WORKER_RELEASE_ACTIVATION_FILE} ] && IFS= read -r marker_revision < ${WORKER_RELEASE_ACTIVATION_FILE} && [ "$marker_revision" = "$expected_revision" ] && kill -0 "$worker_pid"; then exit 0; fi; attempt=$((attempt + 1)); sleep 1; done`,
      "exit 1",
    ]),
  ];
}

function workerShellCommand(commands) {
  const script = commands.join("; ");
  // fly ssh console executes --command directly rather than through a shell.
  // Launch Alpine's POSIX shell explicitly so builtins, substitutions, and
  // control flow are interpreted instead of being treated as executables.
  return `sh -c ${singleQuoteShellArgument(script)}`;
}

function singleQuoteShellArgument(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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

// These inventories contain metadata only. Never ask either platform to
// decrypt a secret, and never echo the raw API response or a CLI diagnostic.
async function recoveryFlySecrets() {
  const raw = await capture("fly", ["secrets", "list", "--app", flyApp, "--json"], { sensitive: true });
  let records;
  try { records = JSON.parse(raw); } catch { throw new Error("Invalid Fly secret metadata."); }
  if (!Array.isArray(records) || !records.length || records.some((entry) =>
    !entry || !/^[A-Z0-9_]+$/.test(entry.name || "") ||
    !/^[a-f0-9]{16,128}$/i.test(entry.digest || "") || typeof entry.status !== "string"
  ) || new Set(records.map((entry) => entry.name)).size !== records.length) {
    throw new Error("Ambiguous Fly secret metadata.");
  }
  return records.map(({ name, digest, status }) => ({ name, digest, status }));
}

async function recoveryVercelEnvironment() {
  const raw = await capture("vercel", [
    "api", `/v10/projects/${VERCEL_PROJECT_ID}/env?decrypt=false`,
    "--method", "GET", "--scope", VERCEL_SCOPE, "--raw",
  ], { environment: vercelEnvironment, sensitive: true });
  let records;
  try { records = raw.length <= 1_048_576 && JSON.parse(raw).envs; } catch { throw new Error("Invalid Vercel environment metadata."); }
  if (!Array.isArray(records) || records.some((entry) => !entry || typeof entry.key !== "string" || typeof entry.id !== "string")) {
    throw new Error("Ambiguous Vercel environment metadata.");
  }
  return records.map(({ id, key, type, visibility, target, gitBranch, customEnvironmentIds, updatedAt, createdAt }) =>
    ({ id, key, type, visibility, target, gitBranch, customEnvironmentIds, updatedAt: updatedAt ?? createdAt }));
}

function exactSensitiveProductionVariable(records, key) {
  const matches = records.filter((entry) => entry.key === key && (
    Array.isArray(entry.target) ? entry.target.includes("production") : true
  ));
  const record = matches[0];
  if (matches.length !== 1 || !record.id || !Number.isSafeInteger(record.updatedAt) || record.updatedAt <= 0 ||
    !(record.type === "sensitive" || record.visibility === "secret") ||
    !Array.isArray(record.target) || record.target.length !== 1 || record.target[0] !== "production" ||
    record.gitBranch || (record.customEnvironmentIds != null &&
      (!Array.isArray(record.customEnvironmentIds) || record.customEnvironmentIds.length))) {
    throw new Error(`${key} must have exactly one unbranched, production-only sensitive Vercel record.`);
  }
  return record;
}

async function prepareManagedPrimaryRecovery({ gateway, previousWorkerImage, previousVercelDeployment, previousHealthRevision }) {
  if (!/^[a-f0-9]{40}$/.test(previousHealthRevision)) {
    throw new Error("Managed-primary recovery requires an exact prior commit SHA.");
  }
  await run("git", ["diff", "--quiet", previousHealthRevision, "--",
    "Dockerfile.worker", "scripts/worker.mjs", "scripts/openai-egress-gateway.mjs",
    "scripts/internal-identity-token.mjs", "scripts/worker-release-activation.mjs",
  ]).catch(() => { throw new Error("The rollback worker sources differ from the audited two-token worker; recovery compatibility is unproven."); });
  const secrets = await recoveryFlySecrets();
  if (secrets.some((entry) => entry.status !== "Deployed") ||
    !secrets.some((entry) => entry.name === OPENAI_GATEWAY_TOKEN_ENV) ||
    secrets.some((entry) => entry.name === OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV)) {
    throw new Error("Recovery requires a deployed Fly primary, an empty secondary slot, and no staged secrets.");
  }
  const statusRaw = await capture("fly", ["status", "--app", flyApp, "--json"], { sensitive: true });
  let machines;
  try { machines = JSON.parse(statusRaw).Machines; } catch { throw new Error("Invalid rollback machine metadata."); }
  const firstImage = machines?.[0]?.image_ref;
  if (!Array.isArray(machines) || !machines.length ||
    firstImage?.registry !== "registry.fly.io" || firstImage?.repository !== flyApp ||
    !/^sha256:[a-f0-9]{64}$/.test(firstImage?.digest || "") ||
    machines.some((machine) => machine.state !== "started" || machine.region !== OPENAI_GATEWAY_REGION ||
      !machine.id || machine.config?.image !== previousWorkerImage ||
      machine.image_ref?.registry !== firstImage.registry || machine.image_ref?.repository !== firstImage.repository ||
      machine.image_ref?.digest !== firstImage.digest)) {
    throw new Error("Recovery requires started, release-matched Fly machines with one immutable rollback image.");
  }
  const environment = await recoveryVercelEnvironment();
  const primary = exactSensitiveProductionVariable(environment, OPENAI_GATEWAY_TOKEN_ENV);
  if (environment.some((entry) => [OPENAI_GATEWAY_RECOVERY_TOKEN_ENV, OPENAI_GATEWAY_RECOVERY_SELECTOR_ENV].includes(entry.key))) {
    throw new Error("Recovery alias and selector must be absent from the Vercel project before recovery.");
  }
  const recovery = {
    gateway, secrets, primaryId: primary.id, primaryUpdatedAt: primary.updatedAt, aliasId: undefined, aliasUpdatedAt: undefined,
    previousVercelDeployment, previousHealthRevision,
    workerImage: `${firstImage.registry}/${firstImage.repository}@${firstImage.digest}`,
    secondaryDigest: undefined,
  };
  const health = await readOpenAIGatewayHealth(gateway, previousHealthRevision, gatewayReadinessRequestTimeoutMs);
  if (!gatewayHealthObservationReady(health)) throw new Error("Recovery requires the current web and gateway to be paired and healthy.");
  if (await probeOpenAIGatewayToken(gateway, gatewayReadinessRequestTimeoutMs) !== 401) {
    throw new Error("Recovery requires a fresh candidate token rejected by the current gateway.");
  }
  await waitForPreservedPrimaryProof(recovery, Date.now(), "Prior recovery web");
  console.log("Managed-primary recovery preflight passed with a pinned compatible rollback image and fresh prior-provider proof.");
  return recovery;
}

async function assertRecoveryVercelMetadata(recovery, { aliasRequired = true, primaryWriteCompleted = false } = {}) {
  const records = await recoveryVercelEnvironment();
  const primary = exactSensitiveProductionVariable(records, OPENAI_GATEWAY_TOKEN_ENV);
  if (primary.id !== recovery.primaryId ||
    (!primaryWriteCompleted && primary.updatedAt !== recovery.primaryUpdatedAt) ||
    (primaryWriteCompleted && primary.updatedAt < recovery.primaryUpdatedAt) ||
    records.some((entry) => entry.key === OPENAI_GATEWAY_RECOVERY_SELECTOR_ENV)) {
    throw new Error("Vercel recovery metadata changed; refusing an ambiguous secret mutation.");
  }
  const aliases = records.filter((entry) => entry.key === OPENAI_GATEWAY_RECOVERY_TOKEN_ENV);
  if (!aliasRequired) {
    if (aliases.length) throw new Error("The recovery alias appeared concurrently; it is not owned by this release.");
    return;
  }
  const alias = exactSensitiveProductionVariable(records, OPENAI_GATEWAY_RECOVERY_TOKEN_ENV);
  if (aliases.length !== 1 || (recovery.aliasId && (
    alias.id !== recovery.aliasId || alias.updatedAt !== recovery.aliasUpdatedAt))) {
    throw new Error("Recovery alias ownership changed; refusing to update or remove it.");
  }
  if (primaryWriteCompleted) recovery.primaryUpdatedAt = primary.updatedAt;
  return alias;
}

async function createRecoveryAlias(recovery, token) {
  await assertRecoveryVercelMetadata(recovery, { aliasRequired: false });
  recovery.aliasCreationAttempted = true;
  await runWithSensitiveStdin("vercel", ["env", "add", OPENAI_GATEWAY_RECOVERY_TOKEN_ENV,
    "production", "--sensitive", "--yes", "--scope", VERCEL_SCOPE], token, { environment: vercelEnvironment });
  const alias = await assertRecoveryVercelMetadata(recovery);
  recovery.aliasId = alias.id;
  recovery.aliasUpdatedAt = alias.updatedAt;
  console.log("Created the release-owned sensitive recovery alias; the Vercel primary remains unchanged.");
}

async function removeOwnedRecoveryAlias(recovery) {
  if (!recovery.aliasId) return;
  await assertRecoveryVercelMetadata(recovery);
  await runWithSensitiveStdin("vercel", ["env", "rm", OPENAI_GATEWAY_RECOVERY_TOKEN_ENV,
    "production", "--yes", "--scope", VERCEL_SCOPE], "", { environment: vercelEnvironment });
  await assertRecoveryVercelMetadata(recovery, { aliasRequired: false });
  recovery.aliasId = undefined;
}

async function synchronizeRecoveryPrimary(recovery, token) {
  await assertRecoveryVercelMetadata(recovery);
  await runWithSensitiveStdin("vercel", ["env", "update", OPENAI_GATEWAY_TOKEN_ENV,
    "production", "--sensitive", "--yes", "--scope", VERCEL_SCOPE], token, { environment: vercelEnvironment });
  await assertRecoveryVercelMetadata(recovery, { primaryWriteCompleted: true });
}

async function readOpenAIGatewayHealth(gateway, expectedRevision, timeoutMs) {
  const response = await fetch(new URL("/healthz", gateway.baseUrl.origin), {
    cache: "no-store", redirect: "manual", headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return readGatewayHealthObservation(response, expectedRevision);
}

async function verifyRecoverySecretInventory(recovery, { beforeStage = false, allowPending = false } = {}) {
  const records = await recoveryFlySecrets();
  const retained = records.filter((entry) => entry.name !== OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV);
  if (retained.length !== recovery.secrets.length || recovery.secrets.some((expected) =>
    !retained.some((entry) => entry.name === expected.name && entry.digest === expected.digest)) ||
    (!allowPending && records.some((entry) => entry.status !== "Deployed"))) {
    throw new Error("Managed Fly secrets changed or remain staged; the original primary cannot be safely assumed.");
  }
  const secondary = records.find((entry) => entry.name === OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV);
  if ((beforeStage && secondary) || (recovery.secondaryDigest && secondary?.digest !== recovery.secondaryDigest)) {
    throw new Error("The recovery secondary slot changed concurrently.");
  }
  return secondary;
}

async function stageManagedPrimaryRecovery(recovery, token) {
  await verifyRecoverySecretInventory(recovery, { beforeStage: true });
  await assertRecoveryVercelMetadata(recovery);
  await runWithSensitiveStdin("fly", ["secrets", "import", "--app", flyApp, "--stage"],
    `${OPENAI_GATEWAY_PREVIOUS_TOKEN_ENV}=${token}\n`);
  const secondary = await verifyRecoverySecretInventory(recovery, { allowPending: true });
  if (!secondary) throw new Error("The recovery secondary was not staged.");
  recovery.secondaryDigest = secondary.digest;
  console.log("Staged only the recovery secondary on Fly; the managed primary was preserved.");
}

async function verifyManagedPrimaryPair(recovery, expectedRevision, label) {
  const notBefore = Date.now();
  const secondary = await verifyRecoverySecretInventory(recovery);
  if (secondary) {
    await waitForOpenAIGatewayReadiness(recovery.gateway, expectedRevision, { label });
  } else {
    const health = await readOpenAIGatewayHealth(recovery.gateway, expectedRevision, gatewayReadinessRequestTimeoutMs);
    if (!gatewayHealthObservationReady(health)) throw new Error(`${label} gateway revision is not ready.`);
  }
  await waitForPreservedPrimaryProof(recovery, notBefore, label);
}

async function waitForPreservedPrimaryProof(recovery, notBefore, label) {
  const deadline = Date.now() + readinessTimeoutMs;
  const internalSecret = process.env.SMOKE_INTERNAL_AUTH_SECRET || process.env.OMNIAGENT_INTERNAL_AUTH_SECRET;
  const tenantId = process.env.SMOKE_TENANT_ID || "production_smoke";
  // The original immutable deployment supplies A internally. This route's
  // provider check calls the deployment OpenAI client, never a tenant key.
  // Its inner 60s cache survives refresh=true, so require its own timestamp.
  while (Date.now() < deadline) {
    const response = await fetch(`${recovery.previousVercelDeployment}/api/release/evidence?refresh=true`, {
      cache: "no-store", redirect: "manual",
      headers: {
        ...readinessHeaders(true),
        "x-omni-internal-auth": internalSecret,
        "x-omni-tenant-id": tenantId,
        "x-omni-user-id": process.env.SMOKE_ACTOR_ID || "production-smoke",
        "x-omni-user-role": "admin",
        "x-omni-synthetic-auth": internalSecret,
        "x-omni-synthetic-source": "production-smoke",
        "x-omni-slo-excluded": "true",
      },
      signal: AbortSignal.timeout(Math.min(60_000, deadline - Date.now())),
    });
    const body = await readResponseTextLimited(response, 262_144);
    let report;
    try { report = !body.exceeded && JSON.parse(body.text).report; } catch { /* fail closed below */ }
    const providers = Array.isArray(report?.gates) ? report.gates.filter((gate) => gate.id === "openai_provider") : [];
    const gateways = Array.isArray(report?.gates) ? report.gates.filter((gate) => gate.id === "openai_us_egress_gateway") : [];
    const provider = providers[0];
    const gateway = gateways[0]?.details;
    const checkedAt = Date.parse(provider?.details?.checkedAt);
    if (response.status !== 200 || report?.tenantId !== tenantId ||
      report?.deployment?.commitSha !== recovery.previousHealthRevision ||
      report?.deployment?.environment !== "production" || report?.deployment?.region !== "sin1" ||
      providers.length !== 1 || gateways.length !== 1 || provider?.status !== "pass" ||
      provider?.details?.configured !== true || provider?.details?.reachable !== true ||
      gateway?.configured !== true || gateway?.safeConfiguration !== true || gateway?.serviceMatches !== true ||
      gateway?.regionMatches !== true || gateway?.protocolMatches !== true || gateway?.reachable !== true || gateway?.serving !== true ||
      typeof provider?.details?.checkedAt !== "string" ||
      !Number.isFinite(checkedAt) || checkedAt > Date.now() + 5_000) {
      throw new Error(`${label} did not prove the preserved primary through the exact original deployment.`);
    }
    if (checkedAt >= notBefore) {
      console.log(`${label} has fresh original-deployment provider proof; no gateway token was exported.`);
      return;
    }
    // Refreshing the expensive report cannot refresh the provider's inner
    // cache. Wait for that entry to expire before collecting another report.
    const cacheExpiryDelay = Math.max(1_000, checkedAt + 61_000 - Date.now());
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, cacheExpiryDelay, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`${label} provider proof stayed stale; the inner provider cache was not accepted as fresh evidence.`);
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

/**
 * A previous binary may not classify a newly migrated, fully protected table.
 * Preserve its blocked report, prove the exact separately authorized defects, and verify
 * the candidate's exact schema against the live migration connection before
 * either platform changes. Candidate smokes still use their ordinary gates.
 */
async function runForwardSchemaPriorCheck(pin, baseUrl, previousRevision, migrationDatabaseUrl) {
  const environment = {
    BASE_URL: baseUrl,
    SMOKE_EXPECTED_REVISION: previousRevision,
    SMOKE_REQUEST_TIMEOUT_MS: "60000",
  };
  await run("npm", ["run", "smoke:preflight"], { environment });

  const evidencePath = path.resolve(process.env.RELEASE_EVIDENCE_OUTPUT);
  await rm(evidencePath, { force: true });
  let priorSmokeFailed = false;
  try {
    await run("npm", ["run", "smoke:release", "--", "--previous-release"], {
      environment,
    });
  } catch {
    priorSmokeFailed = true;
  }
  if (!priorSmokeFailed) {
    fail("Forward-schema recovery was requested, but the previous release passed. Unset the recovery pin.");
  }

  let priorEvidenceRaw;
  let priorEvidence;
  try {
    priorEvidenceRaw = readFileSync(evidencePath, "utf8");
    if (Buffer.byteLength(priorEvidenceRaw) > 1_048_576) {
      throw new Error("Prior release evidence is above the bounded artifact limit.");
    }
    priorEvidence = JSON.parse(priorEvidenceRaw);
  } catch {
    fail("Forward-schema recovery requires the fresh bounded blocked prior-release evidence artifact.");
  }
  let prior;
  try {
    prior = validateForwardSchemaPriorArtifact(priorEvidence, pin, {
      baseUrl,
      previousRevision,
      errorBudgetException: process.env.OMNIAGENT_RELEASE_ERROR_BUDGET_EXCEPTION?.trim(),
      ownerBudgetOverride: readOwnerBudgetOverride(),
      now: Date.now(),
    });
  } catch (error) {
    fail(`Forward-schema recovery rejected the prior release: ${errorMessage(error)}`);
  }

  const verificationOutput = await capture("npm", ["run", "db:verify"], {
    echo: true,
    environment: { MIGRATION_DATABASE_URL: migrationDatabaseUrl },
  }).catch((error) =>
    fail(`Fresh candidate database verification failed: ${errorMessage(error)}`)
  );
  let database;
  try {
    database = validateForwardSchemaDatabaseVerification(
      verificationOutput,
      pin,
      { priorExpectedTables: prior.priorExpectedTables, now: Date.now() },
    );
  } catch (error) {
    fail(`Forward-schema recovery rejected candidate database verification: ${errorMessage(error)}`);
  }

  const recordRoot = evidencePath.slice(0, -".json".length);
  const priorPath = `${recordRoot}.forward-prior-blocked.json`;
  const admissionPath = `${recordRoot}.forward-schema-admission.json`;
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  await rm(priorPath, { force: true });
  await rm(admissionPath, { force: true });
  writeFileSync(priorPath, priorEvidenceRaw, { mode: 0o600 });
  writeFileSync(admissionPath, `${JSON.stringify({
    status: "admitted_prior_inventory_delta",
    admittedAt: new Date().toISOString(),
    previousRevision,
    candidateRevision: revision,
    migrationVersion: pin.migrationVersion,
    migrationChecksum: pin.migrationChecksum,
    unclassifiedTables: pin.unclassifiedTables,
    priorExpectedTables: prior.priorExpectedTables,
    priorEvidenceSha256: sha256(priorEvidenceRaw),
    ...(prior.ownerErrorBudgetOverride ? { ownerErrorBudgetOverride: prior.ownerErrorBudgetOverride } : {}),
    databaseVerification: database,
    databaseVerificationOutputSha256: sha256(verificationOutput),
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `Forward-schema recovery admitted the prior inventory delta at revision ${previousRevision}; ` +
    `fresh candidate database verification covers ${database.migrations} migrations and ${database.tenantTables} tenant tables.` +
    (prior.ownerErrorBudgetOverride?.applied ? " The separate exact-pair owner pin covers only the measured historical error budget; the original report remains blocked." : ""),
  );
}

async function runVerificationCommands(baseUrl) {
  if (ownerLiveVerification) {
    const environment = {
      BASE_URL: baseUrl,
      SMOKE_EXPECTED_REVISION: revision,
      SMOKE_REQUEST_TIMEOUT_MS: "300000",
    };
    await run("npm", ["run", "smoke:preflight"], { environment });
    await run("npm", ["run", "smoke:release"], { environment });
    return;
  }
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

async function runManifestVerification(baseUrl, releaseManifest, previousRevision) {
  await run("npm", ["run", "smoke:manifest"], {
    environment: {
      BASE_URL: baseUrl,
      SMOKE_EXPECTED_REVISION: revision,
      SMOKE_EXPECTED_MANIFEST_SHA256: createHash("sha256")
        .update(releaseManifest)
        .digest("hex"),
      SMOKE_MANIFEST_PREVIOUS_REVISION: previousRevision || "",
      SMOKE_MANIFEST_CONVERGENCE_TIMEOUT_MS: previousRevision
        ? String(readinessTimeoutMs)
        : "",
    },
  });
}

async function runPaidAgentVerification(baseUrl) {
  await run("npm", ["run", "smoke:paid-agent"], {
    environment: {
      BASE_URL: baseUrl,
      EXPECTED_REVISION: revision,
      LIVE_VERIFY_PAID_OPENAI: "CONFIRMED",
      SMOKE_PAID_AGENT_PASSWORD: paidAgentPassword,
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
  if (!ownerLiveVerification) await run("npm", ["run", "smoke:security"], { environment });
  await run("npm", ["run", "smoke:release"], { environment });
}

async function runRollbackVerification(
  baseUrl,
  expectedRevision,
  rollbackGateway,
  gatewayRevision = expectedRevision,
) {
  await waitForDeploymentReadiness(baseUrl, expectedRevision, {
    label: "Rollback web",
  });
  if (rollbackGateway) {
    await waitForOpenAIGatewayTokenPair(
      rollbackGateway,
      gatewayRevision,
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
  const probeUrl = new URL(
    `/v1/models/${GATEWAY_AUTHORIZATION_PROBE_ID}`,
    gateway.baseUrl.origin,
  );
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
  paidInferenceModel,
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
    serving: OPENAI_GATEWAY_SERVING_STATUSES.has(body?.status),
    serviceMatches: body?.service === OPENAI_GATEWAY_SERVICE,
    regionMatches: body?.region === OPENAI_GATEWAY_REGION,
    revisionMatches: body?.revision === expectedRevision,
    protocolMatches: body?.protocol === OPENAI_GATEWAY_PROTOCOL,
  };
}

function gatewayHealthObservationReady(observation) {
  return (
    observation.httpStatus === 200 &&
    observation.serving &&
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
    `serving=${observation.serving}`,
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

function printDryRunReleaseProvenance() {
  console.log(
    ownerLiveVerification
      ? `DRY RUN verify release provenance revision=${revision} is clean exact HEAD at ${RELEASE_REPOSITORY} ${RELEASE_BRANCH} tip; hosted checks are deferred, not passed`
      : `DRY RUN verify release provenance revision=${revision} is clean HEAD on ${RELEASE_REPOSITORY} ${RELEASE_BRANCH} with green checks ${REQUIRED_RELEASE_CHECKS.join(",")}`,
  );
}

function printDryRunReadinessWait(label, baseUrl, expectedRevision) {
  console.log(
    `DRY RUN wait for ${label} readiness at ${baseUrl}/api/health revision=${expectedRevision} timeout=${readinessTimeoutMs}ms`,
  );
}

function printDryRunGatewayPairReadiness(label, expectedRevision) {
  console.log(
    `DRY RUN wait for ${label} ${preserveGatewayPrimary ? "candidate token and fresh original-deployment provider proof" : "active+optional-previous token"} readiness at /healthz revision=${expectedRevision} region=${OPENAI_GATEWAY_REGION} protocol=${OPENAI_GATEWAY_PROTOCOL} timeout=${gatewayReadinessTimeoutMs}ms`,
  );
}

function printDryRunManifestVerification(baseUrl, previousRevision) {
  printDryRun("npm", ["run", "smoke:manifest"], {
    BASE_URL: baseUrl,
    SMOKE_EXPECTED_REVISION: revision,
    SMOKE_EXPECTED_MANIFEST_SHA256: "<signed-candidate-manifest-sha256>",
    ...(previousRevision && {
      SMOKE_MANIFEST_PREVIOUS_REVISION: previousRevision,
      SMOKE_MANIFEST_CONVERGENCE_TIMEOUT_MS: String(readinessTimeoutMs),
    }),
  });
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
  if (!ownerLiveVerification) printDryRun("npm", ["run", "smoke:security"], environment);
  printDryRun("npm", ["run", "smoke:release"], environment);
}

function printDryRunGatewayTokenStage(label) {
  console.log(
    `DRY RUN stage ${label}${preserveGatewayPrimary ? " secondary only; retain managed primary" : ""} on Fly through secret stdin; values redacted`,
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

function resolvePaidInferenceModel() {
  return normalizeModelIdentifier(
    process.env.OMNIAGENT_DEPLOY_OPENAI_SMOKE_MODEL ||
      process.env.OPENAI_FAST_MODEL ||
      process.env.OPENAI_AGENT_MODEL,
  );
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function printVerificationCommands(baseUrl) {
  if (ownerLiveVerification) {
    const environment = { BASE_URL: baseUrl, SMOKE_EXPECTED_REVISION: revision, SMOKE_REQUEST_TIMEOUT_MS: "300000" };
    printDryRun("npm", ["run", "smoke:preflight"], environment);
    printDryRun("npm", ["run", "smoke:release"], environment);
    return;
  }
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
      stdio: options.stdout ? ["ignore", "pipe", options.sensitive ? "ignore" : "inherit"] : "inherit",
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
          `${describeCommand(command, args)} failed with ${signal || `exit code ${code}`}.`,
        ),
      );
    });
  });
}

// A release manifest is long and public, so a failure names it, not its value.
function describeCommand(command, args) {
  const manifest = `${RELEASE_MANIFEST_ENV}=`;
  return [
    command,
    ...args.map((arg) => (arg.startsWith(manifest) ? `${manifest}<manifest>` : arg)),
  ].join(" ");
}

function runWithSensitiveStdin(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...options.environment },
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
