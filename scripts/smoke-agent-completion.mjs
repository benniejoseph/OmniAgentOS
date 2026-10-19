#!/usr/bin/env node
/** One selected release scenario, then read-only canonical readback. No mutation retries. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const production = "https://asael.bennierichard.com";
const base = new URL(required("BASE_URL"));
const loopback = process.env.SMOKE_AGENT_COMPLETION_ALLOW_LOOPBACK === "CONFIRMED" && base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname);
assert((loopback || base.protocol === "https:" && (base.origin === production || /^https:\/\/omniagent-[a-z0-9]+-benniejosephs-projects\.vercel\.app$/.test(base.origin))) && base.pathname === "/" && !base.search && !base.hash && !base.username && !base.password, "Unapproved candidate URL");
assert(process.env.LIVE_VERIFY_AGENT_COMPLETION === "CONFIRMED", "Explicit scenario admission required");
const revision = required("EXPECTED_REVISION"), file = required("SMOKE_AGENT_COMPLETION_EVIDENCE_FILE");
const email = required("SMOKE_PAID_AGENT_EMAIL"), password = required("SMOKE_PAID_AGENT_PASSWORD");
const internalSecret = required("SMOKE_INTERNAL_AUTH_SECRET"), bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "";
const mode = process.env.SMOKE_AGENT_COMPLETION_MODE || "exercise";
assert(["exercise", "readback"].includes(mode), "Unknown scenario mode");
let cookie = "", failure, signedOut = false;
let evidence = { scenario: "agent_completion_v1", revision, status: "pending", resourcesRetained: true };
try {
  const health = await json("/api/health");
  assert(health.status === "healthy" && health.revision === revision, "Candidate health or revision mismatch");
  const login = await request("/api/auth/login", { email, password });
  cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  assert(login.status === 200 && cookie, "Fresh scenario sign-in failed");
  const auth = JSON.parse(await boundedText(login));
  assert(auth.authenticated && auth.context?.source === "session", "Scenario requires a session identity");
  if (mode === "readback") {
    evidence = JSON.parse(await readFile(file, "utf8"));
    assert(evidence.revision === revision && evidence.status === "passed" && evidence.tenantId === auth.context.tenantId, "Stored scenario does not match this release and owner");
  } else {
    const marker = randomUUID(), title = `Agent validation ${marker}`;
    evidence.tenantId = auth.context.tenantId;
    const a = await json("/api/projects", { title: `${title} — Vendor A`, objective: "Fictional validation: Vendor A costs USD 600 and delivers in 7 days. The deadline is 8 days." }, 201);
    evidence.projectA = a.project?.id; await save();
    const b = await json("/api/projects", { title: `${title} — Vendor B`, objective: "Fictional validation: Vendor B costs USD 450 and delivers in 10 days. The deadline is 8 days." }, 201);
    evidence.projectB = b.project?.id; await save();
    const custom = await json("/api/agents", { name: `${title} reader`, role: "Source reader", description: "Fictional release validation specialist", instructions: "Read the exact assigned project through app.projects.show and return its recorded values. When requested, include one markdown draftArtifacts contribution with those values. Do not act outside the assigned read grants.", status: "ready", accent: "blue", modelPolicy: "openai_fast", autonomy: "assist", approvalPolicy: "read_only", memoryScope: "session", skillIds: [], toolIds: ["app.projects.show"] }, 201);
    evidence.customAgentId = custom.agent?.id; await save();
    const opened = await json("/api/threads", { title, mode: "execute" }, 201);
    evidence.threadId = opened.thread?.id; evidence.documentTitle = `${title} recommendation`; await save();
    assert([evidence.projectA, evidence.projectB, evidence.customAgentId, evidence.threadId].every(value => typeof value === "string" && value), "Fixture resource identity missing");
    const prompt = `For this fictional validation task, use app.agents.delegate to assign exactly two specialists. Scout must read project ${evidence.projectA} with app.projects.show (includeFullObjective=true) and return its cost and delivery time; taskClass structured_read. Custom agent ${evidence.customAgentId} must read project ${evidence.projectB} with the same tool and return one markdown draftArtifacts contribution with its cost and delivery time; taskClass artifact_build. Use taskKind research, isolated mode, grant only app.projects.show as governedReadToolIds, and require its actual governed receipt with requiredGovernedToolIds. Each acceptance criterion must refer to the assigned project's recorded values. After both reviewed results arrive, Atlas must compare both vendors against an 8-day deadline, save exactly ONE knowledge document titled "${evidence.documentTitle}" using app.knowledge.ingest, then verify it with app.knowledge.list. Include both costs, both delivery times, and the qualifying vendor. Do not create workflows, watches, send messages or buy anything. These reads and the single document save are authorized. Delegation is an intermediate step; complete the request after the results arrive.`;
    const response = await request("/api/agent", { messages: [{ role: "user", content: prompt }], mode: "execute", strategy: "direct", contextScope: "session", agentId: "atlas", threadId: evidence.threadId, requestId: `agent_completion:${marker}` }, 300_000);
    assert(response.status === 200, "Atlas request was not accepted");
    evidence.rootRunId = response.headers.get("x-asael-run-id") || undefined; await save();
    const events = parseSse(await boundedText(response));
    evidence.rootRunId ||= events.find(event => event.type === "run")?.runId;
    assert(!events.some(event => event.type === "error"), "Initial Atlas run failed; see retained run");
    assert(evidence.rootRunId, "Root run receipt missing");
    evidence.continuationRunId = continuationId(evidence.rootRunId); await save();
    const root = (await json(`/api/runs/${encodeURIComponent(evidence.rootRunId)}`)).run;
    evidence.taskIds = [...new Set((root?.response || "").match(/dar_[a-f0-9]{40}/g) || [])]; await save();
    assert(evidence.taskIds.length === 2, "Atlas did not produce two assignment receipts");
    const deadline = Date.now()+480_000;
    for (;;) {
      const detail = await json(`/api/threads/${encodeURIComponent(evidence.threadId)}`);
      const turn = detail.turns?.find(item => item.id === `parent-result:${evidence.continuationRunId}`);
      if (turn) break;
      assert(Date.now() < deadline, "No final Atlas delivery within the scenario deadline");
      await new Promise(resolve => setTimeout(resolve, 4_000));
    }
  }
  const tasks = [];
  for (const id of evidence.taskIds) tasks.push((await json(`/api/agents/tasks/${encodeURIComponent(id)}`)).task);
  evidence.taskStates = tasks.map(task => ({ id: task?.executionId, agentId: task?.delegateAgentId, state: task?.state, failureCode: task?.failureCode }));
  await save();
  const resumed = (await json(`/api/runs/${encodeURIComponent(evidence.continuationRunId)}`)).run;
  evidence.continuation = { status: resumed?.status, error: resumed?.error };
  await save();
  assert(tasks.length === 2 && tasks.every(task => task?.state === "verified"), "Specialist acceptance failed");
  assert(tasks.some(task => task.delegateAgentId === "scout") && tasks.some(task => task.delegateAgentId === evidence.customAgentId), "The expected specialists did not execute");
  assert(tasks.find(task => task.delegateAgentId === evidence.customAgentId)?.result?.draftArtifacts?.some(draft => /450/.test(draft.content) && /10/.test(draft.content)), "Custom specialist draft missing recorded values");
  assert(resumed?.status === "completed" && /Vendor A/i.test(resumed.response), "Atlas did not finish its dependent work");
  const trajectory = (await json(`/api/runs/${encodeURIComponent(evidence.continuationRunId)}/trajectory`)).trajectory;
  const tools = trajectory?.events?.filter(event => event.type === "run.tool").map(event => event.receipt) || [];
  assert(tools.filter(tool => tool.toolId === "app.knowledge.ingest" && tool.status === "executed" && tool.dryRun === false).length === 1, "Expected one governed document write");
  assert(tools.some(tool => tool.toolId === "app.knowledge.list" && tool.status === "executed"), "Atlas did not verify its saved work");
  const knowledge = await json("/api/knowledge?limit=100");
  const docs = knowledge.documents?.filter(doc => doc.title === evidence.documentTitle) || [];
  assert(docs.length === 1, "Saved document missing or duplicated");
  const text = JSON.stringify(docs[0]) + JSON.stringify((knowledge.chunks || []).filter(chunk => chunk.documentId === docs[0].id));
  assert([/Vendor A/i, /600/, /450/, /7/, /10/].every(pattern => pattern.test(text)), "Saved document omits required comparison values");
  const thread = await json(`/api/threads/${encodeURIComponent(evidence.threadId)}`);
  assert(thread.turns?.filter(turn => turn.id === `parent-result:${evidence.continuationRunId}`).length === 1, "Final delivery missing or duplicated");
  assert((await json("/api/health")).revision === revision, "Revision changed during scenario");
  evidence.status = "passed"; evidence.documentId = docs[0].id; evidence.taskStates = tasks.map(task => ({ id: task.executionId, agentId: task.delegateAgentId, state: task.state, failureCode: task.failureCode }));
  if (mode === "readback") evidence.canonicalReadback = true;
} catch (error) { failure = error; evidence.status = "failed"; evidence.failure = safe(error.message || "Scenario failed"); }
finally {
  if (cookie) { try { const out = await json("/api/auth/logout", {}); assert(out.authenticated === false, "Sign-out incomplete"); signedOut = true; } catch { failure ||= new Error("Scenario sign-out failed"); } }
  evidence.signedOut = signedOut; await save();
}
console.log(JSON.stringify({ ...evidence, tenantId: undefined, status: failure ? "FAIL" : "PASS" }, null, 2));
if (failure) process.exitCode = 1;

function required(name) { const value = process.env[name]; assert(value?.trim(), `${name} required`); return value; }
function assert(condition, message) { if (!condition) throw new Error(message); }
function safe(value) { let text = String(value); for (const secret of [email, password, internalSecret, bypass, cookie]) if (secret) text = text.replaceAll(secret, "[redacted]"); return text.slice(0, 500); }
async function save() { await writeFile(file, JSON.stringify(evidence, null, 2)+"\n", { mode: 0o600 }); }
function continuationId(id) { const h = createHash("sha256").update(`delegation-parent:${id}`).digest("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; }
async function request(path, body, timeoutMs = 60_000) {
  const headers = { origin: production, "x-omni-synthetic-auth": internalSecret, "x-omni-source": "agent_completion_release", "x-omni-slo-excluded": "true", ...(cookie ? { cookie } : {}), ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}), ...(body === undefined ? {} : { "content-type": "application/json", "idempotency-key": body.requestId || randomUUID() }) };
  return fetch(`${base.origin}${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "manual", cache: "no-store" });
}
async function json(path, body, status = 200) { const response = await request(path, body); assert(response.status === status, `${body === undefined ? "GET" : "POST"} ${path} returned HTTP ${response.status}`); return JSON.parse(await boundedText(response)); }
async function boundedText(response) {
  const reader = response.body?.getReader(); if (!reader) return "";
  const decoder = new TextDecoder(); let text = "", size = 0;
  for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 2_000_000) { await reader.cancel(); throw new Error("Scenario response exceeded bound"); } text += decoder.decode(item.value, { stream: true }); }
  return text + decoder.decode();
}
function parseSse(text) { return text.split(/\r?\n\r?\n/).flatMap(block => { const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"); return data ? [JSON.parse(data)] : []; }); }
