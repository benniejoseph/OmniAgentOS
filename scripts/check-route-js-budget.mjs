#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_STATS_FILE = fileURLToPath(
  new URL("../.next/diagnostics/route-bundle-stats.json", import.meta.url),
);

/**
 * Checks the JavaScript each route loads on a first visit against its budget.
 * The rows are the ones a Turbopack `next build` writes: uncompressed bytes,
 * the framework included. A workspace route is `/app` or one under it; every
 * other route has the public budget unless it has one of its own.
 */
export function evaluateRouteJsBudget(rows, budgets) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("The build reported no routes.");
  }
  const routes = rows.map((row, index) => {
    const route = row?.route;
    const bytes = row?.firstLoadUncompressedJsBytes;
    if (typeof route !== "string" || !route.startsWith("/")) {
      throw new Error(`Route ${index + 1} in the build report has no path.`);
    }
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error(`The build report has no JavaScript size for ${route}.`);
    }
    return { route, bytes };
  });
  const limits = normalizeBudgets(budgets);
  const known = new Set(routes.map(({ route }) => route));
  for (const route of Object.keys(limits.routeMaxBytes)) {
    if (!known.has(route)) {
      throw new Error(
        `The JavaScript budget for ${route} names a route the build does not have.`,
      );
    }
  }
  const measured = routes
    .map(({ route, bytes }) => {
      const limitBytes =
        limits.routeMaxBytes[route] ??
        (isWorkspaceRoute(route)
          ? limits.workspaceMaxBytes
          : limits.publicMaxBytes);
      return { route, bytes, limitBytes, overBytes: Math.max(0, bytes - limitBytes) };
    })
    .sort(
      (left, right) =>
        right.bytes - left.bytes || left.route.localeCompare(right.route),
    );
  const failures = measured
    .filter(({ overBytes }) => overBytes > 0)
    .map(
      ({ route, bytes, limitBytes, overBytes }) =>
        `${route} loads ${formatBytes(bytes)} bytes of JavaScript on a first visit, ${formatBytes(overBytes)} over its budget of ${formatBytes(limitBytes)}.`,
    );
  return { ok: failures.length === 0, routes: measured, failures };
}

function isWorkspaceRoute(route) {
  return route === "/app" || route.startsWith("/app/");
}

function normalizeBudgets(budgets) {
  const publicMaxBytes = positiveBytes(budgets?.publicMaxBytes, "publicMaxBytes");
  const workspaceMaxBytes = positiveBytes(
    budgets?.workspaceMaxBytes,
    "workspaceMaxBytes",
  );
  const overrides = budgets?.routeMaxBytes ?? {};
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("routeFirstLoadJs.routeMaxBytes must map routes to bytes.");
  }
  const routeMaxBytes = Object.fromEntries(
    Object.entries(overrides).map(([route, value]) => [
      route,
      positiveBytes(value, `routeMaxBytes["${route}"]`),
    ]),
  );
  return { publicMaxBytes, workspaceMaxBytes, routeMaxBytes };
}

function positiveBytes(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`routeFirstLoadJs.${name} must be a positive number of bytes.`);
  }
  return value;
}

function formatBytes(bytes) {
  return bytes.toLocaleString("en-US");
}

export function formatRouteJsSummary(result) {
  return [
    "### Route JavaScript on a first visit",
    "",
    "| Route | Bytes | Budget | |",
    "| --- | ---: | ---: | --- |",
    ...result.routes.map(
      ({ route, bytes, limitBytes, overBytes }) =>
        `| \`${route}\` | ${formatBytes(bytes)} | ${formatBytes(limitBytes)} | ${overBytes > 0 ? "over" : ""} |`,
    ),
    "",
  ].join("\n");
}

async function main() {
  const statsFile = process.argv[2] || DEFAULT_STATS_FILE;
  let rows;
  try {
    rows = JSON.parse(await readFile(statsFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `No route bundle report at ${statsFile}. Run \`next build\` with Turbopack first; it writes one.`,
      );
    }
    throw error;
  }
  const budgets = JSON.parse(
    await readFile(new URL("../performance-budgets.json", import.meta.url), "utf8"),
  );
  const result = evaluateRouteJsBudget(rows, budgets.routeFirstLoadJs);
  for (const { route, bytes, limitBytes } of result.routes) {
    console.log(
      `${route.padEnd(32)} ${formatBytes(bytes).padStart(11)} of ${formatBytes(limitBytes).padStart(11)}`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, formatRouteJsSummary(result));
  }
  if (!result.ok) {
    for (const failure of result.failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `PASS ${result.routes.length} routes load no more JavaScript than their budgets allow.`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(
      `FAIL ${error instanceof Error ? error.message : "the route JavaScript budget could not be checked."}`,
    );
    process.exitCode = 1;
  });
}
