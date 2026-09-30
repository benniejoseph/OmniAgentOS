import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLatestWorkerHeartbeats,
  getWorkerReleaseActivation,
  listWorkerReleaseActivations,
  recordWorkerHeartbeat,
  selectLatestWorkerHeartbeats,
  summarizeWorkerLaneActivity,
  workerHeartbeatMaxAgeMs,
  type WorkerHeartbeat,
  type WorkerReleaseActivation,
} from "@/lib/operations/worker-heartbeat";

describe("worker heartbeat selection", () => {
  it("ignores a newer delayed heartbeat from the replaced worker", () => {
    const currentTarget = "https://omniagent-current.vercel.app";
    const candidates: WorkerHeartbeat[] = [
      heartbeat({
        instanceId: "replacement",
        revision: "current-release",
        target: currentTarget,
        recordedAt: "2026-08-26T16:52:56.000Z",
      }),
      heartbeat({
        instanceId: "replaced",
        revision: "old-release",
        target: "https://asael.bennierichard.com",
        recordedAt: "2026-08-26T16:53:25.000Z",
      }),
    ];

    expect(selectLatestWorkerHeartbeats(candidates, {
      protocol: "1",
      revision: "current-release",
      target: `${currentTarget}/`,
    })).toEqual([candidates[0]]);
  });

  it("returns the newest matching heartbeat for each lane", () => {
    const candidates: WorkerHeartbeat[] = [
      heartbeat({ recordedAt: "2026-08-26T16:52:00.000Z" }),
      heartbeat({ recordedAt: "2026-08-26T16:54:00.000Z" }),
      heartbeat({
        lane: "background",
        recordedAt: "2026-08-26T16:53:00.000Z",
      }),
    ];

    expect(selectLatestWorkerHeartbeats(candidates, {
      protocol: "1",
      revision: "current-release",
      target: "https://omniagent-current.vercel.app",
    })).toEqual([candidates[1], candidates[2]]);
  });

  it("fails closed when the requested target is invalid", () => {
    const candidate = heartbeat({});

    expect(selectLatestWorkerHeartbeats([candidate], {
      target: "not-a-valid-origin",
    })).toEqual([]);
  });
});

describe("worker release activation", () => {
  let dataDir: string;
  const worker = {
    instanceId: "machine-a",
    protocol: "1",
    revision: "release-b",
    target: "https://asael.test",
  };
  const release = { instanceId: "machine-a", revision: "release-b" };
  const at = (time: string) => vi.setSystemTime(new Date(`2026-09-30T${time}Z`));

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "omni-worker-activation-"));
    vi.stubEnv("OMNIAGENT_DATA_DIR", dataDir);
    vi.stubEnv("DATABASE_URL", "");
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("records an activation only when the worker does release work", async () => {
    at("10:00:00.000");
    await recordWorkerHeartbeat({ ...worker, lane: "fast", phase: "startup" });
    expect(await getWorkerReleaseActivation(release)).toBeUndefined();

    at("10:05:00.000");
    await recordWorkerHeartbeat({ ...worker, lane: "fast", phase: "active" });
    at("10:20:00.000");
    await recordWorkerHeartbeat({ ...worker, lane: "maintenance", phase: "active" });
    at("10:25:00.000");
    await recordWorkerHeartbeat({ ...worker, lane: "fast", phase: "active" });
    // A restart registers again; that leaves the activation as it was.
    at("10:30:00.000");
    await recordWorkerHeartbeat({ ...worker, lane: "fast", phase: "startup" });

    expect(await getWorkerReleaseActivation(release)).toEqual({
      instanceId: "machine-a",
      revision: "release-b",
      activatedAt: "2026-09-30T10:05:00.000Z",
      lanes: {
        fast: "2026-09-30T10:25:00.000Z",
        maintenance: "2026-09-30T10:20:00.000Z",
      },
    });
    const fast = (await getLatestWorkerHeartbeats({ revision: "release-b" }))
      .find((item) => item.lane === "fast");
    expect(fast).toMatchObject({
      phase: "startup",
      recordedAt: "2026-09-30T10:30:00.000Z",
    });
  });

  it("matches an activation to its own machine and release only", async () => {
    at("10:05:00.000");
    await recordWorkerHeartbeat({ ...worker, lane: "fast", phase: "active" });
    // A record without a machine name is nobody's to resume.
    await recordWorkerHeartbeat({
      ...worker,
      instanceId: "",
      lane: "fast",
      phase: "active",
    });

    await expect(getWorkerReleaseActivation({
      instanceId: "machine-b",
      revision: "release-b",
    })).resolves.toBeUndefined();
    await expect(getWorkerReleaseActivation({
      instanceId: "machine-a",
      revision: "release-c",
    })).resolves.toBeUndefined();
    for (const instanceId of ["", " "]) {
      await expect(getWorkerReleaseActivation({
        instanceId,
        revision: "release-b",
      })).resolves.toBeUndefined();
    }
    await expect(getWorkerReleaseActivation({
      instanceId: "machine-a",
      revision: "",
    })).resolves.toBeUndefined();
    await expect(getWorkerReleaseActivation(release)).resolves.toMatchObject({
      instanceId: "machine-a",
      revision: "release-b",
    });
  });

  it("records no activation for a worker that names no revision", async () => {
    at("10:05:00.000");
    await recordWorkerHeartbeat({
      ...worker,
      revision: undefined,
      lane: "fast",
      phase: "active",
    });

    await expect(listWorkerReleaseActivations()).resolves.toEqual([]);
  });

  it("lists one release's activations across its machines", async () => {
    at("10:05:00.000");
    await recordWorkerHeartbeat({ ...worker, lane: "fast", phase: "active" });
    await recordWorkerHeartbeat({
      ...worker,
      instanceId: "machine-b",
      lane: "background",
      phase: "active",
    });
    await recordWorkerHeartbeat({
      ...worker,
      revision: "release-a",
      lane: "fast",
      phase: "active",
    });

    const current = await listWorkerReleaseActivations({ revision: "release-b" });
    expect(current.map((item) => item.instanceId).sort()).toEqual([
      "machine-a",
      "machine-b",
    ]);
    await expect(listWorkerReleaseActivations()).resolves.toHaveLength(3);
  });
});

describe("worker lane activity", () => {
  const now = Date.parse("2026-09-30T11:00:00.000Z");
  const maxAgeMs = 30 * 60_000;

  it("takes each lane's latest work across machines", () => {
    expect(summarizeWorkerLaneActivity([
      activation({
        instanceId: "machine-a",
        activatedAt: "2026-09-30T10:00:00.000Z",
        lanes: {
          fast: "2026-09-30T10:10:00.000Z",
          background: "2026-09-30T10:50:00.000Z",
        },
      }),
      activation({
        instanceId: "machine-b",
        activatedAt: "2026-09-30T10:40:00.000Z",
        lanes: { fast: "2026-09-30T10:58:00.000Z" },
      }),
    ], { maxAgeMs, now })).toEqual([
      { lane: "fast", status: "fresh", ageMs: 2 * 60_000 },
      { lane: "background", status: "fresh", ageMs: 10 * 60_000 },
      // No maintenance pass yet: the lane counts from the latest activation.
      { lane: "maintenance", status: "fresh", ageMs: 20 * 60_000 },
    ]);
  });

  it("reports a quiet lane stale and a release with no worker missing", () => {
    expect(summarizeWorkerLaneActivity([
      activation({
        activatedAt: "2026-09-30T10:00:00.000Z",
        lanes: {
          fast: "2026-09-30T10:29:59.000Z",
          background: "2026-09-30T10:30:00.000Z",
        },
      }),
    ], { maxAgeMs, now })).toEqual([
      { lane: "fast", status: "stale", ageMs: maxAgeMs + 1_000 },
      { lane: "background", status: "fresh", ageMs: maxAgeMs },
      { lane: "maintenance", status: "stale", ageMs: 60 * 60_000 },
    ]);
    expect(summarizeWorkerLaneActivity([], { maxAgeMs, now })).toEqual([
      { lane: "fast", status: "missing" },
      { lane: "background", status: "missing" },
      { lane: "maintenance", status: "missing" },
    ]);
  });

  it("skips unreadable times and never reports a negative age", () => {
    expect(summarizeWorkerLaneActivity([
      activation({
        activatedAt: "not a time",
        lanes: { fast: "2026-09-30T11:05:00.000Z" },
      }),
    ], { maxAgeMs, now })).toEqual([
      { lane: "fast", status: "fresh", ageMs: 0 },
      { lane: "background", status: "missing" },
      { lane: "maintenance", status: "missing" },
    ]);
  });

  it("reads the heartbeat age limit from the environment", () => {
    vi.stubEnv("OMNIAGENT_WORKER_HEARTBEAT_MAX_AGE_MS", "600000");
    expect(workerHeartbeatMaxAgeMs()).toBe(600_000);
    for (const value of ["", "0", "-5", "1.5", "soon"]) {
      vi.stubEnv("OMNIAGENT_WORKER_HEARTBEAT_MAX_AGE_MS", value);
      expect(workerHeartbeatMaxAgeMs()).toBe(2_100_000);
    }
    vi.unstubAllEnvs();
  });
});

function activation(
  overrides: Partial<WorkerReleaseActivation>,
): WorkerReleaseActivation {
  return {
    instanceId: "machine-a",
    revision: "release-b",
    activatedAt: "2026-09-30T10:00:00.000Z",
    lanes: {},
    ...overrides,
  };
}

function heartbeat(
  overrides: Partial<WorkerHeartbeat>,
): WorkerHeartbeat {
  return {
    instanceId: "current-worker",
    lane: "fast",
    phase: "active",
    protocol: "1",
    revision: "current-release",
    target: "https://omniagent-current.vercel.app",
    recordedAt: "2026-08-26T16:52:00.000Z",
    ...overrides,
  };
}
