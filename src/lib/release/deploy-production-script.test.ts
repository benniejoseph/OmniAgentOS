import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("paired production deployment", () => {
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
    expect(commands[0]).toContain("npm run smoke:release");
    expect(commands[1]).toBe("DRY RUN npm run verify");
    expect(commands[2]).toContain(
      "vercel deploy --prod --skip-domain --yes",
    );
    expect(commands[3]).toContain(
      "wait for staged web readiness at https://staged-deployment.example/api/health revision=test-release",
    );
    expect(commands[4]).toContain(
      "stage candidate gateway overlap on Fly through secret stdin; values redacted",
    );
    expect(commands[5]).toContain(
      "fly deploy --app omniagent-os-worker --build-arg OMNIAGENT_RELEASE_SHA=test-release --env OMNIAGENT_WORKER_BASE_URL=https://staged-deployment.example",
    );
    expect(commands[5]).toContain(
      "--env OMNIAGENT_WORKER_CANONICAL_BASE_URL=https://omniagent-os.vercel.app",
    );
    expect(commands[5]).toContain(
      "--env OMNIAGENT_WORKER_RELEASE_HOLD=true",
    );
    expect(commands[5]).toContain("--strategy bluegreen");
    expect(commands[6]).toContain(
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
      command.includes("https://omniagent-os.vercel.app/api/health") &&
      command.includes("revision=test-release"),
    );
    const canonicalSmokeIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://omniagent-os.vercel.app") &&
      command.includes("npm run test:production-smoke"),
    );
    const canonicalPreviewIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://omniagent-os.vercel.app") &&
      command.includes("npm run benchmark:preview"),
    );
    const canonicalDashboardIndex = commands.findIndex((command) =>
      command.includes("BASE_URL=https://omniagent-os.vercel.app") &&
      command.includes("npm run benchmark:dashboard"),
    );
    const workerActivationIndex = commands.findIndex((command) =>
      command.includes("fly ssh console --app omniagent-os-worker") &&
      command.includes("kill -USR1") &&
      command.includes("/tmp/asael-worker-release-activated") &&
      command.includes("expected_revision='test-release'"),
    );
    const workerActivationCommand = commands[workerActivationIndex];
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
      command.includes("BASE_URL=https://omniagent-os.vercel.app") &&
      command.includes("EXPECTED_REVISION=test-release") &&
      command.includes("LIVE_VERIFY_PAID_OPENAI=CONFIRMED") &&
      command.includes("npm run smoke:paid-agent"),
    );
    expect(gatewayTokenStageIndex).toBeGreaterThan(3);
    expect(stagedWorkerIndex).toBeGreaterThan(gatewayTokenStageIndex);
    expect(stagedGatewayIndex).toBeGreaterThan(stagedWorkerIndex);
    expect(stagedWorkerSettleIndex).toBeGreaterThan(stagedGatewayIndex);
    expect(stagedPaidIndex).toBeGreaterThan(stagedWorkerSettleIndex);
    expect(stagedSmokeIndex).toBeGreaterThan(stagedPaidIndex);
    expect(stagedPreviewIndex).toBeGreaterThan(stagedSmokeIndex);
    expect(stagedDashboardIndex).toBeGreaterThan(stagedPreviewIndex);
    expect(promoteIndex).toBeGreaterThan(stagedDashboardIndex);
    expect(canonicalReadinessIndex).toBeGreaterThan(promoteIndex);
    expect(canonicalWorkerIndex).toBeGreaterThan(canonicalReadinessIndex);
    expect(canonicalGatewayIndex).toBeGreaterThan(canonicalWorkerIndex);
    expect(canonicalWorkerSettleIndex).toBeGreaterThan(canonicalGatewayIndex);
    expect(canonicalPaidIndex).toBeGreaterThan(canonicalWorkerSettleIndex);
    expect(canonicalSmokeIndex).toBeGreaterThan(canonicalPaidIndex);
    expect(canonicalPreviewIndex).toBeGreaterThan(canonicalSmokeIndex);
    expect(canonicalDashboardIndex).toBeGreaterThan(canonicalPreviewIndex);
    expect(workerActivationIndex).toBeGreaterThan(canonicalDashboardIndex);
    expect(
      commands.filter((command) => command.includes("fly deploy")),
    ).toHaveLength(1);
    expect(result.stdout).not.toContain("--image registry.fly.io");
    expect(result.stdout).not.toContain("OMNIAGENT_OPENAI_GATEWAY_TOKEN=");
    expect(result.stdout).not.toContain("OPENAI_API_KEY=");
  });

  it("requires a complete safe gateway configuration for the Singapore topology", async () => {
    const evidenceOutput = path.join(
      tmpdir(),
      `asael-release-evidence-test-${process.pid}.json`,
    );
    const baseEnvironment = {
      ...process.env,
      OMNIAGENT_RELEASE_SHA: "release-ready",
      BASE_URL: "https://omniagent-os.vercel.app",
      OMNIAGENT_INTERNAL_AUTH_SECRET: "internal-test-secret",
      OPENAI_API_KEY: "",
      RELEASE_EVIDENCE_OUTPUT: evidenceOutput,
      OMNIAGENT_OPENAI_GATEWAY_URL: "",
      OMNIAGENT_OPENAI_GATEWAY_TOKEN: "",
      OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN: "",
      OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER: "",
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
    expect(`${valid.stdout}\n${valid.stderr}`).not.toContain(token);

    const trailingSlash = await runProcess(
      process.execPath,
      ["scripts/deploy-production.mjs", "--configuration-probe"],
      {
        ...baseEnvironment,
        BASE_URL: "https://omniagent-os.vercel.app/",
        OMNIAGENT_OPENAI_GATEWAY_URL:
          "https://omniagent-os-worker.fly.dev/v1",
        OMNIAGENT_OPENAI_GATEWAY_TOKEN: token,
      },
    );
    expect(trailingSlash.code).toBe(0);

    for (const invalidBaseUrl of [
      "http://omniagent-os.vercel.app",
      "https://omniagent-os.vercel.app:443",
      "https://omniagent-os.vercel.app:8443",
      "https://user@omniagent-os.vercel.app",
      "https://omniagent-os.vercel.app/path",
      "https://omniagent-os.vercel.app?target=other",
      "https://omniagent-os.vercel.app#other",
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
        "BASE_URL must be exactly https://omniagent-os.vercel.app",
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
    const observedPaths: string[] = [];
    await withHealthServer((request, response) => {
      const observedToken = request.headers["x-asael-gateway-token"] as
        | string
        | undefined;
      observedTokens.push(observedToken || "missing");
      observedPaths.push(request.url || "missing");
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/models/gpt-5") {
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
        status: "healthy",
        service: "asael-openai-egress",
        region: healthRequests === 2 ? "sin" : "iad",
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
      expect(healthRequests).toBe(4);
      expect(observedPaths.filter((value) => value === "/healthz")).toHaveLength(4);
      expect(observedPaths.filter((value) => value === "/v1/models/gpt-5")).toHaveLength(2);
      expect(observedTokens).toContain(token);
      expect(observedTokens).toContain(previousToken);
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
      if (request.url === "/v1/models/gpt-5") {
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
        "/v1/models/gpt-5",
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

  it("restores the prior token before the worker image and verifies the rollback pair", async () => {
    const deployScript = await readFile(
      "scripts/deploy-production.mjs",
      "utf8",
    );
    const rollbackPreflight = deployScript.slice(
      deployScript.indexOf("if (rollbackOpenAIGateway) {"),
      deployScript.indexOf("let workerMutationStarted"),
    );
    expect(rollbackPreflight).toContain(
      "await waitForOpenAIGatewayReadiness(",
    );
    expect(rollbackPreflight).not.toContain(
      "waitForOpenAIGatewayTokenPair",
    );
    const rollback = deployScript.slice(
      deployScript.indexOf("} catch (error) {"),
      deployScript.indexOf("console.log(\n  `Production release"),
    );
    expect(rollback).not.toContain("workerReleaseActivationArgs");
    const vercelRollbackIndex = rollback.indexOf(
      '"promote",\n        previousVercelDeployment',
    );
    const secretRollbackIndex = rollback.indexOf(
      "stageFlyGatewayTokenOverlap(rollbackOpenAIGateway",
    );
    const workerRollbackIndex = rollback.indexOf("previousWorkerImage");
    const verificationIndex = rollback.indexOf("runRollbackVerification(");

    expect(vercelRollbackIndex).toBeGreaterThanOrEqual(0);
    expect(secretRollbackIndex).toBeGreaterThan(vercelRollbackIndex);
    expect(workerRollbackIndex).toBeGreaterThan(secretRollbackIndex);
    expect(verificationIndex).toBeGreaterThan(workerRollbackIndex);
    expect(deployScript).toContain(
      "token: gateway.previousToken || gateway.token",
    );
    expect(deployScript).toContain(
      "previousToken: gateway.previousToken ? gateway.token : undefined",
    );
    expect(deployScript).toContain(
      "await waitForOpenAIGatewayTokenPair(\n      rollbackGateway",
    );
    expect(deployScript).toContain(
      '["secrets", "import", "--app", flyApp, "--stage"]',
    );
    expect(deployScript).not.toMatch(
      /--env[^\n]+OMNIAGENT_OPENAI_GATEWAY_(?:PREVIOUS_)?TOKEN=/,
    );
  });

  it("rejects untracked drift and polls asynchronous evaluation smoke jobs", async () => {
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

    expect(deployScript).toContain('"--porcelain"');
    expect(deployScript).not.toContain("--untracked-files=no");
    expect(deployScript).toContain('"--skip-domain"');
    expect(deployScript).toContain('"--scope", VERCEL_SCOPE');
    expect(deployScript).toContain("previousWorkerImage");
    expect(deployScript).toContain("previousVercelDeployment");
    expect(deployScript).toContain("previousHealthRevision");
    expect(deployScript).toContain("runRollbackVerification");
    expect(deployScript).toContain(
      "SMOKE_EXPECTED_REVISION: expectedRevision",
    );
    expect(deployScript).toContain("asael-release-evidence-");
    expect(deployScript).toContain('SMOKE_REQUEST_TIMEOUT_MS: "60000"');
    expect(deployScript).toContain("OMNIAGENT_OPENAI_GATEWAY_URL");
    expect(deployScript).toContain("OMNIAGENT_OPENAI_GATEWAY_TOKEN");
    expect(deployScript).toContain("OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN");
    expect(deployScript).toContain("OMNIAGENT_OPENAI_GATEWAY_INITIAL_CUTOVER");
    expect(deployScript).toContain('"x-asael-gateway-token"');
    expect(deployScript).toContain('new URL("/healthz"');
    expect(deployScript).toContain('new URL("/v1/models/gpt-5"');
    expect(deployScript).toContain("waitForOpenAIGatewayReadiness");
    expect(deployScript).toContain("waitForOpenAIGatewayTokenPair");
    expect(deployScript).toContain("stageFlyGatewayTokenOverlap");
    expect(deployScript).toContain("createRollbackGatewayConfiguration");
    expect(deployScript).toContain("runPaidOpenAIGatewayInference");
    expect(deployScript).toContain("runPaidAgentVerification");
    expect(deployScript).toContain('["run", "smoke:paid-agent"]');
    expect(deployScript).toContain("PAID_INFERENCE_MAX_OUTPUT_TOKENS = 16");
    expect(deployScript).toContain("store: false");
    expect(deployScript).toContain("/tmp/asael-worker.pid");
    expect(deployScript).toContain("kill -HUP");
    expect(deployScript).toContain("kill -USR1");
    expect(deployScript).toContain(
      '"OMNIAGENT_WORKER_RELEASE_HOLD=true"',
    );
    expect(deployScript).toContain(
      '"OMNIAGENT_WORKER_RELEASE_HOLD=false"',
    );
    expect(deployScript).toContain("workerRollbackArgs");
    expect(deployScript).toContain("fly.initial-cutover-rollback.toml");
    expect(deployScript).toContain(
      "runRollbackVerification(\n      productionBaseUrl,\n      previousHealthRevision,\n      rollbackOpenAIGateway",
    );
    expect(deployScript).toContain("sensitive command output was suppressed");
    expect(deployScript).toContain(
      'const PRODUCTION_BASE_URL = "https://omniagent-os.vercel.app"',
    );
    expect(deployScript).toContain(
      "candidate?.status ?? candidate?.Status",
    );
    expect(deployScript).toContain(
      "candidate?.version ?? candidate?.Version",
    );
    expect(deployScript).toContain('status === "complete"');
    expect(deployScript).toContain(
      "VERCEL_DEPLOYMENT_HOST_PATTERN.test(url.hostname)",
    );
    expect(deployScript).not.toContain('"cron secret"');
    expect(deployScript).toContain("SMOKE_SESSION_OUTPUT");
    expect(deployScript).toContain("BENCHMARK_SESSION_FILE");
    expect(securitySmoke).toContain("SMOKE_SESSION_OUTPUT");
    expect(previewBenchmark).toContain("BENCHMARK_SESSION_FILE");
    expect(dashboardBenchmark).toContain("BENCHMARK_SESSION_FILE");
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
      'request("/api/release/evidence?refresh=true"',
    );
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
