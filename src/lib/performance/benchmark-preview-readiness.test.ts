import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readySnapshot = {
  storageSnapshot: { status: "ready", source: "postgres" },
  vectorStore: { status: "ready" },
  memory: { status: "ready" },
  knowledge: { status: "ready" },
};
const degradedSnapshot = {
  storageSnapshot: { status: "degraded", source: "postgres", reason: "timeout" },
  vectorStore: { status: "unavailable" },
  memory: { status: "unavailable" },
  knowledge: { status: "unavailable" },
};

describe("preview benchmark functional readiness", () => {
  it("requires a consecutive-ready prime before accepting measurements", async () => {
    const statuses = [
      "degraded", // warmup
      "ready", "degraded", "ready", "ready", // readiness must reset its streak
      "ready", "ready", // every measured response is ready
    ];
    const fixture = await startSettingsFixture(statuses);
    try {
      const result = await runBenchmark(fixture.baseUrl);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("PASS settings-capabilities");
      expect(fixture.requests()).toBe(7);
    } finally {
      await fixture.close();
    }
  }, 10_000);

  it("fails immediately when any measured sample returns degradation", async () => {
    const statuses = [
      "ready", // warmup
      "ready", "ready", // readiness streak
      "ready", "degraded", // measured responses
    ];
    const fixture = await startSettingsFixture(statuses);
    try {
      const result = await runBenchmark(fixture.baseUrl);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "returned a degraded storage snapshot during preview benchmark",
      );
      expect(result.stdout).not.toContain("PASS settings-capabilities");
      expect(fixture.requests()).toBe(5);
    } finally {
      await fixture.close();
    }
  }, 10_000);
});

async function startSettingsFixture(statuses: string[]) {
  let requestCount = 0;
  const server = createServer((request, response) => {
    if (!request.url?.startsWith("/api/capabilities?view=settings")) {
      response.writeHead(404).end();
      return;
    }
    const status = statuses[Math.min(requestCount, statuses.length - 1)];
    requestCount += 1;
    response.writeHead(200, {
      "content-type": "application/json",
      "server-timing": "total;dur=1",
    });
    response.end(JSON.stringify(
      status === "ready" ? readySnapshot : degradedSnapshot,
    ));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Benchmark fixture did not bind a TCP port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => requestCount,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function runBenchmark(
  baseUrl: string,
  overrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    Object.assign(environment, {
      NODE_ENV: "test",
      VERCEL: "",
      VERCEL_ENV: "",
      BASE_URL: baseUrl,
      SMOKE_INTERNAL_AUTH_SECRET: "benchmark-test-secret",
      BENCHMARK_TARGETS: "settings-capabilities",
      BENCHMARK_SAMPLES: "2",
      BENCHMARK_WARMUPS: "1",
      BENCHMARK_READY_STREAK: "2",
      BENCHMARK_READINESS_TIMEOUT_MS: "2000",
      BENCHMARK_READINESS_POLL_MS: "5",
      BENCHMARK_ENFORCE: "true",
      BENCHMARK_SESSION_FILE: "",
      ...overrides,
    });
    const child = spawn(process.execPath, ["scripts/benchmark-preview.mjs"], {
      cwd: path.resolve("."),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
