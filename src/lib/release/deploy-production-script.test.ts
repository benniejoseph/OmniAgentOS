import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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
      "wait for staged web readiness at https://staged-deployment.example/api/health revision=test-release",
    );
    expect(commands[4]).toContain(
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
    const canonicalReadinessIndex = commands.findIndex((command) =>
      command.includes("wait for canonical web readiness") &&
      command.includes("revision=test-release"),
    );
    const canonicalSmokeIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://production.example") &&
      command.includes("npm run test:production-smoke"),
    );
    expect(stagedSmokeIndex).toBeGreaterThan(4);
    expect(stagedPreviewIndex).toBeGreaterThan(stagedSmokeIndex);
    expect(stagedDashboardIndex).toBeGreaterThan(stagedPreviewIndex);
    expect(promoteIndex).toBeGreaterThan(stagedDashboardIndex);
    expect(canonicalReadinessIndex).toBeGreaterThan(promoteIndex);
    expect(canonicalWorkerIndex).toBeGreaterThan(canonicalReadinessIndex);
    expect(canonicalSmokeIndex).toBeGreaterThan(canonicalWorkerIndex);
  });

  it("waits through transient health failures and revision propagation", async () => {
    let requests = 0;
    let bypassHeader: string | undefined;
    await withHealthServer((request, response) => {
      requests += 1;
      bypassHeader = request.headers["x-vercel-protection-bypass"] as
        | string
        | undefined;
      response.setHeader("content-type", "application/json");
      if (requests === 1) {
        response.writeHead(503);
        response.end(JSON.stringify({
          status: "unhealthy",
          revision: "release-ready",
          dependencies: {
            databaseConfigured: true,
            openAiConfigured: true,
            cronSecretConfigured: true,
          },
          secret: "DO_NOT_PRINT",
        }));
        return;
      }
      response.writeHead(200);
      response.end(JSON.stringify({
        status: "healthy",
        revision: requests === 2 ? "previous-release" : "release-ready",
        dependencies: {
          databaseConfigured: true,
          openAiConfigured: true,
          cronSecretConfigured: true,
        },
        secret: "DO_NOT_PRINT",
      }));
    }, async (baseUrl) => {
      const result = await runProcess(
        process.execPath,
        [
          "scripts/deploy-production.mjs",
          "--readiness-probe",
          baseUrl,
          "release-ready",
        ],
        readinessEnvironment({ timeoutMs: 3_000 }),
      );
      expect(result.code).toBe(0);
      expect(requests).toBe(3);
      expect(bypassHeader).toBeUndefined();
      expect(result.stdout).toContain("http=503");
      expect(result.stdout).toContain("revision=previous-release");
      expect(result.stdout).toContain(
        "Readiness probe became ready at revision release-ready after 3 attempt(s)",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("DO_NOT_PRINT");
    });
  });

  it("fails within the readiness deadline with bounded, redacted diagnostics", async () => {
    let requests = 0;
    await withHealthServer((_request, response) => {
      requests += 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "unhealthy",
        revision: "release-pending",
        dependencies: {
          databaseConfigured: true,
          openAiConfigured: true,
          cronSecretConfigured: true,
        },
        secret: "DO_NOT_PRINT",
      }));
    }, async (baseUrl) => {
      const startedAt = Date.now();
      const result = await runProcess(
        process.execPath,
        [
          "scripts/deploy-production.mjs",
          "--readiness-probe",
          baseUrl,
          "release-ready",
        ],
        readinessEnvironment({ timeoutMs: 1_000 }),
      );
      expect(result.code).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(requests).toBeGreaterThan(1);
      expect(result.stderr).toContain("within 1000ms");
      expect(result.stderr).toContain("http=503");
      expect(result.stderr).toContain("database=true");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("DO_NOT_PRINT");
    });
  });

  it("fails fast with an actionable error when readiness access is denied", async () => {
    await withHealthServer((_request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "protected" }));
    }, async (baseUrl) => {
      const result = await runProcess(
        process.execPath,
        [
          "scripts/deploy-production.mjs",
          "--readiness-probe",
          baseUrl,
          "release-ready",
        ],
        readinessEnvironment({ timeoutMs: 3_000 }),
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "readiness access was denied with HTTP 403",
      );
      expect(result.stderr).toContain("VERCEL_AUTOMATION_BYPASS_SECRET");
      expect(result.stderr).not.toContain("before initialization");
    });
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
    expect(deployScript).toContain("previousHealthRevision");
    expect(deployScript).toContain("runRollbackVerification");
    expect(deployScript).toContain(
      "SMOKE_EXPECTED_REVISION: expectedRevision",
    );
    expect(deployScript).toContain("asael-release-evidence-");
    expect(deployScript).toContain('SMOKE_REQUEST_TIMEOUT_MS: "60000"');
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

function readinessEnvironment({ timeoutMs }: { timeoutMs: number }) {
  return {
    ...process.env,
    OMNIAGENT_RELEASE_SHA: "release-ready",
    OMNIAGENT_DEPLOY_READINESS_TIMEOUT_MS: String(timeoutMs),
    OMNIAGENT_DEPLOY_READINESS_POLL_MS: "100",
    OMNIAGENT_DEPLOY_READINESS_REQUEST_TIMEOUT_MS: "500",
    VERCEL_AUTOMATION_BYPASS_SECRET: "must-not-leave-the-process",
  };
}

async function withHealthServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  callback: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Readiness test server did not expose a TCP address.");
  }
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
