import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
const exec = promisify(execFile);

test("selected probe exercises once, preserves receipts and only reads on canonical verification", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "asael-completion-probe-"));
  const root = "11111111-1111-4111-8111-111111111111", custom = "22222222-2222-4222-8222-222222222222";
  const taskIds = [`dar_${"a".repeat(40)}`, `dar_${"b".repeat(40)}`];
  const h = createHash("sha256").update(`delegation-parent:${root}`).digest("hex");
  const resumed = `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
  let title = "", project = 0, agentTurns = 0, writes = 0, failSpecialist = false;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const value = body ? JSON.parse(body) : {};
    const url = request.url;
    let payload = {}, status = 200;
    if (url === "/api/health") payload = { status: "healthy", revision: "candidate" };
    else if (url === "/api/auth/login") { response.setHeader("set-cookie", "session=fixture; HttpOnly"); payload = { authenticated: true, context: { source: "session", tenantId: "fixture" } }; }
    else if (url === "/api/auth/logout") payload = { authenticated: false };
    else if (url === "/api/projects") { writes++; status = 201; payload = { project: { id: `project-${++project}` } }; }
    else if (url === "/api/agents") { writes++; status = 201; payload = { agent: { id: custom } }; }
    else if (url === "/api/threads") { writes++; status = 201; title = `${value.title} recommendation`; payload = { thread: { id: "thread" } }; }
    else if (url === "/api/agent") { writes++; agentTurns++; assert.equal(value.contextScope, "session"); assert.equal(request.headers["idempotency-key"], value.requestId); response.setHeader("x-asael-run-id", root); response.setHeader("content-type", "text/event-stream"); response.end(`data: ${JSON.stringify({ type: "run", runId: root })}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`); return; }
    else if (url === `/api/runs/${root}`) payload = { run: { response: taskIds.join(" ") } };
    else if (url === `/api/runs/${resumed}`) payload = { run: { status: "completed", response: "Vendor A qualifies." } };
    else if (url === `/api/runs/${resumed}/trajectory`) payload = { trajectory: { events: ["app.knowledge.ingest", "app.knowledge.list"].map(toolId => ({ type: "run.tool", receipt: { toolId, status: "executed", dryRun: false } })) } };
    else if (url === "/api/threads/thread") payload = { turns: [{ id: `parent-result:${resumed}`, content: "Vendor A qualifies." }] };
    else if (url?.startsWith("/api/agents/tasks/")) { const i = taskIds.indexOf(url.split("/").at(-1)); payload = { task: { executionId: taskIds[i], delegateAgentId: i === 0 ? "scout" : custom, state: failSpecialist && i === 1 ? "failed" : "verified", failureCode: failSpecialist && i === 1 ? "runtime_assignment_changed" : undefined, result: { draftArtifacts: [{ content: "Vendor B: 450 USD, 10 days" }] } } }; }
    else if (url === "/api/knowledge?limit=100") payload = { documents: [{ id: "document", title }], chunks: [{ documentId: "document", content: "Vendor A USD 600, 7 days qualifies. Vendor B USD 450, 10 days fails the 8-day deadline." }] };
    else { status = 404; payload = { error: "Unknown fixture request" }; }
    response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const file = path.join(dir, "evidence.json");
  const env = { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}`, EXPECTED_REVISION: "candidate", SMOKE_AGENT_COMPLETION_ALLOW_LOOPBACK: "CONFIRMED", LIVE_VERIFY_AGENT_COMPLETION: "CONFIRMED", SMOKE_AGENT_COMPLETION_EVIDENCE_FILE: file, SMOKE_PAID_AGENT_EMAIL: "fixture@example.test", SMOKE_PAID_AGENT_PASSWORD: "fixture-password", SMOKE_INTERNAL_AUTH_SECRET: "fixture-secret" };
  try {
    await exec(process.execPath, ["scripts/smoke-agent-completion.mjs"], { env, timeout: 30_000 });
    assert.equal(agentTurns, 1); assert.equal(writes, 5);
    await exec(process.execPath, ["scripts/smoke-agent-completion.mjs"], { env: { ...env, SMOKE_AGENT_COMPLETION_MODE: "readback" }, timeout: 30_000 });
    assert.equal(agentTurns, 1); assert.equal(writes, 5);
    const result = JSON.parse(await readFile(file, "utf8"));
    assert.equal(result.status, "passed"); assert.equal(result.canonicalReadback, true); assert.equal(result.signedOut, true);
    failSpecialist = true;
    await assert.rejects(exec(process.execPath, ["scripts/smoke-agent-completion.mjs"], { env: { ...env, SMOKE_AGENT_COMPLETION_MODE: "readback" }, timeout: 30_000 }));
    const failed = JSON.parse(await readFile(file, "utf8"));
    assert.equal(failed.status, "failed"); assert.equal(failed.taskStates[1].failureCode, "runtime_assignment_changed");
    assert.equal(failed.continuation.status, "completed"); assert.equal(failed.signedOut, true);
    assert.equal(agentTurns, 1); assert.equal(writes, 5);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
