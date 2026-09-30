import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = await mkdtemp(path.join(tmpdir(), "omni-worker-health-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", dataDir);
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "release-b");
  vi.stubEnv("OMNIAGENT_WORKER_HEARTBEAT_MAX_AGE_MS", "1800000");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
});

afterEach(async () => {
  vi.doUnmock("@/lib/operations/worker-heartbeat");
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

async function workAllLanes(instanceId: string, revision: string) {
  const { recordWorkerHeartbeat } = await import(
    "@/lib/operations/worker-heartbeat"
  );
  for (const lane of ["fast", "background", "maintenance"] as const) {
    await recordWorkerHeartbeat({
      instanceId,
      lane,
      phase: "active",
      protocol: "1",
      revision,
      target: "https://asael.test",
    });
  }
}

async function readWorkerHealth() {
  const { GET } = await import("@/app/api/health/worker/route");
  const response = await GET(
    new Request("https://asael.test/api/health/worker"),
  );
  return { response, body: await response.json() as Record<string, unknown> };
}

describe("GET /api/health/worker", () => {
  it("reports each lane of this release's worker until one goes quiet", async () => {
    await workAllLanes("machine-a", "release-b");
    vi.setSystemTime(new Date("2026-09-30T10:10:00.000Z"));

    const working = await readWorkerHealth();

    expect(working.response.status).toBe(200);
    expect(working.response.headers.get("cache-control")).toBe("private, no-store");
    expect(working.body).toEqual({
      status: "healthy",
      checkedAt: "2026-09-30T10:10:00.000Z",
      revision: "release-b",
      maxAgeMs: 1_800_000,
      lanes: [
        { lane: "fast", status: "fresh", ageMs: 600_000 },
        { lane: "background", status: "fresh", ageMs: 600_000 },
        { lane: "maintenance", status: "fresh", ageMs: 600_000 },
      ],
    });
    expect(JSON.stringify(working.body)).not.toContain("machine-a");

    // Only the fast lane keeps working.
    vi.setSystemTime(new Date("2026-09-30T10:35:00.000Z"));
    const { recordWorkerHeartbeat } = await import(
      "@/lib/operations/worker-heartbeat"
    );
    await recordWorkerHeartbeat({
      instanceId: "machine-a",
      lane: "fast",
      phase: "active",
      protocol: "1",
      revision: "release-b",
      target: "https://asael.test",
    });
    vi.setSystemTime(new Date("2026-09-30T10:40:00.000Z"));
    const quiet = await readWorkerHealth();

    expect(quiet.response.status).toBe(503);
    expect(quiet.body).toMatchObject({
      status: "unhealthy",
      lanes: [
        { lane: "fast", status: "fresh", ageMs: 300_000 },
        { lane: "background", status: "stale", ageMs: 2_400_000 },
        { lane: "maintenance", status: "stale", ageMs: 2_400_000 },
      ],
    });
  });

  it("does not count a worker still running another release", async () => {
    await workAllLanes("machine-a", "release-a");

    const { response, body } = await readWorkerHealth();

    expect(response.status).toBe(503);
    expect(body.lanes).toEqual([
      { lane: "fast", status: "missing" },
      { lane: "background", status: "missing" },
      { lane: "maintenance", status: "missing" },
    ]);
  });

  it("answers an unreadable record without its detail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.doMock("@/lib/operations/worker-heartbeat", async (importOriginal) => ({
      ...(await importOriginal<
        typeof import("@/lib/operations/worker-heartbeat")
      >()),
      listWorkerReleaseActivations: vi.fn(async () => {
        throw new Error("relation omni_system_health_checks is locked");
      }),
    }));

    const { response, body } = await readWorkerHealth();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "unknown",
      revision: "release-b",
      error: "Worker health could not be read",
      code: "unavailable",
    });
    expect(JSON.stringify(body)).not.toContain("omni_system_health_checks");
  });
});
