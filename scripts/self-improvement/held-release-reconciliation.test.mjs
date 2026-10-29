import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseHeldReleaseReconciliation, runHeldReleaseReconciliation } from "./held-release-reconciliation.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const previous = "a".repeat(40), candidate = "b".repeat(40), binding = "c".repeat(64);
const staged = "https://omniagent-example-benniejosephs-projects.vercel.app", production = "https://asael.bennierichard.com";
const email = "fixture@example.test", password = "synthetic-only-password", cookie = "asael-session=synthetic-cookie";
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "asael-held-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = async (name, text) => {
    const file = path.join(directory, name); await writeFile(file, text, { mode: 0o600 });
    return { file, sha256: hash(text) };
  };
  const config = { version: 1, previousRevision: previous, candidateRevision: candidate, cycleId: `self_cycle_${"d".repeat(64)}`,
    expectedRevision: 76, controllerId: "trusted-controller", releaseBindingSha256: binding, controllerHoldSha256: "e".repeat(64),
    diagnostic: await source("diagnostic.json", '{"refusal":"temporary_directory"}'),
    attemptEvidence: await source("attempt.json", '{"deployStarted":false}'), evidenceFile: path.join(directory, "receipt.json") };
  const receipt = { releaseBindingSha256: binding, outcome: "failed", webRevision: previous, workerRevision: previous,
    manifestSha256: "1".repeat(64), serverHealthEvidenceSha256: "2".repeat(64), evidenceSha256: "3".repeat(64), recordedAt: new Date().toISOString() };
  const cycle = { id: config.cycleId, revision: 77, stage: "failed", usageState: "known", release: { releaseBindingSha256: binding },
    // PostgreSQL JSONB may reorder keys between the action and readback.
    releaseReceipt: Object.fromEntries(Object.entries(receipt).reverse()) };
  const calls = [];
  const fetcher = async (url, options) => {
    const endpoint = new URL(url).pathname;
    calls.push({ url, ...options });
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    if (endpoint === "/api/health") return Response.json({ status: "healthy", revision: candidate });
    if (endpoint === "/api/auth/login") return Response.json({ authenticated: true, context: { source: "session", role: "admin", tenantId: "fixture", actorId: email }, user: { email, id: "fixture-user" } }, { headers: { "set-cookie": cookie + "; Secure; HttpOnly" } });
    assert.equal(options.headers.cookie, cookie);
    if (endpoint === "/api/auth/logout") return Response.json({ authenticated: false });
    if (endpoint === "/api/self-improvement/release-controller") {
      const action = JSON.parse(options.body);
      assert.equal(action.action, "reconcile_web_predeployment_failure");
      assert.equal(action.expectedRevision, 76);
      assert.equal(action.attestation.diagnosticSha256, config.diagnostic.sha256);
      assert.equal(action.attestation.attemptEvidenceSha256, config.attemptEvidence.sha256);
      return Response.json({ cycleId: config.cycleId, stage: "failed", revision: 77, receipt });
    }
    assert.equal(endpoint, "/api/self-improvement");
    assert.equal(new URL(url).searchParams.get("cycleId"), config.cycleId);
    return Response.json({ cycle });
  };
  return { config, calls, fetcher, cycle, run: (extra = {}) => runHeldReleaseReconciliation({ configuration: config, baseUrl: staged,
    phase: "reconcile", email, password, fetcher, ...extra }) };
}

test("no configured reconciliation causes no request", async () => {
  assert.equal(parseHeldReleaseReconciliation(undefined, candidate), null);
  assert.equal(await runHeldReleaseReconciliation({ configuration: null, fetcher: () => assert.fail("unexpected network") }), null);
});

test("the pin requires the owner-authorized exact release and a closed bounded shape", async t => {
  const { config } = await fixture(t), authorization = { previousRevision: previous, candidateRevision: candidate };
  assert.deepEqual(parseHeldReleaseReconciliation(JSON.stringify(config), candidate, authorization), config);
  for (const change of [{ expectedRevision: 0 }, { controllerId: "arbitrary command" }, { cycleId: "other" },
    { candidateRevision: previous }, { previousRevision: candidate }, { releaseBindingSha256: "wrong" }, { replay: true },
    { diagnostic: { file: "relative", sha256: "0".repeat(64) } }, { evidenceFile: config.diagnostic.file }]) {
    assert.throws(() => parseHeldReleaseReconciliation(JSON.stringify({ ...config, ...change }), candidate, authorization), /held_release_/);
  }
  assert.throws(() => parseHeldReleaseReconciliation(JSON.stringify(config), candidate), /release_pair/);
});

test("one staged failure settlement is verified and canonical readback never posts it again", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.run(), { cycleId: f.config.cycleId, stage: "failed", reconciliation: "passed", canonicalReadback: false,
    publicationSucceeded: false, evidenceFile: f.config.evidenceFile });
  await f.run({ phase: "readback", baseUrl: production });
  const saved = await readFile(f.config.evidenceFile, "utf8"), evidence = JSON.parse(saved);
  assert.equal(evidence.status, "passed"); assert.equal(evidence.signedOut, true);
  assert.equal(evidence.canonicalReadback.revision, candidate);
  assert.equal(evidence.publicationSucceeded, false);
  assert.equal(f.calls.filter(call => call.url.endsWith("/release-controller")).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith("/api/auth/logout")).length, 2);
  for (const secret of [password, cookie, email]) assert.equal(saved.includes(secret), false);
  const before = f.calls.length;
  await assert.rejects(f.run(), /existing_attempt/);
  assert.equal(f.calls.length, before);
});

test("changed retained evidence refuses before login or any mutation", async t => {
  const f = await fixture(t);
  await writeFile(f.config.diagnostic.file, "changed");
  await assert.rejects(f.run(), /source_changed/);
  assert.equal(f.calls.length, 0);
});

test("uncertain mutation retains the dispatch and logs out without replay or leaked errors", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ fetcher: (url, options) => {
    if (url.endsWith("/release-controller")) throw new Error(password);
    return f.fetcher(url, options);
  } }), /held_release_verification_failed/);
  const saved = await readFile(f.config.evidenceFile, "utf8"), evidence = JSON.parse(saved);
  assert.equal(evidence.status, "failed"); assert.ok(evidence.mutationDispatchedAt);
  assert.equal(evidence.signedOut, true); assert.equal(saved.includes(password), false);
  await assert.rejects(f.run(), /existing_attempt/);
});

test("a changed canonical terminal receipt blocks success without another mutation", async t => {
  const f = await fixture(t); await f.run();
  f.cycle.releaseReceipt.evidenceSha256 = "9".repeat(64);
  await assert.rejects(f.run({ phase: "readback", baseUrl: production }), /terminal_readback/);
  assert.equal(f.calls.filter(call => call.url.endsWith("/release-controller")).length, 1);
  assert.equal(JSON.parse(await readFile(f.config.evidenceFile)).status, "failed");
});

test("arbitrary origins and reconciliation on canonical are refused before network", async t => {
  const f = await fixture(t);
  for (const baseUrl of [production, "https://example.com", `${staged}/`, `${staged}@example.com`, `${staged}?redirect=1`]) {
    await assert.rejects(f.run({ baseUrl }), /origin_or_phase/);
  }
  assert.equal(f.calls.length, 0);
});

test("the maintained release plan schedules reconciliation before Fly mutation", async t => {
  const { config } = await fixture(t);
  const authorization = { previousRevision: previous, candidateRevision: candidate, reason: "Synthetic release plan verification",
    expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const runner = fileURLToPath(new URL("../deploy-production.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [runner, "--dry-run", "--owner-authorized-live"], {
    encoding: "utf8", timeout: 10000, env: { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", HOME: process.env.HOME,
      OMNIAGENT_RELEASE_SHA: candidate, OMNIAGENT_RELEASE_OWNER_LIVE_AUTHORIZATION: JSON.stringify(authorization),
      OMNIAGENT_HELD_RELEASE_RECONCILIATION: JSON.stringify(config) },
  });
  assert.equal(run.status, 0, run.stderr);
  const reconcile = run.stdout.indexOf("DRY RUN reconcile only the exact held web publication as failed");
  assert.ok(reconcile > 0);
  assert.ok(run.stdout.indexOf("fly deploy") > reconcile);
  await assert.rejects(readFile(config.evidenceFile), { code: "ENOENT" });
});
