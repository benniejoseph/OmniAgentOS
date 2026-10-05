#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { failSmoke, getSmokeBaseUrl, smokeFetch } from "./smoke-helpers.mjs";
import {
  RELEASE_SIGNING_PUBLIC_KEYS,
  verifyReleaseManifest,
} from "./release-manifest.mjs";

/**
 * Judges a deployment's health body: it must serve the expected revision and
 * a manifest that a trusted key signed for that same revision.
 * @param {unknown} health
 * @param {string} expectedRevision
 * @param {{ publicKeys?: readonly string[]; expectedManifestSha256?: string }} [options]
 */
export function assessReleaseManifestHealth(
  health,
  expectedRevision,
  { publicKeys = RELEASE_SIGNING_PUBLIC_KEYS, expectedManifestSha256 } = {},
) {
  const body = /** @type {{ revision?: unknown; releaseManifest?: unknown }} */ (
    health && typeof health === "object" ? health : {}
  );
  if (body.revision !== expectedRevision) {
    throw new Error(
      `deployment revision mismatch: expected ${expectedRevision}, got ${typeof body.revision === "string" ? body.revision.slice(0, 80) : "missing"}.`,
    );
  }
  const result = verifyReleaseManifest(body.releaseManifest, { publicKeys });
  if (!result.valid) {
    throw new Error(`the deployment's release manifest ${result.error}.`);
  }
  if (result.manifest.revision !== expectedRevision) {
    throw new Error(
      `the release manifest signs ${result.manifest.revision}, but the deployment serves ${expectedRevision}.`,
    );
  }
  if (
    expectedManifestSha256 &&
    createHash("sha256").update(body.releaseManifest).digest("hex") !== expectedManifestSha256
  ) {
    throw new Error("the release manifest differs from the runner's signed candidate.");
  }
  return result;
}

/**
 * A custom domain may briefly route alternating requests to the old and new
 * deployment after promotion. Accept only the signed prior release as a
 * transient response, and require consecutive healthy, signed candidate
 * responses before the production runner changes the worker's target.
 */
export async function waitForReleaseManifestConvergence({
  baseUrl,
  expectedRevision,
  previousRevision,
  timeoutMs,
  pollIntervalMs = 2_000,
  requiredMatches = 3,
  expectedManifestSha256,
  publicKeys = RELEASE_SIGNING_PUBLIC_KEYS,
  fetchHealth = smokeFetch,
}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let consecutiveMatches = 0;
  let lastObservation = "no health response";

  while (Date.now() < deadline) {
    attempts += 1;
    let response;
    try {
      response = await fetchHealth(baseUrl, "/api/health", {
        cache: "no-store",
        retryTransport: true,
        timeoutMs: Math.min(15_000, Math.max(1, deadline - Date.now())),
      });
    } catch {
      consecutiveMatches = 0;
      lastObservation = "health request failed";
    }

    if (response) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`release manifest access was denied with HTTP ${response.status}.`);
      }
      if (response.status !== 200 && response.status !== 503) {
        consecutiveMatches = 0;
        lastObservation = `HTTP ${response.status}`;
      } else {
        const health = await response.json().catch(() => undefined);
        const revision =
          health && typeof health === "object" ? health.revision : undefined;
        if (revision === previousRevision) {
          // A stale response is tolerated only when it is the same signed
          // release that was verified before promotion.
          assessReleaseManifestHealth(health, previousRevision, { publicKeys });
          if (response.status !== 200 || health.status !== "healthy") {
            throw new Error("the previous deployment returned unhealthy release evidence.");
          }
          consecutiveMatches = 0;
          lastObservation = "signed previous revision";
        } else if (revision === expectedRevision) {
          const verified = assessReleaseManifestHealth(health, expectedRevision, {
            publicKeys,
            expectedManifestSha256,
          });
          if (response.status === 200 && health.status === "healthy") {
            consecutiveMatches += 1;
            lastObservation = `${consecutiveMatches}/${requiredMatches} signed candidate observations`;
            if (consecutiveMatches >= requiredMatches) {
              return { ...verified, attempts, consecutiveMatches };
            }
          } else {
            consecutiveMatches = 0;
            lastObservation = "signed candidate is not healthy";
          }
        } else if (response.status === 503 && revision === undefined) {
          consecutiveMatches = 0;
          lastObservation = "HTTP 503 without a release revision";
        } else {
          throw new Error("the canonical domain served an unexpected release revision.");
        }
      }
    }

    const delayMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    `the canonical release manifest did not converge on ${expectedRevision} within ${timeoutMs}ms after ${attempts} attempt(s); last observation: ${lastObservation}.`,
  );
}

async function main() {
  const baseUrl = getSmokeBaseUrl();
  const expectedRevision = process.env.SMOKE_EXPECTED_REVISION?.trim();
  if (!expectedRevision) {
    failSmoke("the release manifest check needs SMOKE_EXPECTED_REVISION.");
  }
  const expectedManifestSha256 = process.env.SMOKE_EXPECTED_MANIFEST_SHA256?.trim();
  if (expectedManifestSha256 && !/^[0-9a-f]{64}$/.test(expectedManifestSha256)) {
    failSmoke("SMOKE_EXPECTED_MANIFEST_SHA256 must be a lowercase SHA-256 digest.");
  }
  const convergenceTimeout = process.env.SMOKE_MANIFEST_CONVERGENCE_TIMEOUT_MS?.trim();
  if (convergenceTimeout) {
    const timeoutMs = Number(convergenceTimeout);
    const previousRevision = process.env.SMOKE_MANIFEST_PREVIOUS_REVISION?.trim();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
      failSmoke("SMOKE_MANIFEST_CONVERGENCE_TIMEOUT_MS must be between 1000 and 300000 milliseconds.");
    }
    if (!/^[0-9a-f]{40}$/.test(previousRevision || "") || previousRevision === expectedRevision) {
      failSmoke("SMOKE_MANIFEST_PREVIOUS_REVISION must identify the distinct previous release.");
    }
    try {
      const { keyId, manifest, attempts, consecutiveMatches } =
        await waitForReleaseManifestConvergence({
          baseUrl,
          expectedRevision,
          previousRevision,
          timeoutMs,
          expectedManifestSha256,
        });
      console.log(
        `PASS release manifest: key ${keyId} signed ${manifest.revision} at ${manifest.signedAt} after ${attempts} canonical observations (${consecutiveMatches} consecutive); green checks ${manifest.checks.join(", ")}.`,
      );
    } catch (error) {
      failSmoke(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  let response;
  try {
    response = await smokeFetch(baseUrl, "/api/health", { retryTransport: true });
  } catch (error) {
    failSmoke(error instanceof Error ? error.message : "the health request failed.");
  }
  // An unhealthy deployment still says what it runs; its health is the
  // preflight's to judge.
  if (response.status !== 200 && response.status !== 503) {
    failSmoke(`the release manifest check expected health, got HTTP ${response.status}.`);
  }
  const health = await response.json().catch(() => undefined);
  try {
    const { keyId, manifest } = assessReleaseManifestHealth(health, expectedRevision, {
      expectedManifestSha256,
    });
    console.log(
      `PASS release manifest: key ${keyId} signed ${manifest.revision} at ${manifest.signedAt} with green checks ${manifest.checks.join(", ")}.`,
    );
  } catch (error) {
    failSmoke(error instanceof Error ? error.message : String(error));
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
