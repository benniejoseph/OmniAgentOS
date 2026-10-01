import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = await mkdtemp(path.join(tmpdir(), "omni-health-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", dataDir);
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "release-b");
});

afterEach(async () => {
  vi.doUnmock("@/lib/db/client");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

async function readHealth(manifest: string | undefined) {
  if (manifest !== undefined) vi.stubEnv("OMNIAGENT_RELEASE_MANIFEST", manifest);
  const { GET } = await import("@/app/api/health/route");
  const response = await GET(new Request("https://asael.test/api/health?public=1"));
  return await response.json() as Record<string, unknown>;
}

describe("GET /api/health release manifest", () => {
  it("serves the manifest the release runner gave this deployment", async () => {
    const manifest = `eyJwYXlsb2FkIjp7fX0_-${"A".repeat(4075)}`;
    expect(manifest).toHaveLength(4096);

    const health = await readHealth(` ${manifest}\n`);

    expect(health).toMatchObject({ revision: "release-b", releaseManifest: manifest });
  });

  it("serves no manifest it was not given in its encoded form", async () => {
    for (const manifest of [
      undefined,
      "",
      "   ",
      "not+base64url/",
      "two words",
      "A".repeat(4097),
    ]) {
      vi.resetModules();
      const health = await readHealth(manifest);

      expect(health.revision).toBe("release-b");
      expect(health).not.toHaveProperty("releaseManifest");
    }
  });
});

describe("GET /api/health release manifest with a database", () => {
  const manifest = "eyJwYXlsb2FkIjp7fX0";

  // What production serves: every answer the database path gives carries the
  // manifest, healthy or not.
  it("serves the manifest in every answer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [name, env, databaseUp, status, httpStatus] of [
      ["healthy", {}, true, "healthy", 200],
      ["missing a production dependency", { VERCEL_ENV: "production", OPENAI_API_KEY: "" }, true, "unhealthy", 503],
      ["database down", {}, false, "unhealthy", 503],
    ] as const) {
      vi.resetModules();
      vi.unstubAllEnvs();
      vi.stubEnv("OMNIAGENT_DATA_DIR", dataDir);
      vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "release-b");
      vi.stubEnv("OMNIAGENT_RELEASE_MANIFEST", manifest);
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      vi.doMock("@/lib/db/client", () => ({
        hasDatabaseUrl: () => true,
        ensureDatabaseSchema: async () => undefined,
        getSql: () => async () => {
          if (!databaseUp) throw new Error("database down");
          return [{ ok: 1 }];
        },
        withDatabaseRequestScope: <T extends unknown[], R>(handler: (...args: T) => R) => handler,
      }));
      const { GET } = await import("@/app/api/health/route");
      const response = await GET(new Request("https://asael.test/api/health"));

      expect({ name, status: response.status }).toEqual({ name, status: httpStatus });
      expect(await response.json()).toMatchObject({
        status,
        revision: "release-b",
        releaseManifest: manifest,
      });
    }
  });
});
