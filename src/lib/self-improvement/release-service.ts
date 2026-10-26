import "server-only";
import { z } from "zod";
import { readBuilderGithubReleaseProof } from "@/lib/app-builder/github";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { readResponseTextLimited } from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { sealSelfImprovementReleaseBinding, selfImprovementDigestSchema, selfImprovementReleaseReceiptSchema, selfImprovementRevisionSchema, selfImprovementSha256 } from "./contracts";
import { assertCurrentSelfImprovementConfiguration, assertSelfImprovementCycleIntegrity, classifySelfImprovementChange } from "./policy";
import { assertConfiguredSelfImprovementOwner, claimSelfImprovementReleaseCycle, getSelfImprovementConfiguration, getSelfImprovementCycle, holdSelfImprovementRelease, listSelfImprovementCycles, readSelfImprovementControllerPresence, readSelfImprovementReleaseLease, recordSelfImprovementControllerPresence, renewSelfImprovementCycleLease, settleSelfImprovementPhaseBudget, transitionSelfImprovementCycle, type SelfImprovementOwner, type StoredSelfImprovementCycle } from "./store";

const opaque = z.string().trim().min(1).max(240);
const controller = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/);
const category = z.string().regex(/^[a-z0-9_]{1,120}$/);
const lease = { cycleId: opaque, leaseToken: opaque, controllerId: controller };
const releaseUsage = z.object({ phaseId: opaque, actualUsd: z.number().finite().min(0).max(1_000_000).nullable(), evidenceSha256: selfImprovementDigestSchema }).strict();
export const selfImprovementControllerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), controllerId: controller, status: z.enum(["online", "held"]), category: category.optional(), observedAt: z.string().datetime({ offset: true }) }).strict(),
  z.object({ action: z.literal("claim"), cycleId: opaque, candidateRevision: selfImprovementRevisionSchema, controllerId: controller }).strict(),
  z.object({ action: z.literal("heartbeat"), ...lease }).strict(),
  z.object({ action: z.literal("prepare"), ...lease, mergedRevision: selfImprovementRevisionSchema, sourceTree: selfImprovementRevisionSchema, mergedTree: selfImprovementRevisionSchema }).strict(),
  z.object({ action: z.literal("complete"), ...lease, receipt: selfImprovementReleaseReceiptSchema.omit({ serverHealthEvidenceSha256: true }), releaseUsage }).strict(),
  z.object({ action: z.literal("hold"), cycleId: opaque, candidateRevision: selfImprovementRevisionSchema, controllerId: controller, category, occurredAt: z.string().datetime({ offset: true }), leaseToken: opaque.optional(), releaseUsage: releaseUsage.optional() }).strict(),
]);
export function selfImprovementControllerOwner(context: SecurityContext): SelfImprovementOwner {
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!binding || context.role !== "admin") throw new Error("The release controller requires the configured owner's authenticated administrator account.");
  const owner = { tenantId: context.tenantId, ownerActorId: binding.canonicalActorId };
  assertConfiguredSelfImprovementOwner(owner); return owner;
}
export async function getSelfImprovementControllerStatus(owner: SelfImprovementOwner) {
  const presence = await readSelfImprovementControllerPresence(owner);
  if (!presence) return { status: "not_connected" as const };
  const age = Date.now() - Date.parse(presence.lastSeenAt);
  return { status: age >= 0 && age <= 180_000 ? "online" as const : "offline" as const, lastSeenAt: presence.lastSeenAt,
    ...(presence.controllerStatus === "held" ? { activity: "held" as const, category: presence.category } : {}) };
}
export function buildSelfImprovementReleaseRequest(stored: StoredSelfImprovementCycle, now = new Date().toISOString()) {
  const cycle = { ...stored.cycle, updatedAt: now }; assertSelfImprovementCycleIntegrity(cycle);
  if (cycle.stage !== "ready_for_release" || !cycle.candidate || !cycle.validation || !cycle.pullRequestUrl || stored.controllerHold || stored.usageState !== "known") throw new Error("The cycle is not an exactly verified release candidate.");
  if (classifySelfImprovementChange({ candidate: cycle.candidate, policy: cycle.policy }).protectedFiles.length) throw new Error("Protected control-plane, native and schema changes require the trusted manual release path.");
  return { cycleId: cycle.id, policyId: stored.configurationId, tenantId: cycle.scope.tenantId, ownerActorId: cycle.scope.ownerActorId,
    policySha256: cycle.policy.policySha256, policy: cycle.policy, previousRevision: cycle.scope.baseRevision, candidateRevision: cycle.candidate.revision,
    validationSha256: cycle.validation.validationSha256, pullRequestUrl: cycle.pullRequestUrl, repository: cycle.scope.repository,
    candidate: cycle.candidate, validation: cycle.validation, approval: cycle.approval };
}
async function currentConfiguration(owner: SelfImprovementOwner, stored: StoredSelfImprovementCycle) {
  const configuration = await getSelfImprovementConfiguration(owner, stored.configurationId);
  assertCurrentSelfImprovementConfiguration(configuration, stored);
  return configuration;
}
export async function listSelfImprovementReleaseRequests(context: SecurityContext) {
  const owner = selfImprovementControllerOwner(context);
  const cycles = await listSelfImprovementCycles(owner, { activeOnly: true, limit: 30 });
  const requests: ReturnType<typeof buildSelfImprovementReleaseRequest>[] = [];
  for (const stored of cycles) {
    if (stored.cycle.stage !== "ready_for_release" || stored.controllerId || stored.controllerHold || stored.usageState !== "known") continue;
    try { await currentConfiguration(owner, stored); requests.push(buildSelfImprovementReleaseRequest(stored)); } catch { /* Main UI retains expired approvals and paused policies. */ }
    if (requests.length === 10) break;
  }
  return { requests };
}
async function readPairedHealth() {
  const read = async (url: string): Promise<Record<string, unknown>> => {
    const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok || Number(response.headers.get("content-length") || 0) > 100_000) throw new Error("Independent release health could not be verified.");
    const body = await readResponseTextLimited(response, 100_000);
    if (body.truncated) throw new Error("Independent release health exceeded its response bound.");
    return z.record(z.string(), z.unknown()).parse(JSON.parse(body.text));
  };
  const [web, worker] = await Promise.all([read("https://asael.bennierichard.com/api/health"), read("https://omniagent-os-worker.fly.dev/healthz")]);
  if (web.status !== "healthy" || worker.status !== "healthy" || worker.service !== "asael-openai-egress" || typeof web.releaseManifest !== "string" || !web.releaseManifest) throw new Error("Independent paired release health is not healthy.");
  return { webRevision: selfImprovementRevisionSchema.parse(web.revision), workerRevision: selfImprovementRevisionSchema.parse(worker.revision), manifestSha256: canonicalJsonSha256(web.releaseManifest), serverHealthEvidenceSha256: canonicalJsonSha256({ web, worker }) };
}
export async function executeSelfImprovementControllerAction(context: SecurityContext, raw: unknown) {
  const owner = selfImprovementControllerOwner(context), action = selfImprovementControllerActionSchema.parse(raw);
  if (action.action === "status") {
    if (Math.abs(Date.now() - Date.parse(action.observedAt)) > 300_000) throw new Error("Controller heartbeat observation is stale.");
    await recordSelfImprovementControllerPresence(owner, action);
    return getSelfImprovementControllerStatus(owner);
  }
  if (action.action === "hold") {
    if (action.releaseUsage) {
      if (!action.leaseToken || action.releaseUsage.phaseId !== `release:${action.controllerId}`) throw new Error("Release usage requires its exact active controller lease and reservation.");
      const stored = await readSelfImprovementReleaseLease({ owner, ...action, leaseToken: action.leaseToken });
      await settleSelfImprovementPhaseBudget({ owner, cycleId: action.cycleId, expectedRevision: stored.cycle.revision, leaseToken: action.leaseToken, ...action.releaseUsage });
    }
    const held = await holdSelfImprovementRelease({ owner, ...action });
    await recordSelfImprovementControllerPresence(owner, { controllerId: action.controllerId, status: "held", category: action.category });
    return { cycleId: held.cycle.id, stage: held.cycle.stage, hold: held.controllerHold, automaticRetry: false };
  }
  if (action.action === "claim") {
    const stored = await getSelfImprovementCycle(owner, action.cycleId);
    if (!stored) throw new Error("Release candidate was not found.");
    await currentConfiguration(owner, stored);
    const request = buildSelfImprovementReleaseRequest(stored);
    if (request.candidateRevision !== action.candidateRevision) throw new Error("The requested candidate revision changed.");
    await readBuilderGithubReleaseProof({ repositoryId: stored.repositoryId, pullRequestUrl: request.pullRequestUrl, sourceRevision: request.candidateRevision, baseRevision: request.previousRevision });
    const claimed = await claimSelfImprovementReleaseCycle({ owner, ...action });
    return { claim: { leaseToken: claimed.leaseToken, expiresAt: claimed.leaseExpiresAt, request, releaseBudget: claimed.releaseBudget } };
  }
  let stored = await readSelfImprovementReleaseLease({ owner, ...action });
  if (action.action === "heartbeat") {
    if (!["ready_for_release", "releasing"].includes(stored.cycle.stage)) throw new Error("Release execution is already settled.");
    await recordSelfImprovementControllerPresence(owner, { controllerId: action.controllerId, status: "online" });
    const renewed = await renewSelfImprovementCycleLease({ owner, cycleId: action.cycleId, expectedRevision: stored.cycle.revision, leaseToken: action.leaseToken });
    return { leaseToken: renewed.leaseToken, expiresAt: renewed.leaseExpiresAt };
  }
  if (action.action === "prepare") {
    if (stored.cycle.stage === "releasing" && stored.cycle.release) {
      if (stored.cycle.release.candidateRevision !== action.mergedRevision || stored.cycle.release.sourceTree !== action.sourceTree || stored.cycle.release.mergedTree !== action.mergedTree) throw new Error("Prepared release binding cannot change.");
      return { releaseBinding: stored.cycle.release };
    }
    await currentConfiguration(owner, stored);
    const request = buildSelfImprovementReleaseRequest(stored);
    const proof = await readBuilderGithubReleaseProof({ repositoryId: stored.repositoryId, pullRequestUrl: request.pullRequestUrl, sourceRevision: request.candidateRevision, baseRevision: request.previousRevision, mergedRevision: action.mergedRevision });
    if (proof.sourceTree !== action.sourceTree || proof.mergedCommit?.treeSha !== action.mergedTree) throw new Error("The controller's merged tree differs from provider evidence.");
    const releaseBinding = sealSelfImprovementReleaseBinding({ releaseId: `self_release_${selfImprovementSha256("release_id", { cycleId: stored.cycle.id, mergedRevision: action.mergedRevision })}`, scope: stored.cycle.scope,
      previousRevision: request.previousRevision, sourceCandidateRevision: request.candidateRevision, candidateRevision: action.mergedRevision,
      sourceTree: action.sourceTree, mergedTree: action.mergedTree, pullRequestUrl: request.pullRequestUrl,
      candidateSha256: request.candidate.candidateSha256, policySha256: request.policySha256, validationSha256: request.validationSha256, runner: "asael_paired_production" });
    await transitionSelfImprovementCycle({ owner, cycleId: stored.cycle.id, expectedRevision: stored.cycle.revision, leaseToken: action.leaseToken, nextStage: "releasing", patch: { release: releaseBinding } });
    return { releaseBinding };
  }
  const receipt = action.receipt, release = stored.cycle.release;
  if (!release || stored.cycle.stage !== "releasing" || receipt.releaseBindingSha256 !== release.releaseBindingSha256 || receipt.behaviorEvidenceSha256 !== release.validationSha256 || Math.abs(Date.now() - Date.parse(receipt.recordedAt)) > 300_000) throw new Error("Completion does not bind the active exact release.");
  if (action.releaseUsage.phaseId !== `release:${action.controllerId}`) throw new Error("Release usage does not bind the claimed reservation.");
  stored = await settleSelfImprovementPhaseBudget({ owner, cycleId: action.cycleId, expectedRevision: stored.cycle.revision, leaseToken: action.leaseToken, ...action.releaseUsage });
  if (stored.usageState !== "known") {
    await holdSelfImprovementRelease({ owner, cycleId: action.cycleId, candidateRevision: release.sourceCandidateRevision, controllerId: action.controllerId, category: "release_usage_unconfirmed" });
    throw new Error("Release usage is unconfirmed; the active release remains held for reconciliation.");
  }
  const expected = receipt.outcome === "deployed" ? release.candidateRevision : release.previousRevision;
  const observed = await readPairedHealth();
  if (receipt.webRevision !== expected || receipt.workerRevision !== expected || observed.webRevision !== expected || observed.workerRevision !== expected || observed.manifestSha256 !== receipt.manifestSha256) throw new Error("Independent paired revision or manifest does not confirm this release outcome.");
  const completed = await transitionSelfImprovementCycle({ owner, cycleId: stored.cycle.id, expectedRevision: stored.cycle.revision, leaseToken: action.leaseToken,
    nextStage: receipt.outcome === "deployed" ? "succeeded" : receipt.outcome === "rolled_back" ? "rolled_back" : "failed", patch: { releaseReceipt: { ...receipt, serverHealthEvidenceSha256: observed.serverHealthEvidenceSha256 } } });
  return { cycleId: completed.cycle.id, stage: completed.cycle.stage, receipt: completed.cycle.releaseReceipt };
}
