import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  releaseSigningKeyId,
  signReleaseManifest,
} from "../../../scripts/release-manifest.mjs";
import { REQUIRED_RELEASE_CHECKS } from "../../../scripts/release-provenance.mjs";
import {
  assessReleaseManifestHealth,
  waitForReleaseManifestConvergence,
} from "../../../scripts/smoke-release-manifest.mjs";

const revision = "a53a77aee2e1056f8989cc19b24b0a6a620cf084";
const otherRevision = "0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4";
const keyPair = generateKeyPairSync("ed25519");
const key = {
  privateKey: keyPair.privateKey,
  publicKey: keyPair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  keyId: releaseSigningKeyId(keyPair.publicKey),
};

function manifestFor(signed: string) {
  return signReleaseManifest(
    {
      version: 1,
      revision: signed,
      repository: "benniejoseph/OmniAgentOS",
      branch: "main",
      checks: [...REQUIRED_RELEASE_CHECKS],
      signedAt: "2026-10-01T12:00:00.000Z",
    },
    key,
  );
}

describe("assessReleaseManifestHealth", () => {
  const options = { publicKeys: [key.publicKey] };

  it("passes a deployment that serves a trusted manifest for its own revision", () => {
    expect(
      assessReleaseManifestHealth(
        { status: "ok", revision, releaseManifest: manifestFor(revision) },
        revision,
        options,
      ),
    ).toEqual({
      valid: true,
      keyId: key.keyId,
      manifest: expect.objectContaining({ revision, signedAt: "2026-10-01T12:00:00.000Z" }),
    });
  });

  it("fails a deployment that serves another revision than the one expected", () => {
    const releaseManifest = manifestFor(revision);

    for (const [health, served] of [
      [{ revision: otherRevision, releaseManifest }, otherRevision],
      [{ releaseManifest }, "missing"],
      [{ revision: 7, releaseManifest }, "missing"],
      [{ revision: "r".repeat(120), releaseManifest }, "r".repeat(80)],
      [undefined, "missing"],
      ["ok", "missing"],
    ] as const) {
      expect(() => assessReleaseManifestHealth(health, revision, options)).toThrow(
        `deployment revision mismatch: expected ${revision}, got ${served}.`,
      );
    }
  });

  it("fails a deployment whose manifest no trusted key signed for what it serves", () => {
    expect(() => assessReleaseManifestHealth({ revision }, revision, options)).toThrow(
      "the deployment's release manifest is missing.",
    );
    expect(() =>
      assessReleaseManifestHealth(
        { revision, releaseManifest: manifestFor(revision) },
        revision,
        { publicKeys: [] },
      ),
    ).toThrow(
      `the deployment's release manifest is signed by key ${key.keyId}, which this repository does not trust.`,
    );
    // A manifest copied from another release.
    expect(() =>
      assessReleaseManifestHealth(
        { revision, releaseManifest: manifestFor(otherRevision) },
        revision,
        options,
      ),
    ).toThrow(
      `the release manifest signs ${otherRevision}, but the deployment serves ${revision}.`,
    );
  });

  it("trusts only the keys this repository commits by default", () => {
    expect(() =>
      assessReleaseManifestHealth(
        { revision, releaseManifest: manifestFor(revision) },
        revision,
      ),
    ).toThrow(
      `the deployment's release manifest is signed by key ${key.keyId}, which this repository does not trust.`,
    );
  });

  it("can bind verification to the exact manifest signed by this runner", () => {
    const encoded = manifestFor(revision);
    const health = { revision, releaseManifest: encoded };
    const expectedManifestSha256 = createHash("sha256").update(encoded).digest("hex");
    expect(assessReleaseManifestHealth(health, revision, {
      ...options,
      expectedManifestSha256,
    }).valid).toBe(true);
    expect(() => assessReleaseManifestHealth(health, revision, {
      ...options,
      expectedManifestSha256: "0".repeat(64),
    })).toThrow("the release manifest differs from the runner's signed candidate.");
  });
});

describe("canonical release manifest convergence", () => {
  const candidateManifest = manifestFor(revision);
  const options = {
    publicKeys: [key.publicKey],
    expectedManifestSha256: createHash("sha256").update(candidateManifest).digest("hex"),
  };
  const candidate = { status: "healthy", revision, releaseManifest: candidateManifest };
  const previous = { status: "healthy", revision: otherRevision, releaseManifest: manifestFor(otherRevision) };

  function response(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("resets its stable count when a signed prior release follows the first candidate response", async () => {
    const observations = [candidate, previous, candidate, candidate, candidate];
    let requests = 0;
    const result = await waitForReleaseManifestConvergence({
      baseUrl: "https://asael.example",
      expectedRevision: revision,
      previousRevision: otherRevision,
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      ...options,
      fetchHealth: async () => response(observations[requests++]),
    });

    expect(requests).toBe(5);
    expect(result).toMatchObject({
      attempts: 5,
      consecutiveMatches: 3,
      manifest: { revision },
    });
  });

  it("times out while the signed previous release keeps appearing", async () => {
    let requests = 0;
    await expect(waitForReleaseManifestConvergence({
      baseUrl: "https://asael.example",
      expectedRevision: revision,
      previousRevision: otherRevision,
      timeoutMs: 35,
      pollIntervalMs: 2,
      ...options,
      fetchHealth: async () => {
        requests += 1;
        return response(previous);
      },
    })).rejects.toThrow(
      `the canonical release manifest did not converge on ${revision} within 35ms`,
    );
    expect(requests).toBeGreaterThan(1);
  });

  it("rejects an unsigned old response and a candidate signed for another revision", async () => {
    for (const health of [
      { status: "healthy", revision: otherRevision },
      { status: "healthy", revision, releaseManifest: manifestFor(otherRevision) },
    ]) {
      await expect(waitForReleaseManifestConvergence({
        baseUrl: "https://asael.example",
        expectedRevision: revision,
        previousRevision: otherRevision,
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        ...options,
        fetchHealth: async () => response(health),
      })).rejects.toThrow(/release manifest/);
    }
  });
});

describe("npm run smoke:manifest", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "asael-smoke-manifest-"));
  const requests = path.join(directory, "requests.log");
  const fetchStub = path.join(directory, "fetch-stub.mjs");
  // Stands in for the deployment: answers every request with the configured
  // health response and records what was asked for.
  writeFileSync(
    fetchStub,
    `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url) => {
  appendFileSync(process.env.FAKE_REQUESTS, String(url) + "\\n");
  return new Response(process.env.FAKE_HEALTH_BODY, {
    status: Number(process.env.FAKE_HEALTH_STATUS),
    headers: { "content-type": "application/json" },
  });
};
`,
  );
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function smoke(env: Record<string, string>) {
    rmSync(requests, { force: true });
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(fetchStub).href, path.resolve("scripts/smoke-release-manifest.mjs")],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH ?? "",
          BASE_URL: "https://asael.example",
          FAKE_REQUESTS: requests,
          FAKE_HEALTH_STATUS: "200",
          FAKE_HEALTH_BODY: JSON.stringify({ status: "ok", revision }),
          ...env,
        },
      },
    );
    let requested: string[] = [];
    try {
      requested = readFileSync(requests, "utf8").split("\n").filter(Boolean);
    } catch {
      // No request was made.
    }
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, requested };
  }

  it("needs the revision the deployment must serve", () => {
    expect(smoke({})).toEqual({
      code: 1,
      stdout: "",
      stderr: "FAIL the release manifest check needs SMOKE_EXPECTED_REVISION.\n",
      requested: [],
    });
  });

  it("fails a deployment that serves no manifest, or none the committed keys signed", () => {
    expect(smoke({ SMOKE_EXPECTED_REVISION: revision })).toEqual({
      code: 1,
      stdout: "",
      stderr: "FAIL the deployment's release manifest is missing.\n",
      requested: ["https://asael.example/api/health"],
    });
    const signedByOtherKey = smoke({
      SMOKE_EXPECTED_REVISION: ` ${revision} `,
      FAKE_HEALTH_STATUS: "503",
      FAKE_HEALTH_BODY: JSON.stringify({
        status: "unhealthy",
        revision,
        releaseManifest: manifestFor(revision),
      }),
    });
    expect(signedByOtherKey).toEqual({
      code: 1,
      stdout: "",
      stderr:
        `FAIL the deployment's release manifest is signed by key ${key.keyId}, which this repository does not trust.\n`,
      requested: ["https://asael.example/api/health"],
    });
  });

  it("fails a deployment that answers anything but health", () => {
    expect(smoke({ SMOKE_EXPECTED_REVISION: revision, FAKE_HEALTH_STATUS: "500" })).toEqual({
      code: 1,
      stdout: "",
      stderr: "FAIL the release manifest check expected health, got HTTP 500.\n",
      requested: ["https://asael.example/api/health"],
    });
    expect(
      smoke({ SMOKE_EXPECTED_REVISION: revision, FAKE_HEALTH_BODY: "<html>" }),
    ).toMatchObject({
      code: 1,
      stderr: `FAIL deployment revision mismatch: expected ${revision}, got missing.\n`,
    });
  });
});
