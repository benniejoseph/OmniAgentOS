#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import {
  failSmoke,
  getSmokeBaseUrl,
  positiveInteger,
  smokeFetch,
} from "./smoke-helpers.mjs";
import { evaluateDashboardReleaseGate } from "./benchmark-dashboard-gate.mjs";

const MAX_DASHBOARD_DOCUMENT_BYTES = 8 * 1024 * 1024;
const baseUrl = getSmokeBaseUrl();
const budgets = JSON.parse(
  await readFile(
    new URL("../performance-budgets.json", import.meta.url),
    "utf8",
  ),
);
const enforce = process.env.BENCHMARK_ENFORCE !== "false";
const requestedSamples = positiveInteger(
  process.env.BENCHMARK_DASHBOARD_SAMPLES ||
    process.env.BENCHMARK_BROWSER_SAMPLES,
  20,
  200,
);
const samples = enforce ? Math.max(requestedSamples, 20) : requestedSamples;
const requestedWarmups = positiveInteger(
  process.env.BENCHMARK_DASHBOARD_WARMUPS ||
    process.env.BENCHMARK_BROWSER_WARMUPS,
  2,
  20,
);
if (enforce && requestedWarmups !== 2) {
  failSmoke("enforced dashboard benchmarks require exactly two warmups.");
}
const warmups = Math.max(requestedWarmups, 2);

const email =
  process.env.BENCHMARK_EMAIL ||
  process.env.SMOKE_ADMIN_EMAIL ||
  process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
const password =
  process.env.BENCHMARK_PASSWORD ||
  process.env.SMOKE_ADMIN_PASSWORD ||
  process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
const internalSecret =
  process.env.SMOKE_INTERNAL_AUTH_SECRET ||
  process.env.OMNIAGENT_INTERNAL_AUTH_SECRET;
const internalHeaders = internalSecret
  ? {
      "x-omni-internal-auth": internalSecret,
      "x-omni-synthetic-auth": internalSecret,
      "x-omni-synthetic-source": "production-benchmark",
      "x-omni-slo-excluded": "true",
      "x-omni-tenant-id":
        process.env.SMOKE_TENANT_ID || "production_smoke",
      "x-omni-user-id": process.env.SMOKE_ACTOR_ID || "production-smoke",
      "x-omni-user-role": "admin",
    }
  : undefined;
const reusableCookie = await readSessionCookie();
const cookie =
  reusableCookie ||
  (email && password ? await signIn(email, password) : undefined);

if (!cookie && !internalHeaders) {
  failSmoke(
    "dashboard benchmark requires a reusable session, administrator credentials, or the internal smoke secret.",
  );
}

const requestHeaders = {
  accept: "text/html",
  ...(internalHeaders || {}),
  ...(cookie ? { cookie } : {}),
};
const firstLoad = await measureDashboardDocument();
let recoveryLoad;
for (let index = 1; index < warmups; index += 1) {
  const warmup = await measureDashboardDocument();
  if (index === 1) {
    recoveryLoad = warmup;
  }
}
if (!recoveryLoad) {
  failSmoke("dashboard benchmark did not capture a recovery load.");
}

const measurements = [];
for (let index = 0; index < samples; index += 1) {
  measurements.push(await measureDashboardDocument());
}

const result = {
  name: "dashboard-ssr-ready",
  path: "/app",
  requestedSamples,
  requestedWarmups,
  enforced: enforce,
  measurementMode: "authenticated_ssr_document",
  ...evaluateDashboardReleaseGate({
    firstLoad,
    recoveryLoad,
    hotMeasurements: measurements,
    warmups,
    minimumSamples: enforce ? 20 : 1,
    budgets: {
      firstLoadTargetMs: budgets.releaseDashboardFirstLoadTargetMs,
      firstLoadMs: budgets.releaseDashboardFirstLoadMs,
      firstResponseMs: budgets.releaseDashboardFirstResponseMs,
      firstPostResponseReadyMs:
        budgets.releaseDashboardFirstPostResponseReadyMs,
      recoveryLoadMs: budgets.releaseDashboardRecoveryMs,
      hotP50Ms: budgets.dashboardUsableMs,
      hotP95Ms: budgets.releaseDashboardUsableMs,
      hotMaxMs: budgets.releaseDashboardMaxMs,
      documentP95Ms: budgets.releaseDashboardDocumentP95Ms,
    },
  }),
};

if (!result.firstLoadTargetMet && result.checks.firstLoad) {
  console.warn(
    `WARN ${result.name}: first document ${result.firstLoadMs}ms exceeded the ${result.budgets.firstLoadTargetMs}ms optimization target but remained within the ${result.budgets.firstLoadMs}ms release ceiling.`,
  );
}
console.log(
  `${result.passed ? "PASS" : "FAIL"} ${result.name}: n=${result.samples} warmups=${result.warmups} first=${result.firstLoadMs}ms/${result.budgets.firstLoadMs}ms (target ${result.budgets.firstLoadTargetMs}ms; response ${result.firstResponseMs}ms/${result.budgets.firstResponseMs}ms; body ${result.firstPostResponseReadyMs}ms/${result.budgets.firstPostResponseReadyMs}ms) recovery=${result.recoveryLoadMs}ms/${result.budgets.recoveryLoadMs}ms; hot p50=${result.p50Ms}ms/${result.budgets.hotP50Ms}ms p95=${result.p95Ms}ms/${result.budgets.hotP95Ms}ms max=${result.maxMs}ms/${result.budgets.hotMaxMs}ms; response p95=${result.documentP95Ms}ms/${result.budgets.documentP95Ms}ms; Server-Timing=${result.serverTiming.coverage} (${result.serverTiming.samples}/${result.samples})`,
);
console.log(JSON.stringify({
  event: "benchmark.dashboard.samples",
  measurementMode: result.measurementMode,
  requestedSamples: result.requestedSamples,
  samples: result.samples,
  minimumSamples: result.minimumSamples,
  requestedWarmups: result.requestedWarmups,
  warmups: result.warmups,
  firstLoad: result.firstLoad,
  recoveryLoad: result.recoveryLoad,
  hotDurationsMs: result.hotDurationsMs,
  documentDurationsMs: result.documentDurationsMs,
  serverDurationsMs: result.serverDurationsMs,
  budgets: result.budgets,
  checks: result.checks,
}));

const output = process.env.BENCHMARK_DASHBOARD_OUTPUT?.trim();
if (output) {
  await writeFile(
    output,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        baseUrl,
        revision: process.env.OMNIAGENT_RELEASE_SHA || undefined,
        result,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
if (enforce && !result.passed) {
  failSmoke("dashboard server-rendered document budget was exceeded.");
}

async function measureDashboardDocument() {
  const startedAt = performance.now();
  const response = await smokeFetch(baseUrl, "/app", {
    headers: requestHeaders,
  });
  const documentResponseMs = performance.now() - startedAt;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `dashboard document returned ${response.status} during dashboard benchmark.`,
    );
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("text/html")) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("dashboard benchmark expected an HTML document.");
  }
  const document = await readTextLimited(
    response,
    MAX_DASHBOARD_DOCUMENT_BYTES,
  );
  const durationMs = performance.now() - startedAt;
  validateServerRenderedDashboard(document);
  const serverTiming = response.headers.get("server-timing");
  return {
    durationMs,
    documentResponseMs,
    serverDurationMs: parseServerDuration(serverTiming),
    serverTiming: serverTiming || undefined,
  };
}

function validateServerRenderedDashboard(document) {
  if (
    !hasReadyWorkspaceOpeningTag(document) ||
    !/<h1(?:\s[^>]*)?>Today<\/h1>/.test(document)
  ) {
    throw new Error(
      "dashboard document did not contain the ready server-rendered Today workspace.",
    );
  }
}

function hasReadyWorkspaceOpeningTag(document) {
  const openingTags = document.matchAll(
    /<[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*?)?>/g,
  );
  for (const [tag] of openingTags) {
    if (
      /\bdata-testid\s*=\s*(["'])activity-workspace\1/i.test(tag) &&
      /\baria-busy\s*=\s*(["'])false\1/i.test(tag)
    ) {
      return true;
    }
  }
  return false;
}

async function readTextLimited(response, maximumBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("dashboard document exceeded its bounded response size.");
  }
  if (!response.body) {
    throw new Error("dashboard document returned no response body.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("dashboard document exceeded its bounded response size.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function signIn(loginEmail, loginPassword) {
  const response = await smokeFetch(baseUrl, "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: loginEmail, password: loginPassword }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    failSmoke(`dashboard benchmark login failed with status ${response.status}.`);
  }
  await response.body?.cancel().catch(() => undefined);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    failSmoke("dashboard benchmark login did not return a session cookie.");
  }
  return setCookie.split(";", 1)[0];
}

async function readSessionCookie() {
  const sessionFile = process.env.BENCHMARK_SESSION_FILE?.trim();
  if (!sessionFile) return undefined;
  let cookie;
  try {
    cookie = (await readFile(sessionFile, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (!/^[^=;\s]+=[^;\r\n]+$/.test(cookie)) {
    failSmoke("dashboard benchmark session file did not contain a valid cookie.");
  }
  return cookie;
}

function parseServerDuration(header) {
  const match = String(header || "").match(
    /(?:^|,)\s*total;dur=([0-9]+(?:\.[0-9]+)?)/i,
  );
  const duration = Number(match?.[1]);
  return Number.isFinite(duration) ? duration : undefined;
}
