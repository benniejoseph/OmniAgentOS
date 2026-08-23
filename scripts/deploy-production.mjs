#!/usr/bin/env node

import { spawn } from "node:child_process";

const VERCEL_ORG_ID = "team_hFIwf5wwfzIn2I1WDZwY8pAv";
const VERCEL_PROJECT_ID = "prj_BF3Uy9PhUUitqFAeA0g0LafaL4co";
const dryRun = process.argv.includes("--dry-run");
const flyApp = process.env.FLY_APP?.trim() || "omniagent-os-worker";
const revision =
  process.env.OMNIAGENT_RELEASE_SHA?.trim() ||
  await capture("git", ["rev-parse", "HEAD"]);
const vercelEnvironment = {
  VERCEL_ORG_ID,
  VERCEL_PROJECT_ID,
};
const smokeEnvironment = {
  SMOKE_EXPECTED_REVISION: revision,
  BENCHMARK_ENFORCE: "true",
  OMNIAGENT_RELEASE_SHA: revision,
};

if (dryRun) {
  printDryRun(
    "npm",
    ["run", "smoke:release"],
    { BASE_URL: "https://production.example" },
  );
  printDryRun("npm", ["run", "verify"]);
  printDryRun(
    "vercel",
    ["deploy", "--prod", "--skip-domain", "--yes"],
    vercelEnvironment,
  );
  const staged = "https://staged-deployment.example";
  printDryRun("fly", workerDeployArgs(staged));
  printVerificationCommands(staged);
  printDryRun("vercel", ["promote", staged, "--yes"], vercelEnvironment);
  printDryRun(
    "npm",
    ["run", "smoke:preflight"],
    {
      ...smokeEnvironment,
      BASE_URL: "https://production.example",
    },
  );
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

let workerMutationStarted = false;
let vercelPromoted = false;
try {
  await run("npm", ["run", "smoke:release"], {
    environment: { BASE_URL: productionBaseUrl },
  });
  await run("npm", ["run", "verify"]);
  const deploymentOutput = await capture(
    "vercel",
    ["deploy", "--prod", "--skip-domain", "--yes"],
    { environment: vercelEnvironment, echo: true },
  );
  const stagedBaseUrl = deploymentUrlFromOutput(deploymentOutput);
  workerMutationStarted = true;
  await run("fly", workerDeployArgs(stagedBaseUrl));
  await runVerificationCommands(stagedBaseUrl);

  await run(
    "vercel",
    ["promote", stagedBaseUrl, "--yes"],
    { environment: vercelEnvironment },
  );
  vercelPromoted = true;
  await run("npm", ["run", "smoke:preflight"], {
    environment: {
      ...smokeEnvironment,
      BASE_URL: productionBaseUrl,
    },
  });
} catch (error) {
  const rollbackErrors = [];
  if (vercelPromoted) {
    await run(
      "vercel",
      ["promote", previousVercelDeployment, "--yes"],
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
        "--yes",
      ],
    ).catch((rollbackError) => {
      rollbackErrors.push(`Fly rollback failed: ${errorMessage(rollbackError)}`);
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
  `Production release ${revision} passed staged smoke and performance budgets before promotion.`,
);

function validateReleaseConfiguration() {
  const required = [
    ["BASE_URL", process.env.BASE_URL],
    [
      "administrator email",
      process.env.SMOKE_ADMIN_EMAIL ||
        process.env.OMNIAGENT_BOOTSTRAP_EMAIL,
    ],
    [
      "administrator password",
      process.env.SMOKE_ADMIN_PASSWORD ||
        process.env.OMNIAGENT_BOOTSTRAP_PASSWORD,
    ],
    [
      "internal smoke secret",
      process.env.SMOKE_INTERNAL_AUTH_SECRET ||
        process.env.OMNIAGENT_INTERNAL_AUTH_SECRET,
    ],
    [
      "cron secret",
      process.env.SMOKE_CRON_SECRET || process.env.CRON_SECRET,
    ],
    ["RELEASE_EVIDENCE_OUTPUT", process.env.RELEASE_EVIDENCE_OUTPUT],
  ];
  const missing = required
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length) {
    fail(`Production release configuration is missing: ${missing.join(", ")}.`);
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
    ["inspect", productionBaseUrl, "--format=json"],
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

async function runVerificationCommands(baseUrl) {
  const environment = {
    ...smokeEnvironment,
    BASE_URL: baseUrl,
    SMOKE_DRIVE_BACKGROUND_QUEUE: "true",
    SMOKE_REQUEST_TIMEOUT_MS: "300000",
  };
  await run("npm", ["run", "test:production-smoke"], { environment });
  await run("npm", ["run", "benchmark:preview"], { environment });
  await run("npm", ["run", "benchmark:dashboard"], { environment });
}

function printVerificationCommands(baseUrl) {
  const environment = {
    ...smokeEnvironment,
    BASE_URL: baseUrl,
    SMOKE_DRIVE_BACKGROUND_QUEUE: "true",
    SMOKE_REQUEST_TIMEOUT_MS: "300000",
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
