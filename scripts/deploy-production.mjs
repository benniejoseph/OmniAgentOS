#!/usr/bin/env node

import { spawn } from "node:child_process";
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

const VERCEL_ORG_ID = "team_hFIwf5wwfzIn2I1WDZwY8pAv";
const VERCEL_PROJECT_ID = "prj_BF3Uy9PhUUitqFAeA0g0LafaL4co";
const VERCEL_SCOPE = "benniejosephs-projects";
const dryRun = process.argv.includes("--dry-run");
const readinessProbeIndex = process.argv.indexOf("--readiness-probe");
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

if (dryRun) {
  printDryRun(
    "npm",
    ["run", "smoke:release"],
    { BASE_URL: "https://production.example" },
  );
  printDryRun("npm", ["run", "verify"]);
  printDryRun(
    "vercel",
    ["deploy", "--prod", "--skip-domain", "--yes", "--scope", VERCEL_SCOPE],
    vercelEnvironment,
  );
  const staged = "https://staged-deployment.example";
  printDryRunReadinessWait("staged web", staged, revision);
  printDryRun("fly", workerDeployArgs(staged));
  printDryRunWorkerStartupWait("staged worker");
  printVerificationCommands(staged);
  printDryRun(
    "vercel",
    ["promote", staged, "--yes", "--scope", VERCEL_SCOPE],
    vercelEnvironment,
  );
  printDryRunReadinessWait(
    "canonical web",
    "https://production.example",
    revision,
  );
  printDryRun(
    "fly",
    workerImageDeployArgs(
      "registry.fly.io/omniagent-os-worker:staged",
      "https://production.example",
    ),
  );
  printDryRunWorkerStartupWait("canonical worker");
  printVerificationCommands("https://production.example");
  process.exit(0);
}

const productionBaseUrl = validateReleaseConfiguration();
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
  await run("fly", workerDeployArgs(stagedBaseUrl));
  const stagedWorkerImage = await getCurrentWorkerImage();
  await waitForWorkerStartupWindow("Staged worker");
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
  await run(
    "fly",
    workerImageDeployArgs(stagedWorkerImage, productionBaseUrl),
  );
  await waitForWorkerStartupWindow("Canonical worker");
  await runVerificationCommands(productionBaseUrl);
} catch (error) {
  const rollbackErrors = [];
  if (vercelPromoted) {
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
  }
  if (workerMutationStarted) {
    await run(
      "fly",
      [
        "deploy",
        "--app",
        flyApp,
        "--image",
        previousWorkerImage,
        "--env",
        `OMNIAGENT_WORKER_BASE_URL=${productionBaseUrl}`,
        "--yes",
      ],
    ).catch((rollbackError) => {
      rollbackErrors.push(`Fly rollback failed: ${errorMessage(rollbackError)}`);
    });
  }
  if (!rollbackErrors.length && (vercelPromoted || workerMutationStarted)) {
    await runRollbackVerification(
      productionBaseUrl,
      previousHealthRevision,
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
  `Production release ${revision} passed canonical smoke and performance budgets with rollback protection.`,
);

function validateReleaseConfiguration() {
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
  let url;
  try {
    url = new URL(process.env.BASE_URL);
  } catch {
    fail("BASE_URL must be a valid absolute production URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    fail("BASE_URL must be an HTTPS URL without embedded credentials.");
  }
  if (url.search || url.hash) {
    fail("BASE_URL must not contain a query string or fragment.");
  }
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
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function workerDeployArgs(baseUrl) {
  return [
    "deploy",
    "--app",
    flyApp,
    "--build-arg",
    `OMNIAGENT_RELEASE_SHA=${revision}`,
    ...(baseUrl
      ? ["--env", `OMNIAGENT_WORKER_BASE_URL=${baseUrl}`]
      : []),
    "--yes",
  ];
}

function workerImageDeployArgs(image, baseUrl) {
  return [
    "deploy",
    "--app",
    flyApp,
    "--image",
    image,
    "--env",
    `OMNIAGENT_WORKER_BASE_URL=${baseUrl}`,
    "--yes",
  ];
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
  const release = releases?.find((candidate) => {
    const image =
      candidate?.imageRef || candidate?.image_ref || candidate?.ImageRef;
    return image && String(candidate.status || "").toLowerCase() !== "failed";
  });
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

async function runRollbackVerification(baseUrl, expectedRevision) {
  await waitForDeploymentReadiness(baseUrl, expectedRevision, {
    label: "Rollback web",
  });
  await run("npm", ["run", "smoke:preflight"], {
    environment: {
      BASE_URL: baseUrl,
      SMOKE_EXPECTED_REVISION: expectedRevision,
      SMOKE_REQUEST_TIMEOUT_MS: "300000",
    },
  });
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

function printDryRunWorkerStartupWait(label) {
  console.log(
    `DRY RUN wait for ${label} startup registration window ${workerStartupSettleMs}ms`,
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
  if (url.protocol !== "https:") {
    throw new Error("Vercel deployment URL must use HTTPS.");
  }
  return url.toString().replace(/\/+$/, "");
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
