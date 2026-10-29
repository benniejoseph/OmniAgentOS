import "server-only";
import { assertPublishableCriterionReview } from "./review-contracts";
import { z } from "zod";
import { readBuilderGithubReleaseProof, readBuilderGithubNativeOnlyAdvance } from "@/lib/app-builder/github";
import { nativePairedBaselineSchema } from "./native-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { readResponseTextLimited } from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { sealSelfImprovementReleaseBinding, selfImprovementDigestSchema, selfImprovementReleaseReceiptSchema, selfImprovementRevisionSchema, selfImprovementSha256 } from "./contracts";
import { assertCurrentSelfImprovementConfiguration, assertSelfImprovementCycleIntegrity, classifySelfImprovementChange } from "./policy";
import { assertConfiguredSelfImprovementOwner, claimSelfImprovementReleaseCycle, getSelfImprovementConfiguration, getSelfImprovementCycle, holdSelfImprovementRelease, listSelfImprovementCycles, readSelfImprovementControllerPresence, readSelfImprovementReleaseLease, recordSelfImprovementControllerPresence, recoverSelfImprovementNativeReleaseCompletion, reconcileSelfImprovementWebPredeploymentFailure, selfImprovementWebPredeploymentFailureActionSchema, renewSelfImprovementCycleLease, settleSelfImprovementPhaseBudget, transitionSelfImprovementCycle, type SelfImprovementOwner, type StoredSelfImprovementCycle } from "./store";

const opaque = z.string().trim().min(1).max(240);
const controller = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/);
const category = z.string().regex(/^[a-z0-9_]{1,120}$/);
const lease = { cycleId: opaque, leaseToken: opaque, controllerId: controller };
const releaseUsage = z.object({ phaseId: opaque, actualUsd: z.number().finite().min(0).max(1_000_000).nullable(), evidenceSha256: selfImprovementDigestSchema }).strict();
export const selfImprovementControllerActionSchema = z.discriminatedUnion("action", [
  selfImprovementWebPredeploymentFailureActionSchema,
  z.object({ action: z.literal("status"), controllerId: controller, status: z.enum(["online", "held"]), category: category.optional(), observedAt: z.string().datetime({ offset: true }) }).strict(),
  z.object({ action: z.literal("claim"), cycleId: opaque, candidateRevision: selfImprovementRevisionSchema, controllerId: controller }).strict(),
  z.object({ action: z.literal("heartbeat"), ...lease }).strict(),
  z.object({ action: z.literal("recover_native_completion"), ...lease, releaseBindingSha256: selfImprovementDigestSchema }).strict(),
  z.object({ action: z.literal("prepare"), ...lease, mergedRevision: selfImprovementRevisionSchema, sourceTree: selfImprovementRevisionSchema, mergedTree: selfImprovementRevisionSchema }).strict(),
  z.object({ action: z.literal("complete"), ...lease, receipt: selfImprovementReleaseReceiptSchema.omit({ serverHealthEvidenceSha256: true }), releaseUsage }).strict(),
  z.object({ action: z.literal("hold"), cycleId: opaque, candidateRevision: selfImprovementRevisionSchema, controllerId: controller, category, occurredAt: z.string().datetime({ offset: true }), leaseToken: opaque.optional(), releaseUsage: releaseUsage.optional() }).strict(),
]);
export function selfImprovementControllerOwner(context: SecurityContext): SelfImprovementOwner {
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!binding || context.role !== "admin" || context.source !== "session") throw new Error("The release controller requires the configured owner's authenticated administrator browser session.");
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
  assertPublishableCriterionReview(stored);
  if (classifySelfImprovementChange({ candidate: cycle.candidate, policy: cycle.policy }).protectedFiles.length) throw new Error("Protected control-plane, native and schema changes require the trusted manual release path.");
  return { cycleId: cycle.id, policyId: stored.configurationId, tenantId: cycle.scope.tenantId, ownerActorId: cycle.scope.ownerActorId,
    policySha256: cycle.policy.policySha256, policy: cycle.policy, previousRevision: cycle.scope.baseRevision, candidateRevision: cycle.candidate.revision,
    ...(cycle.validation.native ? { pairedBaseline: cycle.validation.native.pairedBaseline } : {}),
    validationSha256: cycle.validation.validationSha256, pullRequestUrl: cycle.pullRequestUrl, repository: cycle.scope.repository,
    candidate: cycle.candidate, validation: cycle.validation, approval: cycle.approval,
    ...(cycle.candidate.releaseTarget === "macos_app" ? { releaseTarget: "macos_app" as const, native: cycle.validation.native } : {}) };
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
    try {
      await currentConfiguration(owner, stored);
      const request = buildSelfImprovementReleaseRequest(stored);
      // Discovery remains read-only. The controller reports its own precise
      // preflight hold; claim/prepare below independently require server proof.
      try { requests.push(await observeReleaseBaseline(stored)); } catch { requests.push(request); }
    } catch { /* Main UI retains expired approvals and paused policies. */ }
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
async function observeReleaseBaseline(stored: StoredSelfImprovementCycle) {
  const request = buildSelfImprovementReleaseRequest(stored), observed = await readPairedHealth();
  if (observed.webRevision !== observed.workerRevision) throw new Error("The live server pair differs; publication is held.");
  const { serverHealthEvidenceSha256: _health, ...pairedBaseline } = observed;
  const retained = stored.runtime.releasePairedBaseline ? nativePairedBaselineSchema.parse(stored.runtime.releasePairedBaseline) : request.native?.pairedBaseline;
  if (retained && (retained.webRevision !== observed.webRevision || retained.workerRevision !== observed.workerRevision || retained.manifestSha256 !== observed.manifestSha256)) throw new Error("The server pair changed after validation or publication claim.");
  if (observed.webRevision !== request.previousRevision) {
    await readBuilderGithubNativeOnlyAdvance({ repositoryId: stored.repositoryId, repository: request.repository,
      servingRevision: observed.webRevision, sourceBaseRevision: request.previousRevision });
    return { ...request, pairedBaseline };
  }
  return retained || request.native ? { ...request, pairedBaseline } : request;
}
export async function executeSelfImprovementControllerAction(context: SecurityContext, raw: unknown) {
  const owner = selfImprovementControllerOwner(context), action = selfImprovementControllerActionSchema.parse(raw);
  if (action.action === "reconcile_web_predeployment_failure") {
    const stored = await getSelfImprovementCycle(owner, action.cycleId);
    if (!stored) throw new Error("The exact held web publication was not found.");
    // Read health outside database transactions. The store locks/rechecks the
    // exact action and accepts this server-only observation for at most 30s.
    // An exact terminal replay must remain readable after a later deployment.
    const observedAt = new Date().toISOString();
    const priorPair = stored.cycle.stage === "releasing" ? { ...await readPairedHealth(), observedAt } : undefined;
    const completed = await reconcileSelfImprovementWebPredeploymentFailure({ owner, action, priorPair });
    return { cycleId: completed.cycle.id, stage: completed.cycle.stage, revision: completed.cycle.revision,
      receipt: completed.cycle.releaseReceipt, reconciliation: "operator_attested_predeployment_failure" as const, automaticRetry: false };
  }
  if (action.action === "recover_native_completion") {
    const recovered = await recoverSelfImprovementNativeReleaseCompletion({ owner, ...action });
    return { cycleId: recovered.cycle.id, leaseToken: recovered.leaseToken, expiresAt: recovered.leaseExpiresAt, releaseBindingSha256: recovered.cycle.release!.releaseBindingSha256, recoveryOnly: true };
  }
  if (action.action === "status") {
    if (Math.abs(Date.now() - Date.parse(action.observedAt)) > 300_000) throw new Error("Controller heartbeat observation is stale.");
    await recordSelfImprovementControllerPresence(owner, action);
    return getSelfImprovementControllerStatus(owner);
  }
  if (action.action === "hold") {
    if (action.releaseUsage) {
      if (!action.leaseToken || action.releaseUsage.phaseId !== `release:${action.controllerId}`) throw new Error("Release usage requires its exact active controller lease and reservation.");
      const stored = await readSelfImprovementReleaseLease({ owner, ...action, leaseToken: action.leaseToken });
      if (stored.cycle.candidate?.releaseTarget === "macos_app") {
        if (action.releaseUsage.actualUsd !== 0) throw new Error("The native installer does not make paid model calls.");
      } else await settleSelfImprovementPhaseBudget({ owner, cycleId: action.cycleId, expectedRevision: stored.cycle.revision, leaseToken: action.leaseToken, ...action.releaseUsage });
    }
    const held = await holdSelfImprovementRelease({ owner, ...action });
    await recordSelfImprovementControllerPresence(owner, { controllerId: action.controllerId, status: "held", category: action.category });
    return { cycleId: held.cycle.id, stage: held.cycle.stage, hold: held.controllerHold, automaticRetry: false };
  }
  if (action.action === "claim") {
    const stored = await getSelfImprovementCycle(owner, action.cycleId);
    if (!stored) throw new Error("Release candidate was not found.");
    await currentConfiguration(owner, stored);
    const request = await observeReleaseBaseline(stored);
    if (request.candidateRevision !== action.candidateRevision) throw new Error("The requested candidate revision changed.");
    await readBuilderGithubReleaseProof({ repositoryId: stored.repositoryId, pullRequestUrl: request.pullRequestUrl, sourceRevision: request.candidateRevision, baseRevision: request.previousRevision });
    const claimed = await claimSelfImprovementReleaseCycle({ owner, ...action, ...(request.pairedBaseline ? { pairedBaseline: request.pairedBaseline } : {}) });
    return { claim: { leaseToken: claimed.leaseToken, expiresAt: claimed.leaseExpiresAt, request, releaseBudget: claimed.releaseBudget } };
  }
  let stored = await readSelfImprovementReleaseLease({ owner, ...action, allowCompletedNative: action.action === "complete" });
  if (stored.runtime.releaseRecoveryOnly && action.action === "prepare") throw new Error("Recovered native publication authority permits heartbeat, completion and hold only; preparation cannot be replayed.");
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
    let request = buildSelfImprovementReleaseRequest(stored);
    const proof = await readBuilderGithubReleaseProof({ repositoryId: stored.repositoryId, pullRequestUrl: request.pullRequestUrl, sourceRevision: request.candidateRevision, baseRevision: request.previousRevision, mergedRevision: action.mergedRevision });
    if (proof.sourceTree !== action.sourceTree || proof.mergedCommit?.treeSha !== action.mergedTree) throw new Error("The controller's merged tree differs from provider evidence.");
    request = await observeReleaseBaseline(stored);
    const releaseBinding = sealSelfImprovementReleaseBinding({ releaseId: `self_release_${selfImprovementSha256("release_id", { cycleId: stored.cycle.id, mergedRevision: action.mergedRevision })}`, scope: stored.cycle.scope,
      ...(request.pairedBaseline ? { pairedBaseline: request.pairedBaseline } : {}),
      previousRevision: request.previousRevision, sourceCandidateRevision: request.candidateRevision, candidateRevision: action.mergedRevision,
      sourceTree: action.sourceTree, mergedTree: action.mergedTree, pullRequestUrl: request.pullRequestUrl,
      candidateSha256: request.candidate.candidateSha256, policySha256: request.policySha256, validationSha256: request.validationSha256,
      ...(request.releaseTarget === "macos_app" && request.native && request.approval ? { releaseTarget: "macos_app" as const, native: { ...request.native, approvalSha256: request.approval.receiptSha256 }, runner: "asael_macos_publisher" as const } : { runner: "asael_paired_production" as const }) });
    await transitionSelfImprovementCycle({ owner, cycleId: stored.cycle.id, expectedRevision: stored.cycle.revision, leaseToken: action.leaseToken, nextStage: "releasing", patch: { release: releaseBinding } });
    return { releaseBinding };
  }
  const receipt = action.receipt, release = stored.cycle.release;
  const completedNative = (current: StoredSelfImprovementCycle) => {
    if (!current.cycle.release?.native || !current.cycle.releaseReceipt || !["succeeded", "failed", "rolled_back"].includes(current.cycle.stage)) return null;
    const { serverHealthEvidenceSha256: _serverHealth, ...recorded } = current.cycle.releaseReceipt;
    if (action.releaseUsage.phaseId !== `release:${action.controllerId}` || action.releaseUsage.actualUsd !== 0 || canonicalJsonSha256(recorded) !== canonicalJsonSha256(receipt)) throw new Error("Completed native publication evidence is immutable.");
    return { cycleId: current.cycle.id, stage: current.cycle.stage, receipt: current.cycle.releaseReceipt };
  };
  const retained = completedNative(stored);
  if (retained) return retained;
  if (!release || stored.cycle.stage !== "releasing" || receipt.releaseBindingSha256 !== release.releaseBindingSha256 || receipt.behaviorEvidenceSha256 !== release.validationSha256 || Math.abs(Date.now() - Date.parse(receipt.recordedAt)) > 300_000) throw new Error("Completion does not bind the active exact release.");
  if (action.releaseUsage.phaseId !== `release:${action.controllerId}`) throw new Error("Release usage does not bind the claimed reservation.");
  if (release.native) {
    if (action.releaseUsage.actualUsd !== 0 || !receipt.nativeInstall) throw new Error("Native completion requires exact installation evidence and zero model usage.");
  } else stored = await settleSelfImprovementPhaseBudget({ owner, cycleId: action.cycleId, expectedRevision: stored.cycle.revision, leaseToken: action.leaseToken, ...action.releaseUsage });
  if (stored.usageState !== "known") {
    await holdSelfImprovementRelease({ owner, cycleId: action.cycleId, candidateRevision: release.sourceCandidateRevision, controllerId: action.controllerId, category: "release_usage_unconfirmed" });
    throw new Error("Release usage is unconfirmed; the active release remains held for reconciliation.");
  }
  const expected = release.native?.pairedBaseline.webRevision ?? (receipt.outcome === "deployed" ? release.candidateRevision : release.pairedBaseline?.webRevision ?? release.previousRevision);
  const observed = await readPairedHealth();
  if (receipt.webRevision !== expected || receipt.workerRevision !== expected || observed.webRevision !== expected || observed.workerRevision !== expected || observed.manifestSha256 !== receipt.manifestSha256 || (receipt.outcome !== "deployed" && release.pairedBaseline && receipt.manifestSha256 !== release.pairedBaseline.manifestSha256)) throw new Error("Independent paired revision or manifest does not confirm this release outcome.");
  try {
    const completed = await transitionSelfImprovementCycle({ owner, cycleId: stored.cycle.id, expectedRevision: stored.cycle.revision, leaseToken: action.leaseToken,
      nextStage: receipt.outcome === "deployed" ? "succeeded" : receipt.outcome === "rolled_back" ? "rolled_back" : "failed", patch: { releaseReceipt: { ...receipt, serverHealthEvidenceSha256: observed.serverHealthEvidenceSha256 } } });
    return { cycleId: completed.cycle.id, stage: completed.cycle.stage, receipt: completed.cycle.releaseReceipt };
  } catch (error) {
    if (!release.native) throw error;
    const current = await readSelfImprovementReleaseLease({ owner, ...action, allowCompletedNative: true });
    const settled = completedNative(current);
    if (settled) return settled;
    throw error;
  }
}
