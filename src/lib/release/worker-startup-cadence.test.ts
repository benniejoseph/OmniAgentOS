import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcess>();
const servers = new Set<Server>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exit, delay(2_000)]);
    }
  }
  children.clear();
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
});

describe("dedicated worker startup cadence", () => {
  it("starts fast immediately and staggers background, maintenance, and retention", async () => {
    const observations: Array<{ lane: string; at: number }> = [];
    const { baseUrl } = await startWorkerServer((lane) => {
      observations.push({ lane, at: Date.now() });
    });
    const startedAt = Date.now();
    const child = startWorker(baseUrl, {
      OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS: "300",
      OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS: "700",
      OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS: "1100",
    });

    await waitFor(() => new Set(observations.map(({ lane }) => lane)).size === 4);
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;

    const firstByLane = new Map(
      observations.map(({ lane, at }) => [lane, at - startedAt]),
    );
    expect(firstByLane.get("background")).toBeGreaterThanOrEqual(250);
    expect(firstByLane.get("maintenance")).toBeGreaterThanOrEqual(650);
    expect(firstByLane.get("retention")).toBeGreaterThanOrEqual(1_050);
    expect(firstByLane.get("fast")).toBeLessThan(firstByLane.get("background")!);
    expect(firstByLane.get("background")).toBeLessThan(firstByLane.get("maintenance")!);
    expect(firstByLane.get("maintenance")).toBeLessThan(firstByLane.get("retention")!);
  }, 10_000);

  it("interrupts delayed lanes cleanly during shutdown", async () => {
    const observations: string[] = [];
    const { baseUrl } = await startWorkerServer((lane) => observations.push(lane));
    const child = startWorker(baseUrl, {
      OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS: "5000",
      OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS: "5000",
      OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS: "5000",
    });

    await waitFor(() => observations.includes("fast"));
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    const exited = await Promise.race([
      exit.then(() => true),
      delay(2_000).then(() => false),
    ]);

    expect(exited).toBe(true);
    expect(observations).toEqual(["fast"]);
  }, 10_000);

  it("waits a full cadence after a slow lane attempt", async () => {
    const fastStarts: number[] = [];
    const startupMarkers: Array<boolean | undefined> = [];
    const { baseUrl } = await startWorkerServer((lane, startup) => {
      if (lane === "fast") {
        fastStarts.push(Date.now());
        startupMarkers.push(startup);
      }
    }, { responseDelayMs: 150 });
    const child = startWorker(baseUrl, {
      OMNIAGENT_WORKER_INTERVAL_MS: "100",
      OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS: "5000",
      OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS: "5000",
      OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS: "5000",
    });

    await waitFor(() => fastStarts.length >= 2);
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;

    expect(fastStarts[1] - fastStarts[0]).toBeGreaterThanOrEqual(225);
    expect(startupMarkers.slice(0, 2)).toEqual([true, undefined]);
  }, 10_000);

  it("retains the startup marker until a lane receives an OK response", async () => {
    const startupMarkers: Array<boolean | undefined> = [];
    const { baseUrl } = await startWorkerServer(
      (lane, startup) => {
        if (lane === "fast") {
          startupMarkers.push(startup);
        }
      },
      {
        responseStatus: (lane, attempt) =>
          lane === "fast" && attempt === 1 ? 503 : 200,
      },
    );
    const child = startWorker(baseUrl, {
      OMNIAGENT_WORKER_INTERVAL_MS: "100",
      OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS: "5000",
      OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS: "5000",
      OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS: "5000",
    });

    await waitFor(() => startupMarkers.length >= 3);
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;

    expect(startupMarkers.slice(0, 3)).toEqual([true, true, undefined]);
  }, 10_000);

  it("pins conservative production defaults", async () => {
    const [workerScript, flyConfig] = await Promise.all([
      readFile("scripts/worker.mjs", "utf8"),
      readFile("fly.toml", "utf8"),
    ]);

    expect(workerScript).toContain("Math.floor(backgroundIntervalMs / 2)");
    expect(workerScript).toContain("if (startupDelayMs > 0)");
    expect(workerScript).toContain("await sleep(cadenceMs, shutdownController.signal)");
    expect(workerScript).not.toContain("cadenceMs - (Date.now() - startedAt)");
    expect(workerScript).toContain("...(startup ? { startup: true } : {})");
    expect(workerScript).toContain("if (response.ok) {\n        startup = false;");
    expect(workerScript).toContain("maintenanceIntervalMs,\n);");
    expect(workerScript).toContain("10 * 60 * 1_000");
    expect(flyConfig).toContain('OMNIAGENT_WORKER_BACKGROUND_INTERVAL_MS = "15000"');
    expect(flyConfig).toContain('OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS = "7500"');
    expect(flyConfig).toContain('OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS = "60000"');
    expect(flyConfig).toContain('OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS = "600000"');
  });
});

async function startWorkerServer(
  onRequest: (lane: string, startup: boolean | undefined) => void,
  {
    responseDelayMs = 0,
    responseStatus = () => 200,
  }: {
    responseDelayMs?: number;
    responseStatus?: (lane: string, attempt: number) => number;
  } = {},
) {
  const attempts = new Map<string, number>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      lane?: string;
      startup?: boolean;
    };
    const lane = request.url === "/api/security/retention"
      ? "retention"
      : body.lane || "unknown";
    const attempt = (attempts.get(lane) || 0) + 1;
    attempts.set(lane, attempt);
    onRequest(lane, body.startup);
    if (responseDelayMs > 0) {
      await delay(responseDelayMs);
    }
    response.writeHead(responseStatus(lane, attempt), { "content-type": "application/json" });
    response.end(JSON.stringify({ result: { moreAvailable: false } }));
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Worker test server did not expose a TCP port.");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function startWorker(baseUrl: string, overrides: Record<string, string>) {
  const child = spawn(process.execPath, [path.resolve("scripts/worker.mjs")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      OMNIAGENT_WORKER_BASE_URL: baseUrl,
      OMNIAGENT_INTERNAL_AUTH_SECRET: "worker-test-secret",
      OMNIAGENT_WORKER_INTERVAL_MS: "10000",
      OMNIAGENT_WORKER_BACKGROUND_INTERVAL_MS: "10000",
      OMNIAGENT_WORKER_MAINTENANCE_INTERVAL_MS: "30000",
      OMNIAGENT_WORKER_RETENTION_INTERVAL_MS: "3600000",
      OMNIAGENT_WORKER_RETENTION: "true",
      OMNIAGENT_WORKER_REQUEST_TIMEOUT_MS: "3000",
      VERCEL_AUTOMATION_BYPASS_SECRET: "",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for worker observations.");
    }
    await delay(20);
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
