import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  getStudioGenerationContract, parseStudioReadbackRecovery, STUDIO_GENERATION_CONTRACT_PATHS,
  studioProbePhaseEnvironment, verifyStudioReadbackRecovery,
} from "./studio-readback-recovery.mjs";

const exec = promisify(execFile);

test("Both deployment phases map to readback, while ordinary exercises retain their behavior", () => {
  assert.deepEqual(studioProbePhaseEnvironment({}, "exercise"), { SMOKE_STUDIO_FLOW_MODE: "readback", SMOKE_STUDIO_READBACK_STAGE: "staged" });
  assert.deepEqual(studioProbePhaseEnvironment({}, "readback"), { SMOKE_STUDIO_FLOW_MODE: "readback", SMOKE_STUDIO_READBACK_STAGE: "canonical" });
  assert.deepEqual(studioProbePhaseEnvironment(undefined, "exercise"), { SMOKE_STUDIO_FLOW_MODE: "exercise" });
  assert.deepEqual(studioProbePhaseEnvironment(undefined, "readback"), { SMOKE_STUDIO_FLOW_MODE: "readback" });
});

test("Recovery pins reject unknown fields and different candidate revisions", () => {
  const pin = { version: 1, candidateRevision: "a".repeat(40), sourceRevision: "b".repeat(40),
    sourceEvidenceFile: "/tmp/source.json", sourceEvidenceSha256: "c".repeat(64), generationContractSha256: "d".repeat(64) };
  assert.deepEqual(parseStudioReadbackRecovery(JSON.stringify(pin), pin.candidateRevision), pin);
  assert.throws(() => parseStudioReadbackRecovery(JSON.stringify({ ...pin, retry: true }), pin.candidateRevision), /fields/);
  assert.throws(() => parseStudioReadbackRecovery(JSON.stringify(pin), "e".repeat(40)), /revision mismatch/);
});

test("Exact generation manifest permits verifier-only repair and rejects committed or dirty application changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "studio-generation-contract-"));
  const cwd = path.join(dir, "repo");
  await mkdir(cwd);
  const git = async (...args) => (await exec("git", args, { cwd })).stdout.trim();
  const put = async (name, content) => { await mkdir(path.dirname(path.join(cwd, name)), { recursive: true }); await writeFile(path.join(cwd, name), content); };
  try {
    await git("init", "-q");
    await git("config", "user.name", "Studio fixture");
    await git("config", "user.email", "studio@example.test");
    for (const root of STUDIO_GENERATION_CONTRACT_PATHS) await put(root.endsWith("/") ? `${root}fixture.ts` : root, "original\n");
    await git("add", "."); await git("commit", "-qm", "generation source");
    const original = await git("rev-parse", "HEAD");
    const manifest = await getStudioGenerationContract(original, { cwd });
    const sourceFile = path.join(dir, "source.json");
    await writeFile(sourceFile, JSON.stringify({ scenario: "studio_flow_v1", revision: original, mode: "live",
      status: "failed", exerciseStatus: "passed", lastStatus: "succeeded", verifiedGenerationAttempts: 2,
      assets: [{ id: "image" }, { id: "video" }], flowId: "flow", runId: "run", flowRevision: 1,
      graphSha256: "1".repeat(64), ownerHash: "2".repeat(64), maxCostUsd: 3.5, maxGenerations: 2 }));
    await put("scripts/smoke-studio-flow.mjs", "repaired verifier\n");
    await put("src/lib/release/deploy-production-script.test.ts", "new focused regression\n");
    await git("add", "."); await git("commit", "-qm", "verifier repair");
    const pin = { version: 1, candidateRevision: await git("rev-parse", "HEAD"), sourceRevision: original,
      sourceEvidenceFile: sourceFile, sourceEvidenceSha256: createHash("sha256").update(await readFile(sourceFile)).digest("hex"),
      generationContractSha256: manifest.sha256 };
    const options = { mode: "live", outputFile: path.join(dir, "recovered.json"), cwd };
    assert.equal((await verifyStudioReadbackRecovery(pin, options)).linkage.generationContract.sha256, manifest.sha256);
    await put("scripts/unlisted-build-hook.mjs", "changed build semantics\n");
    await git("add", "."); await git("commit", "-qm", "unrelated build hook");
    await assert.rejects(verifyStudioReadbackRecovery({ ...pin, candidateRevision: await git("rev-parse", "HEAD") }, options), /outside the exact verifier repair/);
    await rm(path.join(cwd, "scripts/unlisted-build-hook.mjs"));
    await git("add", "."); await git("commit", "-qm", "restore original build semantics");
    pin.candidateRevision = await git("rev-parse", "HEAD");
    await put("src/fixture.ts", "changed provider contract\n");
    await assert.rejects(verifyStudioReadbackRecovery(pin, options), /uncommitted application/);
    await git("add", "."); await git("commit", "-qm", "changed generation semantics");
    await assert.rejects(verifyStudioReadbackRecovery({ ...pin, candidateRevision: await git("rev-parse", "HEAD") }, options), /generation contract changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
