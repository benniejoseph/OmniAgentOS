import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("paired production deployment", () => {
  it("verifies the staged web and worker before promotion, then verifies canonical", async () => {
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
    expect(commands[3]).toContain(
      "fly deploy --app omniagent-os-worker --build-arg OMNIAGENT_RELEASE_SHA=test-release --env OMNIAGENT_WORKER_BASE_URL=https://staged-deployment.example",
    );
    const stagedSmokeIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://staged-deployment.example") &&
      command.includes("npm run test:production-smoke"),
    );
    const stagedPreviewIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://staged-deployment.example") &&
      command.includes("npm run benchmark:preview"),
    );
    const stagedDashboardIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://staged-deployment.example") &&
      command.includes("npm run benchmark:dashboard"),
    );
    const promoteIndex = commands.findIndex((command) =>
      command.includes("vercel promote"),
    );
    const canonicalWorkerIndex = commands.findIndex((command) =>
      command.includes("--image registry.fly.io/omniagent-os-worker:staged") &&
      command.includes("OMNIAGENT_WORKER_BASE_URL=https://production.example"),
    );
    const canonicalSmokeIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://production.example") &&
      command.includes("npm run test:production-smoke"),
    );
    expect(stagedSmokeIndex).toBeGreaterThan(3);
    expect(stagedPreviewIndex).toBeGreaterThan(stagedSmokeIndex);
    expect(stagedDashboardIndex).toBeGreaterThan(stagedPreviewIndex);
    expect(promoteIndex).toBeGreaterThan(stagedDashboardIndex);
    expect(canonicalWorkerIndex).toBeGreaterThan(promoteIndex);
    expect(canonicalSmokeIndex).toBeGreaterThan(canonicalWorkerIndex);
  });

  it("rejects untracked drift and polls asynchronous evaluation smoke jobs", async () => {
    const [
      deployScript,
      evaluationSmoke,
      securitySmoke,
      previewBenchmark,
      dashboardBenchmark,
      sessionRoute,
      workspaceSession,
      workerScript,
      workerImage,
    ] =
      await Promise.all([
        readFile("scripts/deploy-production.mjs", "utf8"),
        readFile("scripts/smoke-eval-case.mjs", "utf8"),
        readFile("scripts/smoke-security.mjs", "utf8"),
        readFile("scripts/benchmark-preview.mjs", "utf8"),
        readFile("scripts/benchmark-dashboard.mjs", "utf8"),
        readFile("src/app/api/auth/session/route.ts", "utf8"),
        readFile("src/lib/auth/workspace-session.ts", "utf8"),
        readFile("scripts/worker.mjs", "utf8"),
        readFile("Dockerfile.worker", "utf8"),
      ]);

    expect(deployScript).toContain('"--porcelain"');
    expect(deployScript).not.toContain("--untracked-files=no");
    expect(deployScript).toContain('"--skip-domain"');
    expect(deployScript).toContain('"--scope", VERCEL_SCOPE');
    expect(deployScript).toContain("previousWorkerImage");
    expect(deployScript).toContain("previousVercelDeployment");
    expect(deployScript).toContain("runRollbackVerification");
    expect(deployScript).toContain("asael-release-evidence-");
    expect(deployScript).not.toContain('"cron secret"');
    expect(deployScript).toContain("SMOKE_SESSION_OUTPUT");
    expect(deployScript).toContain("BENCHMARK_SESSION_FILE");
    expect(securitySmoke).toContain("SMOKE_SESSION_OUTPUT");
    expect(previewBenchmark).toContain("BENCHMARK_SESSION_FILE");
    expect(dashboardBenchmark).toContain("BENCHMARK_SESSION_FILE");
    expect(sessionRoute).toContain("resolveWorkspaceSession");
    expect(workspaceSession).toContain('headerContext?.source === "headers"');
    expect(evaluationSmoke).toContain("response.status === 202");
    expect(evaluationSmoke).toContain("waitForEvaluationJob");
    expect(evaluationSmoke).toContain("driveBackgroundQueueAttempt <= 3");
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
