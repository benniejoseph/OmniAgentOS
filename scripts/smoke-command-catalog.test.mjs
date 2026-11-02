import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile), revision = "a".repeat(40);

async function fixture(run, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "asael-catalog-probe-"));
  const calls = [];
  const server = createServer(async (request, response) => {
    calls.push([request.method, request.url]);
    let value;
    if (request.url === "/api/health") value = { status: "healthy", revision };
    else if (request.url === "/api/auth/login") {
      response.setHeader("set-cookie", "session=fixture; HttpOnly");
      value = { authenticated: true, context: { source: "session", tenantId: "tenant", actorId: options.foreignOwner ? "other" : "owner" } };
    } else if (request.url === "/api/auth/logout") value = { authenticated: false };
    else if (request.url === "/api/command/catalog") {
      response.setHeader("cache-control", "private, no-store");
      value = { version: 1, sources: { project: "ready" }, items: [{
        kind: "project", id: "project_long", label: "Long project", description: `${"d".repeat(options.longDescription ? 1001 : 999)}…`, selectable: true,
        ...(options.badBinding ? { bindingSha256: "wrong" } : {}),
      }] };
    } else { response.writeHead(500); response.end("unexpected route"); return; }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const file = path.join(directory, "evidence.json");
  const env = { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}`, EXPECTED_REVISION: revision,
    SMOKE_COMMAND_CATALOG_ALLOW_LOOPBACK: "CONFIRMED", SMOKE_COMMAND_CATALOG_EVIDENCE_FILE: file,
    SMOKE_COMMAND_CATALOG_LONG_PROJECT_IDS: '["project_long"]', SMOKE_PAID_AGENT_EMAIL: "fixture@example.test",
    SMOKE_PAID_AGENT_PASSWORD: "fixture-password", SMOKE_INTERNAL_AUTH_SECRET: "fixture-secret" };
  const check = phase => exec(process.execPath, ["scripts/smoke-command-catalog.mjs"], {
    env: { ...env, SMOKE_COMMAND_CATALOG_MODE: phase }, timeout: 15_000,
  });
  try { await run({ check, file, calls, options }); }
  finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
}

test("checks staging and canonical without starting agents or changing project records", () => fixture(async ({ check, file, calls }) => {
  await check("exercise"); await check("readback");
  const evidence = JSON.parse(await readFile(file, "utf8"));
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.phases.exercise.status, "passed");
  assert.equal(evidence.phases.readback.status, "passed");
  assert.equal(evidence.modelCalls, 0); assert.equal(evidence.sourceMutations, 0); assert.equal(evidence.signedOut, true);
  assert.deepEqual(calls.filter(([method]) => method !== "GET"), [
    ["POST", "/api/auth/login"], ["POST", "/api/auth/logout"], ["POST", "/api/auth/login"], ["POST", "/api/auth/logout"],
  ]);
  assert.ok(!JSON.stringify(evidence).includes("fixture-password"));
}));

for (const [label, options] of [["oversized native description", { longDescription: true }], ["invalid reference binding", { badBinding: true }]]) {
  test(`refuses ${label} and still signs out`, () => fixture(async ({ check, file }) => {
    await assert.rejects(check("exercise"));
    const evidence = JSON.parse(await readFile(file, "utf8"));
    assert.equal(evidence.status, "failed"); assert.equal(evidence.failure, "native_catalog_contract"); assert.equal(evidence.signedOut, true);
  }, options));
}

test("refuses canonical readback by another owner", () => fixture(async ({ check, file, options }) => {
  await check("exercise"); options.foreignOwner = true;
  await assert.rejects(check("readback"));
  const evidence = JSON.parse(await readFile(file, "utf8"));
  assert.equal(evidence.status, "failed"); assert.equal(evidence.failure, "owner_changed"); assert.equal(evidence.signedOut, true);
}));

test("does not overwrite an earlier staged attempt", () => fixture(async ({ check, file, calls }) => {
  await check("exercise"); const original = await readFile(file, "utf8"), count = calls.length;
  await assert.rejects(check("exercise"));
  assert.equal(await readFile(file, "utf8"), original); assert.equal(calls.length, count);
}));
