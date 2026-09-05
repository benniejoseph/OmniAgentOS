import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || 3100);
const managedBaseUrl = `http://127.0.0.1:${port}`;
const baseURL = process.env.PLAYWRIGHT_BASE_URL || managedBaseUrl;
const startsManagedServer = !process.env.PLAYWRIGHT_BASE_URL;
const e2eStateDirectory = path.join(os.tmpdir(), `omniagent-playwright-${process.pid}`);
process.env.OMNIAGENT_E2E_SESSION_FILE ||= path.join(e2eStateDirectory, "session-cookies.json");

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  testIgnore: ["**/*.test.ts", "**/*.integration.test.ts"],
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: startsManagedServer
    ? {
        command: process.env.CI
          ? `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`
          : `node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${port}`,
        url: managedBaseUrl,
        reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "true",
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          DATABASE_URL: "",
          OMNIAGENT_MAINTENANCE_DATABASE_URL: "",
          VERCEL: "",
          VERCEL_ENV: "",
          VERCEL_URL: "",
          VERCEL_GIT_COMMIT_SHA: "",
          OPENAI_API_KEY: "",
          CRON_SECRET: "playwright-local-only-cron-secret",
          NEXT_PUBLIC_APP_URL: managedBaseUrl,
          NEXT_PUBLIC_WEB_VITALS_SAMPLE_RATE: "1",
          OMNIAGENT_ALLOW_DEMO_STORAGE: "true",
          OMNIAGENT_AUTH_ENABLED: "true",
          OMNIAGENT_BOOTSTRAP_EMAIL: "playwright-admin@example.invalid",
          OMNIAGENT_BOOTSTRAP_PASSWORD: "playwright-local-only-password",
          OMNIAGENT_BOOTSTRAP_NAME: "Playwright Admin",
          OMNIAGENT_BOOTSTRAP_TENANT: "Playwright Workspace",
          OMNIAGENT_DEFAULT_TENANT: "playwright",
          OMNIAGENT_DEFAULT_ROLE: "operator",
          OMNIAGENT_LOCAL_PRODUCTION: "true",
          TZ: "UTC",
          OMNIAGENT_DATA_DIR: e2eStateDirectory,
          OMNIAGENT_ACCESS_REQUEST_FILE: path.join(
            os.tmpdir(),
            `omniagent-playwright-${process.pid}`,
            "access-requests.json",
          ),
        },
      }
    : undefined,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
