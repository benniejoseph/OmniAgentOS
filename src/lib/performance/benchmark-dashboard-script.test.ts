import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("server-rendered dashboard benchmark", () => {
  it("measures an authenticated ready document without a browser runtime", async () => {
    let requestCount = 0;
    const observedHeaders: Array<Record<string, string | undefined>> = [];
    await withDashboardServer((request, response) => {
      requestCount += 1;
      observedHeaders.push({
        internal: request.headers["x-omni-internal-auth"] as
          | string
          | undefined,
        source: request.headers["x-omni-synthetic-source"] as
          | string
          | undefined,
        sloExcluded: request.headers["x-omni-slo-excluded"] as
          | string
          | undefined,
      });
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "server-timing": "total;dur=3",
      });
      response.end(
        '<!doctype html><main aria-busy="false" data-testid="activity-workspace"><h1>Today</h1></main>',
      );
    }, async (baseUrl) => {
      const result = await runBenchmark(baseUrl);

      expect(result.code, result.stderr).toBe(0);
      expect(requestCount).toBe(3);
      expect(observedHeaders).toEqual(
        Array.from({ length: 3 }, () => ({
          internal: "synthetic-internal-secret",
          source: "production-benchmark",
          sloExcluded: "true",
        })),
      );
      expect(result.stdout).toContain("PASS dashboard-ssr-ready");
      expect(result.stdout).toContain(
        '"measurementMode":"authenticated_ssr_document"',
      );
      expect(result.stdout).toContain("Server-Timing=complete");
    });
  });

  it("fails closed when the authenticated document is still loading", async () => {
    await withDashboardServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        '<main data-testid="activity-workspace" aria-busy="true"><h1>Today</h1><p>PRIVATE_FIXTURE</p></main>',
      );
    }, async (baseUrl) => {
      const result = await runBenchmark(baseUrl);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "did not contain the ready server-rendered Today workspace",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(
        "PRIVATE_FIXTURE",
      );
    });
  });

  it("does not combine workspace identity and readiness from different elements", async () => {
    await withDashboardServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        '<main aria-busy="true" data-testid="activity-workspace"><h1>Today</h1><p>PRIVATE_MIXED_FIXTURE</p></main><aside aria-busy="false">Ready</aside>',
      );
    }, async (baseUrl) => {
      const result = await runBenchmark(baseUrl);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "did not contain the ready server-rendered Today workspace",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(
        "PRIVATE_MIXED_FIXTURE",
      );
    });
  });
});

function runBenchmark(baseUrl: string) {
  return new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/benchmark-dashboard.mjs"],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          BASE_URL: baseUrl,
          BENCHMARK_ENFORCE: "false",
          BENCHMARK_DASHBOARD_SAMPLES: "1",
          BENCHMARK_DASHBOARD_WARMUPS: "2",
          BENCHMARK_SESSION_FILE: "",
          BENCHMARK_EMAIL: "",
          BENCHMARK_PASSWORD: "",
          SMOKE_ADMIN_EMAIL: "",
          SMOKE_ADMIN_PASSWORD: "",
          OMNIAGENT_BOOTSTRAP_EMAIL: "",
          OMNIAGENT_BOOTSTRAP_PASSWORD: "",
          SMOKE_INTERNAL_AUTH_SECRET: "synthetic-internal-secret",
          OMNIAGENT_INTERNAL_AUTH_SECRET: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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

async function withDashboardServer(
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
    throw new Error("Dashboard test server did not expose a TCP address.");
  }
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
