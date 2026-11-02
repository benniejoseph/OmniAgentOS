#!/usr/bin/env node
/** Live repository discovery only. No GitHub grants, project writes, or agent runs. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const need = (value, code) => { if (!value) throw new Error(code); };
const required = name => { const value = process.env[name]?.trim(); need(value, `missing_${name}`); return value; };
const production = "https://asael.bennierichard.com", base = new URL(required("BASE_URL"));
const loopback = process.env.SMOKE_PROJECT_REPOSITORIES_ALLOW_LOOPBACK === "CONFIRMED" && base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname);
need((loopback || base.protocol === "https:" && (base.origin === production || /^https:\/\/omniagent-[a-z0-9]+-benniejosephs-projects\.vercel\.app$/.test(base.origin))) &&
  base.pathname === "/" && !base.search && !base.hash && !base.username && !base.password, "unapproved_url");
const revision = required("EXPECTED_REVISION"), file = required("SMOKE_PROJECT_REPOSITORIES_EVIDENCE_FILE"), phase = required("SMOKE_PROJECT_REPOSITORIES_MODE");
need(/^[a-f0-9]{40}$/.test(revision) && ["exercise", "readback"].includes(phase), "invalid_release_pin");
const projects = JSON.parse(required("SMOKE_PROJECT_REPOSITORIES_PROJECT_IDS"));
need(Array.isArray(projects) && projects.length >= 1 && projects.length <= 2 && new Set(projects).size === projects.length &&
  projects.every(id => typeof id === "string" && /^project_[a-z0-9_]{1,200}$/.test(id)), "invalid_project_pins");
const email = required("SMOKE_PAID_AGENT_EMAIL"), password = required("SMOKE_PAID_AGENT_PASSWORD");
const secret = required("SMOKE_INTERNAL_AUTH_SECRET"), bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "";
const paths = projects.map(id => `/api/projects/${encodeURIComponent(id)}/builder?view=github.repositories`), deadline = Date.now() + 120_000;
let cookie = "", failure;
let evidence = { scenario: "project_repositories_v1", revision, projects, status: "pending", phases: {}, modelCalls: 0, sourceMutations: 0, githubGrantChanges: 0 };
if (phase === "exercise") await writeFile(file, JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
else {
  evidence = JSON.parse(await readFile(file, "utf8"));
  need(evidence.scenario === "project_repositories_v1" && evidence.revision === revision && evidence.status === "passed" &&
    JSON.stringify(evidence.projects) === JSON.stringify(projects), "staged_evidence_mismatch");
}
try {
  const health = await json("/api/health"); need(health.status === "healthy" && health.revision === revision, "revision_or_health_mismatch");
  const login = await request("/api/auth/login", { email, password });
  cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  need(login.status === 200 && cookie, "login_failed");
  const auth = await body(login);
  need(auth.authenticated && auth.context?.source === "session" && auth.context.tenantId && auth.context.actorId, "session_identity_missing");
  if (phase === "readback") need(auth.context.tenantId === evidence.tenantId && auth.context.actorId === evidence.actorId, "owner_changed");
  else { evidence.tenantId = auth.context.tenantId; evidence.actorId = auth.context.actorId; }
  const reads = [];
  for (const [index, path] of paths.entries()) {
    const response = await request(path);
    need(response.status === 200 && response.headers.get("cache-control") === "private, no-store", "repository_http_contract");
    const payload = await body(response), rows = payload.repositories;
    need(payload.github?.configured === true && Array.isArray(payload.github.missing) && payload.github.missing.length === 0 &&
      /^https:\/\/github\.com\/apps\/[A-Za-z0-9-]+\/installations\/new$/.test(payload.github.installUrl || ""), "github_connection_unavailable");
    need(Array.isArray(rows) && rows.length > 0 && rows.length <= 300 && new Set(rows.map(row => row.repositoryId)).size === rows.length, "repository_list_invalid");
    for (const row of rows) need(/^[1-9]\d*$/.test(row.repositoryId) && Number.isSafeInteger(Number(row.repositoryId)) &&
      typeof row.private === "boolean" && /^[A-Za-z0-9-]+$/.test(row.owner) && /^[A-Za-z0-9_.-]+$/.test(row.name) &&
      row.fullName === `${row.owner}/${row.name}` && row.htmlUrl === `https://github.com/${row.fullName}` &&
      typeof row.defaultBranch === "string" && row.defaultBranch.length > 0 && row.defaultBranch.length <= 240, "repository_contract_invalid");
    need(payload.serviceReceipt?.operation === "app.projects.builder.repositories.list" && payload.serviceReceipt.accessMode === "read" &&
      payload.serviceReceipt.eventContract === "read_only:no_domain_mutation" && payload.serviceReceipt.resourceCount === rows.length, "read_receipt_missing");
    reads.push({ projectId: projects[index], repositories: rows, responseSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") });
  }
  need((await json("/api/health")).revision === revision, "revision_changed");
  evidence.phases[phase] = { status: "passed", reads, at: new Date().toISOString() }; evidence.status = "passed";
} catch (error) { failure = error; evidence.status = "failed"; evidence.failure = /^[a-z0-9_]+$/.test(error.message) ? error.message : "repository_check_failed"; }
finally {
  if (cookie) {
    try { need((await json("/api/auth/logout", {}, true)).authenticated === false, "logout_failed"); evidence.signedOut = true; }
    catch { failure ||= new Error("logout_failed"); evidence.status = "failed"; evidence.signedOut = false; }
  }
  evidence.updatedAt = new Date().toISOString(); await writeFile(file, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
}
console.log(JSON.stringify({ scenario: evidence.scenario, revision, phase, status: evidence.status,
  projectCount: evidence.phases[phase]?.reads?.length, modelCalls: 0, sourceMutations: 0, githubGrantChanges: 0, failure: evidence.failure }));
if (failure) process.exitCode = 1;

async function request(path, value, cleanup = false) {
  need(["/api/health", "/api/auth/login", "/api/auth/logout", ...paths].includes(path), "unapproved_path");
  need(value === undefined || ["/api/auth/login", "/api/auth/logout"].includes(path), "source_write_forbidden");
  const remaining = cleanup ? 10_000 : deadline - Date.now(); need(remaining > 0, "deadline_exceeded");
  return fetch(base.origin + path, { method: value === undefined ? "GET" : "POST", redirect: "manual", cache: "no-store",
    signal: AbortSignal.timeout(Math.min(60_000, remaining)), headers: { origin: production, "x-omni-synthetic-auth": secret,
      "x-omni-source": "project_repositories_release", "x-omni-slo-excluded": "true", ...(cookie ? { cookie } : {}),
      ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}), ...(value === undefined ? {} : { "content-type": "application/json" }) },
    body: value === undefined ? undefined : JSON.stringify(value) });
}
async function body(response) {
  const reader = response.body?.getReader(); need(reader, "response_missing");
  const parts = []; let size = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > 2_000_000) { await reader.cancel(); throw new Error("response_too_large"); } parts.push(part.value); }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
async function json(path, value, cleanup) { const response = await request(path, value, cleanup); need(response.status === 200, "http_failed"); return body(response); }
