import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const exec = promisify(execFile), revision = "a".repeat(40);
const original = "<main><h1>Build something <em>useful.</em></h1></main>";
const modified = "<main><h1>Harbor launch <em>ready.</em></h1></main>";
const hash = value => createHash("sha256").update(value).digest("hex");

async function fixture(run, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "asael-assistant-probe-"));
  const state = { turns: [], writes: [], title: "", session: null, content: original, checkExit: 0 };
  const server = createServer(async (request, response) => {
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : {}, url = new URL(request.url, "http://localhost");
      const route = url.pathname;
      let data = {}, status = 200;
      if (route === "/api/health") data = { status: "healthy", revision };
      else if (route === "/api/auth/login") {
        response.setHeader("set-cookie", "session=fixture; HttpOnly");
        data = { authenticated: true, context: { source: "session", tenantId: "tenant", actorId: "actor" } };
      } else if (route === "/api/auth/logout") data = { authenticated: false };
      else if (route === "/api/projects") {
        state.writes.push("project"); status = 201; data = { project: { id: "project" } };
        state.title = body.title + " — launch brief";
      } else if (route === "/api/agent") {
        assert.deepEqual([body.strategy, body.agentId, body.contextScope, body.projectId], ["direct", "atlas", "project", "project"]);
        // Match the route contract: only the composer message creates a saved
        // conversation for a direct run. A legacy messages-only run has none.
        assert.equal(typeof body.message, "string");
        assert.ok(body.message.length > 0);
        assert.equal(body.messages, undefined);
        assert.equal(body.threadId, state.turns.length ? "thread" : undefined);
        assert.equal(request.headers["idempotency-key"], body.requestId);
        assert.equal(body.budgets.retries, 0);
        state.turns.push(body.mode); state.writes.push(`agent:${body.mode}`);
        if (body.mode === "coding") state.content = modified;
        response.writeHead(200, { "content-type": "text/event-stream", "x-asael-run-id": `run-${body.mode}` });
        response.end(`data: ${JSON.stringify({ type: "done" })}\n\n`); return;
      } else if (/^\/api\/runs\/run-\w+$/.test(route)) {
        data = { run: { status: "completed", mode: options.wrongMode ? "orchestrate" : route.split("-").at(-1),
          ...(options.missingThread ? {} : { threadId: "thread" }), response: "Harbor budget USD 600, deadline 8 days." } };
      } else if (/^\/api\/runs\/run-\w+\/trajectory$/.test(route)) {
        const mode = route.split("/")[3].slice(4);
        const ids = mode === "chat" ? ["app.projects.show", ...(options.effectfulChat ? ["app.knowledge.ingest"] : [])]
          : mode === "cowork" ? ["app.projects.show", "app.knowledge.ingest", "app.knowledge.list"]
          : ["show", "file.read", "framework-doc.read", "file.edit", "command.run", "checkpoint.create"].map(id => `app.projects.builder.${id}`);
        data = { trajectory: { events: ids.map(toolId => ({ type: "run.tool", receipt: { toolId,
          status: "executed", dryRun: false, riskLevel: toolId === "app.knowledge.ingest" ? 1 : 0 } })) } };
      } else if (route === "/api/projects/project/builder") {
        if (body.action) {
          state.writes.push(`builder:${body.action}`);
          if (body.action === "create") state.session = { id: "session", status: "ready", currentCheckpointId: "checkpoint" };
          else if (body.action === "stop") state.session.status = "stopped";
          else throw new Error(`Unexpected Builder mutation: ${body.action}`);
          data = { session: state.session };
        } else if (url.searchParams.get("view") === "file") {
          data = { file: { content: state.content, sha256: hash(state.content) } };
        } else {
          data = { session: state.session,
            checkpoints: [{ id: "checkpoint", workspaceSha256: hash("workspace") }],
            activity: state.content === modified ? [
              { eventType: "app_builder.file.updated", detail: { path: "app/page.tsx", previousSha256: hash(original), sha256: hash(modified) } },
              { eventType: "app_builder.command.completed", detail: { command: "typecheck", exitCode: state.checkExit,
                workspaceUnchanged: true, workspaceAfterSha256: hash("workspace"), outputSha256: hash("passed") } },
            ] : [] };
        }
      } else if (route === "/api/knowledge") {
        data = { documents: [{ id: "document", title: state.title }], chunks: [{ documentId: "document", content: "Harbor landing page. Budget USD 600. Deadline 8 days." }] };
      } else if (route === "/api/threads/thread") {
        data = { thread: { mode: "coding", projectId: "project" }, turns: state.turns.flatMap(mode => [
          { role: "user" }, { role: "assistant", runId: `run-${mode}` },
        ]) };
      } else throw new Error(`Unexpected fixture route: ${route}`);
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const file = path.join(directory, "evidence.json");
  const env = { PATH: process.env.PATH, BASE_URL: `http://127.0.0.1:${server.address().port}`, EXPECTED_REVISION: revision,
    SMOKE_ASSISTANT_WORKSPACE_ALLOW_LOOPBACK: "CONFIRMED", LIVE_VERIFY_ASSISTANT_WORKSPACE: "CONFIRMED",
    SMOKE_ASSISTANT_WORKSPACE_EVIDENCE_FILE: file, SMOKE_PAID_AGENT_EMAIL: "fixture@example.test",
    SMOKE_PAID_AGENT_PASSWORD: "fixture-password", SMOKE_INTERNAL_AUTH_SECRET: "fixture-secret" };
  const invoke = (phase = "exercise") => exec(process.execPath, ["scripts/smoke-assistant-workspace.mjs"],
    { env: { ...env, SMOKE_ASSISTANT_WORKSPACE_MODE: phase }, timeout: 30_000 });
  const evidence = async () => JSON.parse(await readFile(file, "utf8"));
  try { await run({ state, invoke, evidence }); }
  finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
}

test("three modes exercise once, stop their sandbox, and use read-only canonical verification", async () => {
  await fixture(async ({ state, invoke, evidence }) => {
    await invoke();
    assert.deepEqual(state.turns, ["chat", "cowork", "coding"]);
    assert.deepEqual(state.writes, ["project", "agent:chat", "agent:cowork", "builder:create", "agent:coding", "builder:stop"]);
    const first = await evidence();
    assert.equal(first.status, "passed"); assert.equal(first.sandboxStopped, true); assert.equal(first.signedOut, true);
    await invoke("readback");
    assert.equal((await evidence()).canonicalReadback, true);
    assert.equal(state.writes.length, 6);
    await assert.rejects(invoke());
    assert.equal(state.writes.length, 6);
    state.checkExit = 1;
    await assert.rejects(invoke("readback"));
    const failed = await evidence();
    assert.equal(failed.status, "failed"); assert.match(failed.failure, /Passing typecheck evidence missing/);
    assert.equal(failed.signedOut, true); assert.equal(state.writes.length, 6);
  });
});

test("an effectful Chat receipt fails before Cowork or a paid coding workspace starts", async () => {
  await fixture(async ({ state, invoke, evidence }) => {
    await assert.rejects(invoke());
    assert.deepEqual(state.turns, ["chat"]); assert.equal(state.session, null);
    const result = await evidence();
    assert.equal(result.status, "failed"); assert.match(result.failure, /effectful tool action/);
    assert.equal(result.signedOut, true);
  }, { effectfulChat: true });
});

test("a completed standalone receipt is not accepted as a saved conversation", async () => {
  await fixture(async ({ state, invoke, evidence }) => {
    await assert.rejects(invoke());
    assert.deepEqual(state.turns, ["chat"]); assert.equal(state.session, null);
    const result = await evidence();
    assert.equal(result.status, "failed"); assert.match(result.failure, /missing its conversation/);
    assert.equal(result.runs.chat.status, "completed"); assert.equal(result.runs.chat.mode, "chat");
    assert.equal(result.runs.chat.threadId, undefined); assert.equal(result.signedOut, true);
  }, { missingThread: true });
});

test("an unexpected persisted mode fails with a distinct diagnostic", async () => {
  await fixture(async ({ state, invoke, evidence }) => {
    await assert.rejects(invoke());
    assert.deepEqual(state.turns, ["chat"]); assert.equal(state.session, null);
    const result = await evidence();
    assert.equal(result.status, "failed"); assert.match(result.failure, /unexpected mode/);
    assert.equal(result.runs.chat.mode, "orchestrate"); assert.equal(result.signedOut, true);
  }, { wrongMode: true });
});
