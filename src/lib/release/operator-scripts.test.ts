import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scripts = ["run-evals.mjs", "smoke-expanded-checkpoints.mjs"] as const;
type Script = typeof scripts[number];
const tenantId = "tenant_operator.personal";
const actorId = "owner@example.test";
const password = " operator owner password ";
const internalSecret = "operator-synthetic-secret";
const bypassSecret = "operator-vercel-bypass";
const sessionToken = "operator-session-token";
const sessionCookie = `__Host-asael_session=${sessionToken}`;
const secretEcho = [actorId.toUpperCase(), password, internalSecret, bypassSecret, sessionToken].join(" ");

describe.each(scripts)("%s authenticated operator flow", (script) => {
  it("signs in, executes once per task with the cookie and Origin, cleans up, and signs out", async () => {
    await withServer({}, async (baseUrl, observed) => {
      const result = await runProcess(script, baseUrl);
      expect(result.code, result.stderr).toBe(0);
      expect(observed.login).toEqual({ email: actorId, password });
      expect(observed.turns).toBe(script === "run-evals.mjs" ? 1 : 2);
      expect(observed.requests.at(-1)).toBe("POST /api/auth/logout");
      expect(observed.sessionOpen).toBe(false);
      if (script === "run-evals.mjs") {
        expect(observed.agentBodies[0]).toMatchObject({
          agentId: "replay-reader",
          requireReadOnlyAgent: true,
          messages: [{ role: "user", content: "Summarize the synthetic notes." }],
        });
        expect(result.stdout).toContain("Scoreboard: 1/1 passed");
        expect(observed.created).toEqual([]);
      } else {
        expect(observed.created).toEqual(["checkpoint-agent-1", "checkpoint-agent-2"]);
        expect(observed.trashed).toEqual([...observed.created].reverse());
        expect(observed.purged).toHaveLength(2);
        expect(result.stdout).toContain('"agentsPurged":2');
        expect(result.stdout).toContain('"signedOut":true');
      }
      expectRedacted(result);
    });
  });

  it.each([
    [{ sessionSource: "headers" }, "Sign-in did not open a browser session."],
    [{ tenantId: "another-tenant" }, "Signed-in tenant does not match the expected tenant."],
    [{ actorId: "another-owner" }, "Signed-in actor does not match the expected actor."],
    [{ malformedLogin: true }, "Sign-in returned invalid JSON."],
  ] as const)("logs out without executing for an invalid session reply %j", async (options, message) => {
    await withServer(options, async (baseUrl, observed) => {
      const result = await runProcess(script, baseUrl);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
      expect(observed.turns).toBe(0);
      expect(observed.created).toEqual([]);
      expect(observed.requests.at(-1)).toBe("POST /api/auth/logout");
      expect(observed.sessionOpen).toBe(false);
      expectRedacted(result);
    });
  });

  it("does not retry a failed paid POST and still cleans up and logs out", async () => {
    await withServer({ agentStatus: 503 }, async (baseUrl, observed) => {
      const result = await runProcess(script, baseUrl);
      expect(result.code).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("HTTP 503");
      expect(observed.turns).toBe(1);
      expect(observed.purged).toHaveLength(script === "run-evals.mjs" ? 0 : 1);
      expect(observed.requests.at(-1)).toBe("POST /api/auth/logout");
      expect(observed.sessionOpen).toBe(false);
    });
  });

  it("does not replay a paid POST after an ambiguous connection loss", async () => {
    await withServer({ disconnectAgent: true }, async (baseUrl, observed) => {
      const result = await runProcess(script, baseUrl);
      expect(result.code).toBe(1);
      expect(observed.turns).toBe(1);
      expect(observed.purged).toHaveLength(script === "run-evals.mjs" ? 0 : 1);
      expect(observed.requests.at(-1)).toBe("POST /api/auth/logout");
      expect(observed.sessionOpen).toBe(false);
    });
  });

  it("reports the primary failure and sign-out failure without masking either", async () => {
    await withServer({ agentStatus: 503, logoutStatus: 503 }, async (baseUrl, observed) => {
      const result = await runProcess(script, baseUrl);
      expect(result.code).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("HTTP 503");
      expect(result.stderr).toContain("Sign-out:");
      if (script === "run-evals.mjs") expect(result.stderr).toContain("Below MIN_PASS_RATE");
      expect(observed.turns).toBe(1);
      expect(observed.requests.at(-1)).toBe("POST /api/auth/logout");
    });
  });

  it("redacts echoed account details, credentials, and session tokens", async () => {
    await withServer({ echoFailure: true }, async (baseUrl, observed) => {
      const result = await runProcess(script, baseUrl, {}, true);
      expect(result.code).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("[redacted-secret]");
      expect(`${result.stdout}\n${result.stderr}`).toContain("[redacted-account]");
      expect(observed.sessionOpen).toBe(false);
      expectRedacted(result);
    });
  });

  it.each([401, 302])("does not execute or follow redirects after sign-in returns %i", async (loginStatus) => {
    await withServer({ loginStatus }, async (baseUrl, observed) => {
      const result = await runProcess(script, baseUrl);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Sign-in returned HTTP ${loginStatus}.`);
      expect(observed.requests.at(-1)).toBe("POST /api/auth/login");
      expect(observed.turns).toBe(0);
      expect(observed.created).toEqual([]);
    });
  });

  it("requires real credentials before making any requests", async () => {
    await withServer({}, async (baseUrl, observed) => {
      const name = script === "run-evals.mjs" ? "EVAL_PASSWORD" : "SMOKE_CHECKPOINT_PASSWORD";
      const result = await runProcess(script, baseUrl, { [name]: "" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${name} is required.`);
      expect(observed.requests).toEqual([]);
    });
  });

  it("refuses noncanonical credential targets before making requests", async () => {
    for (const baseUrl of ["https://example.test", "https://asael.bennierichard.com/path", "https://asael.bennierichard.com:443"]) {
      const result = await runProcess(script, baseUrl);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("BASE_URL is not an approved Asael operator target.");
      expectRedacted(result);
    }
  });
});

describe("expanded checkpoint cleanup", () => {
  it("preserves the primary failure while reporting a refused cleanup and sign-out", async () => {
    await withServer({ agentStatus: 503, trashStatus: 409, logoutStatus: 403 }, async (baseUrl, observed) => {
      const result = await runProcess("smoke-expanded-checkpoints.mjs", baseUrl);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Agent request returned HTTP 503.");
      expect(result.stderr).toContain("Cleanup:");
      expect(result.stderr).toContain("received 409");
      expect(result.stderr).toContain("Sign-out:");
      expect(result.stdout).not.toContain('"status":"PASS"');
      expect(observed.turns).toBe(1);
      expect(observed.requests.at(-1)).toBe("POST /api/auth/logout");
    });
  });

  it.each([
    [{ wrongTrashPreview: true }, "Agent trash preview does not match", 0],
    [{ wrongPurgePreview: true }, "Trash purge preview does not match", 2],
    [{ purgedState: "retained" }, "Trashed agent was not purged", 2],
  ] as const)("fails a mismatched or unconfirmed removal %j and still attempts every cleanup", async (options, message, trashed) => {
    await withServer(options, async (baseUrl, observed) => {
      const result = await runProcess("smoke-expanded-checkpoints.mjs", baseUrl);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
      expect(observed.trashed).toHaveLength(trashed);
      expect(observed.requests.filter((request) => request.includes("?mode=trash-preview"))).toHaveLength(2);
      expect(observed.sessionOpen).toBe(false);
      expect(result.stdout).not.toContain('"status":"PASS"');
    });
  });
});

type Options = {
  sessionSource?: string;
  tenantId?: string;
  actorId?: string;
  malformedLogin?: boolean;
  loginStatus?: number;
  logoutStatus?: number;
  agentStatus?: number;
  disconnectAgent?: boolean;
  echoFailure?: boolean;
  trashStatus?: number;
  wrongTrashPreview?: boolean;
  wrongPurgePreview?: boolean;
  purgedState?: string;
};
type Observed = {
  requests: string[];
  turns: number;
  sessionOpen: boolean;
  login?: unknown;
  created: string[];
  trashed: string[];
  purged: string[];
  agentBodies: Record<string, unknown>[];
  protocolErrors: string[];
};

async function withServer(options: Options, callback: (baseUrl: string, observed: Observed) => Promise<void>) {
  const observed: Observed = { requests: [], turns: 0, sessionOpen: false, created: [], trashed: [], purged: [], agentBodies: [], protocolErrors: [] };
  const server = createServer((request, response) => {
    handleRequest(request, response, options, observed).catch((error) => {
      observed.protocolErrors.push(String(error));
      json(response, 500, { error: "Mock protocol assertion failed." });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server has no TCP address.");
  try {
    await callback(`http://127.0.0.1:${address.port}`, observed);
    expect(observed.protocolErrors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, options: Options, observed: Observed) {
  const requestPath = request.url || "";
  observed.requests.push(`${request.method} ${requestPath}`);
  for (const header of ["x-omni-internal-auth", "x-omni-tenant-id", "x-omni-user-id", "x-omni-user-role", "authorization"]) {
    expect(request.headers[header]).toBeUndefined();
  }
  expect(request.headers.origin).toBe(`http://${request.headers.host}`);
  expect(request.headers["x-omni-synthetic-auth"]).toBe(internalSecret);
  expect(request.headers["x-vercel-protection-bypass"]).toBe(bypassSecret);
  expect(request.headers.cookie).toBe(observed.sessionOpen ? sessionCookie : undefined);
  if (request.method !== "GET") expect(request.headers["idempotency-key"]).toEqual(expect.any(String));

  if (requestPath === "/api/health") return json(response, 200, { status: "healthy", revision: "test-revision" });
  if (requestPath === "/api/auth/login") {
    observed.login = await body(request);
    if (options.loginStatus) {
      response.setHeader("location", "/should-never-follow");
      return json(response, options.loginStatus, { error: secretEcho });
    }
    observed.sessionOpen = true;
    response.setHeader("set-cookie", `${sessionCookie}; Path=/; HttpOnly; Secure; SameSite=Lax`);
    if (options.malformedLogin) return response.end("{invalid json");
    return json(response, 200, {
      authenticated: true,
      context: { source: options.sessionSource ?? "session", tenantId: options.tenantId ?? tenantId, actorId: options.actorId ?? actorId },
    });
  }
  if (requestPath === "/api/auth/logout") {
    if (options.logoutStatus) return json(response, options.logoutStatus, { error: secretEcho });
    observed.sessionOpen = false;
    return json(response, 200, { authenticated: false });
  }
  expect(observed.sessionOpen).toBe(true);
  if (requestPath === "/api/agents" && request.method === "POST") {
    const id = `checkpoint-agent-${observed.created.length + 1}`;
    observed.created.push(id);
    await body(request);
    return json(response, 201, { agent: { id, tenantId } });
  }
  if (requestPath === "/api/agent") {
    observed.turns += 1;
    const input = await body(request);
    observed.agentBodies.push(input);
    if (options.disconnectAgent) {
      request.socket.destroy();
      return;
    }
    if (options.agentStatus) return json(response, options.agentStatus, { error: secretEcho });
    if (options.echoFailure) {
      return sse(response, [{ type: "error", message: secretEcho }]);
    }
    if (input.requireReadOnlyAgent) return sse(response, [{ type: "done", response: "Synthetic notes summarized." }]);
    expect(request.headers["idempotency-key"]).toBe(input.requestId);
    if (observed.turns === 1) {
      return sse(response, [
        { type: "run", runId: "approval-run" },
        { type: "waiting_approval", toolId: "runs.list", executionId: "approval-execution" },
      ]);
    }
    return sse(response, [
      { type: "run", runId: "council-run" },
      { type: "council_member", status: "completed" },
      { type: "council_verdict", status: "approved" },
      { type: "done", response: "Reviewed synthetic checkpoint." },
    ]);
  }
  if (requestPath === "/api/approvals/approval-execution") {
    expect(await body(request)).toMatchObject({ kind: "tool", decision: "approve" });
    return json(response, 200, { record: { status: "executed" }, continuation: { scheduled: true } });
  }
  if (requestPath.startsWith("/api/runs/")) return json(response, 200, { run: { status: "completed" }, consistent: true });

  const url = new URL(requestPath, "http://mock.test");
  const id = decodeURIComponent(url.pathname.split("/")[3] || "");
  if (url.pathname.startsWith("/api/agents/") && observed.created.includes(id)) {
    const preview = trashPreview(id);
    if (request.method === "GET") {
      expect(url.searchParams.get("mode")).toBe("trash-preview");
      return json(response, 200, { preview: options.wrongTrashPreview ? { ...preview, resourceId: "different-agent" } : preview });
    }
    expect(request.method).toBe("DELETE");
    expect(await body(request)).toEqual({ preview });
    if (options.trashStatus) return json(response, options.trashStatus, { error: secretEcho });
    observed.trashed.push(id);
    return json(response, 200, { movedToTrash: true, trash: { trashId: trashIdFor(id), resourceId: id } });
  }
  if (url.pathname.startsWith("/api/trash/")) {
    const agent = observed.created.find((agent) => trashIdFor(agent) === id);
    expect(agent).toBeDefined();
    expect(url.pathname.endsWith("/purge")).toBe(true);
    const preview = { ...trashPreview(agent!), action: "purge", trashId: id, lifecycleRevision: 1, reversible: false };
    if (request.method === "GET") {
      return json(response, 200, { preview: options.wrongPurgePreview ? { ...preview, trashId: "another-trash-item" } : preview });
    }
    expect(request.method).toBe("DELETE");
    expect(await body(request)).toEqual({ preview });
    observed.purged.push(id);
    return json(response, 200, { trash: { trashId: id, state: options.purgedState ?? "purged" } });
  }
  throw new Error(`Unexpected mock request: ${request.method} ${requestPath}`);
}

function trashIdFor(id: string) {
  return `trash:0f0e0d0c-0b0a-4908-8706-05040302010${id.at(-1)}`;
}

function trashPreview(id: string) {
  return {
    version: "trash-preview.v1", action: "trash", trashId: null,
    resourceType: "custom_agent", resourceId: id, lifecycleRevision: 0,
    targetSha256: "a".repeat(64), previewSha256: "b".repeat(64),
    effectSummary: "Move the temporary agent to Trash.", reversible: true,
    issuedAt: "2026-10-03T00:00:00.000Z", expiresAt: "2026-10-03T00:10:00.000Z",
  };
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sse(response: ServerResponse, events: unknown[]) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

type ProcessResult = { code: number | null; stdout: string; stderr: string };
async function runProcess(script: Script, baseUrl: string, overrides: Record<string, string> = {}, echoTask = false): Promise<ProcessResult> {
  const directory = await mkdtemp(path.join(tmpdir(), "asael-operator-test-"));
  try {
    const tasksFile = path.join(directory, "tasks.json");
    await writeFile(tasksFile, JSON.stringify({ kind: "ledger_replay", tasks: [{
      id: echoTask ? secretEcho : "synthetic-task", goal: "Summarize the synthetic notes.", assert: { minLength: 5 },
    }] }));
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("scripts", script)], {
        cwd: process.cwd(),
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          BASE_URL: baseUrl,
          EXPECTED_REVISION: "test-revision",
          SMOKE_INTERNAL_AUTH_SECRET: internalSecret,
          VERCEL_AUTOMATION_BYPASS_SECRET: bypassSecret,
          SMOKE_TENANT_ID: tenantId,
          SMOKE_ACTOR_ID: actorId,
          SMOKE_CHECKPOINT_EMAIL: actorId,
          SMOKE_CHECKPOINT_PASSWORD: password,
          SMOKE_CHECKPOINT_ALLOW_LOOPBACK: "CONFIRMED",
          EVAL_EMAIL: actorId,
          EVAL_PASSWORD: password,
          EVAL_TENANT_ID: tenantId,
          EVAL_ACTOR_ID: actorId,
          EVAL_AGENT_ID: "replay-reader",
          EVAL_TASKS_FILE: tasksFile,
          ...overrides,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => { stdout += data.toString(); });
      child.stderr.on("data", (data) => { stderr += data.toString(); });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Operator script test timed out.")); }, 15_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function expectRedacted(result: ProcessResult) {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  for (const secret of [tenantId, actorId, password.trim(), internalSecret, bypassSecret, sessionToken]) expect(output).not.toContain(secret.toLowerCase());
}
