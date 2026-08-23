#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import {
  failSmoke,
  getSmokeBaseUrl,
  positiveInteger,
  smokeFetch,
} from "./smoke-helpers.mjs";

const baseUrl = getSmokeBaseUrl();
const budgets = JSON.parse(
  await readFile(
    new URL("../performance-budgets.json", import.meta.url),
    "utf8",
  ),
);
const samples = positiveInteger(process.env.BENCHMARK_SAMPLES, 20, 200);
const warmups = positiveInteger(process.env.BENCHMARK_WARMUPS, 3, 20);
const enforce = process.env.BENCHMARK_ENFORCE !== "false";
const email =
  process.env.BENCHMARK_EMAIL ||
  process.env.SMOKE_ADMIN_EMAIL ||
  process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
const password =
  process.env.BENCHMARK_PASSWORD ||
  process.env.SMOKE_ADMIN_PASSWORD ||
  process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;

const reusableCookie = await readSessionCookie();
const cookie =
  reusableCookie ||
  (email && password ? await signIn(email, password) : undefined);
const availableTargets = [
  {
    name: "landing",
    path: "/",
    p95BudgetMs: budgets.landingP95Ms,
  },
  {
    name: "health",
    path: "/api/health",
    p95BudgetMs: budgets.releaseApiP95Ms,
    serverP95BudgetMs: budgets.authenticatedReadP95Ms,
  },
  ...(cookie
    ? [
        {
          name: "session",
          path: "/api/auth/session",
          p95BudgetMs: budgets.releaseApiP95Ms,
          serverP95BudgetMs: budgets.sessionP95Ms,
          cookie,
        },
        {
          name: "workspace-summary",
          path: "/api/workspace-summary?limit=10&approvalLimit=10",
          p95BudgetMs: budgets.releaseApiP95Ms,
          serverP95BudgetMs: budgets.authenticatedReadP95Ms,
          cookie,
        },
      ]
    : []),
];
const selectedTargetNames = new Set(
  (process.env.BENCHMARK_TARGETS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const unknownTargets = [...selectedTargetNames].filter(
  (name) => !availableTargets.some((target) => target.name === name),
);
if (unknownTargets.length) {
  failSmoke(`unknown benchmark targets: ${unknownTargets.join(", ")}.`);
}
const targets = selectedTargetNames.size
  ? availableTargets.filter((target) => selectedTargetNames.has(target.name))
  : availableTargets;
if (!targets.length) {
  failSmoke("no benchmark targets are available with the supplied credentials.");
}

if (!cookie) {
  console.warn(
    "Benchmark credentials are absent; authenticated read budgets were skipped.",
  );
}

const results = [];
for (const target of targets) {
  for (let index = 0; index < warmups; index += 1) {
    await requestTarget(target);
  }
  const measurements = [];
  for (let index = 0; index < samples; index += 1) {
    measurements.push(await requestTarget(target));
  }
  const durations = measurements
    .map((measurement) => measurement.durationMs)
    .sort((left, right) => left - right);
  const serverDurations = measurements
    .map((measurement) => measurement.serverDurationMs)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const p95Ms = percentile(durations, 0.95);
  const serverP95Ms = serverDurations.length
    ? percentile(serverDurations, 0.95)
    : undefined;
  const serverPassed =
    target.serverP95BudgetMs === undefined ||
    (serverP95Ms !== undefined && serverP95Ms <= target.serverP95BudgetMs);
  const result = {
    name: target.name,
    path: target.path,
    samples,
    p50Ms: percentile(durations, 0.5),
    p95Ms,
    maxMs: Math.round(durations.at(-1) || 0),
    averageBytes: Math.round(
      measurements.reduce(
        (total, measurement) => total + measurement.bytes,
        0,
      ) / measurements.length,
    ),
    p95BudgetMs: target.p95BudgetMs,
    serverP95Ms,
    serverP95BudgetMs: target.serverP95BudgetMs,
    passed: p95Ms <= target.p95BudgetMs && serverPassed,
    latestServerTiming: measurements.at(-1)?.serverTiming,
  };
  results.push(result);
  console.log(
    `${result.passed ? "PASS" : "FAIL"} ${result.name}: p50=${result.p50Ms}ms p95=${result.p95Ms}ms budget=${result.p95BudgetMs}ms${
      result.serverP95BudgetMs === undefined
        ? ""
        : `; server p95=${result.serverP95Ms ?? "missing"}ms budget=${result.serverP95BudgetMs}ms`
    }`,
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  revision: process.env.OMNIAGENT_RELEASE_SHA || undefined,
  results,
};
const output = process.env.BENCHMARK_OUTPUT?.trim();
if (output) {
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (enforce && results.some((result) => !result.passed)) {
  failSmoke("preview performance budgets were exceeded.");
}

async function signIn(loginEmail, loginPassword) {
  const response = await smokeFetch(baseUrl, "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: loginEmail, password: loginPassword }),
  });
  if (!response.ok) {
    failSmoke(`benchmark login failed with status ${response.status}.`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    failSmoke("benchmark login did not return a session cookie.");
  }
  return setCookie.split(";", 1)[0];
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
    failSmoke("benchmark session file did not contain a valid cookie.");
  }
  return cookie;
}

async function requestTarget(target) {
  const startedAt = performance.now();
  const response = await smokeFetch(baseUrl, target.path, {
    headers: target.cookie ? { cookie: target.cookie } : undefined,
  });
  const body = await response.arrayBuffer();
  const durationMs = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(
      `${target.name} returned ${response.status} during preview benchmark.`,
    );
  }
  return {
    durationMs,
    bytes: body.byteLength,
    serverTiming: response.headers.get("server-timing") || undefined,
    serverDurationMs: parseServerDuration(
      response.headers.get("server-timing"),
    ),
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
