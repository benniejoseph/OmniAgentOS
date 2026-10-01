#!/usr/bin/env node

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
 * @param {{ publicKeys?: readonly string[] }} [options]
 */
export function assessReleaseManifestHealth(
  health,
  expectedRevision,
  { publicKeys = RELEASE_SIGNING_PUBLIC_KEYS } = {},
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
  return result;
}

async function main() {
  const baseUrl = getSmokeBaseUrl();
  const expectedRevision = process.env.SMOKE_EXPECTED_REVISION?.trim();
  if (!expectedRevision) {
    failSmoke("the release manifest check needs SMOKE_EXPECTED_REVISION.");
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
    const { keyId, manifest } = assessReleaseManifestHealth(health, expectedRevision);
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
