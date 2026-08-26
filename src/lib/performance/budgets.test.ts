import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import budgets from "../../../performance-budgets.json";

describe("frontend performance budgets", () => {
  it("keeps the LCP hero compact, modern, and server-rendered", async () => {
    const root = path.resolve(".");
    const heroAsset = path.join(
      root,
      "public",
      "omniagent-command-center.webp",
    );
    const markAsset = path.join(root, "public", "asael-mark-128.webp");
    const [metadata, markMetadata, hero, landing] = await Promise.all([
      stat(heroAsset),
      stat(markAsset),
      readFile(
        path.join(
          root,
          "src",
          "components",
          "marketing",
          "landing-hero.tsx",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          root,
          "src",
          "components",
          "marketing",
          "landing-page.tsx",
        ),
        "utf8",
      ),
    ]);

    expect(metadata.size).toBeLessThanOrEqual(budgets.heroImageMaxBytes);
    expect(markMetadata.size).toBeLessThanOrEqual(8_000);
    expect(hero).toContain('src="/omniagent-command-center.webp"');
    expect(hero).toContain("preload");
    expect(hero).toContain("unoptimized");
    expect(hero).toContain("sizes=");
    expect(hero).not.toContain("animate-drift");
    expect(landing).not.toContain('"use client"');
    await expect(
      stat(path.join(root, "public", "omniagent-command-center.png")),
    ).rejects.toThrow();
  });

  it("keeps inverted CTA link focus visible in both themes", async () => {
    const [cta, styles] = await Promise.all([
      readFile(
        path.resolve("src/components/marketing/landing-cta.tsx"),
        "utf8",
      ),
      readFile(path.resolve("src/app/globals.css"), "utf8"),
    ]);

    expect(cta).toContain(
      'className="inverse-focus border-t border-line bg-foreground text-background"',
    );
    expect(cta.match(/<Link/g)).toHaveLength(2);

    const inverseFocusRule = styles.match(
      /\.inverse-focus a:focus-visible\s*\{([^}]*)\}/,
    )?.[1];
    expect(inverseFocusRule).toContain(
      "outline: 3px solid var(--background);",
    );
    expect(inverseFocusRule).not.toContain("!important");
    expect(styles).toContain("a:focus-visible,");
    expect(styles.match(/:root\s*\{([^}]*)\}/)?.[1]).toContain(
      "--background:",
    );
    expect(
      styles.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1],
    ).toContain("--background:");
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
    const [reporter, deployment, previewBenchmark, dashboardBenchmark, healthBadge, workspaceSummary, todayRoute, todaySnapshot, todaySnapshotCache] =
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
        readFile(
          path.resolve("src/lib/workspace/summary.ts"),
          "utf8",
        ),
        readFile(path.resolve("src/app/api/today/route.ts"), "utf8"),
        readFile(path.resolve("src/lib/today/snapshot.ts"), "utf8"),
        readFile(path.resolve("src/lib/today/snapshot-cache.ts"), "utf8"),
      ]);
    expect(reporter).toContain('from "web-vitals"');
    expect(reporter).toContain("onCLS(report)");
    expect(reporter).toContain("onINP(report)");
    expect(reporter).not.toContain("new PerformanceObserver");
    expect(previewBenchmark).toContain("serverP95BudgetMs");
    expect(previewBenchmark).toContain("parseServerDuration");
    expect(previewBenchmark).toContain("validateSettingsCapabilities");
    expect(previewBenchmark).toContain(
      'payload?.storageSnapshot?.status !== "ready"',
    );
    expect(previewBenchmark).toContain(
      'await requestTarget(target, { validate: false })',
    );
    expect(previewBenchmark).toContain("waitForTargetReadiness(target)");
    expect(previewBenchmark).toContain("Date.now() + 20_000");
    expect(dashboardBenchmark).toContain('path: "/app"');
    expect(dashboardBenchmark).toContain("budgets.releaseDashboardUsableMs");
    expect(dashboardBenchmark).toContain("serverP95BudgetMs");
    expect(dashboardBenchmark).toContain('pathname === "/api/today"');
    expect(dashboardBenchmark).toContain('pathname === "/api/workspace-summary"');
    expect(dashboardBenchmark).toContain("dashboard performed duplicate hydration reads");
    expect(dashboardBenchmark).toContain("const response = await page.goto");
    expect(dashboardBenchmark).not.toContain("page.waitForResponse(");
    expect(deployment).toContain(
      '["promote", stagedBaseUrl, "--yes", "--scope", VERCEL_SCOPE]',
    );
    expect(healthBadge).toContain("/api/health?public=1");
    expect(healthBadge).toContain('cache: "force-cache"');
    expect(workspaceSummary).toContain("unstable_cache");
    expect(workspaceSummary).toContain('["workspace-summary-v1"]');
    expect(workspaceSummary).toContain("{ revalidate: 15 }");
    expect(todayRoute).not.toContain("unstable_cache");
    expect(todayRoute).toContain("await loadTodaySnapshot(");
    expect(todayRoute).toContain('"cache-control": "private, no-store"');
    expect(todaySnapshot).toContain("loadCachedTodaySnapshot(");
    expect(todaySnapshot).toContain("loadPostgresTodaySnapshot(");
    expect(todaySnapshotCache).toContain("unstable_cache(");
    expect(todaySnapshotCache).toContain(
      "TODAY_SNAPSHOT_REVALIDATE_SECONDS = 15",
    );
    expect(todaySnapshotCache).toContain(
      "revalidate: TODAY_SNAPSHOT_REVALIDATE_SECONDS",
    );
    expect(todaySnapshotCache).toContain("{ expire: 0 }");
  });
});
