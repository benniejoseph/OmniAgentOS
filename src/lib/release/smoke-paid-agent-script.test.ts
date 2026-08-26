import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";

const revision = "release-ready";
const internalSecret = "internal-paid-agent-secret";
const bypassSecret = "vercel-paid-agent-bypass";

describe("paid agent release smoke", () => {
  it("uses the deployed app for exactly one OpenAI turn and verifies persisted evidence", async () => {
    await withPaidAgentServer(false, async (baseUrl, observed) => {
      const result = await runProcess(baseUrl);

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(observed.agentTurns).toBe(1);
      expect(observed.deletedAgents).toBe(1);
      expect(observed.healthChecks).toBe(2);
      expect(observed.paths).toEqual([
        "/api/health",
        "/api/agents",
        "/api/agents/agent_paid_verify",
        "/api/agent",
        "/api/runs/run_paid_verify?replay=true",
        "/api/runs/run_paid_verify/trajectory",
        "/api/health",
        "/api/agents/agent_paid_verify",
      ]);
      expect(observed.createBody).toMatchObject({
        instructions: "Reply only ASAEL_LIVE_OK",
        modelPolicy: "openai_fast",
        memoryScope: "session",
        skillIds: [],
        toolIds: [],
      });
      expect(observed.patchBody).toMatchObject({
        accent: "blue",
      });
      expect(observed.patchBody).not.toHaveProperty("modelPolicy");
      expect(observed.agentBody).toMatchObject({
        messages: [{ role: "user", content: "hello" }],
        strategy: "direct",
        agentId: "agent_paid_verify",
      });
      expect(result.stdout).toContain('"status": "PASS"');
      expect(result.stdout).toContain('"provider": "openai"');
      expect(result.stdout).toContain('"trajectoryVerified": true');
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(internalSecret);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(bypassSecret);
    });
  });

  it("does not retry a failed paid turn and still deletes the temporary agent", async () => {
    await withPaidAgentServer(true, async (baseUrl, observed) => {
      const result = await runProcess(baseUrl);

      expect(result.code).toBe(1);
      expect(observed.agentTurns).toBe(1);
      expect(observed.deletedAgents).toBe(1);
      expect(observed.paths).not.toContain(
        "/api/runs/run_paid_verify?replay=true",
      );
      expect(result.stderr).toContain("Minimal OpenAI turn used a fallback.");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(internalSecret);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(bypassSecret);
    });
  });

  it("rejects secret-bearing requests to non-Asael or noncanonical targets", async () => {
    for (const baseUrl of [
      "https://example.com",
      "https://omniagent-os.vercel.app:443",
      "https://omniagent-os.vercel.app/path",
      "https://omniagent-test-benniejosephs-projects.vercel.app.evil.test",
    ]) {
      const result = await runProcess(baseUrl);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "BASE_URL is not an approved Asael release target.",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(internalSecret);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(bypassSecret);
    }

    const disallowedLoopback = await runProcess("http://127.0.0.1:1", {
      SMOKE_PAID_AGENT_ALLOW_LOOPBACK: "",
    });
    expect(disallowedLoopback.code).toBe(1);
    expect(disallowedLoopback.stderr).toContain(
      "BASE_URL is not an approved Asael release target.",
    );
  });
});

type ObservedRequests = {
  agentTurns: number;
  deletedAgents: number;
  healthChecks: number;
  paths: string[];
  createBody?: Record<string, unknown>;
  patchBody?: Record<string, unknown>;
  agentBody?: Record<string, unknown>;
};

async function withPaidAgentServer(
  fallbackUsed: boolean,
  callback: (baseUrl: string, observed: ObservedRequests) => Promise<void>,
) {
  const observed: ObservedRequests = {
    agentTurns: 0,
    deletedAgents: 0,
    healthChecks: 0,
    paths: [],
  };
  const server = createServer((request, response) => {
    handleRequest(request, response, fallbackUsed, observed).catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Paid smoke test server did not expose a TCP address.");
  }
  try {
    await callback(`http://127.0.0.1:${address.port}`, observed);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  fallbackUsed: boolean,
  observed: ObservedRequests,
) {
  const requestPath = request.url || "missing";
  observed.paths.push(requestPath);
  expect(request.headers["x-omni-internal-auth"]).toBe(internalSecret);
  expect(request.headers["x-omni-synthetic-auth"]).toBe(internalSecret);
  expect(request.headers["x-vercel-protection-bypass"]).toBe(bypassSecret);
  expect(request.headers.authorization).toBeUndefined();
  const tenantId = String(request.headers["x-omni-tenant-id"] || "");
  expect(tenantId).toMatch(/^paid_verify_/);

  if (request.method === "GET" && requestPath === "/api/health") {
    observed.healthChecks += 1;
    return json(response, 200, {
      status: "healthy",
      revision,
      dependencies: { openAiConfigured: true },
    });
  }

  if (request.method === "POST" && requestPath === "/api/agents") {
    observed.createBody = await readJsonBody(request);
    return json(response, 201, {
      agent: {
        ...observed.createBody,
        id: "agent_paid_verify",
        tenantId,
      },
    });
  }

  if (
    request.method === "PATCH" &&
    requestPath === "/api/agents/agent_paid_verify"
  ) {
    observed.patchBody = await readJsonBody(request);
    return json(response, 200, {
      agent: {
        id: "agent_paid_verify",
        tenantId,
        modelPolicy: "openai_fast",
        ...observed.patchBody,
      },
    });
  }

  if (request.method === "POST" && requestPath === "/api/agent") {
    observed.agentTurns += 1;
    observed.agentBody = await readJsonBody(request);
    expect(request.headers["idempotency-key"]).toBe(
      observed.agentBody.requestId,
    );
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse([
      { type: "run", runId: "run_paid_verify" },
      {
        type: "model",
        provider: "openai",
        model: "gpt-4o-mini",
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        fallbackUsed,
      },
      { type: "done", response: "ASAEL_LIVE_OK" },
    ]));
    return;
  }

  if (
    request.method === "GET" &&
    requestPath === "/api/runs/run_paid_verify?replay=true"
  ) {
    return json(response, 200, {
      consistent: true,
      eventCount: 3,
      run: {
        id: "run_paid_verify",
        agentId: "agent_paid_verify",
        status: "completed",
        consolidationCount: 0,
        prompt: "hello",
        messageCount: 1,
      },
      replayed: { status: "completed" },
    });
  }

  if (
    request.method === "GET" &&
    requestPath === "/api/runs/run_paid_verify/trajectory"
  ) {
    return json(response, 200, {
      verification: { valid: true },
      trajectory: {
        run: {
          id: "run_paid_verify",
          tenantId,
          agentId: "agent_paid_verify",
        },
        request: { promptLength: 5, messageCount: 1 },
        runtime: { revision },
        providers: ["openai"],
        models: ["gpt-4o-mini"],
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
          fallbackCount: 0,
        },
        toolExecutionIds: [],
        events: [
          {
            seq: 1,
            type: "run.model",
            receipt: {
              provider: "openai",
              model: "gpt-4o-mini",
              inputTokens: 5,
              outputTokens: 2,
              totalTokens: 7,
              fallbackUsed: false,
            },
          },
          {
            seq: 2,
            type: "run.done",
            receipt: {
              responseLength: 13,
              responseSha256:
                "edcc57ac26f893ba4c0b7f7e24fd8926a2ee3b05b818761dd53c7b5f9a1fe63c",
            },
          },
        ],
      },
    });
  }

  if (
    request.method === "DELETE" &&
    requestPath === "/api/agents/agent_paid_verify"
  ) {
    observed.deletedAgents += 1;
    return json(response, 200, { deleted: true });
  }

  return json(response, 404, { error: "unexpected request" });
}

function runProcess(
  baseUrl: string,
  environment: Record<string, string | undefined> = {},
) {
  return new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/smoke-paid-agent.mjs"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        EXPECTED_REVISION: revision,
        LIVE_VERIFY_PAID_OPENAI: "CONFIRMED",
        SMOKE_PAID_AGENT_ALLOW_LOOPBACK: "CONFIRMED",
        OMNIAGENT_INTERNAL_AUTH_SECRET: internalSecret,
        VERCEL_AUTOMATION_BYPASS_SECRET: bypassSecret,
        OPENAI_API_KEY: "",
        ...environment,
      },
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

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sse(events: Array<Record<string, unknown>>) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}
