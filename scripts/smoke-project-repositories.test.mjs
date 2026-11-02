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
  const directory = await mkdtemp(path.join(tmpdir(), "asael-repository-probe-")), calls = [];
  const server = createServer((request, response) => {
    calls.push([request.method, request.url]); let value;
    if (request.url === "/api/health") value = { status: "healthy", revision };
    else if (request.url === "/api/auth/login") {
      response.setHeader("set-cookie", "session=fixture; HttpOnly");
      value = { authenticated: true, context: { source: "session", tenantId: "tenant", actorId: options.foreignOwner ? "other" : "owner" } };
    } else if (request.url === "/api/auth/logout") value = { authenticated: false };
    else if (["/api/projects/project_fashion/builder?view=github.repositories", "/api/projects/project_trading/builder?view=github.repositories"].includes(request.url)) {
      response.setHeader("cache-control", "private, no-store");
      value = { github: { configured: true, missing: [], installUrl: "https://github.com/apps/asael-builder/installations/new" },
        repositories: [42, 43].map(id => ({ repositoryId: String(id), fullName: `owner/repo-${id}`, owner: "owner", name: `repo-${id}`,
          private: true, defaultBranch: "main", htmlUrl: options.badUrl ? "https://elsewhere.test/" : `https://github.com/owner/repo-${id}` })),
        serviceReceipt: { operation: "app.projects.builder.repositories.list", accessMode: options.mutationReceipt ? "mutation" : "read", eventContract: "read_only:no_domain_mutation", resourceCount: 2 } };
    } else { response.writeHead(500); response.end("unexpected route"); return; }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const file = path.join(directory, "evidence.json");
  const env = { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}`, EXPECTED_REVISION: revision,
    SMOKE_PROJECT_REPOSITORIES_ALLOW_LOOPBACK: "CONFIRMED", SMOKE_PROJECT_REPOSITORIES_EVIDENCE_FILE: file,
    SMOKE_PROJECT_REPOSITORIES_PROJECT_IDS: '["project_fashion","project_trading"]', SMOKE_PAID_AGENT_EMAIL: "fixture@example.test",
    SMOKE_PAID_AGENT_PASSWORD: "fixture-password", SMOKE_INTERNAL_AUTH_SECRET: "fixture-secret" };
  const check = phase => exec(process.execPath, ["scripts/smoke-project-repositories.mjs"], { env: { ...env, SMOKE_PROJECT_REPOSITORIES_MODE: phase }, timeout: 15_000 });
  try { await run({ check, file, calls, options }); }
  finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
}
test("reads two existing projects in staging and production without source or GitHub grant changes", () => fixture(async ({ check, file, calls }) => {
  await check("exercise"); await check("readback");
  const evidence = JSON.parse(await readFile(file, "utf8"));
  assert.equal(evidence.status, "passed"); assert.equal(evidence.phases.exercise.reads.length, 2); assert.equal(evidence.phases.readback.reads.length, 2);
  assert.equal(evidence.modelCalls, 0); assert.equal(evidence.sourceMutations, 0); assert.equal(evidence.githubGrantChanges, 0); assert.equal(evidence.signedOut, true);
  assert.deepEqual(calls.filter(([method]) => method !== "GET"), [["POST", "/api/auth/login"], ["POST", "/api/auth/logout"], ["POST", "/api/auth/login"], ["POST", "/api/auth/logout"]]);
  assert.ok(!JSON.stringify(evidence).includes("fixture-password"));
}));
for (const [label, options, failure] of [["non-GitHub repository URL", { badUrl: true }, "repository_contract_invalid"], ["mutation receipt", { mutationReceipt: true }, "read_receipt_missing"]]) {
  test(`refuses ${label} and signs out`, () => fixture(async ({ check, file }) => {
    await assert.rejects(check("exercise")); const evidence = JSON.parse(await readFile(file, "utf8"));
    assert.equal(evidence.status, "failed"); assert.equal(evidence.failure, failure); assert.equal(evidence.signedOut, true);
  }, options));
}
test("refuses a different owner on readback", () => fixture(async ({ check, file, options }) => {
  await check("exercise"); options.foreignOwner = true; await assert.rejects(check("readback"));
  const evidence = JSON.parse(await readFile(file, "utf8")); assert.equal(evidence.failure, "owner_changed"); assert.equal(evidence.signedOut, true);
}));
test("keeps an existing staged attempt immutable", () => fixture(async ({ check, file, calls }) => {
  await check("exercise"); const original = await readFile(file, "utf8"), count = calls.length;
  await assert.rejects(check("exercise")); assert.equal(await readFile(file, "utf8"), original); assert.equal(calls.length, count);
}));
