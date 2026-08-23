#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  failSmoke,
  getSmokeBaseUrl,
  positiveInteger,
} from "./smoke-helpers.mjs";

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
if (!email || !password) {
  failSmoke(
    "dashboard benchmark requires BENCHMARK_EMAIL/BENCHMARK_PASSWORD or smoke administrator credentials.",
  );
}

const samples = positiveInteger(process.env.BENCHMARK_BROWSER_SAMPLES, 5, 20);
const warmups = positiveInteger(process.env.BENCHMARK_BROWSER_WARMUPS, 1, 5);
const enforce = process.env.BENCHMARK_ENFORCE !== "false";
const bypassSecret =
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    extraHTTPHeaders: bypassSecret
      ? {
          "x-vercel-protection-bypass": bypassSecret,
        }
      : undefined,
  });
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

  const page = await context.newPage();
  for (let index = 0; index < warmups; index += 1) {
    await measureDashboard(page);
  }
  const measurements = [];
  for (let index = 0; index < samples; index += 1) {
    measurements.push(await measureDashboard(page));
  }
  const durations = measurements
    .map((measurement) => measurement.durationMs)
    .sort((left, right) => left - right);
  const serverDurations = measurements
    .map((measurement) => measurement.serverDurationMs)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const result = {
    name: "dashboard-usable",
    path: "/app",
    samples,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: Math.round(durations.at(-1) || 0),
    budgetMs: budgets.releaseDashboardUsableMs,
    serverP95Ms: serverDurations.length
      ? percentile(serverDurations, 0.95)
      : undefined,
    serverP95BudgetMs: budgets.authenticatedReadP95Ms,
  };
  result.passed =
    result.p95Ms <= result.budgetMs &&
    result.serverP95Ms !== undefined &&
    result.serverP95Ms <= result.serverP95BudgetMs;
  console.log(
    `${result.passed ? "PASS" : "FAIL"} ${result.name}: p50=${result.p50Ms}ms p95=${result.p95Ms}ms budget=${result.budgetMs}ms; server p95=${result.serverP95Ms ?? "missing"}ms budget=${result.serverP95BudgetMs}ms`,
  );
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
  const summaryResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/workspace-summary" &&
      response.request().method() === "GET",
  );
  const startedAt = performance.now();
  await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  const response = await summaryResponse;
  if (!response.ok()) {
    throw new Error(
      `workspace summary returned ${response.status()} during dashboard benchmark.`,
    );
  }
  await page
    .getByRole("heading", { name: "Track every task in one place." })
    .waitFor({ state: "visible" });
  await page
    .getByRole("status", { name: "Loading runs" })
    .waitFor({ state: "hidden" });
  const serverTiming = await response.headerValue("server-timing");
  return {
    durationMs: performance.now() - startedAt,
    serverDurationMs: parseServerDuration(serverTiming),
    serverTiming: serverTiming || undefined,
  };
}

function parseServerDuration(header) {
  const match = String(header || "").match(
    /(?:^|,)\s*total;dur=([0-9]+(?:\.[0-9]+)?)/i,
  );
  const duration = Number(match?.[1]);
  return Number.isFinite(duration) ? duration : undefined;
}

function percentile(sorted, quantile) {
  if (!sorted.length) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return Math.round(sorted[index]);
}
