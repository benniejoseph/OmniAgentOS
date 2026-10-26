/** Optional, once-only composition of an operator-reviewed recovery verifier. */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

const production = "https://asael.bennierichard.com";
const staged = /^https:\/\/omniagent-[a-z0-9]+-benniejosephs-projects\.vercel\.app$/;
const sha = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const keys = ["SMOKE_AGENT_RECOVERY_VERIFIER_FILE", "SMOKE_AGENT_RECOVERY_VERIFIER_SHA256",
  "SMOKE_AGENT_RECOVERY_EXERCISE_EVIDENCE_FILE", "SMOKE_AGENT_RECOVERY_READBACK_EVIDENCE_FILE"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const requireValue = (condition, code) => { if (!condition) throw new Error(`supplemental_recovery_${code}`); };
const isPath = value => typeof value === "string" && value.length < 4096 && path.isAbsolute(value) &&
  path.normalize(value) === value && !/[\u0000-\u001f\u007f]/.test(value);

export function recoveryProbeConfiguration({ env, phase, baseUrl, revision, repository, parentEvidenceFile }) {
  // The post-activation queue check never runs or replays the diagnostic.
  if (phase === "queue_readback") return null;
  requireValue(["exercise", "readback"].includes(phase), "invalid_phase");
  if (keys.every(key => env[key] === undefined)) return null;
  requireValue(keys.every(key => typeof env[key] === "string" && env[key].trim()), "incomplete_configuration");
  requireValue(sha.test(env[keys[1]]) && /^[a-f0-9]{40}$/.test(revision), "invalid_pin");
  const origin = new URL(baseUrl);
  requireValue(origin.protocol === "https:" && !origin.username && !origin.password && origin.pathname === "/" &&
    !origin.search && !origin.hash && [origin.origin, `${origin.origin}/`].includes(baseUrl) &&
    (phase === "exercise" ? staged.test(origin.origin) : origin.origin === production), "invalid_origin");
  const [verifierFile, , exerciseFile, readbackFile] = keys.map(key => env[key]);
  const paths = [verifierFile, exerciseFile, readbackFile, parentEvidenceFile];
  requireValue(paths.every(isPath) && isPath(repository) && new Set(paths).size === paths.length, "invalid_paths");
  requireValue(paths.every(value => !paths.some(other => other !== value && value.startsWith(`${other}${path.sep}`))), "overlapping_paths");
  return { phase, origin: origin.origin, revision, repository, verifierFile, verifierSha256: env[keys[1]],
    exerciseFile, readbackFile, outputFile: phase === "exercise" ? exerciseFile : readbackFile, parentEvidenceFile };
}

async function privateParent(file) {
  const directory = path.dirname(file);
  const info = await lstat(directory);
  requireValue(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o022) &&
    await realpath(directory) === directory, "unsafe_parent");
}

async function privateRead(file, maximum = 100_000) {
  await privateParent(file);
  const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await descriptor.stat();
    requireValue(before.isFile() && before.nlink === 1 && before.uid === process.getuid() && !(before.mode & 0o077) &&
      before.size > 0 && before.size <= maximum, "unsafe_file");
    const raw = await descriptor.readFile();
    const after = await descriptor.stat();
    requireValue(raw.length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs &&
      after.ctimeMs === before.ctimeMs, "file_changed_during_read");
    return raw;
  } finally { await descriptor.close(); }
}

async function mustNotExist(file) {
  await privateParent(file);
  try { await lstat(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("supplemental_recovery_existing_attempt");
}

async function snapshot(file, raw) {
  const descriptor = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { await descriptor.writeFile(raw); await descriptor.sync(); } finally { await descriptor.close(); }
}

export function recoveryChildEnvironment(configuration, env, readbackSnapshot) {
  const result = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", NODE_ENV: "production",
    RECOVERY_REPO_DIR: configuration.repository, BASE_URL: configuration.origin, EXPECTED_REVISION: configuration.revision,
    RECOVERY_MODE: configuration.phase, RECOVERY_EVIDENCE_FILE: configuration.outputFile };
  for (const key of ["SMOKE_PAID_AGENT_EMAIL", "SMOKE_PAID_AGENT_PASSWORD", "SMOKE_INTERNAL_AUTH_SECRET"]) {
    requireValue(typeof env[key] === "string" && env[key].trim(), "authentication_missing");
    result[key] = env[key];
  }
  for (const key of ["VERCEL_AUTOMATION_BYPASS_SECRET", "SMOKE_TENANT_ID", "SMOKE_ACTOR_ID"])
    if (env[key]) result[key] = env[key];
  result.INTERNAL_AUTH_SECRET = result.SMOKE_INTERNAL_AUTH_SECRET;
  if (configuration.phase === "exercise") result.LIVE_VERIFY_AGENT_RECOVERY = "CONFIRMED";
  else { requireValue(isPath(readbackSnapshot), "readback_snapshot_missing"); result.RECOVERY_READBACK_FILE = readbackSnapshot; }
  // Deliberate allowlist: no inherited NODE_OPTIONS, preload, loopback, proxy,
  // provider credentials, or recovery-mode overrides reach the reviewed child.
  return result;
}

export async function runRecoveryChild({ executable, script, cwd, env }) {
  return new Promise(resolve => {
    const child = spawn(executable, [script], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const streams = { stdout: { hash: createHash("sha256"), bytes: 0 }, stderr: { hash: createHash("sha256"), bytes: 0 } };
    let timedOut = false, outputLimitExceeded = false, spawnFailed = false, killTimer;
    const kill = signal => { try { process.kill(-child.pid, signal); } catch { /* A completed child has no process group. */ } };
    const stop = () => { kill("SIGTERM"); killTimer ||= setTimeout(() => kill("SIGKILL"), 5_000); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 600_000);
    for (const name of Object.keys(streams)) child[name].on("data", bytes => {
      const state = streams[name]; state.bytes += bytes.length; state.hash.update(bytes);
      if (state.bytes > 65_536 && !outputLimitExceeded) { outputLimitExceeded = true; stop(); }
    });
    child.on("error", () => { spawnFailed = true; });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      resolve({ exitCode, signal, timedOut, outputLimitExceeded, spawnFailed,
        stdoutBytes: streams.stdout.bytes, stdoutSha256: streams.stdout.hash.digest("hex"),
        stderrBytes: streams.stderr.bytes, stderrSha256: streams.stderr.hash.digest("hex") });
    });
  });
}

function validateReceipt(value, configuration, ownerSha256, mode, source) {
  requireValue(value?.schemaVersion === 1 && value.scenario === "paused_research_diagnosis_v1" && value.mode === mode &&
    value.status === "PASS" && value.expectedRevision === configuration.revision && value.mockTarget === false &&
    value.verifierSha256 === configuration.verifierSha256 && value.ownerSha256 === ownerSha256 &&
    value.behaviorVerified === true && value.signedOut === true && value.workflowUnchanged === true &&
    sha.test(value.workflowBeforeSha256 || "") && value.workflowBeforeSha256 === value.workflowAfterSha256 &&
    sha.test(value.responseSha256 || "") && sha.test(value.trajectorySha256 || "") && value.trajectoryRevision === configuration.revision &&
    uuid.test(value.agentId || "") && uuid.test(value.runId || "") && value.agentPosts === (mode === "exercise" ? 1 : 0) &&
    value.cleanup?.agentPurged === true && /^trash:[a-f0-9-]{36}$/.test(value.cleanup.trashId || "") &&
    sha.test(value.cleanup.purgeReceiptSha256 || "") && Array.isArray(value.executedReads) && value.executedReads.length === 2 &&
    new Set(value.executedReads.map(item => item.toolId)).size === 2 && value.executedReads.every(item =>
      ["app.runs.show", "app.workflows.show"].includes(item.toolId) && /^[A-Za-z0-9_.:-]{1,200}$/.test(item.executionId || "") &&
      sha.test(item.inputSha256 || "")), "receipt_invalid");
  requireValue(mode === "exercise" ? staged.test(value.origin || "") : value.origin === production, "receipt_origin_changed");
  if (mode === configuration.phase) requireValue(value.origin === configuration.origin, "receipt_origin_changed");
  if (mode === "readback") requireValue(source && value.sourceEvidenceSha256 === source.sha256 &&
    value.agentId === source.value.agentId && value.runId === source.value.runId &&
    value.workflowAfterSha256 === source.value.workflowAfterSha256 && value.responseSha256 === source.value.responseSha256 &&
    value.cleanup.agentAbsent === true && value.cleanup.readbackVerified === true &&
    value.cleanup.trashId === source.value.cleanup.trashId && value.cleanup.purgeReceiptSha256 === source.value.cleanup.purgeReceiptSha256 &&
    JSON.stringify(value.executedReads) === JSON.stringify(source.value.executedReads), "readback_binding_changed");
}

export async function runSupplementalRecovery({ configuration, phase, env, ownerSha256, priorExercise, record = async () => {},
  execute = runRecoveryChild }) {
  if (!configuration) {
    requireValue(phase !== "readback" || !priorExercise, "configuration_removed");
    return null;
  }
  requireValue(configuration.phase === phase && sha.test(ownerSha256), "owner_or_phase_invalid");
  const result = { version: 1, mode: phase, status: "pending", verifierSha256: configuration.verifierSha256,
    origin: configuration.origin, revision: configuration.revision, evidenceFile: configuration.outputFile };
  try {
    const verifier = await privateRead(configuration.verifierFile, 100_000);
    requireValue(hash(verifier) === configuration.verifierSha256, "verifier_pin_mismatch");
    const directory = `${configuration.outputFile}.runner`;
    requireValue(![configuration.verifierFile, configuration.exerciseFile, configuration.readbackFile, configuration.parentEvidenceFile]
      .some(file => file === directory || file.startsWith(`${directory}${path.sep}`)), "overlapping_paths");
    await mustNotExist(configuration.outputFile);
    if (phase === "exercise") await mustNotExist(configuration.readbackFile);
    let source;
    if (phase === "readback") {
      requireValue(priorExercise?.status === "passed" && priorExercise.evidenceFile === configuration.exerciseFile &&
        priorExercise.verifierSha256 === configuration.verifierSha256 && sha.test(priorExercise.evidenceSha256 || ""), "exercise_reference_missing");
      const raw = await privateRead(configuration.exerciseFile);
      requireValue(hash(raw) === priorExercise.evidenceSha256, "exercise_receipt_changed");
      source = { raw, sha256: hash(raw), value: JSON.parse(raw.toString("utf8")) };
      validateReceipt(source.value, configuration, ownerSha256, "exercise");
    }
    // Private exclusive snapshots eliminate original-file hash/spawn and
    // readback-open races. The directory also retains a once-only attempt marker.
    await mkdir(directory, { mode: 0o700 });
    const script = path.join(directory, "verified-recovery.mjs");
    await snapshot(script, verifier);
    const readbackSnapshot = source ? path.join(directory, "exercise.json") : undefined;
    if (source) await snapshot(readbackSnapshot, source.raw);
    await chmod(directory, 0o500);
    result.verifierSnapshotFile = script;
    if (source) result.sourceEvidenceSha256 = source.sha256;
    const childEnv = recoveryChildEnvironment(configuration, env, readbackSnapshot);
    await record({ ...result });
    result.child = await execute({ executable: process.execPath, script, cwd: configuration.repository, env: childEnv });
    let raw;
    try { raw = await privateRead(configuration.outputFile); result.evidenceSha256 = hash(raw); }
    catch { throw new Error("supplemental_recovery_evidence_unavailable"); }
    requireValue(result.child.exitCode === 0 && !result.child.signal && !result.child.timedOut &&
      !result.child.outputLimitExceeded && !result.child.spawnFailed, "child_failed");
    validateReceipt(JSON.parse(raw.toString("utf8")), configuration, ownerSha256, phase, source);
    result.status = "passed";
    await record({ ...result });
    return result;
  } catch (error) {
    result.status = "failed";
    result.failure = /^supplemental_recovery_[a-z_]+$/.test(error.message) ? error.message : "supplemental_recovery_configuration_or_evidence_failed";
    await record({ ...result });
    const failure = new Error(result.failure); failure.supplementalRecovery = result; throw failure;
  }
}
