import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const RELEASE_REPOSITORY = "benniejoseph/OmniAgentOS";
export const RELEASE_BRANCH = "main";
// GitHub Actions jobs that must pass on the exact release commit. Path-filtered
// jobs such as the Native workflow are judged only when they ran.
export const REQUIRED_RELEASE_CHECKS = Object.freeze([
  "quality",
  "build",
  "audit",
  "integration",
  "worker",
  "gitleaks",
]);
// The scheduled production smoke verifies whichever deployment is served, so its
// result describes production rather than the commit it happens to run on.
const DEPLOYMENT_SCOPED_CHECKS = new Set(["production-smoke"]);
const PASSING_OPTIONAL_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const EXACT_GIT_REVISION = /^[a-f0-9]{40}$/;
const GITHUB_CLI_TIMEOUT_MS = 30_000;
const GITHUB_CLI_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function parseExactGitRevision(value, label = "revision") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!EXACT_GIT_REVISION.test(normalized)) {
    throw new Error(`${label} must be an exact 40-character lowercase Git SHA.`);
  }
  return normalized;
}

/**
 * Proves a release commit is on the release branch of the canonical repository
 * and that its GitHub Actions checks are green. GitHub is the source of truth,
 * so an unpushed commit or a local remote pointing elsewhere cannot pass.
 *
 * @param {{
 *   revision: string;
 *   readGitHub?: (endpoint: string, options?: { jq?: string }) => Promise<unknown>;
 * }} input
 */
export async function verifyReleaseProvenance({
  revision,
  readGitHub = readGitHubWithCli,
}) {
  const sha = parseExactGitRevision(revision, "release revision");
  const comparison = await readGitHub(
    `repos/${RELEASE_REPOSITORY}/compare/${RELEASE_BRANCH}...${sha}`,
    { jq: "{status, ahead_by, behind_by}" },
  );
  const { behindBy } = assessReleaseComparison(comparison, sha);
  const checkRuns = await readGitHub(
    `repos/${RELEASE_REPOSITORY}/commits/${sha}/check-runs?filter=latest&per_page=100`,
  );
  const checks = assessReleaseCheckRuns(checkRuns, sha);
  return { revision: sha, behindBy, checks };
}

export function assessReleaseComparison(comparison, revision) {
  const status = comparison?.status;
  // compare/main...sha is "behind" when sha is an ancestor of main.
  if ((status !== "identical" && status !== "behind") || comparison.ahead_by !== 0) {
    throw new Error(
      `Release ${revision} is not on ${RELEASE_REPOSITORY} ${RELEASE_BRANCH} (GitHub compare status ${safeLabel(status)}). Merge it to ${RELEASE_BRANCH} and release that commit.`,
    );
  }
  return {
    behindBy: Number.isInteger(comparison.behind_by) ? comparison.behind_by : 0,
  };
}

export function assessReleaseCheckRuns(payload, revision) {
  const checkRuns = payload?.check_runs;
  if (!Array.isArray(checkRuns) || !Number.isInteger(payload.total_count)) {
    throw new Error(`GitHub returned an unreadable check-run list for ${revision}.`);
  }
  if (payload.total_count > checkRuns.length) {
    throw new Error(
      `GitHub reported ${payload.total_count} check runs for ${revision} but returned ${checkRuns.length}; refusing to judge a partial list.`,
    );
  }
  const latest = new Map();
  for (const checkRun of checkRuns) {
    // Only GitHub Actions runs for this exact commit count, so another app
    // cannot satisfy a required job name.
    if (
      checkRun?.app?.slug !== "github-actions" ||
      checkRun.head_sha !== revision ||
      typeof checkRun.name !== "string" ||
      !Number.isInteger(checkRun.id)
    ) {
      continue;
    }
    const current = latest.get(checkRun.name);
    if (!current || checkRun.id > current.id) {
      latest.set(checkRun.name, checkRun);
    }
  }
  const problems = [];
  for (const name of REQUIRED_RELEASE_CHECKS) {
    const checkRun = latest.get(name);
    if (!checkRun) {
      problems.push(`${name} has not run`);
    } else if (
      checkRun.status !== "completed" ||
      checkRun.conclusion !== "success"
    ) {
      problems.push(`${name} is ${describeCheckRun(checkRun)}`);
    }
  }
  for (const [name, checkRun] of latest) {
    if (
      REQUIRED_RELEASE_CHECKS.includes(name) ||
      DEPLOYMENT_SCOPED_CHECKS.has(name)
    ) {
      continue;
    }
    if (
      checkRun.status !== "completed" ||
      !PASSING_OPTIONAL_CONCLUSIONS.has(checkRun.conclusion)
    ) {
      problems.push(`${safeLabel(name)} is ${describeCheckRun(checkRun)}`);
    }
  }
  if (problems.length) {
    throw new Error(
      `Release ${revision} does not have green CI: ${problems.join("; ")}. Wait for or fix the ${RELEASE_BRANCH} checks before releasing.`,
    );
  }
  return [...latest.keys()]
    .filter((name) => !DEPLOYMENT_SCOPED_CHECKS.has(name))
    .sort();
}

export function readGitHubWithCli(endpoint, { jq } = {}) {
  const args = ["api", "--hostname", "github.com", "--method", "GET", endpoint];
  if (jq) {
    args.push("--jq", jq);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const child = spawn("gh", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GITHUB_CLI_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > GITHUB_CLI_MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error(`gh api ${endpoint} returned more output than allowed.`));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    child.once("error", (error) => {
      finish(
        new Error(
          `The GitHub CLI is required to verify release provenance (${error.message}). Install gh and run \`gh auth login\`.`,
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (code !== 0) {
        finish(
          new Error(
            `gh api ${endpoint} failed with ${signal || `exit code ${code}`}: ${safeLabel(stderr)}. Authenticate with \`gh auth login\` or GH_TOKEN for read access to ${RELEASE_REPOSITORY}.`,
          ),
        );
        return;
      }
      try {
        finish(undefined, JSON.parse(stdout));
      } catch {
        finish(new Error(`gh api ${endpoint} returned invalid JSON.`));
      }
    });
  });
}

function describeCheckRun(checkRun) {
  return safeLabel(
    checkRun.status === "completed" ? checkRun.conclusion : checkRun.status,
  );
}

function safeLabel(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300) || "unknown";
}

async function main() {
  const provenance = await verifyReleaseProvenance({
    revision: process.env.RELEASE_REVISION,
  });
  const position = provenance.behindBy
    ? `${provenance.behindBy} commits behind ${RELEASE_BRANCH}`
    : `the tip of ${RELEASE_BRANCH}`;
  console.log(
    `PASS release ${provenance.revision} is ${position} on ${RELEASE_REPOSITORY} with green checks: ${provenance.checks.join(", ")}.`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(
      `FAIL ${error instanceof Error ? error.message : "release provenance verification failed."}`,
    );
    process.exitCode = 1;
  });
}
