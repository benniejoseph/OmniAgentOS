import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { recoveryProbeConfiguration, recoveryChildEnvironment, runRecoveryChild, runSupplementalRecovery } from "./supplemental-recovery-probe.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const staged = "https://omniagent-test-benniejosephs-projects.vercel.app";
const canonical = "https://asael.bennierichard.com";
const revision = "a".repeat(40), owner = "b".repeat(64);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const program = `import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const e=process.env,h=x=>createHash('sha256').update(x).digest('hex');
const source=e.RECOVERY_READBACK_FILE?await readFile(e.RECOVERY_READBACK_FILE):null;
const prior=source?JSON.parse(source):null;
const value={schemaVersion:1,scenario:'paused_research_diagnosis_v1',mode:e.RECOVERY_MODE,status:'PASS',expectedRevision:e.EXPECTED_REVISION,
origin:e.BASE_URL,mockTarget:false,verifierSha256:h(await readFile(new URL(import.meta.url))),ownerSha256:'${owner}',behaviorVerified:true,
signedOut:true,workflowUnchanged:true,workflowBeforeSha256:'${"c".repeat(64)}',workflowAfterSha256:'${"c".repeat(64)}',responseSha256:'${"d".repeat(64)}',
trajectorySha256:'${"e".repeat(64)}',trajectoryRevision:e.EXPECTED_REVISION,agentId:'11111111-1111-4111-8111-111111111111',
runId:'22222222-2222-4222-8222-222222222222',agentPosts:e.RECOVERY_MODE==='exercise'?1:0,
cleanup:{agentPurged:true,trashId:'trash:33333333-3333-4333-8333-333333333333',purgeReceiptSha256:'${"f".repeat(64)}',agentAbsent:!!source,readbackVerified:!!source},
executedReads:[{toolId:'app.runs.show',executionId:'read:run',inputSha256:'${"0".repeat(64)}'},{toolId:'app.workflows.show',executionId:'read:workflow',inputSha256:'${"1".repeat(64)}'}],
...(source?{sourceEvidenceSha256:h(source)}:{})};
if(prior&&prior.runId!==value.runId)throw Error('different_fixture');
await writeFile(e.RECOVERY_EVIDENCE_FILE,JSON.stringify(value)+'\\n',{flag:'wx',mode:0o600});
console.log('private child output '+e.SMOKE_PAID_AGENT_PASSWORD);
`;

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "asael-recovery-probe-")));
  t.after(async () => {
    for (const phase of ["exercise", "readback"]) await chmod(path.join(directory, `${phase}.json.runner`), 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const verifier = path.join(directory, "verifier.mjs");
  await writeFile(verifier, program, { mode: 0o600 });
  const env = { SMOKE_AGENT_RECOVERY_VERIFIER_FILE: verifier, SMOKE_AGENT_RECOVERY_VERIFIER_SHA256: hash(program),
    SMOKE_AGENT_RECOVERY_EXERCISE_EVIDENCE_FILE: path.join(directory, "exercise.json"),
    SMOKE_AGENT_RECOVERY_READBACK_EVIDENCE_FILE: path.join(directory, "readback.json"),
    SMOKE_PAID_AGENT_EMAIL: "owner@example.test", SMOKE_PAID_AGENT_PASSWORD: "fixture-secret", SMOKE_INTERNAL_AUTH_SECRET: "internal-fixture",
    RECOVERY_ALLOW_LOOPBACK: "CONFIRMED", SMOKE_ALLOW_LOOPBACK: "CONFIRMED", NODE_OPTIONS: "--require=/unsafe.js",
    HTTP_PROXY: "http://unsafe", OPENAI_API_KEY: "must-not-inherit", RECOVERY_MODE: "override" };
  const input = { env, phase: "exercise", baseUrl: staged, revision, repository, parentEvidenceFile: path.join(directory, "parent.json") };
  return { directory, verifier, env, input, configuration: recoveryProbeConfiguration(input) };
}

test("absent configuration retains existing behavior and queue readback never executes recovery", async () => {
  assert.equal(recoveryProbeConfiguration({ env: {}, phase: "exercise" }), null);
  assert.equal(recoveryProbeConfiguration({ env: { SMOKE_AGENT_RECOVERY_VERIFIER_FILE: "unsafe" }, phase: "queue_readback" }), null);
  assert.equal(await runSupplementalRecovery({ configuration: null, phase: "exercise", execute: () => assert.fail("child") }), null);
  assert.equal(await runSupplementalRecovery({ configuration: null, phase: "queue_readback", priorExercise: { status: "passed" } }), null);
  await assert.rejects(runSupplementalRecovery({ configuration: null, phase: "readback", priorExercise: { status: "passed" } }), /configuration_removed/);
});

test("partial pins, origins, path aliases and overlapping outputs are rejected before spawn", async t => {
  const f = await fixture(t);
  for (const baseUrl of [canonical, "http://127.0.0.1:3000", `${staged}/path`, `${staged}/?x=1`, `https://user@${new URL(staged).hostname}`, "https://example.test"])
    assert.throws(() => recoveryProbeConfiguration({ ...f.input, baseUrl }), /invalid_origin/);
  assert.throws(() => recoveryProbeConfiguration({ ...f.input, phase: "readback" }), /invalid_origin/);
  assert.throws(() => recoveryProbeConfiguration({ ...f.input, env: { SMOKE_AGENT_RECOVERY_VERIFIER_FILE: f.verifier } }), /incomplete_configuration/);
  for (const value of ["relative", `${f.directory}/../other.json`, `${f.directory}/bad\nfile`, f.input.parentEvidenceFile, `${f.verifier}/child`])
    assert.throws(() => recoveryProbeConfiguration({ ...f.input, env: { ...f.env, SMOKE_AGENT_RECOVERY_EXERCISE_EVIDENCE_FILE: value } }), /invalid_paths|overlapping_paths/);
  assert.throws(() => recoveryProbeConfiguration({ ...f.input, env: { ...f.env, SMOKE_AGENT_RECOVERY_VERIFIER_SHA256: "not-a-pin" } }), /invalid_pin/);
});

test("child uses exact phase/auth mapping without inherited options or loopback authority", async t => {
  const f = await fixture(t), exercise = recoveryChildEnvironment(f.configuration, f.env);
  assert.equal(exercise.LIVE_VERIFY_AGENT_RECOVERY, "CONFIRMED");
  assert.equal(exercise.RECOVERY_MODE, "exercise");
  assert.equal(exercise.INTERNAL_AUTH_SECRET, f.env.SMOKE_INTERNAL_AUTH_SECRET);
  for (const name of ["NODE_OPTIONS", "RECOVERY_ALLOW_LOOPBACK", "SMOKE_ALLOW_LOOPBACK", "OPENAI_API_KEY", "HTTP_PROXY", "RECOVERY_READBACK_FILE"])
    assert.equal(exercise[name], undefined);
  const config = recoveryProbeConfiguration({ ...f.input, phase: "readback", baseUrl: canonical });
  const readback = recoveryChildEnvironment(config, f.env, path.join(f.directory, "frozen.json"));
  assert.equal(readback.RECOVERY_MODE, "readback"); assert.equal(readback.BASE_URL, canonical);
  assert.equal(readback.LIVE_VERIFY_AGENT_RECOVERY, undefined);
  assert.equal(readback.RECOVERY_READBACK_FILE, path.join(f.directory, "frozen.json"));
  assert.equal(readback.RECOVERY_EVIDENCE_FILE, f.env.SMOKE_AGENT_RECOVERY_READBACK_EVIDENCE_FILE);
});

test("verifier pin, symlink and nonprivate file failures cannot spawn", async t => {
  const f = await fixture(t);
  const run = config => runSupplementalRecovery({ configuration: config, phase: "exercise", env: f.env, ownerSha256: owner,
    execute: () => assert.fail("must not spawn") });
  await assert.rejects(run({ ...f.configuration, verifierSha256: "0".repeat(64) }), /pin_mismatch/);
  await chmod(f.verifier, 0o644); await assert.rejects(run(f.configuration), /unsafe_file/); await chmod(f.verifier, 0o600);
  await chmod(f.directory, 0o777); await assert.rejects(run(f.configuration), /unsafe_parent/); await chmod(f.directory, 0o755);
  const link = path.join(f.directory, "link.mjs"); await symlink(f.verifier, link);
  await assert.rejects(run({ ...f.configuration, verifierFile: link }), /configuration_or_evidence_failed/);
  await writeFile(f.configuration.readbackFile, "previous receipt", { mode: 0o600 });
  await assert.rejects(run(f.configuration), /existing_attempt/);
});

test("same-record canonical readback uses verified immutable snapshots and bounded content-free child results", async t => {
  const f = await fixture(t), recorded = [];
  const exercise = await runSupplementalRecovery({ configuration: f.configuration, phase: "exercise", env: f.env, ownerSha256: owner,
    record: async value => recorded.push(value), execute: async input => {
      await writeFile(f.verifier, "throw Error('changed after pin');");
      assert.notEqual(input.script, f.verifier);
      return runRecoveryChild(input);
    } });
  assert.equal(exercise.status, "passed"); assert.equal(recorded[0].status, "pending");
  assert.equal(exercise.child.exitCode, 0); assert.ok(exercise.child.stdoutBytes > 0);
  assert.ok(!JSON.stringify(exercise).includes("fixture-secret"));
  assert.equal(hash(await readFile(exercise.verifierSnapshotFile)), f.configuration.verifierSha256);
  await writeFile(f.verifier, program);
  const configuration = recoveryProbeConfiguration({ ...f.input, phase: "readback", baseUrl: canonical });
  const readback = await runSupplementalRecovery({ configuration, phase: "readback", env: f.env, ownerSha256: owner,
    priorExercise: exercise, execute: async input => {
      assert.notEqual(input.env.RECOVERY_READBACK_FILE, configuration.exerciseFile);
      await writeFile(configuration.exerciseFile, "changed after readback pin");
      return runRecoveryChild(input);
    } });
  assert.equal(readback.status, "passed"); assert.equal(readback.sourceEvidenceSha256, exercise.evidenceSha256);
  const result = JSON.parse(await readFile(configuration.outputFile, "utf8"));
  assert.equal(result.agentPosts, 0); assert.equal(result.runId, "22222222-2222-4222-8222-222222222222");
});

test("canonical readback rejects changed source, owner, or absent parent receipt", async t => {
  const f = await fixture(t);
  const exercise = await runSupplementalRecovery({ configuration: f.configuration, phase: "exercise", env: f.env, ownerSha256: owner });
  const configuration = recoveryProbeConfiguration({ ...f.input, phase: "readback", baseUrl: canonical });
  const input = { configuration, phase: "readback", env: f.env, ownerSha256: owner, priorExercise: exercise,
    execute: () => assert.fail("must not spawn") };
  await assert.rejects(runSupplementalRecovery({ ...input, priorExercise: undefined }), /exercise_reference_missing/);
  await assert.rejects(runSupplementalRecovery({ ...input, ownerSha256: "0".repeat(64) }), /receipt_invalid/);
  await writeFile(configuration.exerciseFile, "changed");
  await assert.rejects(runSupplementalRecovery(input), /exercise_receipt_changed/);
});

test("a child failure retains receipt hashes, fails the gate and cannot automatically repeat", async t => {
  const f = await fixture(t); let launches = 0, last;
  const input = { configuration: f.configuration, phase: "exercise", env: f.env, ownerSha256: owner,
    record: async value => { last = value; }, execute: async run => {
      launches++; const result = await runRecoveryChild(run); return { ...result, exitCode: 1 };
    } };
  await assert.rejects(runSupplementalRecovery(input), /child_failed/);
  assert.equal(last.status, "failed"); assert.match(last.evidenceSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(runSupplementalRecovery(input), /existing_attempt/); assert.equal(launches, 1);
});

test("a zero exit cannot turn an incomplete or different receipt into a passing gate", async t => {
  const f = await fixture(t);
  await assert.rejects(runSupplementalRecovery({ configuration: f.configuration, phase: "exercise", env: f.env, ownerSha256: owner,
    execute: async run => {
      const result = await runRecoveryChild(run), value = JSON.parse(await readFile(run.env.RECOVERY_EVIDENCE_FILE));
      value.cleanup.agentPurged = false; await writeFile(run.env.RECOVERY_EVIDENCE_FILE, JSON.stringify(value)); return result;
    } }), /receipt_invalid/);
});

test("the real smoke hook stops before engineering or retained cleanup on supplemental failure", async t => {
  const f = await fixture(t), callsFile = path.join(f.directory, "calls.json");
  const mock = `import {writeFile} from 'node:fs/promises';
const calls=[];globalThis.fetch=async (url,options)=>{const p=new URL(url).pathname;calls.push(p);
if(p==='/api/health')return Response.json({status:'healthy',revision:'${revision}'});
if(p==='/api/auth/login')return Response.json({authenticated:true,context:{source:'session',tenantId:'tenant',actorId:'actor'},user:{id:'user'}},{headers:{'set-cookie':'asael_session=fixture'}});
if(p==='/api/auth/logout')return Response.json({authenticated:false});
throw Error('unexpected engineering request');};
await import(${JSON.stringify(new URL("../smoke-self-improvement.mjs", import.meta.url).href)});
await writeFile(${JSON.stringify(callsFile)},JSON.stringify(calls),{mode:0o600});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", mock], { cwd: repository,
    env: { PATH: "/usr/bin:/bin", ...f.env, NODE_OPTIONS: "", BASE_URL: staged, EXPECTED_REVISION: revision,
      SMOKE_SELF_IMPROVEMENT_MODE: "exercise", LIVE_VERIFY_SELF_IMPROVEMENT: "CONFIRMED",
      SMOKE_SELF_IMPROVEMENT_EVIDENCE_FILE: f.input.parentEvidenceFile, SMOKE_AGENT_RECOVERY_VERIFIER_SHA256: "0".repeat(64) },
    encoding: "utf8", timeout: 10_000, maxBuffer: 100_000 });
  assert.equal(child.status, 1, child.stderr);
  assert.deepEqual(JSON.parse(await readFile(callsFile)), ["/api/health", "/api/auth/login", "/api/auth/logout"]);
  const saved = JSON.parse(await readFile(f.input.parentEvidenceFile));
  assert.equal(saved.status, "failed"); assert.equal(saved.signedOut, true);
  assert.equal(saved.supplementalRecovery.exercise.status, "failed");
  assert.equal(saved.configurationPaused, undefined); assert.equal(saved.cycleId, undefined);
});
