import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("database migration entry point", () => {
  it("executes through tsx and fails clearly without its dedicated URL", async () => {
    const environment = { ...process.env };
    delete environment.MIGRATION_DATABASE_URL;
    const result = await runProcess(
      path.resolve("node_modules/.bin/tsx"),
      ["scripts/db-migrate.ts"],
      environment,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "MIGRATION_DATABASE_URL is required. Do not run schema migrations with the application runtime role.",
    );
    expect(result.stderr).toContain('"event":"database_migration_failed"');
    expect(result.stderr).not.toContain("Top-level await is currently not supported");
  });
});

describe("database verification entry point", () => {
  it("executes through tsx and fails clearly without the migration URL", async () => {
    const environment = { ...process.env };
    delete environment.MIGRATION_DATABASE_URL;
    const result = await runProcess(
      path.resolve("node_modules/.bin/tsx"),
      ["scripts/db-verify.ts"],
      environment,
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      level: "error",
      event: "database_verification_failed",
      failedAt: expect.any(String),
      error:
        "MIGRATION_DATABASE_URL is required. The check reads the schema the release job migrated, over the same connection.",
    });
  });
});

describe("the CI integration job", () => {
  it("migrates an empty database twice with the release commands, then verifies it", () => {
    type Step = { name: string; env?: Record<string, string>; run?: string };
    const workflow = parse(fs.readFileSync(".github/workflows/ci.yml", "utf8")) as {
      jobs: { integration: { steps: Step[] } };
    };
    const steps = workflow.jobs.integration.steps;
    const index = (name: string) => steps.findIndex((step) => step.name === name);
    const tls = index("Enable TLS on Postgres service");
    const release = index("Migrate and verify with the release commands");
    const tests = index("Postgres schema and RLS integration tests");

    expect([tls >= 0, tls < release, release < tests]).toEqual([true, true, true]);
    expect(steps[release]!.env).toEqual({
      MIGRATION_DATABASE_URL: steps[tests]!.env!.DATABASE_URL,
    });
    expect(
      steps[release]!.run!.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")),
    ).toEqual(["set -euo pipefail", "npm run db:migrate", "npm run db:migrate", "npm run db:verify"]);
    const scripts = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts;
    expect([scripts["db:migrate"], scripts["db:verify"]]).toEqual([
      "tsx --conditions=react-server scripts/db-migrate.ts",
      "tsx --conditions=react-server scripts/db-verify.ts",
    ]);
  });
});

function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
