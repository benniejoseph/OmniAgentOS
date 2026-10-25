import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const STUDIO_READBACK_ENV = "OMNIAGENT_RELEASE_STUDIO_READBACK";
// Bind the entire application and its dependencies, not only the provider adapter.
// Verifier scripts, documentation and test-only changes can repair a false negative.
export const STUDIO_GENERATION_CONTRACT_PATHS = Object.freeze([
  "src/",
  "supabase/migrations/",
  "schema-migrations.json",
  "public/studio-demo/",
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "tsconfig.json",
  "scripts/worker.mjs",
  "scripts/internal-identity-token.mjs",
  "scripts/openai-egress-gateway.mjs",
  "scripts/worker-release-activation.mjs",
  "Dockerfile.worker",
  "fly.toml",
  "vercel.json",
]);
export const STUDIO_READBACK_REPAIR_PATHS = Object.freeze([
  "scripts/studio-readback-recovery.mjs",
  "scripts/studio-readback-recovery.test.mjs",
  "scripts/smoke-studio-flow.mjs",
  "scripts/smoke-studio-flow.test.mjs",
  "scripts/deploy-production.mjs",
  "src/lib/release/deploy-production-script.test.ts",
  "docs/studio-providers.md",
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isTest = (name) => /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(name) || name.includes("/__tests__/");
const keys = ["version", "candidateRevision", "sourceRevision", "sourceEvidenceFile", "sourceEvidenceSha256", "generationContractSha256"];

export function parseStudioReadbackRecovery(raw, candidateRevision) {
  if (!raw?.trim()) return undefined;
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("Studio readback recovery must be one JSON object"); }
  requireValue(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
  "Studio readback recovery fields do not match its versioned contract");
  requireValue(value.version === 1 && /^[a-f0-9]{40}$/.test(value.candidateRevision) &&
    /^[a-f0-9]{40}$/.test(value.sourceRevision) && value.candidateRevision === candidateRevision,
  "Studio readback recovery revision mismatch");
  requireValue(typeof value.sourceEvidenceFile === "string" && path.isAbsolute(value.sourceEvidenceFile) &&
    /^[a-f0-9]{64}$/.test(value.sourceEvidenceSha256) && /^[a-f0-9]{64}$/.test(value.generationContractSha256),
  "Studio readback recovery requires an absolute source receipt and exact SHA-256 pins");
  return value;
}

export async function getStudioGenerationContract(revision, { cwd = process.cwd() } = {}) {
  requireValue(/^[a-f0-9]{40}$/.test(revision), "Studio generation contract requires a full commit revision");
  const { stdout } = await exec("git", ["ls-tree", "-rz", "--full-tree", revision, "--", ...STUDIO_GENERATION_CONTRACT_PATHS], {
    cwd, maxBuffer: 8 * 1024 * 1024, timeout: 10_000,
  });
  const entries = stdout.split("\0").filter(Boolean).filter((entry) => !isTest(entry.split("\t")[1])).sort();
  const names = entries.map((entry) => entry.split("\t")[1]);
  requireValue(STUDIO_GENERATION_CONTRACT_PATHS.every((root) => names.some((name) => root.endsWith("/") ? name.startsWith(root) : name === root)),
    "Studio generation contract is missing an application path");
  return { paths: STUDIO_GENERATION_CONTRACT_PATHS, entryCount: entries.length,
    sha256: sha256(JSON.stringify({ paths: STUDIO_GENERATION_CONTRACT_PATHS, entries })) };
}

export async function verifyStudioReadbackRecovery(pin, { mode, outputFile, cwd = process.cwd() }) {
  requireValue(path.isAbsolute(outputFile), "Studio recovery output must be an absolute new receipt path");
  const sourcePath = await realpath(pin.sourceEvidenceFile);
  const outputPath = await realpath(outputFile).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return path.resolve(outputFile);
  });
  requireValue(sourcePath !== outputPath, "Studio recovery must preserve the original receipt in a different file");
  const sourceBytes = await readFile(sourcePath);
  requireValue(sourceBytes.length <= 2_000_000 && sha256(sourceBytes) === pin.sourceEvidenceSha256,
    "Studio recovery source receipt hash mismatch");
  const source = JSON.parse(sourceBytes.toString("utf8"));
  requireValue(source.scenario === "studio_flow_v1" && source.revision === pin.sourceRevision && source.mode === mode &&
    source.exerciseStatus === "passed" && source.lastStatus === "succeeded" && source.verifiedGenerationAttempts === 2 &&
    source.assets?.length === 2 && typeof source.flowId === "string" && typeof source.runId === "string" &&
    Number.isSafeInteger(source.flowRevision) && source.flowRevision > 0 && /^[a-f0-9]{64}$/.test(source.graphSha256) &&
    /^[a-f0-9]{64}$/.test(source.ownerHash) && source.maxCostUsd === 3.5 && source.maxGenerations === 2 && !source.recovery,
  "Studio recovery requires the exact completed original exercise and its two asset receipts");
  const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 });
  requireValue(head.trim() === pin.candidateRevision, "Studio recovery candidate must be the current checkout revision");
  const [original, candidate] = await Promise.all([
    getStudioGenerationContract(pin.sourceRevision, { cwd }), getStudioGenerationContract(pin.candidateRevision, { cwd }),
  ]);
  requireValue(original.sha256 === pin.generationContractSha256 && candidate.sha256 === original.sha256,
    "Studio generation contract changed; existing generation cannot verify this candidate");
  const { stdout: repairedPaths } = await exec("git", ["diff", "--name-only", "-z", pin.sourceRevision, pin.candidateRevision], {
    cwd, maxBuffer: 8 * 1024 * 1024, timeout: 10_000,
  });
  requireValue(repairedPaths.split("\0").filter(Boolean).every((name) => STUDIO_READBACK_REPAIR_PATHS.includes(name)),
    "Studio recovery candidate changes files outside the exact verifier repair");
  const { stdout: changes } = await exec("git", ["status", "--porcelain", "--untracked-files=all", "--", ...STUDIO_GENERATION_CONTRACT_PATHS], {
    cwd, maxBuffer: 8 * 1024 * 1024, timeout: 10_000,
  });
  requireValue(changes.split("\n").filter(Boolean).every((line) => isTest(line.slice(3))),
    "Studio generation contract has uncommitted application changes");
  return { source, linkage: { version: 1, sourceRevision: pin.sourceRevision,
    sourceEvidenceFile: sourcePath, sourceEvidenceSha256: pin.sourceEvidenceSha256,
    sourceStatus: source.status, sourceFailure: source.failure ?? null, generationContract: candidate } };
}

export function studioProbePhaseEnvironment(recovery, phase) {
  requireValue(["exercise", "readback"].includes(phase), "Unknown Studio release phase");
  return recovery ? { SMOKE_STUDIO_FLOW_MODE: "readback", SMOKE_STUDIO_READBACK_STAGE: phase === "exercise" ? "staged" : "canonical" } :
    { SMOKE_STUDIO_FLOW_MODE: phase };
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
