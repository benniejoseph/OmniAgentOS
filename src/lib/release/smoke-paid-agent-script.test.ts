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
const ownerTenantId = "tenant_owner.personal";
const ownerEmail = "owner@example.test";
const ownerPassword = "owner paid-agent password";
const sessionToken = "paid-agent-session-token";
const sessionCookie = `__Host-asael_session=${sessionToken}`;
const agentPath = "/api/agents/agent_paid_verify";
const trashId = "trash:0f0e0d0c-0b0a-4908-8706-050403020100";
const purgePath = `/api/trash/${encodeURIComponent(trashId)}/purge`;
const trashPreview = {
  version: "trash-preview.v1",
  action: "trash",
  trashId: null,
  resourceType: "custom_agent",
  resourceId: "agent_paid_verify",
  lifecycleRevision: 0,
  targetSha256: "a".repeat(64),
  effectSummary: "Move the agent to Trash.",
  reversible: true,
  issuedAt: "2026-10-02T00:00:00.000Z",
  expiresAt: "2026-10-02T00:10:00.000Z",
  previewSha256: "b".repeat(64),
};
const purgePreview = {
  ...trashPreview,
  action: "purge",
  trashId,
  lifecycleRevision: 1,
  effectSummary: "Permanently delete the agent.",
  reversible: false,
  previewSha256: "c".repeat(64),
};

describe("paid agent release smoke", () => {
  it("uses the deployed app for exactly one OpenAI turn and verifies persisted evidence", async () => {
    await withPaidAgentServer({}, async (baseUrl, observed) => {
      const result = await runProcess(baseUrl);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.code, output).toBe(0);
      expect(observed.agentTurns).toBe(1);
      expect(observed.trashedAgents).toBe(1);
      expect(observed.purgedAgents).toBe(1);
      expect(observed.healthChecks).toBe(2);
      expect(observed.requests).toEqual([
        "GET /api/health",
        "POST /api/auth/login",
        "POST /api/agents",
        `PATCH ${agentPath}`,
        "POST /api/agent",
        "GET /api/runs/run_paid_verify?replay=true",
        "GET /api/runs/run_paid_verify/trajectory",
        "GET /api/health",
        `GET ${agentPath}?mode=trash-preview`,
        `DELETE ${agentPath}`,
        `GET ${purgePath}`,
        `DELETE ${purgePath}`,
        "POST /api/auth/logout",
      ]);
      expect(observed.signInBody).toEqual({
        email: ownerEmail,
        password: ownerPassword,
      });
      expect(observed.sessionOpen).toBe(false);
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
      expect(result.stdout).toContain(`"trashId": "${trashId}"`);
      expect(result.stdout).toContain('"agentPurged": true');
      expect(result.stdout).toContain('"signedOut": true');
      expect(output).not.toContain(ownerTenantId);
      expect(output).not.toContain(ownerEmail);
      expect(output).not.toContain(ownerPassword);
      expect(output).not.toContain(sessionToken);
      expect(output).not.toContain(internalSecret);
      expect(output).not.toContain(bypassSecret);
    });
  });

  it("does not retry a failed paid turn and still removes the temporary agent", async () => {
    await withPaidAgentServer({ fallbackUsed: true }, async (baseUrl, observed) => {
      const result = await runProcess(baseUrl);

      expect(result.code).toBe(1);
      expect(observed.agentTurns).toBe(1);
      expect(observed.trashedAgents).toBe(1);
      expect(observed.purgedAgents).toBe(1);
      expect(observed.requests).not.toContain(
        "GET /api/runs/run_paid_verify?replay=true",
      );
      expect(observed.requests.at(-1)).toBe("POST /api/auth/logout");
      expect(observed.sessionOpen).toBe(false);
      expect(result.stderr).toContain("Minimal OpenAI turn used a fallback.");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(internalSecret);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(bypassSecret);
    });
  });

  it("rejects secret-bearing requests to non-Asael or noncanonical targets", async () => {
    for (const baseUrl of [
      "https://example.com",
      "https://asael.bennierichard.com:443",
      "https://asael.bennierichard.com/path",
      "https://omniagent-test-benniejosephs-projects.vercel.app.evil.test",
    ]) {
      const result = await runProcess(baseUrl);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "BASE_URL is not an approved Asael release target.",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(internalSecret);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(bypassSecret);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(ownerPassword);
    }

    const disallowedLoopback = await runProcess("http://127.0.0.1:1", {
      SMOKE_PAID_AGENT_ALLOW_LOOPBACK: "",
    });
    expect(disallowedLoopback.code).toBe(1);
    expect(disallowedLoopback.stderr).toContain(
      "BASE_URL is not an approved Asael release target.",
    );
  });

  it("refuses a missing sign-in account before any request", async () => {
    await withPaidAgentServer({}, async (baseUrl, observed) => {
      for (const [environment, message] of [
        [{ SMOKE_PAID_AGENT_EMAIL: " " }, "SMOKE_PAID_AGENT_EMAIL is required."],
        [
          { SMOKE_PAID_AGENT_PASSWORD: " " },
          "SMOKE_PAID_AGENT_PASSWORD is required.",
        ],
      ] as const) {
        const result = await runProcess(baseUrl, environment);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(message);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(ownerPassword);
      }
      expect(observed.requests).toEqual([]);
    });
  });

  it("creates nothing when sign-in is refused", async () => {
    await withPaidAgentServer({ signInStatus: 401 }, async (baseUrl, observed) => {
      const result = await runProcess(baseUrl);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Sign-in returned HTTP 401.");
      expect(observed.requests).toEqual([
        "GET /api/health",
        "POST /api/auth/login",
      ]);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(ownerPassword);
    });
  });

  it("signs out of a sign-in reply that is not a browser session", async () => {
    await withPaidAgentServer({ sessionSource: "headers" }, async (baseUrl, observed) => {
      const result = await runProcess(baseUrl);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Sign-in did not open a browser session.");
      expect(observed.requests).toEqual([
        "GET /api/health",
        "POST /api/auth/login",
        "POST /api/auth/logout",
      ]);
      expect(observed.sessionOpen).toBe(false);
    });
  });

  it("fails when the session is not signed out, after removing the agent", async () => {
    await withPaidAgentServer({ signOutStatus: 403 }, async (baseUrl, observed) => {
      const result = await runProcess(baseUrl);

      expect(result.code).toBe(1);
      expect(observed.purgedAgents).toBe(1);
      expect(result.stderr).toContain(
        "FAIL paid agent verification: Sign-out: POST /api/auth/logout expected HTTP 200, received 403.",
      );
      expect(result.stdout).not.toContain('"status": "PASS"');
    });
  });

  it("redacts the account, password, and session from a failure", async () => {
    await withPaidAgentServer({ streamErrorEchoesAccount: true }, async (baseUrl, observed) => {
      const result = await runProcess(baseUrl);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.code).toBe(1);
      expect(observed.sessionOpen).toBe(false);
      expect(result.stderr).toContain("Agent stream failed:");
      expect(result.stderr).toContain("[redacted-account]");
      expect(result.stderr).toContain("[redacted-secret]");
      expect(output).not.toContain(ownerPassword);
      expect(output).not.toContain(sessionToken);
      expect(output.toLowerCase()).not.toContain(ownerEmail);
    });
  });

  it("fails when the trashed agent is not confirmed purged", async () => {
    await withPaidAgentServer({ purgedState: "retained" }, async (baseUrl, observed) => {
      const result = await runProcess(baseUrl);

      expect(result.code).toBe(1);
      expect(observed.trashedAgents).toBe(1);
      expect(result.stderr).toContain("Trashed agent was not purged.");
      expect(result.stdout).not.toContain('"status": "PASS"');
    });
  });
});

type PaidAgentServerOptions = {
  fallbackUsed?: boolean;
  purgedState?: string;
  signInStatus?: number;
  sessionSource?: string;
  signOutStatus?: number;
  streamErrorEchoesAccount?: boolean;
};

type ObservedRequests = {
  agentTurns: number;
  trashedAgents: number;
  purgedAgents: number;
  healthChecks: number;
  requests: string[];
  sessionOpen: boolean;
  signInBody?: Record<string, unknown>;
  createBody?: Record<string, unknown>;
  patchBody?: Record<string, unknown>;
  agentBody?: Record<string, unknown>;
};

async function withPaidAgentServer(
  options: PaidAgentServerOptions,
  callback: (baseUrl: string, observed: ObservedRequests) => Promise<void>,
) {
  const observed: ObservedRequests = {
    agentTurns: 0,
    trashedAgents: 0,
    purgedAgents: 0,
    healthChecks: 0,
    requests: [],
    sessionOpen: false,
  };
  const server = createServer((request, response) => {
    handleRequest(request, response, options, observed).catch((error) => {
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
  options: PaidAgentServerOptions,
  observed: ObservedRequests,
) {
  const requestPath = request.url || "missing";
  observed.requests.push(`${request.method} ${requestPath}`);
  // The check signs in like the app: no internal identity, and every request
  // after sign-in carries the session from the app's own origin.
  expect(request.headers["x-omni-internal-auth"]).toBeUndefined();
  expect(request.headers["x-omni-tenant-id"]).toBeUndefined();
  expect(request.headers["x-omni-user-id"]).toBeUndefined();
  expect(request.headers["x-omni-user-role"]).toBeUndefined();
  expect(request.headers["x-omni-synthetic-auth"]).toBe(internalSecret);
  expect(request.headers["x-vercel-protection-bypass"]).toBe(bypassSecret);
  expect(request.headers.authorization).toBeUndefined();
  expect(request.headers.origin).toBe("https://asael.bennierichard.com");
  expect(request.headers.cookie).toBe(
    observed.sessionOpen ? sessionCookie : undefined,
  );
  const tenantId = ownerTenantId;

  if (request.method === "POST" && requestPath === "/api/auth/login") {
    observed.signInBody = await readJsonBody(request);
    if (options.signInStatus) {
      return json(response, options.signInStatus, { error: "Unauthorized" });
    }
    observed.sessionOpen = true;
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie":
        `${sessionCookie}; Path=/; Expires=Fri, 09 Oct 2026 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`,
    });
    response.end(JSON.stringify({
      authenticated: true,
      context: {
        tenantId,
        actorId: "actor:0f0e0d0c-0b0a-4908-8706-050403020100",
        role: "admin",
        source: options.sessionSource ?? "session",
      },
    }));
    return;
  }

  if (request.method === "POST" && requestPath === "/api/auth/logout") {
    if (options.signOutStatus) {
      return json(response, options.signOutStatus, { error: "Forbidden" });
    }
    observed.sessionOpen = false;
    return json(response, 200, { authenticated: false });
  }

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
    if (options.streamErrorEchoesAccount) {
      response.end(sse([{
        type: "error",
        message:
          `Rejected ${ownerEmail.toUpperCase()} with ${ownerPassword} and ${request.headers.cookie}.`,
      }]));
      return;
    }
    response.end(sse([
      { type: "run", runId: "run_paid_verify" },
      {
        type: "model",
        provider: "openai",
        model: "gpt-4o-mini",
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        fallbackUsed: options.fallbackUsed === true,
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
    request.method === "GET" &&
    requestPath === `${agentPath}?mode=trash-preview`
  ) {
    return json(response, 200, { preview: trashPreview, reversible: true });
  }

  if (request.method === "DELETE" && requestPath === agentPath) {
    expect(await readJsonBody(request)).toEqual({ preview: trashPreview });
    observed.trashedAgents += 1;
    return json(response, 200, {
      movedToTrash: true,
      trash: {
        trashId,
        resourceType: "custom_agent",
        resourceId: "agent_paid_verify",
        state: "retained",
      },
    });
  }

  if (request.method === "GET" && requestPath === purgePath) {
    return json(response, 200, {
      item: { trashId, state: "retained" },
      preview: purgePreview,
      permanent: true,
    });
  }

  if (request.method === "DELETE" && requestPath === purgePath) {
    expect(await readJsonBody(request)).toEqual({ preview: purgePreview });
    observed.purgedAgents += 1;
    return json(response, 200, {
      trash: { trashId, state: options.purgedState ?? "purged" },
      finalDeletionReceipt: { action: "purge" },
    });
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
        SMOKE_INTERNAL_AUTH_SECRET: internalSecret,
        OMNIAGENT_INTERNAL_AUTH_SECRET: internalSecret,
        VERCEL_AUTOMATION_BYPASS_SECRET: bypassSecret,
        SMOKE_PAID_AGENT_EMAIL: ownerEmail,
        SMOKE_PAID_AGENT_PASSWORD: ownerPassword,
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
