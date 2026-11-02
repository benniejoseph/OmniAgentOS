#!/usr/bin/env node
/** One three-mode Assistant scenario. Canonical verification only reads its receipts. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const production = "https://asael.bennierichard.com";
const base = new URL(required("BASE_URL"));
const loopback = process.env.SMOKE_ASSISTANT_WORKSPACE_ALLOW_LOOPBACK === "CONFIRMED" &&
  base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname);
assert((loopback || base.protocol === "https:" && (base.origin === production ||
  /^https:\/\/omniagent-[a-z0-9]+-benniejosephs-projects\.vercel\.app$/.test(base.origin))) &&
  base.pathname === "/" && !base.search && !base.hash && !base.username && !base.password, "Unapproved candidate URL");
assert(process.env.LIVE_VERIFY_ASSISTANT_WORKSPACE === "CONFIRMED", "Explicit scenario admission required");
const revision = required("EXPECTED_REVISION"), file = required("SMOKE_ASSISTANT_WORKSPACE_EVIDENCE_FILE");
const email = required("SMOKE_PAID_AGENT_EMAIL"), password = required("SMOKE_PAID_AGENT_PASSWORD");
const secret = required("SMOKE_INTERNAL_AUTH_SECRET"), bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "";
const phase = process.env.SMOKE_ASSISTANT_WORKSPACE_MODE || "exercise";
assert(["exercise", "readback"].includes(phase), "Unknown scenario phase");
let cookie = "", failure, signedOut = false;
let evidence = { scenario: "assistant_workspace_v1", revision, status: "pending", runs: {}, resourcesRetained: true };
// Never start a second paid exercise over a completed or failed attempt.
if (phase === "exercise") await writeFile(file, JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
else evidence = JSON.parse(await readFile(file, "utf8"));

try {
  const health = await json("/api/health");
  assert(health.status === "healthy" && health.revision === revision, "Candidate health or revision mismatch");
  const login = await request("/api/auth/login", { email, password });
  cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  assert(login.status === 200 && cookie, "Fresh scenario sign-in failed");
  const auth = JSON.parse(await boundedText(login));
  assert(auth.authenticated && auth.context?.source === "session", "Scenario requires a session identity");
  if (phase === "readback") {
    assert(evidence.scenario === "assistant_workspace_v1" && evidence.revision === revision &&
      evidence.status === "passed" && evidence.tenantId === auth.context.tenantId &&
      evidence.actorId === auth.context.actorId && evidence.sandboxStopped === true,
    "Saved scenario does not match this release and owner");
  } else {
    evidence.tenantId = auth.context.tenantId; evidence.actorId = auth.context.actorId;
    evidence.marker = randomUUID();
    evidence.documentTitle = `Assistant validation ${evidence.marker} — launch brief`;
    const project = await json("/api/projects", {
      title: `Assistant validation ${evidence.marker}`,
      objective: "Fictional Harbor launch: budget USD 600, deadline 8 days, deliverable a landing page. Release validation only.",
    }, 201);
    evidence.projectId = project.project?.id;
    assert(typeof evidence.projectId === "string" && evidence.projectId, "Fixture project identity missing");
    await save();

    await turn("chat", `Read project ${evidence.projectId} with app.projects.show, includeFullObjective=true. What are its recorded budget, deadline, and deliverable? Cite the saved project. Answer only; do not create or change anything.`,
      { modelTurns: 4, tokens: 80_000, toolCalls: 6, costMicrousd: 750_000 });
    await verifyRun("chat");
    await turn("cowork", `Use the same fictional project ${evidence.projectId}. Read its current recorded objective with app.projects.show. Create exactly one concise markdown launch brief titled "${evidence.documentTitle}" with the goal, budget, deadline, and three practical next steps. Save it using app.knowledge.ingest and verify the saved document using app.knowledge.list. This document save is authorized. Complete this small task directly. Do not create workflows, delegate, send messages, or deploy anything.`,
      { modelTurns: 6, tokens: 140_000, toolCalls: 10, costMicrousd: 1_250_000 });
    await verifyRun("cowork");

    const created = await json(builderPath(), { action: "create", workspaceMode: "interactive" }, 200, 300_000);
    evidence.sessionId = created.session?.id;
    assert(typeof evidence.sessionId === "string" && created.session?.status === "ready", "Coding workspace is not ready");
    await save();
    const before = (await json(builderPath("file", "app/page.tsx"))).file;
    const original = "<h1>Build something <em>useful.</em></h1>";
    const replacement = "<h1>Harbor launch <em>ready.</em></h1>";
    assert(typeof before?.content === "string" && before.content.split(original).length === 2,
      "Starter file does not have the expected single heading");
    evidence.beforeFileSha256 = hash(before.content);
    assert(before.sha256 === evidence.beforeFileSha256, "Source file hash mismatch");
    evidence.afterFileSha256 = hash(before.content.replace(original, replacement));
    await save();
    await turn("coding", `In project ${evidence.projectId}, the authorized interactive Builder session is ${evidence.sessionId}. Inspect the workspace, applicable instructions, app/page.tsx, package.json, and relevant checks. Read the installed Next.js server-and-client-components guide with app.projects.builder.framework-doc.read. Make exactly one source change: replace ${JSON.stringify(original)} with ${JSON.stringify(replacement)} in app/page.tsx, preserving the rest of the file. Use the actual file SHA with app.projects.builder.file.edit. Run the existing typecheck through app.projects.builder.command.run, read back the changed file, and create one checkpoint with reason manual for this direct edit. Report the real change and exit code. This edit and check are authorized. Complete this small task directly; do not delegate, deliver a PR, deploy, or install anything.`,
      { modelTurns: 16, tokens: 240_000, toolCalls: 20, costMicrousd: 2_500_000 });
    await verifyRun("coding");
    const after = (await json(builderPath("file", "app/page.tsx"))).file;
    assert(after?.sha256 === evidence.afterFileSha256 && hash(after.content) === evidence.afterFileSha256,
      "Coding changed more than the requested heading or did not save it");
    evidence.fileReadbackVerified = true;
    await save();
  }

  if (phase === "readback") for (const mode of ["chat", "cowork", "coding"]) await verifyRun(mode);
  const knowledge = await json("/api/knowledge?limit=100");
  const documents = knowledge.documents?.filter(doc => doc.title === evidence.documentTitle) || [];
  assert(documents.length === 1, "Saved brief missing or duplicated");
  const text = JSON.stringify(documents[0]) + JSON.stringify((knowledge.chunks || []).filter(chunk => chunk.documentId === documents[0].id));
  assert([/Harbor/i, /600/, /8/, /landing page/i].every(pattern => pattern.test(text)), "Brief omits the recorded project facts");
  evidence.documentId = documents[0].id;
  const builder = await json(builderPath());
  assert(builder.session?.id === evidence.sessionId, "Coding workspace identity changed");
  if (phase === "readback") assert(builder.session.status === "stopped", "Fixture sandbox was restarted after validation");
  const changed = builder.activity?.filter(item => item.eventType === "app_builder.file.updated") || [];
  assert(changed.length === 1 && changed[0].detail?.path === "app/page.tsx" &&
    changed[0].detail?.previousSha256 === evidence.beforeFileSha256 &&
    changed[0].detail?.sha256 === evidence.afterFileSha256, "Saved file-change receipt mismatch");
  const check = builder.activity?.find(item => item.eventType === "app_builder.command.completed" &&
    item.detail?.command === "typecheck" && item.detail?.exitCode === 0);
  assert(check?.detail?.outputSha256 && check.detail.workspaceUnchanged === true, "Passing typecheck evidence missing");
  const checkpoint = builder.checkpoints?.find(item => item.id === builder.session?.currentCheckpointId);
  assert(checkpoint?.workspaceSha256 === check.detail.workspaceAfterSha256, "Checkpoint does not match the checked files");
  evidence.checkpointId = checkpoint.id; evidence.checkOutputSha256 = check.detail.outputSha256;
  assert(evidence.fileReadbackVerified, "Source readback was not verified during the exercise");
  const thread = await json(`/api/threads/${encodeURIComponent(evidence.threadId)}`);
  assert(thread.thread?.mode === "coding" && thread.thread?.projectId === evidence.projectId,
    "Conversation did not retain its mode and project");
  assert(thread.turns?.filter(item => item.role === "user").length === 3, "Expected exactly three accepted user turns");
  for (const run of Object.values(evidence.runs)) {
    assert(thread.turns?.filter(item => item.role === "assistant" && item.runId === run.id).length === 1,
      "A mode's result is missing or duplicated in shared history");
  }
  assert((await json("/api/health")).revision === revision, "Revision changed during the scenario");
  evidence.status = "passed";
  if (phase === "readback") evidence.canonicalReadback = true;
} catch (error) {
  failure = error; evidence.status = "failed"; evidence.failure = safe(error.message || "Scenario failed");
} finally {
  if (cookie && phase === "exercise" && evidence.projectId) {
    try {
      // Reconcile a create response lost after acceptance, using this fixture only.
      if (!evidence.sessionId) evidence.sessionId = (await json(builderPath())).session?.id;
      if (evidence.sessionId) {
        const stopped = await json(builderPath(), { action: "stop", sessionId: evidence.sessionId }, 200, 120_000);
        assert(stopped.session?.id === evidence.sessionId && stopped.session?.status === "stopped", "Fixture sandbox stop unconfirmed");
        evidence.sandboxStopped = true;
      }
    } catch (error) { failure ||= error; evidence.cleanupFailure = safe(error.message); }
  }
  if (cookie) {
    try { assert((await json("/api/auth/logout", {})).authenticated === false, "Sign-out incomplete"); signedOut = true; }
    catch (error) { failure ||= error; evidence.signOutFailure = safe(error.message); }
  }
  if (failure) evidence.status = "failed";
  evidence.signedOut = signedOut; evidence.updatedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ scenario: evidence.scenario, revision, status: evidence.status,
  phase, projectId: evidence.projectId, threadId: evidence.threadId, documentId: evidence.documentId,
  runs: evidence.runs, sandboxStopped: evidence.sandboxStopped, failure: evidence.failure,
  cleanupFailure: evidence.cleanupFailure, signedOut }, null, 2));
if (failure) process.exitCode = 1;

async function turn(mode, content, limits) {
  // Use the same persisted-conversation entry point as the web/native composer.
  // The legacy `messages` entry point intentionally permits a standalone run.
  const response = await request("/api/agent", { message: content,
    mode, strategy: "direct", agentId: "atlas", contextScope: "project", projectId: evidence.projectId,
    ...(evidence.threadId ? { threadId: evidence.threadId } : {}),
    requestId: `assistant_workspace:${evidence.marker}:${mode}`,
    budgets: { ...limits, wallTimeMs: 300_000, agents: 1, fanOut: 0, retries: 0, replans: 0 } }, 360_000);
  if (response.status !== 200) {
    evidence.runs[mode] = { requestStatus: response.status };
    try {
      const rejected = JSON.parse(await boundedText(response));
      evidence.runs[mode].rejection = Object.fromEntries(
        ["error", "code", "message"].filter(key => typeof rejected[key] === "string")
          .map(key => [key, safe(rejected[key])]),
      );
    } catch { /* Malformed or oversized errors must not hide the status. */ }
    await save();
    throw new Error(`${mode} request was not accepted (HTTP ${response.status}); retained receipt has its diagnostic`);
  }
  evidence.runs[mode] = { id: response.headers.get("x-asael-run-id") || undefined }; await save();
  const events = parseSse(await boundedText(response));
  evidence.runs[mode].id ||= events.find(event => event.type === "run")?.runId;
  evidence.runs[mode].streamFailure = events.find(event => event.type === "error")?.message;
  await save();
  assert(evidence.runs[mode].id && !events.some(event => event.type === "error"), `${mode} execution failed; retained run contains its evidence`);
}

async function verifyRun(mode) {
  const id = evidence.runs[mode]?.id;
  assert(typeof id === "string" && id, `${mode} run receipt missing`);
  const run = (await json(`/api/runs/${encodeURIComponent(id)}`)).run;
  evidence.runs[mode].status = run?.status;
  evidence.runs[mode].mode = run?.mode;
  evidence.runs[mode].threadId = run?.threadId;
  await save();
  assert(run?.status === "completed", `${mode} did not complete`);
  assert(run.mode === mode, `${mode} saved run has an unexpected mode`);
  assert(typeof run.threadId === "string" && run.threadId, `${mode} saved run is missing its conversation`);
  evidence.threadId ||= run.threadId;
  assert(run.threadId === evidence.threadId, `${mode} changed the conversation`);
  const trajectory = (await json(`/api/runs/${encodeURIComponent(id)}/trajectory`)).trajectory;
  const tools = trajectory?.events?.filter(event => event.type === "run.tool").map(event => event.receipt) || [];
  const executed = tools.filter(tool => tool.status === "executed" && tool.dryRun === false);
  evidence.runs[mode].tools = executed.map(tool => ({ toolId: tool.toolId, riskLevel: tool.riskLevel })); await save();
  const has = tool => executed.some(receipt => receipt.toolId === tool);
  if (mode === "chat") {
    assert(has("app.projects.show") && executed.every(tool => tool.riskLevel === 0), "Chat lacked its source read or performed an effectful tool action");
    assert(/600/.test(run.response) && /8/.test(run.response), "Chat omitted recorded project facts");
  } else if (mode === "cowork") {
    assert(executed.filter(tool => tool.toolId === "app.knowledge.ingest").length === 1 && has("app.knowledge.list"),
      "Cowork did not save and verify exactly one brief");
  } else {
    assert(["show", "file.read", "framework-doc.read", "file.edit", "command.run", "checkpoint.create"]
      .every(action => has(`app.projects.builder.${action}`)), "Coding did not record the required inspection, edit, check, and checkpoint");
  }
}

function builderPath(view, path) {
  const route = `/api/projects/${encodeURIComponent(evidence.projectId)}/builder`;
  return view ? `${route}?${new URLSearchParams({ view, sessionId: evidence.sessionId, ...(path ? { path } : {}) })}` : route;
}
function required(name) { const value = process.env[name]; assert(value?.trim(), `${name} required`); return value; }
function assert(condition, message) { if (!condition) throw new Error(message); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function safe(value) {
  let text = String(value); for (const token of [email, password, secret, bypass, cookie]) if (token) text = text.replaceAll(token, "[redacted]");
  return text.slice(0, 500);
}
async function save() { await writeFile(file, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 }); }
async function request(path, body, timeoutMs = 60_000) {
  const headers = { origin: production, "x-omni-synthetic-auth": secret, "x-omni-source": "assistant_workspace_release",
    "x-omni-slo-excluded": "true", ...(cookie ? { cookie } : {}), ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json", "idempotency-key": body.requestId || randomUUID() }) };
  return fetch(`${base.origin}${path}`, { method: body === undefined ? "GET" : "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "manual", cache: "no-store" });
}
async function json(path, body, status = 200, timeoutMs) {
  const response = await request(path, body, timeoutMs);
  assert(response.status === status, `${body === undefined ? "GET" : "POST"} ${path} returned HTTP ${response.status}`);
  return JSON.parse(await boundedText(response));
}
async function boundedText(response) {
  const reader = response.body?.getReader(); if (!reader) return "";
  const decoder = new TextDecoder(); let text = "", size = 0;
  for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length;
    if (size > 2_000_000) { await reader.cancel(); throw new Error("Scenario response exceeded bound"); }
    text += decoder.decode(item.value, { stream: true }); }
  return text + decoder.decode();
}
function parseSse(text) {
  return text.split(/\r?\n\r?\n/).flatMap(block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    return data ? [JSON.parse(data)] : [];
  });
}
