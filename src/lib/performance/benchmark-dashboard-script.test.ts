import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CohesiveTodayProjection } from "@/lib/today/cohesive-projection";

const fixtureSession = vi.hoisted(() => ({ name: undefined as string | undefined }));
vi.mock("@/components/app-shell/session-context", () => ({
  useWorkspaceSession: () => ({
    session: { authEnabled: true, authenticated: true, user: { name: fixtureSession.name } },
    status: "ready",
  }),
}));
vi.mock("@/components/source-coverage/source-coverage-panel", () => ({
  SourceCoveragePanel: () => null,
}));
vi.mock("@/components/use-live-refresh", () => ({ useLiveRefresh: () => undefined }));

const { TodayWorkspace } = await import("@/components/today-workspace");
const timestamp = "2026-10-13T12:00:00.000Z";
const initialProjection: CohesiveTodayProjection = {
  policyVersion: "p11.1-cohesive-today:1", generatedAt: timestamp, timezone: "UTC",
  visibleSections: ["focus"],
  today: {
    generatedAt: timestamp, items: [], threads: [], memories: [], projects: [],
    brief: undefined, briefLocalDate: "2026-10-13", briefGenerationDue: false,
    preferences: {
      briefEnabled: false, briefTime: "08:00", timezone: "UTC", reminderLeadMinutes: 30,
      notificationsEnabled: false, quietHoursEnabled: true,
      quietHoursStart: "22:00", quietHoursEnd: "07:00", visibleSections: ["focus"],
    },
  },
  workspaceSummary: null, meetings: [], usage: null, agenda: [], sources: [],
  counts: { needsAttention: 0, meetingsToday: 0, openCommitments: 0, approvals: 0,
    activeAgents: 0, activeWork: 0, unknownSources: 0 },
  projectionSha256: "synthetic-benchmark-projection",
};

function dashboardDocument({ ready = true, name }: { ready?: boolean; name?: string } = {}) {
  fixtureSession.name = name;
  return '<!doctype html><div hidden><main><h1>Loading workspace</h1></main></div>' +
    renderToString(createElement(TodayWorkspace, { initialProjection: ready ? initialProjection : undefined }));
}

describe("server-rendered dashboard benchmark", () => {
  it.each([undefined, "A<& Test"])("measures the actual server-rendered Today component with name %s", async (name) => {
    let requestCount = 0;
    const observedHeaders: Array<Record<string, string | undefined>> = [];
    const document = dashboardDocument({ name });
    expect(document).toContain('data-testid="activity-workspace"');
    expect(document).toContain('aria-busy="false"');
    expect(document).toContain("Welcome back");
    expect(document).toContain("<!-- -->");
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
      response.end(document);
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
      response.end(dashboardDocument({ ready: false }) + "<p>PRIVATE_FIXTURE</p>");
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
        '<main aria-busy="true" data-testid="activity-workspace"><header><p>Today</p><h1>Welcome back<!-- -->.</h1></header><p>PRIVATE_MIXED_FIXTURE</p></main><aside aria-busy="false">Ready</aside>',
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

  it.each(["missing heading", "missing Today kicker", "unrelated heading"])("rejects a ready main with %s", async (missing) => {
    let document = dashboardDocument();
    if (missing === "missing Today kicker") {
      document = document.replace(/<p(?:\s[^>]*)?>Today<\/p>/, "");
    } else {
      document = document.replace(/<h1>Welcome back[\s\S]*?<\/h1>/, "");
      if (missing === "unrelated heading") document += "<aside><h1>Welcome back.</h1></aside>";
    }
    await withDashboardServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(document);
    }, async (baseUrl) => {
      const result = await runBenchmark(baseUrl);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("did not contain the ready server-rendered Today workspace");
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
