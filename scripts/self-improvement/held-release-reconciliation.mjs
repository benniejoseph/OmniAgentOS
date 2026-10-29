/** Explicit owner settlement of one held, never-dispatched web publication. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { readImprovementReceipt, writeImprovementReceipt } from "./probe-receipt.mjs";

export const HELD_RELEASE_RECONCILIATION_ENV = "OMNIAGENT_HELD_RELEASE_RECONCILIATION";
const production = "https://asael.bennierichard.com";
const staged = /^https:\/\/omniagent-[a-z0-9]+-benniejosephs-projects\.vercel\.app$/;
const digest = /^[a-f0-9]{64}$/, revision = /^[a-f0-9]{40}$/;
const hash = raw => createHash("sha256").update(raw).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const requireValue = (condition, code) => { if (!condition) throw new Error(`held_release_${code}`); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join(",") === keys.sort().join(",");
const absolutePath = value => typeof value === "string" && value.length < 4096 &&
  path.isAbsolute(value) && path.normalize(value) === value && !/[\u0000-\u001f\u007f]/.test(value);

export function parseHeldReleaseReconciliation(raw, candidateRevision, ownerLiveAuthorization) {
  if (raw === undefined || raw === "") return null;
  requireValue(typeof raw === "string" && Buffer.byteLength(raw) <= 12000, "configuration_bound");
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("held_release_invalid_json"); }
  requireValue(exactKeys(value, ["version", "previousRevision", "candidateRevision", "cycleId", "expectedRevision", "controllerId",
    "releaseBindingSha256", "controllerHoldSha256", "diagnostic", "attemptEvidence", "evidenceFile"]), "configuration_shape");
  requireValue(value.version === 1 && revision.test(value.previousRevision) && revision.test(candidateRevision) &&
    value.candidateRevision === candidateRevision && ownerLiveAuthorization?.previousRevision === value.previousRevision &&
    ownerLiveAuthorization?.candidateRevision === candidateRevision, "release_pair");
  requireValue(/^self_cycle_[a-f0-9]{64}$/.test(value.cycleId) && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision > 0 &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value.controllerId) && digest.test(value.releaseBindingSha256) &&
    digest.test(value.controllerHoldSha256), "cycle_binding");
  for (const reference of [value.diagnostic, value.attemptEvidence]) {
    requireValue(exactKeys(reference, ["file", "sha256"]) && absolutePath(reference.file) && digest.test(reference.sha256), "evidence_reference");
  }
  requireValue(absolutePath(value.evidenceFile) && new Set([value.evidenceFile, value.diagnostic.file, value.attemptEvidence.file]).size === 3,
    "evidence_paths");
  return value;
}

async function verifyPrivateEvidence(reference) {
  const descriptor = await open(reference.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await descriptor.stat();
    requireValue(info.isFile() && info.nlink === 1 && info.uid === process.getuid() && !(info.mode & 0o077) &&
      info.size > 0 && info.size <= 100000, "source_file");
    const bytes = Buffer.alloc(100001), result = await descriptor.read(bytes, 0, bytes.length, 0);
    requireValue(result.bytesRead === info.size && hash(bytes.subarray(0, result.bytesRead)) === reference.sha256, "source_changed");
  } finally { await descriptor.close(); }
}

export async function checkHeldReleaseReconciliation(configuration) {
  if (!configuration) return;
  await verifyPrivateEvidence(configuration.diagnostic);
  await verifyPrivateEvidence(configuration.attemptEvidence);
  const parent = await lstat(path.dirname(configuration.evidenceFile));
  requireValue(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid() && !(parent.mode & 0o022), "output_parent");
  try { await lstat(configuration.evidenceFile); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("held_release_existing_attempt");
}

async function responseJson(response) {
  requireValue(response.status === 200, `http_${response.status}`);
  const reader = response.body?.getReader();
  requireValue(reader, "missing_body");
  const chunks = []; let bytes = 0;
  for (;;) {
    const item = await reader.read(); if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > 250000) { await reader.cancel(); throw new Error("held_release_response_bound"); }
    chunks.push(item.value);
  }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); }
  catch { throw new Error("held_release_response_json"); }
}

function failedReceiptMatches(receipt, configuration) {
  return receipt?.outcome === "failed" && receipt.releaseBindingSha256 === configuration.releaseBindingSha256 &&
    receipt.webRevision === configuration.previousRevision && receipt.workerRevision === configuration.previousRevision &&
    digest.test(receipt.evidenceSha256 || "") && digest.test(receipt.serverHealthEvidenceSha256 || "");
}

/** No model calls or automatic mutation retries. Readback only reads this same terminal record. */
export async function runHeldReleaseReconciliation({ configuration, baseUrl, phase, email, password, bypass = "", fetcher = fetch }) {
  if (!configuration) return null;
  requireValue(["reconcile", "readback"].includes(phase) &&
    (phase === "reconcile" ? staged.test(baseUrl) : baseUrl === production), "origin_or_phase");
  requireValue(typeof email === "string" && email.length > 0 && typeof password === "string" && password.length > 0, "login_required");
  let evidence, cookie = "", failure, signedOut = false;
  const marker = randomUUID();
  const request = async (endpoint, value) => {
    const response = await fetcher(`${baseUrl}${endpoint}`, { method: value === undefined ? "GET" : "POST", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(30000), headers: { origin: production, ...(cookie ? { cookie } : {}),
        ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
        ...(value === undefined ? {} : { "content-type": "application/json", "idempotency-key": `held-release:${marker}:${endpoint}` }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    if (endpoint === "/api/auth/login") {
      cookie = response.headers.getSetCookie().map(item => item.split(";")[0]).join("; ");
    }
    return responseJson(response);
  };
  if (phase === "reconcile") {
    await checkHeldReleaseReconciliation(configuration);
    evidence = { version: 1, scenario: "held_web_predeployment_failure", status: "pending", candidateRevision: configuration.candidateRevision,
      previousRevision: configuration.previousRevision, cycleId: configuration.cycleId, releaseBindingSha256: configuration.releaseBindingSha256,
      diagnosticSha256: configuration.diagnostic.sha256, attemptEvidenceSha256: configuration.attemptEvidence.sha256,
      stagedOrigin: baseUrl, startedAt: new Date().toISOString(), automaticRetry: false, publicationSucceeded: false, paidCalls: 0 };
    await writeImprovementReceipt(configuration.evidenceFile, evidence, { create: true });
  } else {
    evidence = await readImprovementReceipt(configuration.evidenceFile);
    requireValue(evidence.status === "passed" && evidence.signedOut === true && evidence.candidateRevision === configuration.candidateRevision &&
      evidence.cycleId === configuration.cycleId && evidence.releaseBindingSha256 === configuration.releaseBindingSha256 &&
      failedReceiptMatches(evidence.receipt, configuration) && !evidence.canonicalReadback, "readback_source");
  }
  try {
    const health = await request("/api/health");
    requireValue(health.status === "healthy" && health.revision === configuration.candidateRevision, "candidate_health");
    const auth = await request("/api/auth/login", { email, password });
    requireValue(cookie && auth.authenticated === true && auth.context?.source === "session" && auth.context?.role === "admin" &&
      auth.user?.email?.toLowerCase() === email.toLowerCase(), "owner_login");
    const ownerSha256 = hash(JSON.stringify([auth.context.tenantId, auth.context.actorId, auth.user.id]));
    if (phase === "reconcile") {
      evidence.ownerSha256 = ownerSha256;
      const action = { action: "reconcile_web_predeployment_failure", cycleId: configuration.cycleId,
        expectedRevision: configuration.expectedRevision, controllerId: configuration.controllerId,
        releaseBindingSha256: configuration.releaseBindingSha256, controllerHoldSha256: configuration.controllerHoldSha256,
        attestation: { version: 1, kind: "operator_attested_predeployment_failure", diagnosticSha256: configuration.diagnostic.sha256,
          attemptEvidenceSha256: configuration.attemptEvidence.sha256, recordedAt: new Date().toISOString() } };
      evidence.action = action; evidence.mutationDispatchedAt = new Date().toISOString();
      await writeImprovementReceipt(configuration.evidenceFile, evidence);
      const result = await request("/api/self-improvement/release-controller", action);
      requireValue(result.cycleId === configuration.cycleId && result.stage === "failed" && failedReceiptMatches(result.receipt, configuration), "settlement_result");
      evidence.receipt = result.receipt;
    } else requireValue(evidence.ownerSha256 === ownerSha256, "readback_owner");
    const { cycle } = await request(`/api/self-improvement?cycleId=${configuration.cycleId}`);
    requireValue(cycle?.id === configuration.cycleId && cycle.stage === "failed" && cycle.usageState === "known" &&
      cycle.release?.releaseBindingSha256 === configuration.releaseBindingSha256 &&
      JSON.stringify(canonical(cycle.releaseReceipt)) === JSON.stringify(canonical(evidence.receipt)), "terminal_readback");
    evidence.status = "passed";
    if (phase === "readback") evidence.canonicalReadback = { at: new Date().toISOString(), revision: health.revision, cycleRevision: cycle.revision };
    else evidence.failedCycleRevision = cycle.revision;
  } catch (error) {
    failure = error;
    evidence.status = "failed";
    evidence.failure = /^held_release_[a-z0-9_]+$/.test(error.message) ? error.message : "held_release_verification_failed";
  } finally {
    if (cookie) {
      try { signedOut = (await request("/api/auth/logout", {})).authenticated === false; }
      catch { signedOut = false; }
    }
    cookie = "";
    evidence.signedOut = signedOut;
    evidence.completedAt = new Date().toISOString();
    if (!signedOut) { evidence.status = "failed"; failure ||= new Error("held_release_logout_failed"); }
    await writeImprovementReceipt(configuration.evidenceFile, evidence);
  }
  if (failure) throw new Error(evidence.failure || "held_release_logout_failed");
  return { cycleId: evidence.cycleId, stage: "failed", reconciliation: "passed", canonicalReadback: Boolean(evidence.canonicalReadback),
    publicationSucceeded: false, evidenceFile: configuration.evidenceFile };
}
