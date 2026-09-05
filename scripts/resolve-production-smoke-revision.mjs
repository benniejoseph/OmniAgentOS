import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  getSmokeBaseUrl,
  smokeFetch,
} from "./smoke-helpers.mjs";

const EXACT_GIT_REVISION = /^[a-f0-9]{40}$/;

export function parseExactGitRevision(value, label = "revision") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!EXACT_GIT_REVISION.test(normalized)) {
    throw new Error(`${label} must be an exact 40-character lowercase Git SHA.`);
  }
  return normalized;
}

export async function resolveProductionSmokeRevision({
  baseUrl,
  requestedRevision = undefined,
  fetchHealth = defaultFetchHealth,
}) {
  if (String(requestedRevision || "").trim()) {
    return {
      revision: parseExactGitRevision(requestedRevision, "requested revision"),
      source: "workflow_input",
    };
  }

  const health = await fetchHealth(baseUrl);
  if (!health || health.status !== "healthy") {
    throw new Error("production health did not report healthy while resolving its revision.");
  }
  return {
    revision: parseExactGitRevision(health.revision, "production health revision"),
    source: "production_health",
  };
}

async function defaultFetchHealth(baseUrl) {
  const response = await smokeFetch(baseUrl, "/api/health", {
    retryTransport: true,
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`production health returned HTTP ${response.status} while resolving its revision.`);
  }
  return response.json().catch(() => {
    throw new Error("production health returned invalid JSON while resolving its revision.");
  });
}

async function main() {
  const baseUrl = getSmokeBaseUrl();
  const resolved = await resolveProductionSmokeRevision({
    baseUrl,
    requestedRevision: process.env.REQUESTED_SMOKE_REVISION,
  });
  const environmentFile = process.env.GITHUB_ENV?.trim();
  if (!environmentFile) {
    throw new Error("GITHUB_ENV is required to publish the resolved smoke revision.");
  }
  await appendFile(
    environmentFile,
    `SMOKE_EXPECTED_REVISION=${resolved.revision}\n`,
    { encoding: "utf8" },
  );
  console.log(
    `Resolved production smoke revision ${resolved.revision} from ${resolved.source}.`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : "production revision resolution failed."}`);
    process.exitCode = 1;
  });
}
