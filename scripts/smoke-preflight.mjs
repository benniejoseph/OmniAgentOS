import { failSmoke, getSmokeBaseUrl, smokeFetch } from "./smoke-helpers.mjs";

const baseUrl = getSmokeBaseUrl();
const email = process.env.SMOKE_ADMIN_EMAIL || process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
const password = process.env.SMOKE_ADMIN_PASSWORD || process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
const internalSecret = process.env.SMOKE_INTERNAL_AUTH_SECRET || process.env.OMNIAGENT_INTERNAL_AUTH_SECRET;
const cronSecret = process.env.SMOKE_CRON_SECRET || process.env.CRON_SECRET;
const evidenceOutput = process.env.RELEASE_EVIDENCE_OUTPUT?.trim();
const expectedRevision = process.env.SMOKE_EXPECTED_REVISION?.trim();
const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(
  new URL(baseUrl).hostname,
);

const missing = [
  ["administrator email", email],
  ["administrator password", password],
  ["internal smoke secret", internalSecret],
  ["cron secret", cronSecret],
  ["release evidence output path", evidenceOutput],
  ...(!isLoopback ? [["expected deployment revision", expectedRevision]] : []),
].filter(([, value]) => !value).map(([label]) => label);

if (missing.length) {
  failSmoke(`production smoke preflight is missing: ${missing.join(", ")}.`);
}
if (!email.includes("@")) {
  failSmoke("production smoke administrator email is invalid.");
}

let health;
try {
  health = await smokeFetch(baseUrl, "/api/health");
} catch (error) {
  failSmoke(error instanceof Error ? error.message : "production health preflight failed.");
}

if (health.status !== 200) {
  failSmoke(`production health preflight expected 200, got ${health.status}.`);
}
const healthBody = await health.json().catch(() => ({}));
if (healthBody.status !== "healthy") {
  failSmoke(
    `production health preflight expected healthy, got ${String(healthBody.status || "missing")}.`,
  );
}
if (expectedRevision && healthBody.revision !== expectedRevision) {
  failSmoke(
    `deployment revision mismatch: expected ${expectedRevision}, got ${String(healthBody.revision || "missing")}.`,
  );
}

const cron = await smokeFetch(baseUrl, "/api/workflows/tick", {
  headers: {
    authorization: `Bearer ${cronSecret}`,
    "x-omni-synthetic-auth": internalSecret,
    "x-omni-synthetic-source":
      process.env.SMOKE_SYNTHETIC_SOURCE || "production-smoke",
    "x-omni-slo-excluded": "true",
    "x-omni-correlation-id": `production-smoke:cron:${process.env.SMOKE_RUN_ID || Date.now()}`,
  },
});
const cronBody = await cron.json().catch(() => ({}));
if (cron.status !== 200 || cronBody.trigger !== "vercel_cron") {
  failSmoke(
    `authenticated cron preflight failed with status ${cron.status}: ${String(cronBody.error || "unexpected response")}.`,
  );
}

console.log(
  `PASS production smoke preflight - ${baseUrl} is healthy at revision ${healthBody.revision || "local"} and cron authentication succeeded`,
);
