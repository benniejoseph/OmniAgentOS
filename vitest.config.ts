import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["tests/e2e/**", "tests/integration/**"],
    environment: "node",
    // File-backed concurrency tests run on developer workspaces as well as
    // local SSDs. Keep the limit bounded while allowing ordinary I/O variance.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/lib/**/types.ts"],
      thresholds: {
        lines: 17,
        statements: 17,
        functions: 28,
        branches: 65,
      },
    },
  },
});
