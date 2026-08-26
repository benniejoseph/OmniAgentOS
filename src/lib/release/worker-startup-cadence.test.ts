import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
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

  it("delays first maintenance work until startup registration succeeds", async () => {
    const maintenance: Array<{ startup: boolean | undefined; at: number }> = [];
    const { baseUrl } = await startWorkerServer(
      (lane, startup) => {
        if (lane === "maintenance") {
          maintenance.push({ startup, at: Date.now() });
        }
      },
      {
        responseStatus: (lane, attempt) =>
          lane === "maintenance" && attempt === 1 ? 503 : 200,
      },
    );
    const child = startWorker(baseUrl, {
      OMNIAGENT_WORKER_INTERVAL_MS: "100",
      OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS: "5000",
      OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS: "100",
      OMNIAGENT_WORKER_MAINTENANCE_FIRST_RUN_DELAY_MS: "300",
      OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS: "5000",
    });

    await waitFor(() => maintenance.length >= 3);
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;

    expect(maintenance.slice(0, 3).map(({ startup }) => startup)).toEqual([
      true,
      true,
      undefined,
    ]);
    expect(maintenance[1].at - maintenance[0].at).toBeGreaterThanOrEqual(75);
    expect(maintenance[2].at - maintenance[1].at).toBeGreaterThanOrEqual(250);
  }, 10_000);

  it("serializes heavy lanes while the fast lane remains independent", async () => {
    let heavyInFlight = 0;
    let maxHeavyInFlight = 0;
    let fastRanDuringHeavyWork = false;
    const completedHeavyLanes = new Set<string>();
    const isHeavyWork = (lane: string, startup: boolean | undefined) =>
      startup !== true && ["background", "maintenance", "retention"].includes(lane);
    const { baseUrl } = await startWorkerServer(
      (lane, startup) => {
        if (isHeavyWork(lane, startup)) {
          heavyInFlight += 1;
          maxHeavyInFlight = Math.max(maxHeavyInFlight, heavyInFlight);
        } else if (lane === "fast" && startup !== true && heavyInFlight > 0) {
          fastRanDuringHeavyWork = true;
        }
      },
      {
        responseDelayMs: (lane, _attempt, startup) =>
          isHeavyWork(lane, startup) ? 150 : 0,
        onResponse: (lane, startup) => {
          if (isHeavyWork(lane, startup)) {
            heavyInFlight -= 1;
            completedHeavyLanes.add(lane);
          }
        },
      },
    );
    const child = startWorker(baseUrl, {
      OMNIAGENT_WORKER_INTERVAL_MS: "50",
      OMNIAGENT_WORKER_BACKGROUND_INTERVAL_MS: "50",
      OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS: "0",
      OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS: "0",
      OMNIAGENT_WORKER_MAINTENANCE_FIRST_RUN_DELAY_MS: "50",
      OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS: "50",
    });

    await waitFor(() =>
      completedHeavyLanes.size === 3 && fastRanDuringHeavyWork,
    );
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;

    expect(maxHeavyInFlight).toBe(1);
    expect(completedHeavyLanes).toEqual(
      new Set(["background", "maintenance", "retention"]),
    );
    expect(fastRanDuringHeavyWork).toBe(true);
  }, 10_000);

  it("keeps a staged release to throttled startup registrations while held", async () => {
    const observations: Array<{
      lane: string;
      startup: boolean | undefined;
      target: string | undefined;
    }> = [];
    const revision = `held-staged-${process.pid}`;
    const stagedServer = await startWorkerServer(
      (lane, startup, target) => {
        observations.push({ lane, startup, target });
      },
      { responseStatus: () => 503 },
    );
    const canonicalServer = await startWorkerServer(() => undefined, {
      healthRevision: "previous-release",
    });
    const child = startWorker(stagedServer.baseUrl, {
      OMNIAGENT_WORKER_CANONICAL_BASE_URL: canonicalServer.baseUrl,
      OMNIAGENT_RELEASE_SHA: revision,
      OMNIAGENT_WORKER_RELEASE_HOLD: "true",
      OMNIAGENT_WORKER_INTERVAL_MS: "50",
      OMNIAGENT_WORKER_BACKGROUND_INTERVAL_MS: "50",
      OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS: "0",
      OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS: "0",
      OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS: "0",
    });

    await waitFor(() =>
      new Set(observations.map(({ lane }) => lane)).size === 3,
    );
    await delay(300);

    expect(observations).toHaveLength(3);
    expect(new Set(observations.map(({ lane }) => lane))).toEqual(
      new Set(["fast", "background", "maintenance"]),
    );
    for (const observation of observations) {
      expect(observation.startup).toBe(true);
      expect(observation.target).toBe(stagedServer.baseUrl);
    }

    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;
  }, 10_000);

  it("retries canonical recovery after an activated process restart", async () => {
    const revision = `activated-retry-${process.pid}`;
    const canonicalRequests: Array<{
      startup: boolean | undefined;
      at: number;
    }> = [];
    const canonicalHealthRequests: number[] = [];
    let healthAttempt = 0;
    const stagedServer = await startWorkerServer(() => undefined);
    const canonicalServer = await startWorkerServer(
      (_lane, startup) => {
        canonicalRequests.push({ startup, at: Date.now() });
      },
      {
        healthRevision: () => {
          canonicalHealthRequests.push(Date.now());
          healthAttempt += 1;
          return healthAttempt === 1 ? "previous-release" : revision;
        },
      },
    );
    await writeFile(
      "/tmp/asael-worker-release-activated",
      `${revision}\n`,
      { mode: 0o600 },
    );
    const child = startWorker(stagedServer.baseUrl, {
      NODE_OPTIONS: acceleratedWorkerClock(100),
      OMNIAGENT_WORKER_CANONICAL_BASE_URL: canonicalServer.baseUrl,
      OMNIAGENT_RELEASE_SHA: revision,
      OMNIAGENT_WORKER_RELEASE_HOLD: "true",
      OMNIAGENT_WORKER_INTERVAL_MS: "10000",
      OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS: "600000",
      OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS: "600000",
      OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS: "600000",
    });

    await waitFor(() =>
      canonicalRequests.some(({ startup }) => startup !== true),
    );

    expect(canonicalHealthRequests).toHaveLength(2);
    expect(
      canonicalHealthRequests[1] - canonicalHealthRequests[0],
    ).toBeGreaterThanOrEqual(250);
    expect(canonicalRequests[0]?.startup).toBe(true);
    expect(child.exitCode).toBeNull();

    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;
  }, 10_000);

  it("re-registers canonical while held and activates work only after SIGUSR1", async () => {
    const revision = `held-canonical-${process.pid}`;
    const staged: Array<{ lane: string; startup: boolean | undefined }> = [];
    const canonical: Array<{ lane: string; startup: boolean | undefined }> = [];
    let canonicalRevision = "previous-release";
    const stagedServer = await startWorkerServer((lane, startup) => {
      staged.push({ lane, startup });
    });
    const canonicalServer = await startWorkerServer((lane, startup) => {
      canonical.push({ lane, startup });
    }, { healthRevision: () => canonicalRevision });
    const heldEnvironment = {
      OMNIAGENT_WORKER_CANONICAL_BASE_URL: canonicalServer.baseUrl,
      OMNIAGENT_RELEASE_SHA: revision,
      OMNIAGENT_WORKER_RELEASE_HOLD: "true",
      OMNIAGENT_WORKER_INTERVAL_MS: "50",
      OMNIAGENT_WORKER_BACKGROUND_INTERVAL_MS: "50",
      OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS: "0",
      OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS: "0",
      OMNIAGENT_WORKER_MAINTENANCE_FIRST_RUN_DELAY_MS: "50",
      OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS: "0",
    };
    const child = startWorker(stagedServer.baseUrl, heldEnvironment);

    await waitFor(() => staged.length === 3);
    canonicalRevision = revision;
    expect(child.kill("SIGHUP")).toBe(true);
    await waitFor(() =>
      new Set(canonical.map(({ lane }) => lane)).size === 3,
    );
    await delay(200);

    expect(canonical.every(({ startup }) => startup === true)).toBe(true);
    expect(canonical.some(({ lane }) => lane === "retention")).toBe(false);
    expect(staged.every(({ startup }) => startup === true)).toBe(true);

    expect(child.kill("SIGUSR1")).toBe(true);
    await waitFor(() =>
      canonical.some(({ startup }) => startup !== true),
    );
    expect(staged.every(({ startup }) => startup === true)).toBe(true);
    expect(canonical.some(({ lane }) => lane === "retention")).toBe(false);
    expect(
      (await readFile("/tmp/asael-worker-release-activated", "utf8")).trim(),
    ).toBe(revision);

    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;

    const stagedCount = staged.length;
    const canonicalCount = canonical.length;
    const restarted = startWorker(stagedServer.baseUrl, heldEnvironment);
    await waitFor(() =>
      canonical.slice(canonicalCount).some(({ startup }) => startup !== true),
    );
    expect(staged).toHaveLength(stagedCount);

    const restartedExit = once(restarted, "exit");
    restarted.kill("SIGTERM");
    await restartedExit;
  }, 15_000);

  it("discards an in-flight held registration before activating canonical work", async () => {
    const revision = `held-in-flight-${process.pid}`;
    const canonicalFast: Array<{
      startup: boolean | undefined;
      at: number;
    }> = [];
    let canonicalRevision = "previous-release";
    let stagedFastRegistered = false;
    const stagedServer = await startWorkerServer((lane) => {
      if (lane === "fast") stagedFastRegistered = true;
    });
    const canonicalServer = await startWorkerServer(
      (lane, startup) => {
        if (lane === "fast") {
          canonicalFast.push({ startup, at: Date.now() });
        }
      },
      {
        healthRevision: () => canonicalRevision,
        responseDelayMs: (lane, attempt, startup) =>
          lane === "fast" && attempt === 1 && startup === true ? 250 : 0,
      },
    );
    const child = startWorker(stagedServer.baseUrl, {
      OMNIAGENT_WORKER_CANONICAL_BASE_URL: canonicalServer.baseUrl,
      OMNIAGENT_RELEASE_SHA: revision,
      OMNIAGENT_WORKER_RELEASE_HOLD: "true",
      OMNIAGENT_WORKER_INTERVAL_MS: "300",
      OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS: "5000",
      OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS: "5000",
      OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS: "5000",
    });

    await waitFor(() => stagedFastRegistered);
    canonicalRevision = revision;
    expect(child.kill("SIGHUP")).toBe(true);
    await waitFor(() => canonicalFast.length === 1);
    expect(child.kill("SIGUSR1")).toBe(true);
    await waitFor(() => canonicalFast.length >= 3);

    expect(canonicalFast.slice(0, 3).map(({ startup }) => startup)).toEqual([
      true,
      true,
      undefined,
    ]);
    expect(canonicalFast[2].at - canonicalFast[1].at).toBeGreaterThanOrEqual(250);

    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;
  }, 10_000);

  it("rebinds every tick lane on SIGHUP without terminating the worker", async () => {
    const staged = new Map<string, { startup: boolean | undefined; target: string | undefined }>();
    const canonical = new Map<string, { startup: boolean | undefined; target: string | undefined }>();
    let canonicalRevision = "previous-release";
    const stagedServer = await startWorkerServer((lane, startup, target) => {
      if (!staged.has(lane)) staged.set(lane, { startup, target });
    });
    const canonicalServer = await startWorkerServer(
      (lane, startup, target) => {
        if (!canonical.has(lane)) canonical.set(lane, { startup, target });
      },
      { healthRevision: () => canonicalRevision },
    );
    const child = startWorker(stagedServer.baseUrl, {
      OMNIAGENT_WORKER_CANONICAL_BASE_URL: canonicalServer.baseUrl,
      OMNIAGENT_RELEASE_SHA: "release-ready",
      OMNIAGENT_WORKER_INTERVAL_MS: "5000",
      OMNIAGENT_WORKER_BACKGROUND_INTERVAL_MS: "5000",
      OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS: "0",
      OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS: "0",
      OMNIAGENT_WORKER_MAINTENANCE_FIRST_RUN_DELAY_MS: "5000",
      OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS: "0",
    });

    await waitFor(() => staged.size === 4);
    canonicalRevision = "release-ready";
    expect(child.kill("SIGHUP")).toBe(true);
    await waitFor(() => canonical.size === 3);

    expect(child.exitCode).toBeNull();
    expect(new Set(canonical.keys())).toEqual(
      new Set(["fast", "background", "maintenance"]),
    );
    for (const lane of ["fast", "background", "maintenance"]) {
      expect(canonical.get(lane)?.startup).toBe(true);
    }
    for (const observation of canonical.values()) {
      expect(observation.target).toBe(canonicalServer.baseUrl);
    }

    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;
  }, 10_000);

  it("recovers the canonical target after a process restart", async () => {
    const stagedLanes: string[] = [];
    const canonicalRequests: Array<{
      lane: string;
      startup: boolean | undefined;
      target: string | undefined;
    }> = [];
    const stagedServer = await startWorkerServer((lane) => {
      stagedLanes.push(lane);
    });
    const canonicalServer = await startWorkerServer(
      (lane, startup, target) => {
        canonicalRequests.push({ lane, startup, target });
      },
      { healthRevision: "release-ready" },
    );
    const child = startWorker(stagedServer.baseUrl, {
      OMNIAGENT_WORKER_CANONICAL_BASE_URL: canonicalServer.baseUrl,
      OMNIAGENT_RELEASE_SHA: "release-ready",
      OMNIAGENT_WORKER_INTERVAL_MS: "5000",
      OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS: "5000",
      OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS: "5000",
      OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS: "5000",
    });

    await waitFor(() => canonicalRequests.some(({ lane }) => lane === "fast"));
    expect(stagedLanes).toEqual([]);
    expect(canonicalRequests[0]).toMatchObject({
      lane: "fast",
      startup: true,
      target: canonicalServer.baseUrl,
    });
    expect(child.exitCode).toBeNull();

    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;
  }, 10_000);

  it("pins conservative production defaults", async () => {
    const [workerScript, flyConfig, workerImage, releaseEvidence] = await Promise.all([
      readFile("scripts/worker.mjs", "utf8"),
      readFile("fly.toml", "utf8"),
      readFile("Dockerfile.worker", "utf8"),
      readFile("src/lib/release/evidence.ts", "utf8"),
    ]);

    expect(workerScript).toContain("Math.floor(backgroundIntervalMs / 2)");
    expect(workerScript).toContain("if (startupDelayMs > 0)");
    expect(workerScript).toContain(
      "await sleepForWorkerEvent(\n        nextDelayMs,\n        targetGeneration,\n        releaseGeneration,\n      )",
    );
    expect(workerScript).not.toContain("cadenceMs - (Date.now() - startedAt)");
    expect(workerScript).toContain("...(startupAttempt ? { startup: true } : {})");
    expect(workerScript).toContain(
      "if (releaseWorkIsEnabled()) {\n          startup = false;",
    );
    expect(workerScript).toContain("maintenanceFirstRunDelayMs");
    expect(workerScript).toContain("await runHeavyLane(executeTick)");
    expect(workerScript).toContain("await runHeavyLane(runRetentionSweep)");
    expect(workerScript).toContain('process.on("SIGHUP"');
    expect(workerScript).toContain('process.on("SIGUSR1"');
    expect(workerScript).toContain("activateCanonicalWorkerTarget");
    expect(workerScript).toContain("activateReleaseWork");
    expect(workerScript).toContain("Math.max(cadenceMs, 30_000)");
    expect(workerScript).toContain("const canonicalRetryIntervalMs = 30_000");
    expect(workerScript).toContain(
      "!releaseHoldRequested || !releaseHeld",
    );
    expect(workerScript).toContain(
      'const releaseActivationFile = "/tmp/asael-worker-release-activated"',
    );
    expect(workerScript).toContain("body?.revision !== releaseRevision");
    expect(workerScript).toContain('const workerPidFile = "/tmp/asael-worker.pid"');
    expect(workerScript).toContain("OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN");
    expect(workerScript).toContain(
      "previousToken: openAIEgressGatewayPreviousToken",
    );
    expect(workerScript).toContain("15 * 60 * 1_000");
    expect(workerScript).toContain("10 * 60 * 1_000");
    expect(flyConfig).toContain('OMNIAGENT_WORKER_BACKGROUND_INTERVAL_MS = "15000"');
    expect(flyConfig).toContain('OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS = "7500"');
    expect(flyConfig).toContain('OMNIAGENT_WORKER_MAINTENANCE_INTERVAL_MS = "300000"');
    expect(flyConfig).toContain('OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS = "60000"');
    expect(flyConfig).toContain('OMNIAGENT_WORKER_MAINTENANCE_FIRST_RUN_DELAY_MS = "900000"');
    expect(flyConfig).toContain('OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS = "600000"');
    expect(flyConfig).toContain('OMNIAGENT_WORKER_HEARTBEAT_MAX_AGE_MS = "2100000"');
    expect(workerImage).toContain("OMNIAGENT_WORKER_HEARTBEAT_MAX_AGE_MS||2100000");
    expect(releaseEvidence).toContain("2_100_000");
  });

  it("rejects a previous gateway token without a primary token", async () => {
    const { baseUrl } = await startWorkerServer(() => undefined);
    const danglingPreviousToken =
      "dangling-previous-gateway-token-that-is-at-least-32-chars";
    const child = startWorker(baseUrl, {
      OMNIAGENT_OPENAI_GATEWAY_TOKEN: "",
      OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN: danglingPreviousToken,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const [exitCode] = await once(child, "exit");

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN requires OMNIAGENT_OPENAI_GATEWAY_TOKEN",
    );
    expect(stderr).not.toContain(danglingPreviousToken);
  });
});

async function startWorkerServer(
  onRequest: (
    lane: string,
    startup: boolean | undefined,
    target: string | undefined,
  ) => void,
  {
    responseDelayMs = 0,
    responseStatus = () => 200,
    onResponse = () => undefined,
    healthRevision = "release-not-promoted",
  }: {
    responseDelayMs?: number | ((lane: string, attempt: number, startup: boolean | undefined) => number);
    responseStatus?: (lane: string, attempt: number, startup: boolean | undefined) => number;
    onResponse?: (lane: string, startup: boolean | undefined) => void;
    healthRevision?: string | (() => string);
  } = {},
) {
  const attempts = new Map<string, number>();
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "healthy",
        revision:
          typeof healthRevision === "function"
            ? healthRevision()
            : healthRevision,
      }));
      return;
    }
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
    onRequest(
      lane,
      body.startup,
      request.headers["x-omni-worker-target"] as string | undefined,
    );
    const requestDelayMs = typeof responseDelayMs === "function"
      ? responseDelayMs(lane, attempt, body.startup)
      : responseDelayMs;
    if (requestDelayMs > 0) {
      await delay(requestDelayMs);
    }
    response.writeHead(responseStatus(lane, attempt, body.startup), { "content-type": "application/json" });
    response.end(JSON.stringify({ result: { moreAvailable: false } }));
    onResponse(lane, body.startup);
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
      OMNIAGENT_WORKER_CANONICAL_BASE_URL: "",
      OMNIAGENT_INTERNAL_AUTH_SECRET: "worker-test-secret",
      OMNIAGENT_WORKER_INTERVAL_MS: "10000",
      OMNIAGENT_WORKER_BACKGROUND_INTERVAL_MS: "10000",
      OMNIAGENT_WORKER_MAINTENANCE_INTERVAL_MS: "30000",
      OMNIAGENT_WORKER_RETENTION_INTERVAL_MS: "3600000",
      OMNIAGENT_WORKER_RETENTION: "true",
      OMNIAGENT_WORKER_REQUEST_TIMEOUT_MS: "3000",
      OMNIAGENT_WORKER_TARGET_SWITCH_TIMEOUT_MS: "1000",
      OMNIAGENT_RELEASE_SHA: "",
      OMNIAGENT_WORKER_RELEASE_HOLD: "false",
      OMNIAGENT_OPENAI_GATEWAY_TOKEN: "",
      OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN: "",
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

function acceleratedWorkerClock(scale: number) {
  const source = [
    "const realNow = Date.now.bind(Date)",
    "const realSetTimeout = globalThis.setTimeout.bind(globalThis)",
    "const epoch = realNow()",
    `const scale = ${scale}`,
    "Date.now = () => epoch + (realNow() - epoch) * scale",
    "globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, Number(delay) / scale, ...args)",
  ].join(";");
  return `--import=data:text/javascript,${encodeURIComponent(source)}`;
}
