import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
