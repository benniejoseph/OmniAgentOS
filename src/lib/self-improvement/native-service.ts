import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { getProjectBuilderSession, getBuilderCheckpoint } from "@/lib/app-builder/store";
import { getBuilderWorkspaceManifest, readBuilderRepositoryChanges } from "@/lib/app-builder/sandbox";
import { requireSelfImprovementExecutionAuthority } from "./authority";
import { assertCurrentSelfImprovementConfiguration } from "./policy";
import { selfImprovementRuntimeSchema, type SelfImprovementRuntime } from "./runtime";
import { assertConfiguredSelfImprovementOwner, assertSelfImprovementOwnerAuthority, getSelfImprovementConfiguration, getSelfImprovementCycle,
  listSelfImprovementCycles, claimSelfImprovementNativeValidation, readSelfImprovementNativeLease, finishSelfImprovementNativeValidation,
  renewSelfImprovementCycleLease, recordSelfImprovementControllerPresence, type SelfImprovementOwner, type StoredSelfImprovementCycle } from "./store";
import { SELF_IMPROVEMENT_NATIVE_PROFILE, SELF_IMPROVEMENT_NATIVE_PROFILE_SHA256, nativeSourceChangeSchema, nativeSourceSnapshotSchema,
  nativeValidationRequestSchema, nativeValidationReceiptSchema, nativeCandidateValidationPassed, assertNativeValidationReceipt,
  selfImprovementNativeSha, type NativeSourceChange, type NativeValidationRequest, type NativeValidationReceipt, type NativeSourceSnapshotDescriptor } from "./native-contracts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const opaque = z.string().min(1).max(240), requestId = z.string().regex(/^self_native_[a-f0-9]{64}$/);
const controller = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/), sha = z.string().regex(/^[a-f0-9]{64}$/);
const lease = { cycleId: opaque, requestId, controllerId: controller, leaseToken: opaque };
export const nativeControllerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), cycleId: opaque, requestId, requestSha256: sha, controllerId: controller }).strict(),
  z.object({ action: z.literal("source"), ...lease }).strict(),
  z.object({ action: z.literal("heartbeat"), ...lease }).strict(),
  z.object({ action: z.literal("complete"), ...lease, receipt: nativeValidationReceiptSchema }).strict(),
  z.object({ action: z.literal("hold"), ...lease, category: z.string().regex(/^[a-z0-9_]{1,120}$/) }).strict(),
]);
function controllerOwner(context: SecurityContext): SelfImprovementOwner {
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!binding || context.source !== "session" || context.role !== "admin") throw new Error("The native validator requires the configured owner's authenticated publisher session.");
  const owner = { tenantId: context.tenantId, ownerActorId: binding.canonicalActorId };
  assertConfiguredSelfImprovementOwner(owner); return owner;
}
async function currentAuthority(owner: SelfImprovementOwner, stored: StoredSelfImprovementCycle) {
  await assertSelfImprovementOwnerAuthority(owner, stored.projectId);
  assertCurrentSelfImprovementConfiguration(await getSelfImprovementConfiguration(owner, stored.configurationId), stored);
}
export async function readSelfImprovementNativeSource(stored: StoredSelfImprovementCycle, checkpointId: string): Promise<{ snapshot: NativeSourceSnapshotDescriptor; changes: NativeSourceChange[] }> {
  const owner = { tenantId: stored.cycle.scope.tenantId, actorId: stored.cycle.scope.ownerActorId };
  const session = await getProjectBuilderSession(stored.projectId, owner);
  if (!session || session.id !== stored.cycle.builderSessionId || session.currentCheckpointId !== checkpointId) throw new Error("Native source checkpoint is no longer current.");
  const checkpoint = await getBuilderCheckpoint(checkpointId, session.id, owner);
  const before = await getBuilderWorkspaceManifest(session.sandboxName);
  if (!checkpoint || before.sha256 !== checkpoint.workspaceSha256) throw new Error("Native source changed after its immutable checkpoint.");
  const raw = await readBuilderRepositoryChanges({ sandboxName: session.sandboxName, repositoryId: stored.repositoryId, baseSha: stored.cycle.scope.baseRevision });
  const changes = raw.map(change => {
    const mode = change.kind === "upsert" ? change.file.mode : change.previousMode;
    if (mode !== "100644" && mode !== "100755") throw new Error("Native source requires its exact observed regular-file mode.");
    return nativeSourceChangeSchema.parse(change.kind === "upsert"
      ? { path: change.file.path, beforeSha256: change.previousSha256 ?? null, afterSha256: change.file.sha256, mode, content: change.file.content }
      : { path: change.path, beforeSha256: change.previousSha256, afterSha256: null, mode, content: null });
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (changes.some(change => change.content !== null && digest(change.content) !== change.afterSha256)) throw new Error("Native file content does not match its exact source digest.");
  const after = await getBuilderWorkspaceManifest(session.sandboxName);
  if (after.sha256 !== before.sha256) throw new Error("Native source changed while its snapshot was being read.");
  const body = { version: 1 as const, cycleId: stored.cycle.id, projectId: stored.projectId, sessionId: session.id, checkpointId,
    baseRevision: stored.cycle.scope.baseRevision, workspaceSha256: before.sha256, changesSha256: selfImprovementNativeSha("native_source_changes", changes),
    byteCount: Buffer.byteLength(JSON.stringify(changes)), files: changes.map(({ content: _content, ...file }) => file) };
  return { snapshot: nativeSourceSnapshotSchema.parse({ ...body, snapshotSha256: selfImprovementNativeSha("native_source_snapshot", body) }), changes };
}
export async function prepareSelfImprovementNativeValidation(stored: StoredSelfImprovementCycle, runtime: SelfImprovementRuntime, checkpointId: string, purpose: "baseline" | "candidate"): Promise<NativeValidationRequest> {
  if (runtime.plan?.releaseTarget !== "macos_app") throw new Error("Native validation requires an explicit native source plan.");
  const { snapshot } = await readSelfImprovementNativeSource(stored, checkpointId);
  const allowed = purpose === "baseline" ? runtime.plan.focusedTestPaths : [...runtime.plan.sourcePaths, ...runtime.plan.newSourcePaths, ...runtime.plan.focusedTestPaths];
  if (snapshot.files.some(file => !allowed.includes(file.path)) || purpose === "baseline" && snapshot.files.some(file => file.afterSha256 === null)) throw new Error("The native snapshot changed files outside its phase plan.");
  const createdAt = new Date().toISOString();
  const body = { version: 1 as const, requestId: `self_native_${selfImprovementNativeSha("native_validation_id", { cycleId: stored.cycle.id, purpose, snapshotSha256: snapshot.snapshotSha256, correction: stored.cycle.correctionsUsed })}`,
    cycleId: stored.cycle.id, tenantId: stored.cycle.scope.tenantId, ownerActorId: stored.cycle.scope.ownerActorId, projectId: stored.projectId,
    sessionId: snapshot.sessionId, checkpointId, purpose, releaseTarget: "macos_app" as const, profile: SELF_IMPROVEMENT_NATIVE_PROFILE, profileSha256: SELF_IMPROVEMENT_NATIVE_PROFILE_SHA256,
    policySha256: stored.cycle.policy.policySha256, snapshot, focusedTestPaths: runtime.plan.focusedTestPaths, adjacentTestPaths: runtime.plan.adjacentTestPaths,
    analyzePaths: [...runtime.plan.sourcePaths, ...(purpose === "candidate" ? runtime.plan.newSourcePaths : []), ...runtime.plan.focusedTestPaths], createdAt,
    expiresAt: new Date(Date.parse(createdAt) + Math.max(1, 86_400_000 - (runtime.native?.waitedMs || 0))).toISOString() };
  return nativeValidationRequestSchema.parse({ ...body, requestSha256: selfImprovementNativeSha("native_validation_request", body) });
}
export async function listSelfImprovementNativeValidationRequests(context: SecurityContext) {
  const owner = controllerOwner(context), requests: NativeValidationRequest[] = [];
  for (const stored of await listSelfImprovementCycles(owner, { activeOnly: true, limit: 20 })) {
    const runtime = selfImprovementRuntimeSchema.safeParse(stored.runtime);
    const entry = runtime.success ? runtime.data.native?.requests.find(item => item.request.requestId === runtime.data.native?.activeRequestId) : undefined;
    if (entry?.status !== "queued" || Date.parse(entry.request.expiresAt) <= Date.now() || stored.usageState !== "known") continue;
    try { await currentAuthority(owner, stored); requests.push(entry.request); } catch { /* Paused or revoked work stays retained. */ }
  }
  return { requests };
}
export async function executeSelfImprovementNativeControllerAction(context: SecurityContext, raw: unknown) {
  const owner = controllerOwner(context), action = nativeControllerActionSchema.parse(raw);
  if (action.action === "claim") {
    const claimed = await claimSelfImprovementNativeValidation({ owner, ...action });
    await recordSelfImprovementControllerPresence(owner, { controllerId: action.controllerId, status: "online" });
    return { claim: { leaseToken: claimed.cycle.leaseToken, expiresAt: claimed.cycle.leaseExpiresAt, request: claimed.request } };
  }
  const held = await readSelfImprovementNativeLease({ owner, ...action, allowExpired: action.action === "heartbeat" });
  if (action.action === "heartbeat") {
    const renewed = await renewSelfImprovementCycleLease({ owner, cycleId: action.cycleId, expectedRevision: held.stored.cycle.revision, leaseToken: action.leaseToken });
    await recordSelfImprovementControllerPresence(owner, { controllerId: action.controllerId, status: "online" });
    return { leaseToken: renewed.leaseToken, expiresAt: renewed.leaseExpiresAt };
  }
  if (action.action === "hold") return { cycleId: (await finishSelfImprovementNativeValidation({ owner, ...action, holdCategory: action.category })).cycle.id, status: "held", automaticRetry: false };
  if (action.action === "source") await currentAuthority(owner, held.stored);
  const source = await readSelfImprovementNativeSource(held.stored, held.entry.request.checkpointId);
  if (source.snapshot.snapshotSha256 !== held.entry.request.snapshot.snapshotSha256) throw new Error("The native request no longer matches its exact source snapshot.");
  if (action.action === "source") return source;
  const completed = await finishSelfImprovementNativeValidation({ owner, ...action });
  return { cycleId: completed.cycle.id, requestId: action.requestId, status: "completed", receiptSha256: action.receipt.receiptSha256 };
}
/** Only the internal governed Builder bridge may import completed check evidence. */
export async function getCompletedSelfImprovementNativeVerification(input: { owner: SelfImprovementOwner; projectId: string; requestId: string; sessionId: string; checkpointId: string }): Promise<{ request: NativeValidationRequest; snapshot: NativeSourceSnapshotDescriptor; receipt: NativeValidationReceipt }> {
  const authority = await requireSelfImprovementExecutionAuthority({ ...input.owner, projectId: input.projectId });
  const stored = await getSelfImprovementCycle(input.owner, authority.cycleId);
  if (!stored || stored.projectId !== input.projectId || stored.cycle.builderSessionId !== input.sessionId || stored.cycle.checkpointId !== input.checkpointId) throw new Error("Native verification scope changed.");
  const runtime = selfImprovementRuntimeSchema.parse(stored.runtime);
  const entry = runtime.native?.requests.find(item => item.request.requestId === input.requestId);
  if (runtime.native?.activeRequestId !== input.requestId || !entry || entry.status !== "completed" || !entry.receipt || entry.request.purpose !== "candidate" || entry.request.sessionId !== input.sessionId || entry.request.checkpointId !== input.checkpointId || !nativeCandidateValidationPassed(entry.receipt)) throw new Error("The native candidate has no exact completed passing validation.");
  assertNativeValidationReceipt(entry.request, entry.receipt);
  const source = await readSelfImprovementNativeSource(stored, input.checkpointId);
  if (source.snapshot.snapshotSha256 !== entry.request.snapshot.snapshotSha256) throw new Error("Native validation source changed after completion.");
  return { request: entry.request, snapshot: source.snapshot, receipt: entry.receipt };
}
