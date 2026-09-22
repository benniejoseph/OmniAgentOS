import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_READ_ONLY_SCHEDULE_BUDGET } from "@/lib/workflows/schedule-defaults";

describe("workflow schedule module boundary", () => {
  it("keeps the immutable default in a dependency-free module", () => {
    expect(Object.isFrozen(DEFAULT_READ_ONLY_SCHEDULE_BUDGET)).toBe(true);
    expect(DEFAULT_READ_ONLY_SCHEDULE_BUDGET).toEqual({
      modelTurns: 4,
      tokens: 32_000,
      costMicrousd: 750_000,
      wallTimeMs: 180_000,
      toolCalls: 16,
      browserActions: 0,
      agents: 0,
      fanOut: 0,
      retries: 1,
      replans: 0,
    });
  });

  it("does not initialize route or service schemas through the trigger runtime", async () => {
    const [defaultsSource, routeSource, serviceSource] = await Promise.all([
      readFile("src/lib/workflows/schedule-defaults.ts", "utf8"),
      readFile("src/app/api/triggers/route.ts", "utf8"),
      readFile("src/lib/app-services/workflows.ts", "utf8"),
    ]);

    expect(defaultsSource).not.toMatch(/^\s*import\s/m);
    for (const source of [routeSource, serviceSource]) {
      expect(source).toContain(
        'import { DEFAULT_READ_ONLY_SCHEDULE_BUDGET } from "@/lib/workflows/schedule-defaults";',
      );
      expect(source).not.toMatch(
        /import\s*\{[^}]*DEFAULT_READ_ONLY_SCHEDULE_BUDGET[^}]*\}\s*from\s*["']@\/lib\/workflows\/triggers["']/s,
      );
    }
  });
});
