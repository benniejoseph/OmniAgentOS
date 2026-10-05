import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  releaseSigningKeyId,
  verifyReleaseManifest,
} from "../../../scripts/release-manifest.mjs";
import { assessReleaseManifestHealth } from "../../../scripts/smoke-release-manifest.mjs";

// The runner signs each test release's manifest with this key: outside the
// checkout and readable only by its owner, like the real one.
const signingKeyDirectory = mkdtempSync(
  path.join(tmpdir(), "asael-release-signing-"),
);
const signingKeyPair = generateKeyPairSync("ed25519");
const signingKeyPem = String(
  signingKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }),
);
const signingKeyFile = path.join(signingKeyDirectory, "release-signing-key.pem");
writeFileSync(signingKeyFile, signingKeyPem, { mode: 0o600 });
const signingPublicKey = signingKeyPair.publicKey
  .export({ type: "spki", format: "der" })
  .toString("base64");
const signingKeyId = releaseSigningKeyId(signingKeyPair.publicKey);
const paidVerifierEmail = "owner@example.test";
const paidVerifierPassword = "owner paid-agent password";
afterAll(() => {
  rmSync(signingKeyDirectory, { recursive: true, force: true });
});

describe("paired production deployment", () => {
  it("can reuse exact-commit hosted verification while retaining paired promotion checks", async () => {
    const result = await runProcess(process.execPath,
      ["scripts/deploy-production.mjs", "--dry-run", "--use-hosted-verification"],
      { ...process.env, OMNIAGENT_RELEASE_SHA: "test-release" });
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    const provenance = lines.findIndex((line) => line.includes("verify release provenance"));
    const hosted = lines.findIndex((line) => line.includes("use green exact-commit hosted verification"));
    const stage = lines.findIndex((line) => line.includes("vercel deploy"));
    expect(provenance).toBeGreaterThanOrEqual(0);
    expect(hosted).toBeGreaterThan(provenance);
    expect(stage).toBeGreaterThan(hosted);
    expect(result.stdout).not.toContain("DRY RUN npm run verify");
    expect(result.stdout).toContain("smoke:release");
    expect(result.stdout).toContain("vercel promote");
    expect(result.stdout).toContain("kill -USR1");
  });
  it("keeps the tenant-isolation workflow read to the scoped run list", async () => {
    const tenantSmoke = await readFile(
      "scripts/smoke-tenant-isolation.mjs",
      "utf8",
    );

    expect(tenantSmoke).toContain(
      "/api/workflows?limit=100&stats=false&queue=false",
    );
    expect(tenantSmoke).not.toContain('"/api/workflows?limit=100"');
  });

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
    expect(commands[0]).toBe(
      "DRY RUN verify release provenance revision=test-release is clean HEAD on benniejoseph/OmniAgentOS main with green checks quality,build,audit,integration,worker,gitleaks",
    );
    expect(commands[1]).toBe("DRY RUN npm run verify");
    expect(commands[2]).toContain("npm run smoke:release -- --previous-release");
    expect(commands.filter((command) => command.includes("--previous-release")))
      .toEqual([commands[2]]);
    expect(commands[3]).toContain(
      "vercel deploy --prod --skip-domain --yes",
    );
    expect(commands[3]).toContain(
      "--env OMNIAGENT_RELEASE_SHA=test-release --env OMNIAGENT_RELEASE_MANIFEST=<release manifest signed with OMNIAGENT_RELEASE_SIGNING_KEY_FILE>",
    );
    expect(commands[4]).toContain(
      "wait for staged web readiness at https://staged-deployment.example/api/health revision=test-release",
    );
    // The staged manifest is checked before anything production runs on.
    expect(commands[5]).toBe(
      "DRY RUN BASE_URL=https://staged-deployment.example SMOKE_EXPECTED_REVISION=test-release SMOKE_EXPECTED_MANIFEST_SHA256=<signed-candidate-manifest-sha256> npm run smoke:manifest",
    );
    expect(commands[6]).toContain(
      "stage candidate gateway overlap on Fly through secret stdin; values redacted",
    );
    expect(commands[7]).toContain(
      "fly deploy --app omniagent-os-worker --build-arg OMNIAGENT_RELEASE_SHA=test-release --env OMNIAGENT_WORKER_BASE_URL=https://staged-deployment.example",
    );
    expect(commands[7]).toContain(
      "--env OMNIAGENT_WORKER_CANONICAL_BASE_URL=https://asael.bennierichard.com",
    );
    expect(commands[7]).toContain(
      "--env OMNIAGENT_WORKER_RELEASE_HOLD=true",
    );
    expect(commands[7]).toContain("--strategy bluegreen");
    expect(commands[8]).toContain(
      "wait for staged gateway active+optional-previous token readiness at /healthz revision=test-release region=iad protocol=1",
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
      command.includes("fly ssh console --app omniagent-os-worker") &&
      command.includes("/tmp/asael-worker.pid") &&
      command.includes("kill -HUP"),
    );
    const canonicalReadinessIndex = commands.findIndex((command) =>
      command.includes("wait for canonical web readiness") &&
      command.includes("https://asael.bennierichard.com/api/health") &&
      command.includes("revision=test-release"),
    );
    const canonicalManifestIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://asael.bennierichard.com") &&
      command.includes("SMOKE_EXPECTED_REVISION=test-release") &&
      command.includes("SMOKE_EXPECTED_MANIFEST_SHA256=<signed-candidate-manifest-sha256>") &&
      command.includes("SMOKE_MANIFEST_PREVIOUS_REVISION=<current-production-revision>") &&
      command.includes("SMOKE_MANIFEST_CONVERGENCE_TIMEOUT_MS=180000") &&
      command.includes("npm run smoke:manifest"),
    );
    const canonicalSmokeIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://asael.bennierichard.com") &&
      command.includes("npm run test:production-smoke"),
    );
    const canonicalPreviewIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://asael.bennierichard.com") &&
      command.includes("npm run benchmark:preview"),
    );
    const canonicalDashboardIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://asael.bennierichard.com") &&
      command.includes("npm run benchmark:dashboard"),
    );
    const workerActivationIndex = commands.findIndex((command) =>
      command.includes("fly ssh console --app omniagent-os-worker") &&
      command.includes("kill -USR1") &&
      command.includes("/tmp/asael-worker-release-activated") &&
      command.includes("expected_revision=") &&
      command.includes("test-release"),
    );
    const activatedWorkerSettleIndex = commands.findIndex((command) =>
      command.includes(
        "wait for activated canonical worker target registration window",
      ),
    );
    const postActivationSecurityIndex = commands.findIndex(
      (command, index) =>
        index > workerActivationIndex &&
        command.includes("BASE_URL=https://asael.bennierichard.com") &&
        command.includes("OMNIAGENT_REQUIRE_ACTIVE_WORKER_HEARTBEATS=true") &&
        command.includes(
          "OMNIAGENT_WORKER_HEARTBEAT_NOT_BEFORE=<activation-started-at>",
        ) &&
        command.includes("npm run smoke:security"),
    );
    const postActivationEvidenceIndex = commands.findIndex(
      (command, index) =>
        index > workerActivationIndex &&
        command.includes("BASE_URL=https://asael.bennierichard.com") &&
        command.includes("OMNIAGENT_REQUIRE_ACTIVE_WORKER_HEARTBEATS=true") &&
        command.includes(
          "OMNIAGENT_WORKER_HEARTBEAT_NOT_BEFORE=<activation-started-at>",
        ) &&
        command.includes("npm run smoke:release"),
    );
    const workerActivationCommand = commands[workerActivationIndex];
    expect(commands[canonicalWorkerIndex]).toContain("--command sh -c ");
    expect(commands[canonicalWorkerIndex]).not.toContain("--command read ");
    expect(workerActivationCommand).toContain("--command sh -c ");
    const commandMarker = " --command ";
    const activationShell = workerActivationCommand
      ? workerActivationCommand.slice(
          workerActivationCommand.indexOf(commandMarker) + commandMarker.length,
        )
      : "";
    const activationSyntax = await runProcess(
      "/bin/sh",
      ["-n", "-c", activationShell],
      process.env,
    );
    expect(activationSyntax.code).toBe(0);
    const stagedGatewayIndex = commands.findIndex((command) =>
      command.includes("wait for staged gateway") &&
      command.includes("token readiness") &&
      command.includes("revision=test-release") &&
      command.includes("region=iad") &&
      command.includes("protocol=1"),
    );
    const canonicalGatewayIndex = commands.findIndex((command) =>
      command.includes("wait for canonical gateway") &&
      command.includes("token readiness") &&
      command.includes("revision=test-release") &&
      command.includes("region=iad") &&
      command.includes("protocol=1"),
    );
    const gatewayTokenStageIndex = commands.findIndex((command) =>
      command.includes("stage candidate gateway overlap") &&
      command.includes("values redacted"),
    );
    const stagedWorkerIndex = commands.findIndex((command) =>
      command.includes("fly deploy") &&
      command.includes("OMNIAGENT_WORKER_BASE_URL=https://staged-deployment.example"),
    );
    const stagedWorkerSettleIndex = commands.findIndex((command) =>
      command.includes("wait for staged worker target registration window"),
    );
    const stagedPaidIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://staged-deployment.example") &&
      command.includes("EXPECTED_REVISION=test-release") &&
      command.includes("LIVE_VERIFY_PAID_OPENAI=CONFIRMED") &&
      command.includes("npm run smoke:paid-agent"),
    );
    const canonicalWorkerSettleIndex = commands.findIndex((command) =>
      command.includes("wait for canonical worker target registration window"),
    );
    const canonicalPaidIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://asael.bennierichard.com") &&
      command.includes("EXPECTED_REVISION=test-release") &&
      command.includes("LIVE_VERIFY_PAID_OPENAI=CONFIRMED") &&
      command.includes("npm run smoke:paid-agent"),
    );
    expect(gatewayTokenStageIndex).toBeGreaterThan(5);
    expect(stagedWorkerIndex).toBeGreaterThan(gatewayTokenStageIndex);
    expect(stagedGatewayIndex).toBeGreaterThan(stagedWorkerIndex);
    expect(stagedWorkerSettleIndex).toBeGreaterThan(stagedGatewayIndex);
    expect(stagedPaidIndex).toBeGreaterThan(stagedWorkerSettleIndex);
    expect(stagedSmokeIndex).toBeGreaterThan(stagedPaidIndex);
    expect(stagedPreviewIndex).toBeGreaterThan(stagedSmokeIndex);
    expect(stagedDashboardIndex).toBeGreaterThan(stagedPreviewIndex);
    expect(promoteIndex).toBeGreaterThan(stagedDashboardIndex);
    expect(canonicalReadinessIndex).toBeGreaterThan(promoteIndex);
    expect(canonicalManifestIndex).toBe(canonicalReadinessIndex + 1);
    expect(canonicalWorkerIndex).toBeGreaterThan(canonicalManifestIndex);
    expect(canonicalGatewayIndex).toBeGreaterThan(canonicalWorkerIndex);
    expect(canonicalWorkerSettleIndex).toBeGreaterThan(canonicalGatewayIndex);
    expect(canonicalPaidIndex).toBeGreaterThan(canonicalWorkerSettleIndex);
    expect(canonicalSmokeIndex).toBeGreaterThan(canonicalPaidIndex);
    expect(canonicalPreviewIndex).toBeGreaterThan(canonicalSmokeIndex);
    expect(canonicalDashboardIndex).toBeGreaterThan(canonicalPreviewIndex);
    expect(workerActivationIndex).toBeGreaterThan(canonicalDashboardIndex);
    expect(activatedWorkerSettleIndex).toBeGreaterThan(workerActivationIndex);
    expect(postActivationSecurityIndex).toBeGreaterThan(
      activatedWorkerSettleIndex,
    );
    expect(postActivationEvidenceIndex).toBeGreaterThan(
      postActivationSecurityIndex,
    );
    expect(
      commands.filter((command) => command.includes("fly deploy")),
    ).toHaveLength(1);
    expect(result.stdout).not.toContain("--image registry.fly.io");
    expect(result.stdout).not.toContain("OMNIAGENT_OPENAI_GATEWAY_TOKEN=");
    expect(result.stdout).not.toContain("OPENAI_API_KEY=");
  });

  it("proves release provenance before local verification or any deploy", async () => {
    const head = "a53a77aee2e1056f8989cc19b24b0a6a620cf084";
    const onMain = JSON.stringify({ status: "behind", ahead_by: 0, behind_by: 2 });

    await withFakeReleaseTools(async ({ environment, readLog }) => {
      const release = {
        ...environment,
        ...releaseConfigurationEnvironment(),
        FAKE_GIT_HEAD: head,
        FAKE_GH_COMPARE: onMain,
        FAKE_GH_CHECKS: releaseCheckRunsJson(head, {
          "macos-policy": "success",
          "production-smoke": "failure",
        }),
      };

      const mislabeled = await runProcess(
        process.execPath,
        ["scripts/deploy-production.mjs"],
        {
          ...release,
          OMNIAGENT_RELEASE_SHA: "0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4",
        },
      );
      expect(mislabeled.code).toBe(1);
      expect(mislabeled.stderr).toContain(`does not match HEAD ${head}`);
      expect(await readLog()).toEqual([
        "git status --porcelain",
        "git rev-parse HEAD",
      ]);

      const offMain = await runProcess(
        process.execPath,
        ["scripts/deploy-production.mjs"],
        {
          ...release,
          OMNIAGENT_RELEASE_SHA: head,
          FAKE_GH_COMPARE: JSON.stringify({
            status: "ahead",
            ahead_by: 1,
            behind_by: 0,
          }),
        },
      );
      expect(offMain.code).toBe(1);
      expect(offMain.stderr).toContain(
        "is not on benniejoseph/OmniAgentOS main",
      );
      expect((await readLog()).some((line) => line.startsWith("npm "))).toBe(
        false,
      );

      const redChecks = await runProcess(
        process.execPath,
        ["scripts/deploy-production.mjs"],
        {
          ...release,
          OMNIAGENT_RELEASE_SHA: head,
          FAKE_GH_CHECKS: releaseCheckRunsJson(head, {
            integration: "failure",
          }),
        },
      );
      expect(redChecks.code).toBe(1);
      expect(redChecks.stderr).toContain("integration is failure");
      expect((await readLog()).some((line) => line.startsWith("npm "))).toBe(
        false,
      );

      const unauthenticated = await runProcess(
        process.execPath,
        ["scripts/deploy-production.mjs"],
        {
          ...release,
          OMNIAGENT_RELEASE_SHA: head,
          FAKE_GH_FAIL: "HTTP 401: Bad credentials",
        },
      );
      expect(unauthenticated.code).toBe(1);
      expect(unauthenticated.stderr).toContain(
        "failed with exit code 4: HTTP 401: Bad credentials",
      );
      expect((await readLog()).some((line) => line.startsWith("npm "))).toBe(
        false,
      );

      const proven = await runProcess(
        process.execPath,
        ["scripts/deploy-production.mjs"],
        { ...release, OMNIAGENT_RELEASE_SHA: "" },
      );
      expect(proven.code).toBe(1);
      expect(proven.stdout).toContain(
        `Release ${head} is 2 commits behind main on benniejoseph/OmniAgentOS with green checks: audit, build, gitleaks, integration, macos-policy, quality, worker.`,
      );
      expect(proven.stderr).toContain("Production verification failed");
      expect(await readLog()).toEqual([
        "git rev-parse HEAD",
        "git status --porcelain",
        "git rev-parse HEAD",
        `gh api --hostname github.com --method GET repos/benniejoseph/OmniAgentOS/compare/main...${head} --jq {status, ahead_by, behind_by}`,
        `gh api --hostname github.com --method GET repos/benniejoseph/OmniAgentOS/commits/${head}/check-runs?filter=latest&per_page=100`,
        "npm run verify",
      ]);
    });
  });

  it("checks provenance without deploying and refuses a dirty checkout", async () => {
    const head = "a53a77aee2e1056f8989cc19b24b0a6a620cf084";
    await withFakeReleaseTools(async ({ environment, readLog }) => {
      const probeEnvironment = {
        ...environment,
        OMNIAGENT_RELEASE_SHA: "",
        FAKE_GIT_HEAD: head,
        FAKE_GH_COMPARE: JSON.stringify({
          status: "identical",
          ahead_by: 0,
          behind_by: 0,
        }),
        FAKE_GH_CHECKS: releaseCheckRunsJson(head),
      };

      const dirty = await runProcess(
        process.execPath,
        ["scripts/deploy-production.mjs", "--provenance-probe"],
        { ...probeEnvironment, FAKE_GIT_STATUS: "?? untracked.txt" },
      );
      expect(dirty.code).toBe(1);
      expect(dirty.stderr).toContain("requires a clean working tree");
      expect((await readLog()).some((line) => line.startsWith("gh "))).toBe(
        false,
      );

      const clean = await runProcess(
        process.execPath,
        ["scripts/deploy-production.mjs", "--provenance-probe"],
        probeEnvironment,
      );
      expect(clean.code).toBe(0);
      expect(clean.stdout).toContain(
        `Release ${head} is the tip of main on benniejoseph/OmniAgentOS`,
      );
      expect(
        (await readLog()).filter((line) => /^(?:npm|vercel|fly) /.test(line)),
      ).toEqual([]);
    });
  });

  it("requires a complete safe gateway configuration for the Singapore topology", async () => {
    const evidenceOutput = path.join(
      tmpdir(),
      `asael-release-evidence-test-${process.pid}.json`,
    );
    const baseEnvironment = {
      ...process.env,
      OMNIAGENT_RELEASE_SHA: "release-ready",
      BASE_URL: "https://asael.bennierichard.com",
      OMNIAGENT_INTERNAL_AUTH_SECRET: "internal-test-secret",
      OPENAI_API_KEY: "",
      RELEASE_EVIDENCE_OUTPUT: evidenceOutput,
      OMNIAGENT_OPENAI_GATEWAY_URL: "",
      OMNIAGENT_OPENAI_GATEWAY_TOKEN: "",
      OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN: "",
      OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER: "",
      OMNIAGENT_RELEASE_SPLIT_RECOVERY: "",
      OMNIAGENT_RELEASE_SIGNING_KEY_FILE: signingKeyFile,
      SMOKE_PAID_AGENT_EMAIL: paidVerifierEmail,
      SMOKE_PAID_AGENT_PASSWORD: paidVerifierPassword,
    };
    const missing = await runProcess(
      process.execPath,
      ["scripts/deploy-production.mjs", "--configuration-probe"],
      baseEnvironment,
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      "Singapore releases require OMNIAGENT_OPENAI_GATEWAY_URL and OMNIAGENT_OPENAI_GATEWAY_TOKEN",
    );

    const token = "gateway_token_abcdefghijklmnopqrstuvwxyz123456";
    const valid = await runProcess(
      process.execPath,
      ["scripts/deploy-production.mjs", "--configuration-probe"],
      {
        ...baseEnvironment,
        OMNIAGENT_OPENAI_GATEWAY_URL:
          "https://omniagent-os-worker.fly.dev/v1",
        OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
      },
    );
    expect(valid.code).toBe(0);
    expect(valid.stdout).toContain(
      "Production release configuration is valid.",
    );
    expect(valid.stdout).toContain(
      `Release manifests are signed with key ${signingKeyId}.`,
    );
    expect(`${valid.stdout}\n${valid.stderr}`).not.toContain(token);

    const trailingSlash = await runProcess(
      process.execPath,
      ["scripts/deploy-production.mjs", "--configuration-probe"],
      {
        ...baseEnvironment,
        BASE_URL: "https://asael.bennierichard.com/",
        OMNIAGENT_OPENAI_GATEWAY_URL:
          "https://omniagent-os-worker.fly.dev/v1",
        OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
      },
    );
    expect(trailingSlash.code).toBe(0);

    for (const invalidBaseUrl of [
      "http://omniagent-os.vercel.app",
      "https://asael.bennierichard.com:443",
      "https://asael.bennierichard.com:8443",
      "https://user@omniagent-os.vercel.app",
      "https://asael.bennierichard.com/path",
      "https://asael.bennierichard.com?target=other",
      "https://asael.bennierichard.com#other",
      "https://other-project.vercel.app",
    ]) {
      const invalid = await runProcess(
        process.execPath,
        ["scripts/deploy-production.mjs", "--configuration-probe"],
        {
          ...baseEnvironment,
          BASE_URL: invalidBaseUrl,
          OMNIAGENT_OPENAI_GATEWAY_URL:
            "https://omniagent-os-worker.fly.dev/v1",
          OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
        },
      );
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain(
        "BASE_URL must be exactly https://asael.bennierichard.com",
      );
    }

    const previousToken = "gateway_previous_abcdefghijklmnopqrstuvwxyz987654";
    const rotating = await runProcess(
      process.execPath,
      ["scripts/deploy-production.mjs", "--configuration-probe"],
      {
        ...baseEnvironment,
        OMNIAGENT_OPENAI_GATEWAY_URL:
          "https://omniagent-os-worker.fly.dev:443/v1/",
        OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
        OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN: previousToken,
      },
    );
    expect(rotating.code).toBe(0);
    expect(`${rotating.stdout}\n${rotating.stderr}`).not.toContain(token);
    expect(`${rotating.stdout}\n${rotating.stderr}`).not.toContain(previousToken);

    const initialCutover = await runProcess(
      process.execPath,
      ["scripts/deploy-production.mjs", "--configuration-probe"],
      {
        ...baseEnvironment,
        OMNIAGENT_OPENAI_GATEWAY_URL:
          "https://omniagent-os-worker.fly.dev/v1",
        OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
        OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER: "CONFIRMED",
      },
    );
    expect(initialCutover.code).toBe(0);

    const invalidInitialRotation = await runProcess(
      process.execPath,
      ["scripts/deploy-production.mjs", "--configuration-probe"],
      {
        ...baseEnvironment,
        OMNIAGENT_OPENAI_GATEWAY_URL:
          "https://omniagent-os-worker.fly.dev/v1",
        OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
        OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN: previousToken,
        OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER: "CONFIRMED",
      },
    );
    expect(invalidInitialRotation.code).toBe(1);
    expect(invalidInitialRotation.stderr).toContain(
      "cannot be used with OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN",
    );

    const unconfirmedInitialCutover = await runProcess(
      process.execPath,
      ["scripts/deploy-production.mjs", "--configuration-probe"],
      {
        ...baseEnvironment,
        OMNIAGENT_OPENAI_GATEWAY_URL:
          "https://omniagent-os-worker.fly.dev/v1",
        OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
        OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER: "true",
      },
    );
    expect(unconfirmedInitialCutover.code).toBe(1);
    expect(unconfirmedInitialCutover.stderr).toContain("must equal CONFIRMED");

    const gatewayEnvironment = {
      ...baseEnvironment,
      OMNIAGENT_OPENAI_GATEWAY_URL: "https://omniagent-os-worker.fly.dev/v1",
      OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
    };
    for (const [overrides, error] of [
      [{ OMNIAGENT_RELEASE_SPLIT_RECOVERY: "CONFIRMED" }, ""],
      [
        { OMNIAGENT_RELEASE_SPLIT_RECOVERY: "true" },
        "OMNIAGENT_RELEASE_SPLIT_RECOVERY must equal CONFIRMED",
      ],
      [
        {
          OMNIAGENT_RELEASE_SPLIT_RECOVERY: "CONFIRMED",
          OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN: previousToken,
        },
        "OMNIAGENT_RELEASE_SPLIT_RECOVERY cannot be used with OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN",
      ],
      [
        {
          OMNIAGENT_RELEASE_SPLIT_RECOVERY: "CONFIRMED",
          OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER: "CONFIRMED",
        },
        "OMNIAGENT_RELEASE_SPLIT_RECOVERY cannot be used with OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER",
      ],
    ] as const) {
      const splitRecovery = await runProcess(
        process.execPath,
        ["scripts/deploy-production.mjs", "--configuration-probe"],
        { ...gatewayEnvironment, ...overrides },
      );
      expect(splitRecovery.code).toBe(error ? 1 : 0);
      expect(splitRecovery.stderr).toContain(error);
    }

    const duplicate = await runProcess(
      process.execPath,
      ["scripts/deploy-production.mjs", "--configuration-probe"],
      {
        ...baseEnvironment,
        OMNIAGENT_OPENAI_GATEWAY_URL:
          "https://omniagent-os-worker.fly.dev/v1",
        OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
        OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN: token,
      },
    );
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain(
      "must differ from OMNIAGENT_OPENAI_GATEWAY_TOKEN",
    );
    expect(`${duplicate.stdout}\n${duplicate.stderr}`).not.toContain(token);

    for (const invalidUrl of [
      "https://example.com/v1",
      "https://omniagent-os-worker.fly.dev:8443/v1",
      "https://omniagent-os-worker.fly.dev/v1/extra",
    ]) {
      const invalid = await runProcess(
        process.execPath,
        ["scripts/deploy-production.mjs", "--configuration-probe"],
        {
          ...baseEnvironment,
          OMNIAGENT_OPENAI_GATEWAY_URL: invalidUrl,
          OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
        },
      );
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain(
        "must be exactly https://omniagent-os-worker.fly.dev/v1",
      );
    }
  });

  it("refuses a signing key that is missing, readable by others, or in the checkout", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "asael-signing-probe-"));
    try {
      const groupReadable = path.join(directory, "group-readable.pem");
      await copyFile(signingKeyFile, groupReadable);
      await chmod(groupReadable, 0o640);
      // A link from outside resolves into the checkout the deploy uploads.
      const intoCheckout = path.join(directory, "checkout-link.pem");
      await symlink(path.resolve("package.json"), intoCheckout);
      for (const [file, error] of [
        [
          "",
          "Production release configuration is missing: OMNIAGENT_RELEASE_SIGNING_KEY_FILE.",
        ],
        [
          groupReadable,
          "OMNIAGENT_RELEASE_SIGNING_KEY_FILE must be readable only by its owner (chmod 600).",
        ],
        [
          intoCheckout,
          "OMNIAGENT_RELEASE_SIGNING_KEY_FILE must be outside the release checkout, which the deploy uploads.",
        ],
      ] as const) {
        const probe = await runProcess(
          process.execPath,
          ["scripts/deploy-production.mjs", "--configuration-probe"],
          {
            ...process.env,
            ...releaseConfigurationEnvironment(),
            OMNIAGENT_RELEASE_SHA: "release-ready",
            OMNIAGENT_RELEASE_SIGNING_KEY_FILE: file,
          },
        );
        expect(probe.code).toBe(1);
        expect(probe.stderr).toContain(error);
        expect(probe.stdout).not.toContain("configuration is valid");
        expectNoSigningKey(probe);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires the paid verification account before any deploy and never prints it", async () => {
    const probe = (overrides: Record<string, string>) =>
      runProcess(
        process.execPath,
        ["scripts/deploy-production.mjs", "--configuration-probe"],
        {
          ...process.env,
          ...releaseConfigurationEnvironment(),
          OMNIAGENT_RELEASE_SHA: "release-ready",
          ...overrides,
        },
      );

    const missing = await probe({
      SMOKE_PAID_AGENT_EMAIL: "",
      SMOKE_PAID_AGENT_PASSWORD: " ",
    });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      "Production release configuration is missing: SMOKE_PAID_AGENT_EMAIL, SMOKE_PAID_AGENT_PASSWORD.",
    );
    expect(missing.stdout).not.toContain("configuration is valid");

    const valid = await probe({});
    const output = `${valid.stdout}\n${valid.stderr}`;
    expect(valid.code, output).toBe(0);
    expect(valid.stdout).toContain("Production release configuration is valid.");
    expect(output).not.toContain(paidVerifierEmail);
    expect(output).not.toContain(paidVerifierPassword);
  });

  it("requires a configured model only for the optional paid gateway diagnostic", async () => {
    const token = "gateway_token_abcdefghijklmnopqrstuvwxyz123456";
    const result = await runProcess(
      process.execPath,
      [
        "scripts/deploy-production.mjs",
        "--gateway-paid-probe",
        "http://127.0.0.1:1/v1",
        "release-ready",
      ],
      {
        ...process.env,
        OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
        OMNIAGENT_DEPLOY_OPENAI_SMOKE_MODEL: "",
        OPENAI_FAST_MODEL: "",
        OPENAI_AGENT_MODEL: "",
        OPENAI_API_KEY: "",
      },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "OMNIAGENT_DEPLOY_OPENAI_SMOKE_MODEL must be a bounded model identifier.",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(token);
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
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
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

  it("authenticates active and previous gateway tokens without logging either secret", async () => {
    const token = "gateway_token_abcdefghijklmnopqrstuvwxyz123456";
    const previousToken = "gateway_previous_abcdefghijklmnopqrstuvwxyz987654";
    let healthRequests = 0;
    const observedTokens: string[] = [];
    const observedAuthorizations: Array<string | undefined> = [];
    const observedPaths: string[] = [];
    await withHealthServer((request, response) => {
      const observedToken = request.headers["x-asael-gateway-token"] as
        | string
        | undefined;
      observedTokens.push(observedToken || "missing");
      observedAuthorizations.push(request.headers.authorization);
      observedPaths.push(request.url || "missing");
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/models/authorization-probe") {
        response.writeHead(
          observedToken === token || observedToken === previousToken
            ? 400
            : 401,
        );
        response.end(JSON.stringify({ error: "authorization required" }));
        return;
      }
      healthRequests += 1;
      if (healthRequests === 1) {
        response.writeHead(503);
        response.end(JSON.stringify({
          status: "starting",
          service: "asael-openai-egress",
          region: "iad",
          revision: "release-ready",
          protocol: "1",
          secret: token,
        }));
        return;
      }
      response.writeHead(200);
      response.end(JSON.stringify({
        // A draining gateway is not ready; a degraded one still serves.
        status: ["draining", "healthy", "degraded"][healthRequests - 2] ?? "healthy",
        service: "asael-openai-egress",
        region: healthRequests === 3 ? "sin" : "iad",
        revision: "release-ready",
        protocol: "1",
        secret: token,
      }));
    }, async (baseUrl) => {
      const result = await runProcess(
        process.execPath,
        [
          "scripts/deploy-production.mjs",
          "--gateway-readiness-probe",
          `${baseUrl}/v1`,
          "release-ready",
        ],
        gatewayReadinessEnvironment({
          timeoutMs: 3_000,
          token,
          previousToken,
        }),
      );

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(healthRequests).toBe(5);
      expect(observedPaths.filter((value) => value === "/healthz")).toHaveLength(5);
      expect(observedPaths.filter((value) => value === "/v1/models/authorization-probe")).toHaveLength(2);
      expect(observedTokens).toContain(token);
      expect(observedTokens).toContain(previousToken);
      expect(observedAuthorizations.every((value) => value === undefined)).toBe(
        true,
      );
      expect(result.stdout).toContain("http=503");
      expect(result.stdout).toContain("region=false");
      expect(result.stdout).toContain(
        "Gateway readiness probe active token became ready for release release-ready in iad with protocol 1",
      );
      expect(result.stdout).toContain(
        "Gateway readiness probe previous token became ready for release release-ready in iad with protocol 1",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(token);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(previousToken);
    });
  });

  it("runs one bounded, stateless paid inference and verifies gateway/provider usage", async () => {
    const token = "gateway_token_abcdefghijklmnopqrstuvwxyz123456";
    const openAIKey = "sk-test-openai-key-for-paid-release-probe";
    let paidBody: Record<string, unknown> | undefined;
    let paidAuthorization: string | undefined;
    let paidGatewayToken: string | undefined;
    let paidIdempotencyKey: string | undefined;
    const observedPaths: string[] = [];

    await withHealthServer(async (request, response) => {
      observedPaths.push(request.url || "missing");
      response.setHeader("content-type", "application/json");
      if (request.url === "/healthz") {
        response.writeHead(200);
        response.end(JSON.stringify({
          status: "healthy",
          service: "asael-openai-egress",
          region: "iad",
          revision: "release-ready",
          protocol: "1",
        }));
        return;
      }
      if (request.url === "/v1/models/authorization-probe") {
        response.writeHead(400);
        response.end(JSON.stringify({ error: "authorization required" }));
        return;
      }
      if (request.url === "/v1/responses") {
        paidAuthorization = request.headers.authorization;
        paidGatewayToken = request.headers["x-asael-gateway-token"] as
          | string
          | undefined;
        paidIdempotencyKey = request.headers["idempotency-key"] as
          | string
          | undefined;
        paidBody = JSON.parse(await readRequestBody(request)) as Record<
          string,
          unknown
        >;
        response.setHeader("x-asael-gateway-request-id", "gateway-request");
        response.setHeader("x-request-id", "openai-request");
        response.writeHead(200);
        response.end(JSON.stringify({
          id: "resp_release_probe",
          object: "response",
          model: "gpt-4o-mini-2024-07-18",
          usage: {
            input_tokens: 12,
            output_tokens: 5,
            total_tokens: 17,
          },
          output: [{
            type: "message",
            content: [{ type: "output_text", text: "ASAEL_RELEASE_OK" }],
          }],
        }));
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: "unexpected path" }));
    }, async (baseUrl) => {
      const result = await runProcess(
        process.execPath,
        [
          "scripts/deploy-production.mjs",
          "--gateway-paid-probe",
          `${baseUrl}/v1`,
          "release-ready",
        ],
        {
          ...gatewayReadinessEnvironment({ timeoutMs: 3_000, token }),
          OPENAI_API_KEY: openAIKey,
          OMNIAGENT_DEPLOY_OPENAI_SMOKE_MODEL: "gpt-4o-mini",
          OMNIAGENT_DEPLOY_PAID_INFERENCE_TIMEOUT_MS: "5000",
        },
      );

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(observedPaths).toEqual([
        "/healthz",
        "/v1/models/authorization-probe",
        "/v1/responses",
      ]);
      expect(paidAuthorization).toBe(`Bearer ${openAIKey}`);
      expect(paidGatewayToken).toBe(token);
      expect(paidIdempotencyKey).toContain("asael-release-release-ready");
      expect(paidBody).toMatchObject({
        model: "gpt-4o-mini",
        max_output_tokens: 16,
        store: false,
      });
      expect(result.stdout).toContain(
        "provider=openai model=gpt-4o-mini-2024-07-18 inputTokens=12 outputTokens=5 totalTokens=17 revision=release-ready store=false",
      );
      expect(result.stdout).toContain("appData=none");
      const processOutput = `${result.stdout}\n${result.stderr}`;
      expect(processOutput).not.toContain(token);
      expect(processOutput).not.toContain(openAIKey);
      expect(processOutput).not.toContain("Synthetic Asael release verification");
      expect(processOutput).not.toContain("ASAEL_RELEASE_OK");
    });
  });

  it("keeps the smoke, benchmark and worker release wiring", async () => {
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
      releaseEvidenceSmoke,
      flyConfig,
      initialCutoverRollbackConfig,
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
        readFile("scripts/smoke-release-evidence.mjs", "utf8"),
        readFile("fly.toml", "utf8"),
        readFile("fly.initial-cutover-rollback.toml", "utf8"),
      ]);

    expect(deployScript).toContain("asael-release-evidence-");
    expect(deployScript).toContain('SMOKE_REQUEST_TIMEOUT_MS: "60000"');
    expect(deployScript).toContain("OMNIAGENT_OPENAI_GATEWAY_URL");
    expect(deployScript).toContain("OMNIAGENT_OPENAI_GATEWAY_TOKEN");
    expect(deployScript).toContain("OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN");
    expect(deployScript).toContain("OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER");
    expect(deployScript).toContain('"x-asael-gateway-token"');
    expect(deployScript).toContain('new URL("/healthz"');
    expect(deployScript).toContain(
      '`/v1/models/${GATEWAY_AUTHORIZATION_PROBE_ID}`',
    );
    expect(deployScript).toContain("waitForOpenAIGatewayReadiness");
    expect(deployScript).toContain("runPaidOpenAIGatewayInference");
    expect(deployScript).toContain("PAID_INFERENCE_MAX_OUTPUT_TOKENS = 16");
    expect(deployScript).toContain("store: false");
    expect(deployScript).toContain(
      'const PRODUCTION_BASE_URL = "https://asael.bennierichard.com"',
    );
    expect(deployScript).toContain(
      "VERCEL_DEPLOYMENT_HOST_PATTERN.test(url.hostname)",
    );
    expect(deployScript).not.toContain('"cron secret"');
    expect(deployScript).toContain("SMOKE_SESSION_OUTPUT");
    expect(deployScript).toContain("BENCHMARK_SESSION_FILE");
    expect(securitySmoke).toContain("SMOKE_SESSION_OUTPUT");
    expect(previewBenchmark).toContain("BENCHMARK_SESSION_FILE");
    expect(dashboardBenchmark).toContain("BENCHMARK_SESSION_FILE");
    expect(dashboardBenchmark).toContain(
      'const response = await smokeFetch(baseUrl, "/app"',
    );
    expect(dashboardBenchmark).not.toContain('from "playwright"');
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
    expect(flyConfig).toContain('strategy = "bluegreen"');
    expect(flyConfig).toContain('path = "/healthz"');
    expect(initialCutoverRollbackConfig).toContain('strategy = "immediate"');
    expect(initialCutoverRollbackConfig).not.toContain("[http_service]");
    expect(releaseEvidenceSmoke).toContain(
      'OMNIAGENT_REQUIRE_ACTIVE_WORKER_HEARTBEATS === "true"',
    );
    expect(releaseEvidenceSmoke).toContain(
      'evidenceQuery.set("requireActiveWorker", "true")',
    );
    expect(releaseEvidenceSmoke).toContain(
      'evidenceQuery.set(\n    "workerHeartbeatNotBefore"',
    );
    expect(releaseEvidenceSmoke).toContain(
      'evidenceQuery.set("errorBudgetException", errorBudgetException)',
    );
    expect(releaseEvidenceSmoke).toContain(
      'gateById.get("agent_error_budget")?.status === "pass"',
    );
  });
});

describe("rolling back a failed production release", () => {
  const head = FAKE_RELEASE_HEAD;
  const canonical = "https://asael.bennierichard.com";
  const staged = "https://omniagent-candidate-benniejosephs-projects.vercel.app";
  const gateway = "https://omniagent-os-worker.fly.dev";
  const activeToken =
    releaseConfigurationEnvironment().OMNIAGENT_OPENAI_GATEWAY_TOKEN;
  const candidateToken = "gateway_candidate_abcdefghijklmnopqrstuvwxyz1234";
  const priorToken = "gateway_prior_abcdefghijklmnopqrstuvwxyz98765432";
  // A release that rotates the gateway token. The running gateway accepts
  // only the token the prior release uses until the release is deployed.
  const rotation = {
    OMNIAGENT_OPENAI_GATEWAY_TOKEN: candidateToken,
    OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN: priorToken,
    FAKE_GATEWAY_TOKENS: priorToken,
  };
  const listSecrets = "fly secrets list --app omniagent-os-worker --json";
  const stageSecrets = "fly secrets import --app omniagent-os-worker --stage";
  const releaseDeploy = `fly deploy --app omniagent-os-worker --build-arg OMNIAGENT_RELEASE_SHA=${head} --env OMNIAGENT_WORKER_BASE_URL=${staged} --env OMNIAGENT_WORKER_CANONICAL_BASE_URL=${canonical} --env OMNIAGENT_WORKER_RELEASE_HOLD=true --strategy bluegreen --yes`;
  const workerRollback = `fly deploy --app omniagent-os-worker --strategy bluegreen --image registry.fly.io/omniagent-os-worker:prior --env OMNIAGENT_WORKER_BASE_URL=${canonical} --env OMNIAGENT_WORKER_CANONICAL_BASE_URL=${canonical} --env OMNIAGENT_WORKER_RELEASE_HOLD=false --yes`;
  const webRollback =
    "vercel promote https://omniagent-prior-benniejosephs-projects.vercel.app --yes --scope benniejosephs-projects";
  const rollbackVerified = `npm run smoke:preflight against ${canonical} expecting prior-release`;
  const staging =(token: string, previousToken?: string) =>
    `fly staged OMNIAGENT_OPENAI_GATEWAY_TOKEN=${token}${previousToken ? ` OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN=${previousToken}` : ""}`;
  const gatewayChecks = (token: string) => [
    `fetch ${gateway}/healthz with ${token}`,
    `fetch ${gateway}/v1/models/authorization-probe with ${token}`,
  ];
  const verificationCommands = (baseUrl: string) =>
    ["test:production-smoke", "benchmark:preview", "benchmark:dashboard"].map(
      (script) => `npm run ${script} against ${baseUrl} expecting ${head}`,
    );
  const stagedDeploy = `vercel deploy --prod --skip-domain --yes --scope benniejosephs-projects --env OMNIAGENT_RELEASE_SHA=${head} --env OMNIAGENT_RELEASE_MANIFEST=<manifest>`;
  const promotion = `vercel promote ${staged} --yes --scope benniejosephs-projects`;
  const manifestCheck = (baseUrl: string) =>
    `npm run smoke:manifest against ${baseUrl} expecting ${head}`;

  it("limits previous-release evidence compatibility to the initial production check", async () => {
    await withFakeReleasePlatform(async ({ deploy }) => {
      const result = await deploy();
      const priorCheck = `npm run smoke:release -- --previous-release against ${canonical}`;

      expect(result.code).toBe(0);
      expect(result.log.filter((line) => line.includes("--previous-release")))
        .toEqual([priorCheck]);
      expect(result.log.indexOf(priorCheck)).toBeLessThan(result.log.indexOf(stagedDeploy));
      expect(result.log).toContain(manifestCheck(staged));
      expect(result.log).toContain(manifestCheck(canonical));
      expect(result.log).toContain(`npm run test:production-smoke against ${staged} expecting ${head}`);
      expect(result.log).toContain(`npm run test:production-smoke against ${canonical} expecting ${head}`);
      expect(result.log).toContain(`npm run smoke:release against ${canonical} expecting ${head}`);
    });
  });

  it("forward-schema recovery verifies the exact gap before platform mutation and retains every candidate gate", async () => {
    await withForwardSchemaFixture(async ({ overrides, evidencePath, prior }) => {
      await withFakeReleasePlatform(async ({ deploy }) => {
        const result = await deploy(overrides);
        expect(result.code, result.stderr).toBe(0);
        const preflight = `npm run smoke:preflight against ${canonical} expecting ${prior}`;
        const blockedSmoke = `npm run smoke:release -- --previous-release against ${canonical} expecting ${prior}`;
        const database = `npm run db:verify against ${canonical}`;
        const firstMutation = result.log.findIndex((line) => /^(?:vercel (?:deploy|promote)|fly (?:deploy|secrets import|ssh console)) /.test(line));
        expect(result.log.indexOf(preflight)).toBeGreaterThanOrEqual(0);
        expect(result.log.indexOf(blockedSmoke)).toBeGreaterThan(result.log.indexOf(preflight));
        expect(result.log.indexOf(database)).toBeGreaterThan(result.log.indexOf(blockedSmoke));
        expect(firstMutation).toBeGreaterThan(result.log.indexOf(database));
        expect(result.log[firstMutation]).toBe(stagedDeploy);
        expect(result.log.filter((line) => line.includes("--previous-release"))).toEqual([blockedSmoke]);
        expect(result.log.filter((line) => line.includes("npm run db:verify"))).toEqual([database]);
        for (const baseUrl of [staged, canonical]) {
          expect(result.log).toContain(manifestCheck(baseUrl));
          for (const command of verificationCommands(baseUrl)) expect(result.log).toContain(command);
          expect(result.log).toContain(`npm run smoke:paid-agent against ${baseUrl} expecting ${head}`);
        }
        expect(result.log.indexOf(promotion)).toBeGreaterThan(result.log.indexOf(verificationCommands(staged).at(-1)!));
        expect(result.log).toContain(`npm run smoke:release against ${canonical} expecting ${head}`);
        expect(result.stdout).toContain("Forward-schema recovery admitted the prior inventory delta");
        const recordRoot = evidencePath.slice(0, -".json".length);
        const blocked = JSON.parse(await readFile(`${recordRoot}.forward-prior-blocked.json`, "utf8"));
        expect(blocked.releaseGate).toMatchObject({ approved: false, status: "blocked" });
        expect(blocked.gates.find((gate: { id: string }) => gate.id === "tenant_isolation_database").status).toBe("fail");
        const admitted = JSON.parse(await readFile(`${recordRoot}.forward-schema-admission.json`, "utf8"));
        expect(admitted).toMatchObject({ status: "admitted_prior_inventory_delta", previousRevision: prior,
          candidateRevision: head, priorExpectedTables: 265, unclassifiedTables: ["omni_native_openapi_import_preparations"],
          databaseVerification: { tenantTables: 266 } });
      });
    });
  });

  it.each(["different table", "second prior failure"])("forward-schema recovery refuses %s before db verification or platform mutation", async (failure) => {
    await withForwardSchemaFixture(async ({ overrides }) => {
      const artifact = JSON.parse(overrides.FAKE_FORWARD_SCHEMA_ARTIFACT);
      if (failure === "different table") {
        artifact.tenantIsolation.unclassifiedTables = ["omni_unexpected_table"];
      } else {
        artifact.gates.find((gate: { id: string }) => gate.id === "agent_error_budget").status = "fail";
        artifact.releaseGate.reasons.push("agent_error_budget: Ready.");
        artifact.releaseGate.summary.failures++;
        artifact.releaseGate.summary.passed--;
      }
      await withFakeReleasePlatform(async ({ deploy }) => {
        const result = await deploy({ ...overrides, FAKE_FORWARD_SCHEMA_ARTIFACT: JSON.stringify(artifact) });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Forward-schema recovery rejected the prior release");
        expect(result.log.some((line) => line.includes("npm run db:verify"))).toBe(false);
        expect(result.log.some((line) => /^(?:vercel (?:deploy|promote)|fly (?:deploy|secrets import|ssh console)) /.test(line))).toBe(false);
      });
    });
  });

  it("signs the manifest it deploys and checks it staged, then canonical", async () => {
    await withFakeReleasePlatform(async ({ deploy }) => {
      const signingStarted = Date.now();
      const stopped = await deploy({ FAKE_RELEASE_FAIL: manifestCheck(staged) });

      expect(stopped.code).toBe(1);
      expect(stopped.stderr).toBe(
        "Production deployment failed: npm run smoke:manifest failed with exit code 1.\n",
      );
      expect(stopped.stdout).toContain(
        `Signed the release manifest for ${head} with key ${signingKeyId}.`,
      );
      // A staged manifest that fails stops the release before the worker or
      // production changes, so nothing is rolled back.
      expect(stopped.log.slice(stopped.log.indexOf(stagedDeploy))).toEqual([
        stagedDeploy,
        `fetch ${staged}/api/health`,
        manifestCheck(staged),
      ]);
      expect(stopped.manifests).toHaveLength(1);
      const [manifest] = stopped.manifests;
      const verified = verifyReleaseManifest(manifest, {
        publicKeys: [signingPublicKey],
      });
      expect(verified).toEqual({
        valid: true,
        keyId: signingKeyId,
        manifest: {
          version: 1,
          revision: head,
          repository: "benniejoseph/OmniAgentOS",
          branch: "main",
          checks: ["audit", "build", "gitleaks", "integration", "quality", "worker"],
          signedAt: expect.any(String),
        },
      });
      const signedAt = verified.valid ? Date.parse(verified.manifest.signedAt) : NaN;
      expect(signedAt).toBeGreaterThanOrEqual(signingStarted - 1000);
      expect(signedAt).toBeLessThanOrEqual(Date.now());
      // The smoke's own judge accepts what the runner deployed, and only
      // with the runner's key.
      expect(
        assessReleaseManifestHealth({ revision: head, releaseManifest: manifest }, head, {
          publicKeys: [signingPublicKey],
        }).valid,
      ).toBe(true);
      expect(verifyReleaseManifest(manifest)).toEqual({
        valid: false,
        error: `is signed by key ${signingKeyId}, which this repository does not trust`,
      });
      expectNoSigningKey(stopped);

      const rolledBack = await deploy({ FAKE_RELEASE_FAIL: manifestCheck(canonical) });
      expect(rolledBack.code).toBe(1);
      expect(rolledBack.log.slice(rolledBack.log.indexOf(promotion))).toEqual([
        promotion,
        `fetch ${canonical}/api/health`,
        manifestCheck(canonical),
        listSecrets,
        stageSecrets,
        staging(activeToken),
        workerRollback,
        webRollback,
        `fetch ${canonical}/api/health`,
        ...gatewayChecks(activeToken),
        rollbackVerified,
      ]);
    });
  });

  it("rolls a promoted release back worker first, then web, and verifies the prior pair", async () => {
    await withFakeReleasePlatform(async ({ deploy }) => {
      const failure = `npm run smoke:release against ${canonical} expecting ${head}`;
      const result = await deploy({ ...rotation, FAKE_RELEASE_FAIL: failure });

      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        "Production deployment failed: npm run smoke:release failed with exit code 1.\n",
      );
      expect(result.log).toEqual([
        "git status --porcelain",
        "git rev-parse HEAD",
        `gh api --hostname github.com --method GET repos/benniejoseph/OmniAgentOS/compare/main...${head} --jq {status, ahead_by, behind_by}`,
        `gh api --hostname github.com --method GET repos/benniejoseph/OmniAgentOS/commits/${head}/check-runs?filter=latest&per_page=100`,
        `npm run verify against ${canonical}`,
        "fly releases --app omniagent-os-worker --image --json",
        `vercel inspect ${canonical} --format=json --scope benniejosephs-projects`,
        `fetch ${canonical}/api/health`,
        // The token the prior release uses still reaches the running gateway.
        ...gatewayChecks(priorToken),
        `npm run smoke:release -- --previous-release against ${canonical}`,
        stagedDeploy,
        `fetch ${staged}/api/health`,
        manifestCheck(staged),
        stageSecrets,
        staging(candidateToken, priorToken),
        releaseDeploy,
        ...gatewayChecks(candidateToken),
        ...gatewayChecks(priorToken),
        `npm run smoke:paid-agent against ${staged} expecting ${head}`,
        ...verificationCommands(staged),
        promotion,
        `fetch ${canonical}/api/health`,
        manifestCheck(canonical),
        expect.stringMatching(
          /^fly ssh console --app omniagent-os-worker --command sh -c '.*cat \/tmp\/asael-worker\.pid.*kill -HUP "\$worker_pid"'$/,
        ),
        ...gatewayChecks(candidateToken),
        ...gatewayChecks(priorToken),
        `npm run smoke:paid-agent against ${canonical} expecting ${head}`,
        ...verificationCommands(canonical),
        expect.stringMatching(
          new RegExp(
            `^fly ssh console --app omniagent-os-worker --command sh -c '.*expected_revision='"'"'${head}'"'"'.*kill -USR1 "\\$worker_pid"`,
          ),
        ),
        `npm run smoke:security against ${canonical} expecting ${head}`,
        failure,
        // The worker goes back first, with the prior release's token active.
        stageSecrets,
        staging(priorToken, candidateToken),
        workerRollback,
        webRollback,
        `fetch ${canonical}/api/health`,
        ...gatewayChecks(priorToken),
        ...gatewayChecks(candidateToken),
        rollbackVerified,
      ]);
      expectNoSecretTokens(result, [candidateToken, priorToken]);
      // Only the staged and canonical paid checks receive the sign-in password.
      expect(result.passwordHolders).toEqual([
        "npm run smoke:paid-agent",
        "npm run smoke:paid-agent",
      ]);
      expect(`${result.stdout}\n${result.stderr}\n${result.log.join("\n")}`).not.toContain(
        paidVerifierPassword,
      );
    });
  });

  it("rolls the web back too when its promotion fails", async () => {
    await withFakeReleasePlatform(async ({ deploy }) => {
      // A promotion that fails may still have moved the domain.
      const result = await deploy({ FAKE_RELEASE_FAIL: promotion });

      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        `Production deployment failed: ${promotion} failed with exit code 1.\n`,
      );
      expect(result.log.slice(result.log.indexOf(promotion))).toEqual([
        promotion,
        listSecrets,
        stageSecrets,
        staging(activeToken),
        workerRollback,
        webRollback,
        `fetch ${canonical}/api/health`,
        ...gatewayChecks(activeToken),
        rollbackVerified,
      ]);
    });
  });

  it("rolls back only the worker when the release fails before promotion", async () => {
    await withFakeReleasePlatform(async ({ deploy }) => {
      const failure = `npm run test:production-smoke against ${staged} expecting ${head}`;
      const retirePreviousToken =
        "fly secrets unset OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN --app omniagent-os-worker --stage";
      const result = await deploy({
        // A finished rotation left the retired token on Fly.
        FAKE_FLY_SECRETS: JSON.stringify([
          { Name: "OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN" },
        ]),
        FAKE_RELEASE_FAIL: failure,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        "Production deployment failed: npm run test:production-smoke failed with exit code 1.\n",
      );
      const stagedHealth = `fetch ${staged}/api/health`;
      expect(result.log.slice(result.log.indexOf(stagedHealth))).toEqual([
        stagedHealth,
        manifestCheck(staged),
        listSecrets,
        stageSecrets,
        staging(activeToken),
        retirePreviousToken,
        releaseDeploy,
        ...gatewayChecks(activeToken),
        `npm run smoke:paid-agent against ${staged} expecting ${head}`,
        failure,
        listSecrets,
        stageSecrets,
        staging(activeToken),
        retirePreviousToken,
        workerRollback,
        `fetch ${canonical}/api/health`,
        ...gatewayChecks(activeToken),
        rollbackVerified,
      ]);
      expect(
        result.log.filter((line) => line.startsWith("vercel promote ")),
      ).toEqual([]);
      expectNoSecretTokens(result, [activeToken]);
    });
  });

  it("keeps the web release when the worker cannot be rolled back first", async () => {
    await withFakeReleasePlatform(async ({ deploy }) => {
      const failure = `npm run test:production-smoke against ${canonical} expecting ${head}`;
      const failed =
        "Production deployment failed: npm run test:production-smoke failed with exit code 1.";
      const skipped =
        "Vercel rollback was skipped because the active worker could not be safely rolled back first.";

      const rollbackFails = await deploy({
        ...rotation,
        FAKE_RELEASE_FAIL: [failure, workerRollback].join("\n"),
      });
      expect(rollbackFails.code).toBe(1);
      expect(rollbackFails.stderr).toBe(
        [
          failed,
          `Fly rollback failed: ${workerRollback} failed with exit code 1.`,
          skipped,
          "",
        ].join("\n"),
      );
      expect(
        rollbackFails.log.slice(rollbackFails.log.indexOf(failure)),
      ).toEqual([
        failure,
        stageSecrets,
        staging(priorToken, candidateToken),
        workerRollback,
      ]);

      const stagingFails = await deploy({
        ...rotation,
        FAKE_RELEASE_FAIL: [failure, staging(priorToken, candidateToken)].join(
          "\n",
        ),
      });
      expect(stagingFails.code).toBe(1);
      expect(stagingFails.stderr).toBe(
        [
          failed,
          `Fly rollback gateway secret staging failed: ${stageSecrets} failed with exit code 1; sensitive command output was suppressed.`,
          skipped,
          "",
        ].join("\n"),
      );
      expect(
        stagingFails.log.slice(stagingFails.log.indexOf(failure)),
      ).toEqual([failure, stageSecrets]);
    });
  });

  it("leaves both platforms alone until the worker changes, then restores it", async () => {
    await withFakeReleasePlatform(async ({ deploy }) => {
      const untouched = await deploy({ FAKE_RELEASE_FAIL: stagedDeploy });
      expect(untouched.code).toBe(1);
      expect(untouched.stderr).toBe(
        `Production deployment failed: ${stagedDeploy} failed with exit code 1.\n`,
      );
      expect(untouched.log.at(-1)).toBe(stagedDeploy);

      const partlyStaged = await deploy({
        ...rotation,
        FAKE_RELEASE_FAIL: staging(candidateToken, priorToken),
      });
      expect(partlyStaged.code).toBe(1);
      expect(partlyStaged.stderr).toBe(
        `Production deployment failed: ${stageSecrets} failed with exit code 1; sensitive command output was suppressed.\n`,
      );
      const stagedHealth = `fetch ${staged}/api/health`;
      expect(
        partlyStaged.log.slice(partlyStaged.log.indexOf(stagedHealth)),
      ).toEqual([
        stagedHealth,
        manifestCheck(staged),
        // Fly may hold part of the candidate secrets, so the worker is restored.
        stageSecrets,
        stageSecrets,
        staging(priorToken, candidateToken),
        workerRollback,
        `fetch ${canonical}/api/health`,
        ...gatewayChecks(priorToken),
        ...gatewayChecks(candidateToken),
        rollbackVerified,
      ]);
    });
  });

  it("replaces a split production and rolls back to the same split", async () => {
    await withFakeReleasePlatform(async ({ deploy }) => {
      // The web serves "prior-release" but the gateway an older worker.
      const split = { FAKE_PRIOR_GATEWAY_REVISION: "prior-gateway" };
      const preDeploy = [
        `npm run verify against ${canonical}`,
        "fly releases --app omniagent-os-worker --image --json",
        `vercel inspect ${canonical} --format=json --scope benniejosephs-projects`,
        `fetch ${canonical}/api/health`,
      ];

      // Without the flag no release can start from a split production.
      const blocked = await deploy(split);
      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toContain(
        "Rollback gateway preflight did not become ready",
      );
      const blockedStart = blocked.log.indexOf(preDeploy[0]);
      expect(
        blocked.log.slice(blockedStart, blockedStart + preDeploy.length),
      ).toEqual(preDeploy);
      expect(
        new Set(blocked.log.slice(blockedStart + preDeploy.length)),
      ).toEqual(new Set([`fetch ${gateway}/healthz with ${activeToken}`]));

      const failure = `npm run test:production-smoke against ${canonical} expecting ${head}`;
      const result = await deploy({
        ...split,
        OMNIAGENT_RELEASE_SPLIT_RECOVERY: "CONFIRMED",
        FAKE_RELEASE_FAIL: failure,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        "Split production recovery confirmed: web prior-release and gateway prior-gateway",
      );
      expect(result.stderr).toBe(
        "Production deployment failed: npm run test:production-smoke failed with exit code 1.\n",
      );
      expect(
        result.log.slice(
          result.log.indexOf(preDeploy[0]),
          result.log.indexOf(stagedDeploy) + 1,
        ),
      ).toEqual([
        ...preDeploy,
        `fetch ${gateway}/healthz with ${activeToken}`,
        // The running gateway is checked at its own revision.
        ...gatewayChecks(activeToken),
        `npm run smoke:preflight against ${canonical} expecting prior-release`,
        stagedDeploy,
      ]);
      expect(result.log.slice(result.log.indexOf(failure))).toEqual([
        failure,
        listSecrets,
        stageSecrets,
        staging(activeToken),
        workerRollback,
        webRollback,
        `fetch ${canonical}/api/health`,
        ...gatewayChecks(activeToken),
        rollbackVerified,
      ]);
    });
  });

  it("refuses split recovery unless the gateway reports its own bounded revision", async () => {
    await withFakeReleasePlatform(async ({ deploy }) => {
      const paired = await deploy({ OMNIAGENT_RELEASE_SPLIT_RECOVERY: "CONFIRMED" });

      expect(paired.code).toBe(1);
      expect(paired.stderr).toContain(
        "Production web and gateway both serve prior-release; unset OMNIAGENT_RELEASE_SPLIT_RECOVERY.",
      );
      expect(paired.log.slice(-2)).toEqual([
        `fetch ${canonical}/api/health`,
        `fetch ${gateway}/healthz with ${activeToken}`,
      ]);

      for (const revision of ["r".repeat(201), "prior gateway"]) {
        const unbounded = await deploy({
          FAKE_PRIOR_GATEWAY_REVISION: revision,
          OMNIAGENT_RELEASE_SPLIT_RECOVERY: "CONFIRMED",
        });

        expect(unbounded.code).toBe(1);
        expect(unbounded.stderr).toContain(
          "The current gateway must report a bounded revision; observed http=200",
        );
        expect(unbounded.stderr).not.toContain(revision);
        expect(unbounded.log.at(-1)).toBe(
          `fetch ${gateway}/healthz with ${activeToken}`,
        );
      }
    });
  });

  it("rolls an initial gateway cutover back to the worker without a gateway", async () => {
    await withFakeReleasePlatform(async ({ deploy }) => {
      const failure = `npm run test:production-smoke against ${staged} expecting ${head}`;
      const releaseSmoke = `npm run smoke:release -- --previous-release against ${canonical}`;
      const result = await deploy({
        OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER: "CONFIRMED",
        // The running worker serves no gateway yet.
        FAKE_GATEWAY_TOKENS: "",
        FAKE_RELEASE_FAIL: failure,
      });

      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        "Initial OpenAI gateway cutover confirmed",
      );
      expect(result.stderr).toBe(
        "Production deployment failed: npm run test:production-smoke failed with exit code 1.\n",
      );
      expect(result.log).toContain(releaseSmoke);
      expect(
        result.log
          .slice(0, result.log.indexOf(releaseSmoke))
          .filter((line) => line.startsWith(`fetch ${gateway}`)),
      ).toEqual([]);
      expect(result.log.slice(result.log.indexOf(failure))).toEqual([
        failure,
        `fly deploy --app omniagent-os-worker --config fly.initial-cutover-rollback.toml --strategy immediate --image registry.fly.io/omniagent-os-worker:prior --env OMNIAGENT_WORKER_BASE_URL=${canonical} --env OMNIAGENT_WORKER_CANONICAL_BASE_URL=${canonical} --env OMNIAGENT_WORKER_RELEASE_HOLD=false --yes`,
        `fetch ${canonical}/api/health`,
        rollbackVerified,
      ]);
    });
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

// Green required release checks for a commit, with per-job conclusion
// overrides. A job named only in overrides is added as an extra check run.
function releaseCheckRunsJson(
  head: string,
  conclusions: Record<string, string> = {},
) {
  const names = [
    ...new Set([
      "quality",
      "build",
      "audit",
      "integration",
      "worker",
      "gitleaks",
      ...Object.keys(conclusions),
    ]),
  ];
  return JSON.stringify({
    total_count: names.length,
    check_runs: names.map((name, index) => ({
      id: index + 1,
      name,
      head_sha: head,
      status: "completed",
      conclusion: conclusions[name] ?? "success",
      app: { slug: "github-actions" },
    })),
  });
}

function releaseConfigurationEnvironment() {
  return {
    BASE_URL: "https://asael.bennierichard.com",
    OMNIAGENT_INTERNAL_AUTH_SECRET: "internal-test-secret",
    OPENAI_API_KEY: "",
    RELEASE_EVIDENCE_OUTPUT: path.join(
      tmpdir(),
      `asael-release-evidence-provenance-${process.pid}.json`,
    ),
    OMNIAGENT_OPENAI_GATEWAY_URL: "https://omniagent-os-worker.fly.dev/v1",
    OMNIAGENT_OPENAI_GATEWAY_TOKEN:
      "gateway_token_abcdefghijklmnopqrstuvwxyz123456",
    OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN: "",
    OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER: "",
    OMNIAGENT_RELEASE_SPLIT_RECOVERY: "",
    OMNIAGENT_RELEASE_SIGNING_KEY_FILE: signingKeyFile,
    SMOKE_PAID_AGENT_EMAIL: paidVerifierEmail,
    SMOKE_PAID_AGENT_PASSWORD: paidVerifierPassword,
  };
}

// Puts logging stand-ins for git, gh, npm, vercel, and fly first on PATH, so a
// test can never reach a real deployment. npm, vercel, and fly fail unless a
// test replaces a stand-in's whole script.
async function withFakeReleaseTools(
  callback: (tools: {
    environment: NodeJS.ProcessEnv;
    readLog: () => Promise<string[]>;
  }) => Promise<void>,
  scripts: Record<string, string> = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "asael-release-tools-"));
  const logFile = path.join(directory, "invocations.log");
  const tools: Record<string, string> = {
    git: [
      'case "$1" in',
      '  status) printf \'%s\' "$FAKE_GIT_STATUS" ;;',
      '  rev-parse) printf \'%s\\n\' "$FAKE_GIT_HEAD" ;;',
      "  *) exit 97 ;;",
      "esac",
    ].join("\n"),
    gh: [
      'if [ -n "$FAKE_GH_FAIL" ]; then',
      '  printf \'%s\\n\' "$FAKE_GH_FAIL" >&2',
      "  exit 4",
      "fi",
      'case "$*" in',
      '  *"/compare/"*) printf \'%s\' "$FAKE_GH_COMPARE" ;;',
      '  *"/check-runs"*) printf \'%s\' "$FAKE_GH_CHECKS" ;;',
      "  *) exit 97 ;;",
      "esac",
    ].join("\n"),
    npm: "exit 1",
    vercel: "exit 1",
    fly: "exit 1",
  };
  try {
    for (const [name, body] of Object.entries(tools)) {
      const file = path.join(directory, name);
      await writeFile(
        file,
        `#!/bin/sh\n${passwordWitness(name)}\n${scripts[name] ?? `printf '%s\\n' "${name} $*" >> "$FAKE_RELEASE_LOG"\n${body}`}\n`,
      );
      await chmod(file, 0o755);
    }
    await callback({
      environment: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_RELEASE_LOG: logFile,
        FAKE_GIT_STATUS: "",
        FAKE_GH_FAIL: "",
      },
      async readLog() {
        const lines = await readFile(logFile, "utf8")
          .then((content) => content.split("\n").filter(Boolean))
          .catch(() => []);
        await rm(logFile, { force: true });
        return lines;
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Notes each call that can read the paid check's sign-in password, so a test
// can prove no other command receives it.
function passwordWitness(name: string) {
  return `if [ -n "$SMOKE_PAID_AGENT_PASSWORD" ]; then printf '%s\\n' "${name} $*" >> "$FAKE_RELEASE_LOG.password"; fi`;
}

const FAKE_RELEASE_HEAD = "a53a77aee2e1056f8989cc19b24b0a6a620cf084";

async function withForwardSchemaFixture(callback: (fixture: {
  overrides: Record<string, string>; evidencePath: string; prior: string;
}) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "asael-release-forward-fixture-"));
  try {
    const evidencePath = path.join(directory, "asael-release-evidence-forward.json");
    const prior = "1".repeat(40), at = new Date().toISOString();
    const manifest = JSON.parse(await readFile("schema-migrations.json", "utf8"));
    const latest = manifest.at(-1);
    const pin = { previousRevision: prior, candidateRevision: FAKE_RELEASE_HEAD,
      migrationVersion: latest.version, migrationChecksum: latest.checksum,
      unclassifiedTables: ["omni_native_openapi_import_preparations"] };
    const gates = ["deployment_environment", "internal_smoke_auth", "openai_us_egress_gateway", "openai_provider",
      "cron_auth", "runtime_database_role", "maintenance_database_role", "dedicated_worker", "tenant_isolation_database",
      "latest_tenant_isolation_eval", "observability_slo", "agent_error_budget", "eval_report_signing"].map((id) => ({
        id, name: id === "tenant_isolation_database" ? "Database tenant isolation" : id,
        status: id === "tenant_isolation_database" ? "fail" : "pass",
        summary: id === "tenant_isolation_database" ? "Tenant isolation schema evidence is incomplete." : "Ready.",
      }));
    const artifact = { httpStatus: 200, generatedAt: at, reportCheckedAt: at,
      baseUrl: "https://asael.bennierichard.com", deployment: { commitSha: prior }, tenantIsolationStatus: "degraded", gates,
      releaseGate: { approved: false, status: "blocked", reasons: ["Database tenant isolation: Tenant isolation schema evidence is incomplete."],
        warnings: [], summary: { total: gates.length, passed: gates.length - 1, warnings: 0, failures: 1 } },
      tenantIsolation: { expectedTables: 265, protectedTables: 265, failingTables: 0, childTables: 0,
        unclassifiedTables: pin.unclassifiedTables, missingTables: [], missingTenantColumns: [], rlsDisabled: [], forceRlsDisabled: [], missingPolicies: [] } };
    await callback({ evidencePath, prior, overrides: {
      OMNIAGENT_RELEASE_FORWARD_SCHEMA_RECOVERY: JSON.stringify(pin),
      MIGRATION_DATABASE_URL: "postgresql://synthetic.invalid/not-a-real-database",
      RELEASE_EVIDENCE_OUTPUT: evidencePath, FAKE_PRIOR_REVISION: prior,
      FAKE_FORWARD_SCHEMA_ARTIFACT: JSON.stringify(artifact),
      FAKE_FORWARD_SCHEMA_DATABASE: JSON.stringify({ level: "info", event: "database_verification_completed",
        migrations: latest.version, tenantTables: 266, completedAt: at }),
    } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Each platform stand-in logs its call and fails when FAKE_RELEASE_FAIL lists
// one of its lines.
const FAKE_PLATFORM_PRELUDE = `
log() { printf '%s\\n' "$1" >> "$FAKE_RELEASE_LOG"; }
fails() { printf '%s\\n' "$FAKE_RELEASE_FAIL" | grep -qxF -e "$1" -e "\${2:-$1}"; }`;

// npm logs the URL and revision a run targets. vercel logs a release manifest
// as <manifest> and keeps the manifest itself beside the log. fly logs the
// secrets it is asked to stage as a "fly staged" line, which a test can fail
// on its own.
const FAKE_PLATFORM_SCRIPTS: Record<string, string> = {
  npm: `${FAKE_PLATFORM_PRELUDE}
expected="\${SMOKE_EXPECTED_REVISION:-$EXPECTED_REVISION}"
line="npm $*\${BASE_URL:+ against $BASE_URL}\${expected:+ expecting $expected}"
log "$line"
if [ "$1 $2" = "run smoke:manifest" ]; then
  if [ "\${#SMOKE_EXPECTED_MANIFEST_SHA256}" -ne 64 ]; then exit 96; fi
  if [ "$BASE_URL" = "https://asael.bennierichard.com" ]; then
    if [ "$SMOKE_MANIFEST_PREVIOUS_REVISION" != "$FAKE_PRIOR_REVISION" ] || [ "$SMOKE_MANIFEST_CONVERGENCE_TIMEOUT_MS" != "$OMNIAGENT_DEPLOY_READINESS_TIMEOUT_MS" ]; then exit 94; fi
  elif [ -n "$SMOKE_MANIFEST_PREVIOUS_REVISION" ] || [ -n "$SMOKE_MANIFEST_CONVERGENCE_TIMEOUT_MS" ]; then
    exit 95
  fi
fi
if [ -n "$FAKE_FORWARD_SCHEMA_ARTIFACT" ]; then
  if [ -n "$OMNIAGENT_RELEASE_FORWARD_SCHEMA_RECOVERY" ]; then exit 91; fi
  if [ "$1 $2" != "run db:verify" ] && [ -n "$MIGRATION_DATABASE_URL" ]; then exit 92; fi
  if [ "$*" = "run smoke:release -- --previous-release" ]; then
    printf '%s\\n' "$FAKE_FORWARD_SCHEMA_ARTIFACT" > "$RELEASE_EVIDENCE_OUTPUT"
    exit 1
  fi
  if [ "$1 $2" = "run db:verify" ]; then
    if [ -z "$MIGRATION_DATABASE_URL" ]; then exit 93; fi
    printf '%s\\n' "$FAKE_FORWARD_SCHEMA_DATABASE"
  fi
fi
if fails "$line"; then exit 1; fi`,
  vercel: `${FAKE_PLATFORM_PRELUDE}
for argument in "$@"; do
  case "$argument" in
    OMNIAGENT_RELEASE_MANIFEST=*) printf '%s\\n' "\${argument#OMNIAGENT_RELEASE_MANIFEST=}" >> "$FAKE_RELEASE_LOG.manifests" ;;
  esac
done
line="$(printf '%s' "vercel $*" | sed -E 's/(OMNIAGENT_RELEASE_MANIFEST=)[A-Za-z0-9_-]+/\\1<manifest>/')"
log "$line"
if fails "$line"; then exit 1; fi
case "$1" in
  inspect) printf '%s\\n' '{"url":"omniagent-prior-benniejosephs-projects.vercel.app"}' ;;
  deploy) printf '%s\\n' "Inspect: https://vercel.com/benniejosephs-projects/omniagent" "https://omniagent-candidate-benniejosephs-projects.vercel.app" ;;
esac`,
  fly: `${FAKE_PLATFORM_PRELUDE}
log "fly $*"
staged=""
if [ "$1 $2" = "secrets import" ]; then staged="fly staged $(paste -sd ' ' -)"; fi
if fails "fly $*" "$staged"; then exit 1; fi
if [ -n "$staged" ]; then log "$staged"; fi
case "$1 $2" in
  "releases --app") printf '%s\\n' "$FAKE_FLY_RELEASES" ;;
  "secrets list") printf '%s\\n' "$FAKE_FLY_SECRETS" ;;
esac`,
};

// Answers the deploy script's fetches from the log: the canonical web serves
// whichever deployment was promoted last, and the gateway serves the last Fly
// deploy with the secrets staged before it. Any other origin is the staged web.
const FAKE_PLATFORM_FETCH = `
import { appendFileSync, readFileSync } from "node:fs";

const { FAKE_RELEASE_LOG, FAKE_PRIOR_REVISION, OMNIAGENT_RELEASE_SHA } = process.env;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const token = new Headers(init.headers).get("x-asael-gateway-token");
  appendFileSync(
    FAKE_RELEASE_LOG,
    "fetch " + url.origin + url.pathname + (token ? " with " + token : "") + "\\n",
  );
  const lines = readFileSync(FAKE_RELEASE_LOG, "utf8").split("\\n");
  if (url.origin === "https://omniagent-os-worker.fly.dev") {
    const deployed = lines.findLastIndex((line) => line.startsWith("fly deploy "));
    const staged = lines
      .slice(0, Math.max(deployed, 0))
      .findLast((line) => line.startsWith("fly staged "));
    const accepted = staged
      ? staged.split(" ").slice(2).map((pair) => pair.slice(pair.indexOf("=") + 1))
      : (process.env.FAKE_GATEWAY_TOKENS || "").split(" ");
    const revision = lines[deployed]?.includes("OMNIAGENT_RELEASE_SHA=" + OMNIAGENT_RELEASE_SHA)
      ? OMNIAGENT_RELEASE_SHA
      : process.env.FAKE_PRIOR_GATEWAY_REVISION || FAKE_PRIOR_REVISION;
    if (url.pathname === "/healthz") {
      return json(200, {
        status: "healthy",
        service: "asael-openai-egress",
        region: "iad",
        protocol: "1",
        revision,
      });
    }
    if (url.pathname === "/v1/models/authorization-probe") {
      return json(token && accepted.includes(token) ? 400 : 401, {});
    }
    return json(404, {});
  }
  if (url.origin === "https://asael.bennierichard.com") {
    const promoted = lines.findLast((line) => line.startsWith("vercel promote "));
    return json(200, {
      status: "healthy",
      revision: promoted?.includes("omniagent-candidate-")
        ? OMNIAGENT_RELEASE_SHA
        : FAKE_PRIOR_REVISION,
    });
  }
  return json(200, { status: "healthy", revision: OMNIAGENT_RELEASE_SHA });
};
`;

type FakeReleaseRun = {
  code: number | null;
  stdout: string;
  stderr: string;
  log: string[];
  // Each release manifest vercel was asked to deploy, in order.
  manifests: string[];
  // Each tool call that received the paid check's sign-in password.
  passwordHolders: string[];
};

// Runs the whole deploy script against the platform stand-ins. The prior
// release is Fly image ":prior" and revision "prior-release", which its
// gateway also serves unless FAKE_PRIOR_GATEWAY_REVISION says otherwise.
async function withFakeReleasePlatform(
  callback: (platform: {
    deploy: (overrides?: Record<string, string>) => Promise<FakeReleaseRun>;
  }) => Promise<void>,
) {
  await withFakeReleaseTools(async ({ environment, readLog }) => {
    const fetchStub = path.join(
      path.dirname(String(environment.FAKE_RELEASE_LOG)),
      "fetch.mjs",
    );
    await writeFile(fetchStub, FAKE_PLATFORM_FETCH);
    const configuration = releaseConfigurationEnvironment();
    await callback({
      async deploy(overrides = {}) {
        const result = await runProcess(
          process.execPath,
          [
            "--import",
            pathToFileURL(fetchStub).href,
            "scripts/deploy-production.mjs",
          ],
          {
            ...environment,
            ...configuration,
            OMNIAGENT_RELEASE_SHA: FAKE_RELEASE_HEAD,
            FAKE_GIT_HEAD: FAKE_RELEASE_HEAD,
            FAKE_GH_COMPARE: JSON.stringify({
              status: "identical",
              ahead_by: 0,
              behind_by: 0,
            }),
            FAKE_GH_CHECKS: releaseCheckRunsJson(FAKE_RELEASE_HEAD),
            FAKE_PRIOR_REVISION: "prior-release",
            FAKE_PRIOR_GATEWAY_REVISION: "",
            // Newest first is a failed release; status case varies by flyctl.
            FAKE_FLY_RELEASES: JSON.stringify([
              {
                Version: 13,
                Status: "failed",
                ImageRef: "registry.fly.io/omniagent-os-worker:failed",
              },
              {
                Version: 12,
                Status: "Complete",
                ImageRef: "registry.fly.io/omniagent-os-worker:prior",
              },
              {
                version: 11,
                status: "complete",
                imageRef: "registry.fly.io/omniagent-os-worker:older",
              },
            ]),
            FAKE_FLY_SECRETS: "[]",
            FAKE_GATEWAY_TOKENS: configuration.OMNIAGENT_OPENAI_GATEWAY_TOKEN,
            FAKE_RELEASE_FAIL: "",
            SMOKE_EXPECTED_REVISION: "",
            EXPECTED_REVISION: "",
            FLY_APP: "",
            VERCEL_AUTOMATION_BYPASS_SECRET: "",
            OMNIAGENT_DEPLOY_READINESS_TIMEOUT_MS: "1000",
            OMNIAGENT_DEPLOY_READINESS_POLL_MS: "100",
            OMNIAGENT_DEPLOY_GATEWAY_READINESS_TIMEOUT_MS: "1000",
            OMNIAGENT_DEPLOY_GATEWAY_READINESS_POLL_MS: "100",
            OMNIAGENT_DEPLOY_WORKER_STARTUP_SETTLE_MS: "0",
            ...overrides,
          },
        );
        const manifestFile = `${String(environment.FAKE_RELEASE_LOG)}.manifests`;
        const manifests = await readFile(manifestFile, "utf8")
          .then((content) => content.split("\n").filter(Boolean))
          .catch(() => []);
        await rm(manifestFile, { force: true });
        const passwordFile = `${String(environment.FAKE_RELEASE_LOG)}.password`;
        const passwordHolders = await readFile(passwordFile, "utf8")
          .then((content) => content.split("\n").filter(Boolean))
          .catch(() => []);
        await rm(passwordFile, { force: true });
        return { ...result, log: await readLog(), manifests, passwordHolders };
      },
    });
  }, FAKE_PLATFORM_SCRIPTS);
}

// The signing key's own lines never reach output or a command line.
function expectNoSigningKey(run: { stdout: string; stderr: string; log?: string[] }) {
  const visible = [...(run.log ?? []), run.stdout, run.stderr].join("\n");
  expect(visible).not.toContain("PRIVATE KEY");
  for (const line of signingKeyPem.split("\n").filter((part) => part && !part.startsWith("-----"))) {
    expect(visible).not.toContain(line);
  }
}

// Secret values reach Fly only on stdin, so no command line or output carries
// one. The stand-ins' own fetch and staging lines are left out.
function expectNoSecretTokens(run: FakeReleaseRun, tokens: string[]) {
  const visible = [
    ...run.log.filter((line) => !/^(?:fetch|fly staged) /.test(line)),
    run.stdout,
    run.stderr,
  ].join("\n");
  for (const token of tokens) {
    expect(visible).not.toContain(token);
  }
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

function gatewayReadinessEnvironment({
  timeoutMs,
  token,
  previousToken,
}: {
  timeoutMs: number;
  token: string;
  previousToken?: string;
}) {
  return {
    ...process.env,
    OMNIAGENT_RELEASE_SHA: "release-ready",
    OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
    OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN: previousToken || "",
    OMNIAGENT_DEPLOY_GATEWAY_READINESS_TIMEOUT_MS: String(timeoutMs),
    OMNIAGENT_DEPLOY_GATEWAY_READINESS_POLL_MS: "100",
    OMNIAGENT_DEPLOY_GATEWAY_READINESS_REQUEST_TIMEOUT_MS: "500",
  };
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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
