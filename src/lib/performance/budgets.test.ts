import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import budgets from "../../../performance-budgets.json";

describe("frontend performance budgets", () => {
  it("keeps the LCP hero compact, modern, and non-animated", async () => {
    const root = path.resolve(".");
    const hero = path.join(
      root,
      "public",
      "omniagent-command-center.webp",
    );
    const [metadata, landing] = await Promise.all([
      stat(hero),
      readFile(
        path.join(root, "src/components/marketing/landing-page.tsx"),
        "utf8",
      ),
    ]);

    expect(metadata.size).toBeLessThanOrEqual(budgets.heroImageMaxBytes);
    expect(landing).toContain('src="/omniagent-command-center.webp"');
    expect(landing).toContain("preload");
    expect(landing).not.toContain("animate-drift");
    await expect(
      stat(path.join(root, "public", "omniagent-command-center.png")),
    ).rejects.toThrow();
  });

  it("records the release budgets used by preview verification", () => {
    expect(budgets).toMatchObject({
      authenticatedReadP95Ms: 500,
      sessionP95Ms: 300,
      releaseApiP95Ms: 1_500,
      dashboardUsableMs: 1_500,
      releaseDashboardUsableMs: 2_500,
      firstSseStatusMs: 1_000,
      completionVisibilityMs: 1_000,
      workflowPickupP95Ms: 10_000,
      lcpMs: 2_500,
      inpMs: 200,
      cls: 0.1,
    });
  });

  it("uses finalized Web Vitals and a browser dashboard release gate", async () => {
    const [reporter, deployment, previewBenchmark, dashboardBenchmark, healthBadge] =
      await Promise.all([
        readFile(
          path.resolve(
            "src/components/performance/web-vitals-reporter.tsx",
          ),
          "utf8",
        ),
        readFile(path.resolve("scripts/deploy-production.mjs"), "utf8"),
        readFile(path.resolve("scripts/benchmark-preview.mjs"), "utf8"),
        readFile(path.resolve("scripts/benchmark-dashboard.mjs"), "utf8"),
        readFile(
          path.resolve(
            "src/components/marketing/public-health-badge.tsx",
          ),
          "utf8",
        ),
      ]);
    expect(reporter).toContain('from "web-vitals"');
    expect(reporter).toContain("onCLS(report)");
    expect(reporter).toContain("onINP(report)");
    expect(reporter).not.toContain("new PerformanceObserver");
    expect(previewBenchmark).toContain("serverP95BudgetMs");
    expect(previewBenchmark).toContain("parseServerDuration");
    expect(dashboardBenchmark).toContain('path: "/app"');
    expect(dashboardBenchmark).toContain("budgets.releaseDashboardUsableMs");
    expect(dashboardBenchmark).toContain("serverP95BudgetMs");
    expect(deployment).toContain('["promote", stagedBaseUrl, "--yes"]');
    expect(healthBadge).toContain("/api/health?public=1");
    expect(healthBadge).toContain('cache: "force-cache"');
  });
});
