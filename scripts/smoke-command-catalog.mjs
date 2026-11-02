#!/usr/bin/env node
/** Read the real native context contract; never start an agent or change sources. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const need = (value, code) => { if (!value) throw new Error(code); };
const required = name => { const value = process.env[name]?.trim(); need(value, `missing_${name}`); return value; };
const production = "https://asael.bennierichard.com";
const base = new URL(required("BASE_URL"));
const loopback = process.env.SMOKE_COMMAND_CATALOG_ALLOW_LOOPBACK === "CONFIRMED" &&
  base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname);
need((loopback || base.protocol === "https:" && (base.origin === production ||
  /^https:\/\/omniagent-[a-z0-9]+-benniejosephs-projects\.vercel\.app$/.test(base.origin))) &&
  base.pathname === "/" && !base.search && !base.hash && !base.username && !base.password, "unapproved_url");
const revision = required("EXPECTED_REVISION");
need(/^[a-f0-9]{40}$/.test(revision), "invalid_revision");
const file = required("SMOKE_COMMAND_CATALOG_EVIDENCE_FILE");
const phase = required("SMOKE_COMMAND_CATALOG_MODE");
need(["exercise", "readback"].includes(phase), "invalid_phase");
const projects = JSON.parse(required("SMOKE_COMMAND_CATALOG_LONG_PROJECT_IDS"));
need(Array.isArray(projects) && projects.length > 0 && projects.length <= 10 &&
  new Set(projects).size === projects.length && projects.every(id => typeof id === "string" && /^project_[a-z0-9_]{1,200}$/.test(id)), "invalid_project_pins");
const email = required("SMOKE_PAID_AGENT_EMAIL"), password = required("SMOKE_PAID_AGENT_PASSWORD");
const secret = required("SMOKE_INTERNAL_AUTH_SECRET"), bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "";
const deadline = Date.now() + 90_000;
let cookie = "", failure;
let evidence = { scenario: "command_catalog_v1", revision, status: "pending", projects, phases: {}, modelCalls: 0, sourceMutations: 0 };
if (phase === "exercise") await writeFile(file, JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
else {
  evidence = JSON.parse(await readFile(file, "utf8"));
  need(evidence.scenario === "command_catalog_v1" && evidence.revision === revision && evidence.status === "passed" &&
    JSON.stringify(evidence.projects) === JSON.stringify(projects), "staged_evidence_mismatch");
}
try {
  const health = await json("/api/health");
  need(health.status === "healthy" && health.revision === revision, "revision_or_health_mismatch");
  const login = await request("/api/auth/login", { email, password });
  cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  need(login.status === 200 && cookie, "login_failed");
  const auth = await body(login);
  need(auth.authenticated && auth.context?.source === "session" && auth.context.tenantId && auth.context.actorId, "session_identity_missing");
  if (phase === "readback") need(evidence.tenantId === auth.context.tenantId && evidence.actorId === auth.context.actorId, "owner_changed");
  else { evidence.tenantId = auth.context.tenantId; evidence.actorId = auth.context.actorId; }
  const response = await request("/api/command/catalog");
  need(response.status === 200 && response.headers.get("cache-control") === "private, no-store", "catalog_http_contract");
  const catalog = await body(response);
  need(catalog.version === 1 && Array.isArray(catalog.items) && catalog.items.length > 0 && catalog.items.length <= 1000 &&
    catalog.sources?.project === "ready", "catalog_shape");
  for (const item of catalog.items) {
    // Match TalkCommandContextReference.fromJson in the unchanged native app.
    need(["agent", "skill", "plugin", "project", "integration", "file"].includes(item.kind) &&
      typeof item.id === "string" && item.id.length > 0 && item.id.length <= 320 &&
      typeof item.label === "string" && item.label.length > 0 && item.label.length <= 240 &&
      typeof item.description === "string" && item.description.length <= 1000 &&
      (item.expectedVersion == null || typeof item.expectedVersion === "number" && item.expectedVersion >= 1) &&
      (item.bindingSha256 == null || /^[a-f0-9]{64}$/.test(item.bindingSha256)), "native_catalog_contract");
  }
  for (const id of projects) {
    const item = catalog.items.find(item => item.kind === "project" && item.id === id);
    need(item && item.description.length <= 1000 && item.description.endsWith("…"), "long_project_preview_missing");
  }
  need((await json("/api/health")).revision === revision, "revision_changed");
  evidence.phases[phase] = { status: "passed", itemCount: catalog.items.length, sources: catalog.sources,
    responseSha256: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"), at: new Date().toISOString() };
  evidence.status = "passed";
} catch (error) { failure = error; evidence.status = "failed"; evidence.failure = /^[a-z0-9_]+$/.test(error.message) ? error.message : "catalog_check_failed"; }
finally {
  if (cookie) {
    try { need((await json("/api/auth/logout", {}, true)).authenticated === false, "logout_failed"); evidence.signedOut = true; }
    catch { failure ||= new Error("logout_failed"); evidence.status = "failed"; evidence.signedOut = false; }
  }
  evidence.updatedAt = new Date().toISOString();
  await writeFile(file, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
}
console.log(JSON.stringify({ scenario: evidence.scenario, revision, phase, status: evidence.status,
  itemCount: evidence.phases[phase]?.itemCount, modelCalls: 0, sourceMutations: 0, signedOut: evidence.signedOut, failure: evidence.failure }));
if (failure) process.exitCode = 1;

async function request(path, value, cleanup = false) {
  need(["/api/health", "/api/auth/login", "/api/auth/logout", "/api/command/catalog"].includes(path), "unapproved_path");
  need(value === undefined || ["/api/auth/login", "/api/auth/logout"].includes(path), "source_write_forbidden");
  const remaining = cleanup ? 10_000 : deadline - Date.now(); need(remaining > 0, "deadline_exceeded");
  return fetch(base.origin + path, { method: value === undefined ? "GET" : "POST", redirect: "manual", cache: "no-store",
    signal: AbortSignal.timeout(Math.min(30_000, remaining)),
    headers: { origin: production, "x-omni-synthetic-auth": secret, "x-omni-source": "command_catalog_release", "x-omni-slo-excluded": "true",
      ...(cookie ? { cookie } : {}), ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
      ...(value === undefined ? {} : { "content-type": "application/json" }) },
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
