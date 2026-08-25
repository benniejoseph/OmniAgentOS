import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("paired production deployment", () => {
  it("promotes protected Vercel releases before canonical paired verification", async () => {
    const result = await runProcess(
      process.execPath,
      ["scripts/deploy-production.mjs", "--dry-run"],
      {
        ...process.env,
        OMNIAGENT_RELEASE_SHA: "test-release",
      },
    );

    expect(result.code).toBe(0);
    const commands = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("DRY RUN "));
    expect(commands[0]).toContain("npm run smoke:release");
    expect(commands[1]).toBe("DRY RUN npm run verify");
    expect(commands[2]).toContain(
      "vercel deploy --prod --skip-domain --yes",
    );
    expect(commands[3]).toContain("vercel promote https://staged-deployment.example");
    expect(commands[4]).toContain(
      "fly deploy --app omniagent-os-worker --build-arg OMNIAGENT_RELEASE_SHA=test-release --env OMNIAGENT_WORKER_BASE_URL=https://production.example",
    );
    const smokeIndex = commands.findIndex((command) =>
      command.includes("npm run test:production-smoke"),
    );
    const previewIndex = commands.findIndex((command) =>
      command.includes("npm run benchmark:preview"),
    );
    const dashboardIndex = commands.findIndex((command) =>
      command.includes("npm run benchmark:dashboard"),
    );
    const promoteIndex = commands.findIndex((command) =>
      command.includes("vercel promote"),
    );
    expect(smokeIndex).toBeGreaterThan(4);
    expect(previewIndex).toBeGreaterThan(smokeIndex);
    expect(dashboardIndex).toBeGreaterThan(previewIndex);
    expect(promoteIndex).toBe(3);
    expect(smokeIndex).toBeGreaterThan(promoteIndex);
  });

  it("rejects untracked drift and polls asynchronous evaluation smoke jobs", async () => {
    const [
      deployScript,
      evaluationSmoke,
      securitySmoke,
      previewBenchmark,
      dashboardBenchmark,
      workerScript,
      workerImage,
    ] =
      await Promise.all([
        readFile("scripts/deploy-production.mjs", "utf8"),
        readFile("scripts/smoke-eval-case.mjs", "utf8"),
        readFile("scripts/smoke-security.mjs", "utf8"),
        readFile("scripts/benchmark-preview.mjs", "utf8"),
        readFile("scripts/benchmark-dashboard.mjs", "utf8"),
        readFile("scripts/worker.mjs", "utf8"),
        readFile("Dockerfile.worker", "utf8"),
      ]);

    expect(deployScript).toContain('"--porcelain"');
    expect(deployScript).not.toContain("--untracked-files=no");
    expect(deployScript).toContain('"--skip-domain"');
    expect(deployScript).toContain('"--scope", VERCEL_SCOPE');
    expect(deployScript).toContain("previousWorkerImage");
    expect(deployScript).toContain("previousVercelDeployment");
    expect(deployScript).not.toContain('"cron secret"');
    expect(deployScript).toContain("SMOKE_SESSION_OUTPUT");
    expect(deployScript).toContain("BENCHMARK_SESSION_FILE");
    expect(securitySmoke).toContain("SMOKE_SESSION_OUTPUT");
    expect(previewBenchmark).toContain("BENCHMARK_SESSION_FILE");
    expect(dashboardBenchmark).toContain("BENCHMARK_SESSION_FILE");
    expect(evaluationSmoke).toContain("response.status === 202");
    expect(evaluationSmoke).toContain("waitForEvaluationJob");
    expect(evaluationSmoke).toContain("/api/operations/jobs/");
    expect(evaluationSmoke).toContain('"x-omni-internal-auth"');
    expect(evaluationSmoke).toContain('"x-omni-worker-protocol"');
    expect(evaluationSmoke).toContain('method: "POST"');
    expect(workerScript).toContain('recordLaneState(lane, "running"');
    expect(workerImage).toContain("['fast','background','maintenance'].every");
  });
});

function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.resolve("."),
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
