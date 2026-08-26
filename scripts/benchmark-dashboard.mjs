#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  failSmoke,
  getSmokeBaseUrl,
  positiveInteger,
} from "./smoke-helpers.mjs";
import { evaluateDashboardReleaseGate } from "./benchmark-dashboard-gate.mjs";

const baseUrl = getSmokeBaseUrl();
const budgets = JSON.parse(
  await readFile(
    new URL("../performance-budgets.json", import.meta.url),
    "utf8",
  ),
);
const email =
  process.env.BENCHMARK_EMAIL ||
  process.env.SMOKE_ADMIN_EMAIL ||
  process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
const password =
  process.env.BENCHMARK_PASSWORD ||
  process.env.SMOKE_ADMIN_PASSWORD ||
  process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
const internalSecret = process.env.SMOKE_INTERNAL_AUTH_SECRET || process.env.OMNIAGENT_INTERNAL_AUTH_SECRET;
const reusableCookie = await readSessionCookie();
if (!reusableCookie && (!email || !password) && !internalSecret) {
  failSmoke(
    "dashboard benchmark requires a reusable session or administrator credentials.",
  );
}

const enforce = process.env.BENCHMARK_ENFORCE !== "false";
const requestedSamples = positiveInteger(
  process.env.BENCHMARK_BROWSER_SAMPLES,
  20,
  200,
);
const samples = enforce ? Math.max(requestedSamples, 20) : requestedSamples;
const requestedWarmups = positiveInteger(
  process.env.BENCHMARK_BROWSER_WARMUPS,
  2,
  20,
);
if (enforce && requestedWarmups !== 2) {
  failSmoke("enforced dashboard benchmarks require exactly two warmups.");
}
const warmups = Math.max(requestedWarmups, 2);
const bypassSecret =
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    extraHTTPHeaders: {
      ...(bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {}),
      ...(internalSecret ? {
        "x-omni-internal-auth": internalSecret,
        "x-omni-synthetic-auth": internalSecret,
        "x-omni-synthetic-source": "production-benchmark",
        "x-omni-slo-excluded": "true",
        "x-omni-tenant-id": process.env.SMOKE_TENANT_ID || "production_smoke",
        "x-omni-user-id": process.env.SMOKE_ACTOR_ID || "production-smoke",
        "x-omni-user-role": "admin",
      } : {}),
    },
  });
  if (reusableCookie) {
    const separator = reusableCookie.indexOf("=");
    await context.addCookies([
      {
        name: reusableCookie.slice(0, separator),
        value: reusableCookie.slice(separator + 1),
        url: baseUrl,
      },
    ]);
  } else if (!internalSecret) {
    const login = await context.request.post(`${baseUrl}/api/auth/login`, {
      data: { email, password },
      headers: bypassSecret
        ? {
            "x-vercel-protection-bypass": bypassSecret,
          }
        : undefined,
    });
    if (!login.ok()) {
      failSmoke(`dashboard benchmark login failed with status ${login.status()}.`);
    }
  }

  const page = await context.newPage();
  const firstLoad = await measureDashboard(page);
  let recoveryLoad;
  for (let index = 1; index < warmups; index += 1) {
    const warmup = await measureDashboard(page);
    if (index === 1) {
      recoveryLoad = warmup;
    }
  }
  if (!recoveryLoad) {
    failSmoke("dashboard benchmark did not capture a recovery load.");
  }
  const measurements = [];
  for (let index = 0; index < samples; index += 1) {
    measurements.push(await measureDashboard(page));
  }
  const result = {
    name: "dashboard-usable",
    path: "/app",
    requestedSamples,
    requestedWarmups,
    enforced: enforce,
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
        // NavigationTiming includes client-to-edge transit and SSR. Keep this
        // distinct from the API Server-Timing processing budget.
        documentP95Ms: budgets.releaseDashboardDocumentP95Ms,
      },
    }),
  };
  if (!result.firstLoadTargetMet && result.checks.firstLoad) {
    console.warn(
      `WARN ${result.name}: first navigation ${result.firstLoadMs}ms exceeded the ${result.budgets.firstLoadTargetMs}ms optimization target but remained within the ${result.budgets.firstLoadMs}ms release ceiling.`,
    );
  }
  console.log(
    `${result.passed ? "PASS" : "FAIL"} ${result.name}: n=${result.samples} warmups=${result.warmups} first=${result.firstLoadMs}ms/${result.budgets.firstLoadMs}ms (target ${result.budgets.firstLoadTargetMs}ms; response ${result.firstResponseMs}ms/${result.budgets.firstResponseMs}ms; post-response-ready ${result.firstPostResponseReadyMs}ms/${result.budgets.firstPostResponseReadyMs}ms) recovery=${result.recoveryLoadMs}ms/${result.budgets.recoveryLoadMs}ms; hot p50=${result.p50Ms}ms/${result.budgets.hotP50Ms}ms p95=${result.p95Ms}ms/${result.budgets.hotP95Ms}ms max=${result.maxMs}ms/${result.budgets.hotMaxMs}ms; document p95=${result.documentP95Ms}ms/${result.budgets.documentP95Ms}ms; Server-Timing=${result.serverTiming.coverage} (${result.serverTiming.samples}/${result.samples})`,
  );
  console.log(JSON.stringify({
    event: "benchmark.dashboard.samples",
    requestedSamples: result.requestedSamples,
    samples: result.samples,
    minimumSamples: result.minimumSamples,
    requestedWarmups: result.requestedWarmups,
    warmups: result.warmups,
    firstLoad: result.firstLoad,
    firstLoadMs: result.firstLoadMs,
    firstLoadTargetMet: result.firstLoadTargetMet,
    firstResponseMs: result.firstResponseMs,
    firstPostResponseReadyMs: result.firstPostResponseReadyMs,
    recoveryLoad: result.recoveryLoad,
    recoveryLoadMs: result.recoveryLoadMs,
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
    failSmoke("dashboard usable-time budget was exceeded.");
  }
} finally {
  await browser.close();
}

async function measureDashboard(page) {
  const hydrationRequests = [];
  const captureHydrationRequest = (request) => {
    if (request.method() !== "GET") return;
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/today" || pathname === "/api/workspace-summary") {
      hydrationRequests.push(pathname);
    }
  };
  page.on("request", captureHydrationRequest);
  try {
    const startedAt = performance.now();
    const response = await page.goto(`${baseUrl}/app`, {
      waitUntil: "domcontentloaded",
    });
    if (!response?.ok()) {
      throw new Error(
        `dashboard document returned ${response?.status() ?? "no response"} during dashboard benchmark.`,
      );
    }
    await page
      .locator('[data-testid="activity-workspace"] h1')
      .waitFor({ state: "visible" });
    await page
      .locator('[data-testid="activity-workspace"][data-hydrated="true"][aria-busy="false"]')
      .waitFor({ state: "visible" });
    const durationMs = performance.now() - startedAt;
    const documentResponseMs = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      return navigation && Number.isFinite(navigation.responseStart)
        ? navigation.responseStart
        : null;
    });
    if (!Number.isFinite(documentResponseMs) || documentResponseMs <= 0) {
      throw new Error(
        "dashboard NavigationTiming responseStart was unavailable during dashboard benchmark.",
      );
    }
    await page.waitForLoadState("load");
    await page.waitForTimeout(250);
    if (hydrationRequests.length) {
      throw new Error(
        `dashboard performed duplicate hydration reads: ${[...new Set(hydrationRequests)].join(", ")}.`,
      );
    }
    const serverTiming = await response.headerValue("server-timing");
    return {
      durationMs,
      documentResponseMs,
      serverDurationMs: parseServerDuration(serverTiming),
      serverTiming: serverTiming || undefined,
    };
  } finally {
    page.off("request", captureHydrationRequest);
  }
}

async function readSessionCookie() {
  const sessionFile = process.env.BENCHMARK_SESSION_FILE?.trim();
  if (!sessionFile) {
    return undefined;
  }
  let cookie;
  try {
    cookie = (await readFile(sessionFile, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
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
