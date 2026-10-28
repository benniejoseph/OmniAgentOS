import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { signReleaseManifest } from "./release-manifest.mjs";
import { REQUIRED_RELEASE_CHECKS } from "./release-provenance.mjs";
import { assertMachineBinding, assertNoReleaseProcesses, executeRecovery, readPinnedPrivateJson,
  recoveryEnvironment, recoverySteps, validateRecoveryAuthentication, validateRecoveryInput } from "./rollback-production.mjs";
const previous = "b".repeat(40), candidate = "c".repeat(40), imageDigest = `sha256:${"d".repeat(64)}`;
const now = Date.parse("2026-10-28T08:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const options = { publicKeys: [publicKey.export({ type: "spki", format: "der" }).toString("base64")] };
const signed = signReleaseManifest({ version: 1, revision: previous, repository: "benniejoseph/OmniAgentOS",
  branch: "main", checks: [...REQUIRED_RELEASE_CHECKS], signedAt: new Date(now - 60_000).toISOString() }, { privateKey });
function fixture() {
  return { input: { version: 1, action: "restore_prior_worker_only", operationId: "12345678-1234-4234-8234-123456789012",
    createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    checkoutRevision: candidate, previousRevision: previous, currentWorkerRevision: candidate,
    priorImage: `registry.fly.io/omniagent-os-worker@${imageDigest}`,
    proofs: Object.fromEntries(["imageManifest", "imageConfig", "priorWeb", "currentMachines"].map((key) => [key, { path: `/private/${key}.json`, sha256: "a".repeat(64) }])) },
  proofs: {
    imageManifest: { status: 200, mutations: false, digest: imageDigest, computedDigest: imageDigest,
      mediaType: "application/vnd.oci.image.manifest.v1+json", manifests: null,
      config: { digest: `sha256:${"e".repeat(64)}`, mediaType: "application/vnd.oci.image.config.v1+json" } },
    imageConfig: { status: 200, mutations: false, environmentValuesPersisted: false, imageDigest,
      configDigest: `sha256:${"e".repeat(64)}`, os: "linux", architecture: "amd64", releaseRevision: previous },
    priorWeb: { status: "healthy", revision: previous, releaseManifest: signed, observedAt: new Date(now).toISOString() },
    currentMachines: { observedAt: new Date(now).toISOString(), data: [{ id: "1234567890abcd", state: "started", region: "iad",
      image_ref: { registry: "registry.fly.io", repository: "omniagent-os-worker", digest: `sha256:${"f".repeat(64)}` } }] },
  } };
}
function validated() { const { input, proofs } = fixture(); return validateRecoveryInput(input, proofs, now, options); }
test("signed scoped proof produces one immutable worker-only mutation with maintained checks", () => {
  const plan = recoverySteps(validated());
  assert.deepEqual(plan.filter((step) => step.mutation).map((step) => step.label), ["restore-worker"]);
  assert.deepEqual(plan[3].args, ["deploy", "--app", "omniagent-os-worker", "--strategy", "bluegreen", "--image",
    `registry.fly.io/omniagent-os-worker@${imageDigest}`, "--env", "OMNIAGENT_WORKER_BASE_URL=https://asael.bennierichard.com",
    "--env", "OMNIAGENT_WORKER_CANONICAL_BASE_URL=https://asael.bennierichard.com", "--env", "OMNIAGENT_WORKER_RELEASE_HOLD=false", "--yes"]);
  assert.equal(plan.some((step) => /vercel|secret|paid|feature|self-improvement/.test(JSON.stringify(step))), false);
  assert.equal(plan[1].environment.SMOKE_MANIFEST_CONVERGENCE_TIMEOUT_MS, undefined);
  assert.equal(plan[5].environment.SMOKE_MANIFEST_CONVERGENCE_TIMEOUT_MS, "120000");
});
for (const [label, change, error] of [
  ["mutable tag", ({ input }) => { input.priorImage = "registry.fly.io/omniagent-os-worker:deployment-old"; }, /prior_image_binding/],
  ["wrong image revision", ({ proofs }) => { proofs.imageConfig.releaseRevision = candidate; }, /prior_image_binding/],
  ["different config blob", ({ proofs }) => { proofs.imageConfig.configDigest = `sha256:${"f".repeat(64)}`; }, /prior_image_binding/],
  ["unverified digest", ({ proofs }) => { proofs.imageManifest.computedDigest = `sha256:${"f".repeat(64)}`; }, /registry_manifest/],
  ["expired authorization", ({ input }) => { input.expiresAt = new Date(now).toISOString(); }, /authorization_expired/],
  ["future authorization", ({ input }) => { input.createdAt = new Date(now + 1).toISOString(); }, /authorization_expired/],
  ["overlong authorization", ({ input }) => { input.expiresAt = new Date(now + 4 * 3600_000).toISOString(); }, /authorization_expired/],
  ["stale web observation", ({ proofs }) => { proofs.priorWeb.observedAt = new Date(now - 900_001).toISOString(); }, /stale_pair/],
  ["future machine observation", ({ proofs }) => { proofs.currentMachines.observedAt = new Date(now + 1).toISOString(); }, /stale_pair/],
  ["unsigned health", ({ proofs }) => { proofs.priorWeb.releaseManifest = "invalid"; }, /release manifest/],
  ["unscoped field", ({ input }) => { input.rotateSecrets = true; }, /invalid_recovery_input/],
]) test(`refuses ${label}`, () => {
  const value = fixture(); change(value);
  assert.throws(() => validateRecoveryInput(value.input, value.proofs, now, options), error);
});
test("machine readback binds the exact failed set, then the restored image", () => {
  const { proofs } = fixture(), value = validated();
  assert.equal(assertMachineBinding({ Machines: proofs.currentMachines.data }, value.currentMachines).length, 1);
  assert.throws(() => assertMachineBinding({ Machines: [] }, value.currentMachines), /machine_observation/);
  const moved = structuredClone(proofs.currentMachines.data); moved[0].id = "ffffffffffffff";
  assert.throws(() => assertMachineBinding({ Machines: moved }, value.currentMachines), /binding_changed/);
  assert.throws(() => assertMachineBinding({ Machines: moved }, [], value.input.priorImage), /binding_changed/);
  moved[0].image_ref.digest = imageDigest;
  assert.equal(assertMachineBinding({ Machines: moved }, [], value.input.priorImage).length, 1);
});
test("active deploy, rollback, Fly deploy or broker refuses; own process is excluded", () => {
  for (const command of ["node scripts/deploy-production.mjs", "node /repo/scripts/rollback-production.mjs --execute", "npm run deploy:production", "fly deploy --app omniagent-os-worker", "python /private/release-broker-verified-login.py"])
    assert.throws(() => assertNoReleaseProcesses(`100 501 ${command}`, 101, 501), /active_release_process/);
  assertNoReleaseProcesses("101 501 node scripts/rollback-production.mjs\n102 502 node scripts/deploy-production.mjs\n103 501 node harmless.mjs", 101, 501);
});
test("only active gateway token or preflight credentials reach their own child", () => {
  const env = { PATH: "/safe", HOME: "/private", OPENAI_API_KEY: "never", SMOKE_PAID_AGENT_PASSWORD: "never", OMNIAGENT_RELEASE_FEATURE_PROBE: "never",
    OMNIAGENT_OPENAI_GATEWAY_TOKEN: "active", OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN: "never", SMOKE_INTERNAL_AUTH_SECRET: "internal", CRON_SECRET: "cron", FLY_API_TOKEN: "fly" };
  const plan = recoverySteps(validated());
  assert.deepEqual(recoveryEnvironment(env, plan[2]), { PATH: "/safe", HOME: "/private", OMNIAGENT_OPENAI_GATEWAY_TOKEN: "active" });
  assert.deepEqual(recoveryEnvironment(env, plan[3]), { PATH: "/safe", HOME: "/private", FLY_API_TOKEN: "fly" });
  const preflight = recoveryEnvironment(env, plan[7], "/private/evidence.json");
  assert.equal(preflight.SMOKE_INTERNAL_AUTH_SECRET, "internal"); assert.equal(preflight.SMOKE_CRON_SECRET, "cron");
  assert.equal(Object.values(preflight).includes("never"), false); assert.equal(preflight.FLY_API_TOKEN, undefined);
});
test("private pinned input refuses drift, symlinks, permissions and oversize", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rollback-input-")));
  const file = path.join(directory, "input.json"), data = Buffer.from('{"proof":true}\n');
  const digest = createHash("sha256").update(data).digest("hex");
  try {
    writeFileSync(file, data, { mode: 0o600 }); assert.deepEqual(readPinnedPrivateJson(file, digest), { proof: true });
    assert.throws(() => readPinnedPrivateJson(file, "a".repeat(64)), /hash_mismatch/);
    symlinkSync(file, path.join(directory, "link.json")); assert.throws(() => readPinnedPrivateJson(path.join(directory, "link.json"), digest));
    chmodSync(file, 0o644); assert.throws(() => readPinnedPrivateJson(file, digest), /unsafe_evidence/);
    chmodSync(file, 0o600); writeFileSync(file, "x".repeat(100_000)); assert.throws(() => readPinnedPrivateJson(file, digest), /unsafe_evidence/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
function dependencies({ failStep, changedBefore = false } = {}) {
  const { proofs } = fixture(); const calls = [], events = []; let observations = 0;
  return { calls, events,
    run: async (step) => { calls.push(step.label); if (step.label === failStep) throw new Error("synthetic_failure"); },
    observeMachines: async () => { const machines = structuredClone(proofs.currentMachines.data);
      if (observations++ > 0) machines[0].image_ref.digest = imageDigest;
      if (changedBefore && observations === 1) machines[0].id = "ffffffffffffff";
      return { Machines: machines }; },
    record: (event) => events.push(event), assertExclusive: () => calls.push("exclusive-before-mutation"),
  };
}
test("restoration preserves before/after order and records one mutation", async () => {
  const deps = dependencies(); await executeRecovery(validated(), deps);
  assert.deepEqual(deps.calls, ["before-web", "before-manifest", "before-gateway", "exclusive-before-mutation", "restore-worker", "after-web", "after-manifest", "after-gateway", "after-preflight"]);
  assert.equal(deps.events.filter((event) => event.event === "mutation-intent").length, 1);
  assert.equal(deps.events.at(-1).event, "restored");
});
for (const failStep of ["before-web", "before-manifest", "before-gateway", "restore-worker", "after-gateway", "after-preflight"])
  test(`failure at ${failStep} stops without retry or false success`, async () => {
    const deps = dependencies({ failStep }); await assert.rejects(executeRecovery(validated(), deps), /synthetic_failure/);
    assert.equal(deps.calls.at(-1), failStep);
    assert.equal(deps.calls.filter((step) => step === "restore-worker").length, failStep.startsWith("before-") ? 0 : 1);
    assert.equal(deps.events.some((event) => event.event === "restored"), false);
  });
test("live machine drift refuses before probes or mutation", async () => {
  const deps = dependencies({ changedBefore: true }); await assert.rejects(executeRecovery(validated(), deps), /binding_changed/); assert.deepEqual(deps.calls, []);
});
test("dry run has no credential/claim/hosting action; ambiguous mutation retains lock and direct-file logs", () => {
  const source = readFileSync(new URL("./rollback-production.mjs", import.meta.url), "utf8");
  assert.ok(source.indexOf('if (args[4] === "--dry-run")') < source.indexOf('validateRecoveryAuthentication(process.env)'));
  assert.match(source, /if \(!mutationStarted \|\| restored\) releaseLock\(\);/);
  assert.match(source, /stdio: \["ignore", fd, fd\]/);
  assert.match(source, /privateJson\(path\.join\(uses, `\$\{digest\}\.json`\)/);
});

test("credential admission permits absent or empty cron and keeps authenticated configuration fallback", () => {
  const env = { OMNIAGENT_OPENAI_GATEWAY_TOKEN: "a".repeat(64), SMOKE_INTERNAL_AUTH_SECRET: "s" };
  const step = recoverySteps(validated()).at(-1);
  for (const absentCron of [{}, { CRON_SECRET: "" }, { SMOKE_CRON_SECRET: "", CRON_SECRET: "" }]) {
    const configured = { ...env, ...absentCron };
    assert.doesNotThrow(() => validateRecoveryAuthentication(configured));
    const child = recoveryEnvironment(configured, step, "/private/evidence.json");
    assert.equal(child.SMOKE_INTERNAL_AUTH_SECRET, "s");
    assert.equal(Object.hasOwn(child, "SMOKE_CRON_SECRET"), false);
    assert.equal(step.args[0], "scripts/smoke-preflight.mjs");
  }
});
test("credential admission permits short configured internal and optional cron secrets", () => {
  const env = { OMNIAGENT_OPENAI_GATEWAY_TOKEN: "a".repeat(32), OMNIAGENT_INTERNAL_AUTH_SECRET: "i", CRON_SECRET: "c" };
  assert.doesNotThrow(() => validateRecoveryAuthentication(env));
  assert.equal(recoveryEnvironment(env, recoverySteps(validated()).at(-1)).SMOKE_CRON_SECRET, "c");
});
test("credential admission still refuses invalid active gateway, absent internal and malformed optional cron", () => {
  const env = { OMNIAGENT_OPENAI_GATEWAY_TOKEN: "a".repeat(64), SMOKE_INTERNAL_AUTH_SECRET: "i" };
  assert.throws(() => validateRecoveryAuthentication({ ...env, OMNIAGENT_OPENAI_GATEWAY_TOKEN: "short" }), /gateway_authentication/);
  assert.throws(() => validateRecoveryAuthentication({ ...env, SMOKE_INTERNAL_AUTH_SECRET: "" }), /missing_recovery/);
  assert.throws(() => validateRecoveryAuthentication({ ...env, SMOKE_INTERNAL_AUTH_SECRET: "i\n" }), /missing_recovery/);
  for (const value of ["c\r\n", " ", "x".repeat(4097)])
    assert.throws(() => validateRecoveryAuthentication({ ...env, CRON_SECRET: value }), /optional_cron/);
});
