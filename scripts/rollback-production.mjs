#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquirePairedReleaseLock } from "./self-improvement/deploy-lock.mjs";
import { assessReleaseManifestHealth } from "./smoke-release-manifest.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB = "https://asael.bennierichard.com";
const GATEWAY = "https://omniagent-os-worker.fly.dev/v1";
const APP = "omniagent-os-worker";
const HEX = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_BYTES = 100_000;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function requireThat(condition, category) { if (!condition) throw new Error(category); }
function exactKeys(value, keys, category) {
  requireThat(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(","), category);
}
function timestamp(value) { return typeof value === "string" ? Date.parse(value) : NaN; }
function privateDirectory(directory) {
  requireThat(path.isAbsolute(directory) && realpathSync(directory) === directory, "unsafe_directory");
  const stat = lstatSync(directory);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && !(stat.mode & 0o077), "unsafe_directory");
}
export function readPinnedPrivateJson(file, digest) {
  requireThat(path.isAbsolute(file) && HEX.test(digest), "invalid_file_pin");
  privateDirectory(path.dirname(file));
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireThat(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() &&
      (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size < MAX_BYTES, "unsafe_evidence_file");
    const bytes = readFileSync(fd);
    requireThat(bytes.length === stat.size && sha256(bytes) === digest, "evidence_hash_mismatch");
    return JSON.parse(bytes.toString("utf8"));
  } finally { closeSync(fd); }
}

/** Proofs are pinned, operator-observed registry metadata; they are not a new signature authority. */
export function validateRecoveryInput(input, proofs, now = Date.now(), manifestOptions = {}) {
  exactKeys(input, ["version", "action", "operationId", "createdAt", "expiresAt", "checkoutRevision",
    "previousRevision", "currentWorkerRevision", "priorImage", "proofs"], "invalid_recovery_input");
  requireThat(input.version === 1 && input.action === "restore_prior_worker_only" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.operationId), "invalid_recovery_scope");
  requireThat(REVISION.test(input.previousRevision) && REVISION.test(input.currentWorkerRevision) &&
    input.previousRevision !== input.currentWorkerRevision && input.checkoutRevision === input.currentWorkerRevision,
  "invalid_recovery_revisions");
  const created = timestamp(input.createdAt), expires = timestamp(input.expiresAt);
  requireThat(Number.isFinite(created) && Number.isFinite(expires) && created <= now && now < expires &&
    expires > created && expires - created <= 4 * 60 * 60 * 1000, "recovery_authorization_expired");
  exactKeys(input.proofs, ["imageManifest", "imageConfig", "priorWeb", "currentMachines"], "invalid_proof_inventory");
  for (const ref of Object.values(input.proofs)) {
    exactKeys(ref, ["path", "sha256"], "invalid_proof_pin");
    requireThat(path.isAbsolute(ref.path) && HEX.test(ref.sha256), "invalid_proof_pin");
  }
  const { imageManifest: manifest, imageConfig: config, priorWeb: health, currentMachines } = proofs;
  requireThat(manifest.status === 200 && manifest.mutations === false && DIGEST.test(manifest.digest) &&
    manifest.computedDigest === manifest.digest && manifest.mediaType === "application/vnd.oci.image.manifest.v1+json" &&
    manifest.manifests === null && DIGEST.test(manifest.config?.digest) &&
    manifest.config.mediaType === "application/vnd.oci.image.config.v1+json", "invalid_registry_manifest_proof");
  requireThat(config.status === 200 && config.mutations === false && config.environmentValuesPersisted === false &&
    config.imageDigest === manifest.digest && config.configDigest === manifest.config.digest &&
    config.os === "linux" && config.architecture === "amd64" && config.releaseRevision === input.previousRevision &&
    input.priorImage === `registry.fly.io/${APP}@${manifest.digest}`, "invalid_prior_image_binding");
  requireThat(health.status === "healthy", "invalid_prior_web_health");
  assessReleaseManifestHealth(health, input.previousRevision, manifestOptions);
  requireThat(timestamp(health.observedAt) <= now && now - timestamp(health.observedAt) <= 15 * 60_000 &&
    timestamp(currentMachines.observedAt) <= now && now - timestamp(currentMachines.observedAt) <= 15 * 60_000,
  "stale_pair_observation");
  validateMachines(currentMachines.data);
  return {
    input,
    manifestSha256: sha256(health.releaseManifest),
    currentMachines: machineProjection(currentMachines.data),
  };
}
function validateMachines(machines) {
  requireThat(Array.isArray(machines) && machines.length > 0 && machines.length <= 4 &&
    new Set(machines.map((machine) => machine.id)).size === machines.length && machines.every((machine) =>
      /^[a-f0-9]{14}$/.test(machine.id) && machine.state === "started" && machine.region === "iad" &&
      machine.image_ref?.registry === "registry.fly.io" && machine.image_ref.repository === APP &&
      DIGEST.test(machine.image_ref.digest)), "invalid_machine_observation");
}
function machineProjection(machines) {
  return machines.map(({ id, state, region, image_ref }) => ({ id, state, region,
    image: `${image_ref.registry}/${image_ref.repository}@${image_ref.digest}` })).sort((a, b) => a.id.localeCompare(b.id));
}
export function assertMachineBinding(raw, expected, restoredImage) {
  const machines = raw?.Machines;
  validateMachines(machines);
  const projection = machineProjection(machines);
  requireThat(restoredImage ? projection.every((machine) => machine.image === restoredImage) :
    JSON.stringify(projection) === JSON.stringify(expected), "live_machine_binding_changed");
  return projection;
}
export function assertNoReleaseProcesses(processes, ownPid = process.pid, uid = process.getuid?.()) {
  for (const line of processes.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || Number(match[1]) === ownPid || Number(match[2]) !== uid) continue;
    requireThat(!/(?:^|\s)(?:\S*\/)?(?:deploy-production|rollback-production)\.mjs(?:\s|$)|(?:^|\s)npm\s+(?:run\s+)?deploy:production(?:\s|$)|(?:^|\s)(?:\S*\/)?fly(?:ctl)?\s+deploy(?:\s|$)|(?:^|\s)(?:\S*\/)?release-broker-verified-login\.py(?:\s|$)/.test(match[3]), "active_release_process");
  }
}

/** Only this single deploy command can mutate hosting. No promotion or secret command exists here. */
export function recoverySteps(validated) {
  const { input, manifestSha256 } = validated;
  const node = process.execPath;
  const readiness = (label) => ({ label, command: node, args: ["scripts/deploy-production.mjs", "--readiness-probe", WEB, input.previousRevision] });
  const manifest = (label) => ({ label, command: node, args: ["scripts/smoke-release-manifest.mjs"], environment: {
    BASE_URL: WEB, SMOKE_EXPECTED_REVISION: input.previousRevision, SMOKE_EXPECTED_MANIFEST_SHA256: manifestSha256,
    ...(label === "after-manifest" ? { SMOKE_MANIFEST_PREVIOUS_REVISION: input.currentWorkerRevision, SMOKE_MANIFEST_CONVERGENCE_TIMEOUT_MS: "120000" } : {}),
  } });
  const gateway = (label, revision) => ({ label, command: node, args: ["scripts/deploy-production.mjs", "--gateway-readiness-probe", GATEWAY, revision], gateway: true });
  return [readiness("before-web"), manifest("before-manifest"), gateway("before-gateway", input.currentWorkerRevision),
    { label: "restore-worker", command: "fly", args: ["deploy", "--app", APP, "--strategy", "bluegreen", "--image", input.priorImage,
      "--env", `OMNIAGENT_WORKER_BASE_URL=${WEB}`, "--env", `OMNIAGENT_WORKER_CANONICAL_BASE_URL=${WEB}`,
      "--env", "OMNIAGENT_WORKER_RELEASE_HOLD=false", "--yes"], mutation: true },
    readiness("after-web"), manifest("after-manifest"), gateway("after-gateway", input.previousRevision),
    { label: "after-preflight", command: node, args: ["scripts/smoke-preflight.mjs"], preflight: true,
      environment: { BASE_URL: WEB, SMOKE_EXPECTED_REVISION: input.previousRevision, SMOKE_REQUEST_TIMEOUT_MS: "300000" } },
  ];
}
export function validateRecoveryAuthentication(source) {
  // Match the maintained gateway token contract; preflight requires only the internal secret.
  requireThat(/^[A-Za-z0-9._~-]{32,256}$/.test(String(source.OMNIAGENT_OPENAI_GATEWAY_TOKEN || "").trim()), "invalid_gateway_authentication");
  const internal = source.SMOKE_INTERNAL_AUTH_SECRET || source.OMNIAGENT_INTERNAL_AUTH_SECRET;
  requireThat(typeof internal === "string" && internal.trim().length > 0 && internal.length <= 4096 && !/[\r\n]/.test(internal), "missing_recovery_authentication");
  const cron = source.SMOKE_CRON_SECRET || source.CRON_SECRET;
  // Absent/empty cron uses smoke-preflight's internally authenticated configuration gate.
  if (cron) requireThat(typeof cron === "string" && cron.trim().length > 0 && cron.length <= 4096 && !/[\r\n]/.test(cron), "invalid_optional_cron_authentication");
}

export function recoveryEnvironment(source, step, evidencePath) {
  // Never pass deployment feature flags, signing keys, provider keys, passwords, or override grants.
  const environment = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) if (source[key]) environment[key] = source[key];
  if (step.command === "fly" && source.FLY_API_TOKEN) environment.FLY_API_TOKEN = source.FLY_API_TOKEN;
  if (step.gateway) environment.OMNIAGENT_OPENAI_GATEWAY_TOKEN = source.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
  if (step.preflight) {
    environment.SMOKE_INTERNAL_AUTH_SECRET = source.SMOKE_INTERNAL_AUTH_SECRET || source.OMNIAGENT_INTERNAL_AUTH_SECRET;
    const cron = source.SMOKE_CRON_SECRET || source.CRON_SECRET;
    if (cron) environment.SMOKE_CRON_SECRET = cron;
    environment.RELEASE_EVIDENCE_OUTPUT = evidencePath;
  }
  return { ...environment, ...step.environment };
}
export async function executeRecovery(validated, { run, observeMachines, record, assertExclusive }) {
  const steps = recoverySteps(validated);
  record({ event: "started", previousRevision: validated.input.previousRevision, currentWorkerRevision: validated.input.currentWorkerRevision,
    priorImage: validated.input.priorImage, operationId: validated.input.operationId });
  record({ event: "before-machines", machines: assertMachineBinding(await observeMachines(), validated.currentMachines) });
  for (const step of steps) {
    if (step.mutation) {
      assertExclusive();
      record({ event: "mutation-intent", image: validated.input.priorImage });
    }
    record({ event: "step-started", step: step.label });
    await run(step);
    record({ event: "step-passed", step: step.label });
  }
  record({ event: "after-machines", machines: assertMachineBinding(await observeMachines(), [], validated.input.priorImage) });
  record({ event: "restored", revision: validated.input.previousRevision });
}

function processInventory() {
  return execFileSync("/bin/ps", ["-axo", "pid=,uid=,command="], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
}
function privateJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
function commandRunner(directory, environment, signal) {
  return (step) => new Promise((resolve, reject) => {
    const fd = openSync(path.join(directory, `${step.label}.log`), "wx", 0o600);
    // Direct file descriptors survive a broken caller stdout pipe; no text decoder or forwarding loop.
    const child = spawn(step.command, step.args, { cwd: ROOT, env: recoveryEnvironment(environment, step, path.join(directory, "preflight-evidence.json")),
      stdio: ["ignore", fd, fd] });
    closeSync(fd);
    let cancelled = false;
    let killTimer;
    const stop = () => { cancelled = true; child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 5000); };
    const timer = setTimeout(stop, step.mutation ? 15 * 60_000 : 6 * 60_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.once("error", () => { clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener("abort", stop); reject(new Error("child_start_failed")); });
    child.once("close", (code) => { clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener("abort", stop);
      if (code === 0 && !cancelled) resolve(); else reject(new Error(cancelled ? "child_interrupted_reconcile" : "child_failed_reconcile")); });
  });
}
export async function main(args = process.argv.slice(2)) {
  requireThat(args.length === 5 && args[0] === "--input" && args[2] === "--input-sha256" &&
    ["--dry-run", "--execute"].includes(args[4]), "usage: --input FILE --input-sha256 SHA256 --dry-run|--execute");
  const file = path.resolve(args[1]);
  const digest = args[3];
  const input = readPinnedPrivateJson(file, digest);
  const proofs = Object.fromEntries(Object.entries(input.proofs || {}).map(([key, ref]) => [key, readPinnedPrivateJson(ref.path, ref.sha256)]));
  const validated = validateRecoveryInput(input, proofs);
  requireThat(execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() === input.checkoutRevision, "checkout_revision_changed");
  const lockRoot = path.join(homedir(), ".asael");
  requireThat(!existsSync(path.join(lockRoot, "production-release.lock")), "paired_release_lock_present");
  assertNoReleaseProcesses(processInventory());
  if (args[4] === "--dry-run") {
    console.log(JSON.stringify({ status: "dry-run", inputSha256: digest, operationId: input.operationId,
      plan: recoverySteps(validated).map(({ label, command, args: argv, mutation }) => ({ label, command, args: argv, mutation: !!mutation })),
      liveChecksPerformed: false, credentialAccess: false }));
    return;
  }
  validateRecoveryAuthentication(process.env);
  const releaseLock = acquirePairedReleaseLock(lockRoot);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let directory;
  let eventIndex = 0;
  let record;
  let mutationStarted = false;
  let restored = false;
  try {
    const uses = path.join(lockRoot, "rollback-production");
    if (!existsSync(uses)) mkdirSync(uses, { mode: 0o700 });
    privateDirectory(uses);
    // Exclusive durable marker remains after every outcome, including failed or interrupted commands.
    privateJson(path.join(uses, `${digest}.json`), { inputSha256: digest, operationId: input.operationId, startedAt: new Date().toISOString(), pid: process.pid });
    directory = `${file}.attempt`;
    mkdirSync(directory, { mode: 0o700 });
    record = (event) => {
      if (event.event === "mutation-intent") mutationStarted = true;
      privateJson(path.join(directory, `${String(++eventIndex).padStart(2, "0")}-${event.event}.json`),
        { ...event, at: new Date().toISOString(), inputSha256: digest });
    };
    const run = commandRunner(directory, { ...process.env }, abort.signal);
    const observeMachines = async () => {
      // Full provider response is kept only in bounded memory; save the closed projection in receipts.
      const raw = execFileSync("fly", ["status", "--app", APP, "--json"], {
        cwd: ROOT, env: recoveryEnvironment(process.env, { command: "fly" }), encoding: "utf8", maxBuffer: 1_048_576,
        timeout: 30_000, stdio: ["ignore", "pipe", "ignore"],
      });
      return JSON.parse(raw);
    };
    await executeRecovery(validated, { run, observeMachines, record, assertExclusive: () => {
      requireThat(!abort.signal.aborted && Date.now() < timestamp(input.expiresAt), "recovery_authorization_expired");
      assertNoReleaseProcesses(processInventory());
    } });
    privateJson(path.join(directory, "result.json"), { status: "restored", previousRevision: input.previousRevision,
      inputSha256: digest, completedAt: new Date().toISOString(), hostingMutations: ["restore_prior_worker_only"] });
    restored = true;
  } catch (error) {
    if (record) {
      record({ event: "reconciliation-required", category: ["child_start_failed", "child_interrupted_reconcile", "child_failed_reconcile",
        "live_machine_binding_changed", "active_release_process", "recovery_authorization_expired"].includes(error?.message) ? error.message : "recovery_failed" });
      privateJson(path.join(directory, "result.json"), { status: "reconciliation_required", inputSha256: digest,
        completedAt: new Date().toISOString(), automaticRetry: false });
    }
    throw new Error("recovery_incomplete_inspect_private_receipts_no_retry");
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    // An ambiguous Fly outcome keeps the shared lock for explicit reconciliation.
    if (!mutationStarted || restored) releaseLock();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // A closed caller output pipe must not terminate an in-progress recovery.
  process.stdout.on("error", () => {}); process.stderr.on("error", () => {});
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
