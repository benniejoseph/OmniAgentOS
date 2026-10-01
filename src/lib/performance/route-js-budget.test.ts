import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateRouteJsBudget,
  formatRouteJsSummary,
} from "../../../scripts/check-route-js-budget.mjs";
import budgets from "../../../performance-budgets.json";

const limits = {
  publicMaxBytes: 500_000,
  workspaceMaxBytes: 800_000,
  routeMaxBytes: { "/app/agents": 1_100_000 },
};

function row(route: string, bytes: unknown) {
  return { route, firstLoadUncompressedJsBytes: bytes, firstLoadChunkPaths: [] };
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the route JavaScript budget", () => {
  it("holds each route to its own, the workspace, or the public budget", () => {
    const result = evaluateRouteJsBudget(
      [
        row("/", 500_000),
        row("/appendix", 500_001),
        row("/app", 800_000),
        row("/app/settings", 800_001),
        row("/app/agents", 1_000_000),
      ],
      limits,
    );

    expect(result.routes).toEqual([
      { route: "/app/agents", bytes: 1_000_000, limitBytes: 1_100_000, overBytes: 0 },
      { route: "/app/settings", bytes: 800_001, limitBytes: 800_000, overBytes: 1 },
      { route: "/app", bytes: 800_000, limitBytes: 800_000, overBytes: 0 },
      { route: "/appendix", bytes: 500_001, limitBytes: 500_000, overBytes: 1 },
      { route: "/", bytes: 500_000, limitBytes: 500_000, overBytes: 0 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      "/app/settings loads 800,001 bytes of JavaScript on a first visit, 1 over its budget of 800,000.",
      "/appendix loads 500,001 bytes of JavaScript on a first visit, 1 over its budget of 500,000.",
    ]);
    expect(evaluateRouteJsBudget([row("/app/agents", 1_100_000)], limits).ok).toBe(true);
  });

  it("refuses a report or a budget it cannot check against", () => {
    expect(() => evaluateRouteJsBudget([], limits)).toThrow("The build reported no routes.");
    expect(() => evaluateRouteJsBudget(undefined, limits)).toThrow("no routes");
    for (const bytes of [0, -1, Number.NaN, 1.5, "500", undefined]) {
      expect(() => evaluateRouteJsBudget([row("/app/agents", bytes)], limits))
        .toThrow("The build report has no JavaScript size for /app/agents.");
    }
    expect(() => evaluateRouteJsBudget([row("app", 1)], limits)).toThrow("Route 1");
    expect(() => evaluateRouteJsBudget([row("/app", 1)], limits)).toThrow(
      "The JavaScript budget for /app/agents names a route the build does not have.",
    );
    for (const broken of [
      undefined,
      { ...limits, publicMaxBytes: 0 },
      { ...limits, workspaceMaxBytes: undefined },
      { ...limits, workspaceMaxByte: 800_000, workspaceMaxBytes: undefined },
      { ...limits, routeMaxBytes: { "/app/agents": "1100000" } },
      { ...limits, routeMaxBytes: [] },
    ]) {
      expect(() => evaluateRouteJsBudget([row("/app/agents", 1)], broken))
        .toThrow(/routeFirstLoadJs\./);
    }
  });

  it("summarizes every route for the run, largest first", () => {
    const summary = formatRouteJsSummary(
      evaluateRouteJsBudget([row("/", 400_000), row("/app/agents", 1_200_000)], limits),
    );
    expect(summary.split("\n").slice(2, 6)).toEqual([
      "| Route | Bytes | Budget | |",
      "| --- | ---: | ---: | --- |",
      "| `/app/agents` | 1,200,000 | 1,100,000 | over |",
      "| `/` | 400,000 | 500,000 |  |",
    ]);
  });
});

describe("checking a build", () => {
  function check(rows: unknown, options: { missing?: boolean } = {}) {
    const directory = mkdtempSync(path.join(tmpdir(), "route-js-budget-"));
    directories.push(directory);
    const statsFile = path.join(directory, "route-bundle-stats.json");
    if (!options.missing) writeFileSync(statsFile, JSON.stringify(rows));
    const summaryFile = path.join(directory, "summary.md");
    const run = spawnSync(
      process.execPath,
      [path.resolve("scripts/check-route-js-budget.mjs"), statsFile],
      { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile } },
    );
    let summary = "";
    try {
      summary = readFileSync(summaryFile, "utf8");
    } catch {
      // No summary was written.
    }
    return { ...run, statsFile, summary };
  }

  const routes = Object.keys(budgets.routeFirstLoadJs.routeMaxBytes);

  it("passes a build within the repository's budgets, and fails one over them", () => {
    const within = check([row("/", 400_000), ...routes.map((route) => row(route, 500_000))]);
    expect(within.status).toBe(0);
    expect(within.stdout).toContain(`PASS ${routes.length + 1} routes load no more JavaScript`);
    expect(within.summary).toContain("| `/` | 400,000 | 560,000 |  |");

    const over = check([row("/app/accounts", 1_402_821), ...routes.map((route) => row(route, 500_000))]);
    expect(over.status).toBe(1);
    expect(over.stderr).toContain(
      "FAIL /app/accounts loads 1,402,821 bytes of JavaScript on a first visit, 602,821 over its budget of 800,000.",
    );
    expect(over.summary).toContain("| `/app/accounts` | 1,402,821 | 800,000 | over |");
  });

  it("fails when the build wrote no report, rather than passing", () => {
    const missing = check(undefined, { missing: true });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      `FAIL No route bundle report at ${missing.statsFile}. Run \`next build\` with Turbopack first`,
    );
    expect(check([]).stderr).toContain("FAIL The build reported no routes.");
  });
});
