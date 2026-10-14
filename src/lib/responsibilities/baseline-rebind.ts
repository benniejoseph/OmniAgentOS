import type { SqlClient } from "@/lib/db/sql-types";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { ResponsibilityBaseline } from "./observation-contracts";
import { baselineRebindReceiptSchema, type BaselineRebindReceipt } from "./baseline-rebind-contracts";
export { baselineRebindReceiptSchema, type BaselineRebindReceipt } from "./baseline-rebind-contracts";
import { baselineFromRow, readBaseline, verifiedBaseline } from "./baseline-store";
import { verifyRuntimeReceipt } from "./lifecycle-state";
import type { ResponsibilityLifecycle, ResponsibilityRuntimeReceipt } from "./runtime-contracts";
import { storageInvalid } from "./state";

/** Transfers only the review target. The accepted observation and semantic
 * comparison remain unchanged, including their original evidence timestamp. */
export function buildBaselineRebind(previousValue: ResponsibilityBaseline, previousRuntime: ResponsibilityLifecycle, runtimeValue: ResponsibilityRuntimeReceipt): BaselineRebindReceipt {
  const previous = verifiedBaseline(previousValue); const runtime = verifyRuntimeReceipt(runtimeValue); const current = runtime.snapshot;
  if (runtime.action !== "resume" || previousRuntime.state !== "blocked" || previousRuntime.reason !== "authority_changed" || current.state !== "active" ||
    current.reason !== "owner_resumed" || runtime.previousRevision !== previousRuntime.revision || current.generation !== previousRuntime.generation + 1 ||
    current.tenantId !== previous.target.tenantId || current.actorId !== previous.target.actorId || current.responsibilityId !== previous.target.responsibilityId ||
    previous.target.responsibilityRevision !== previousRuntime.configuration.responsibilityRevision || previous.target.reviewSha256 !== previousRuntime.configuration.reviewSha256 ||
    previous.policySha256 !== current.configuration.comparisonPolicySha256) throw storageInvalid();
  const { baselineSha256: _hash, ...body } = previous; void _hash;
  const nextBody = { ...body, revision: previous.revision + 1, target: { ...previous.target,
    responsibilityRevision: current.configuration.responsibilityRevision, reviewSha256: current.configuration.reviewSha256 } };
  const next = verifiedBaseline({ ...nextBody, baselineSha256: canonicalJsonSha256(nextBody) });
  const receiptBody = { schemaVersion: 1 as const, id: `responsibility-baseline-rebind:${canonicalJsonSha256([runtime.id, previous.baselineSha256])}`,
    runtimeReceiptId: runtime.id, runtimeReceiptSha256: runtime.receiptSha256, previous, next, savedAt: runtime.savedAt };
  return verifyBaselineRebind({ ...receiptBody, receiptSha256: canonicalJsonSha256(receiptBody) });
}
export function verifyBaselineRebind(value: unknown): BaselineRebindReceipt {
  const receipt = baselineRebindReceiptSchema.parse(value); const { receiptSha256, ...body } = receipt;
  const previous = verifiedBaseline(receipt.previous); const next = verifiedBaseline(receipt.next);
  const { target: previousTarget, revision: _oldRevision, baselineSha256: _oldHash, ...priorEvidence } = previous;
  const { target: nextTarget, revision: _nextRevision, baselineSha256: _nextHash, ...nextEvidence } = next;
  void _oldRevision; void _oldHash; void _nextRevision; void _nextHash;
  if (receiptSha256 !== canonicalJsonSha256(body) || receipt.id !== `responsibility-baseline-rebind:${canonicalJsonSha256([receipt.runtimeReceiptId, previous.baselineSha256])}` ||
    next.revision !== previous.revision + 1 || nextTarget.tenantId !== previousTarget.tenantId || nextTarget.actorId !== previousTarget.actorId ||
    nextTarget.responsibilityId !== previousTarget.responsibilityId || nextTarget.responsibilityRevision <= previousTarget.responsibilityRevision ||
    nextTarget.reviewSha256 === previousTarget.reviewSha256 || canonicalJsonSha256(priorEvidence) !== canonicalJsonSha256(nextEvidence) || receipt.savedAt < previous.acceptedAt) throw storageInvalid();
  return receipt;
}
export async function rebindResponsibilityBaselineWithSql(sql: SqlClient, previousRuntime: ResponsibilityLifecycle, runtime: ResponsibilityRuntimeReceipt) {
  if (!sql.transactionScoped) throw storageInvalid();
  const current = runtime.snapshot; const owner = { tenantId: current.tenantId, actorId: current.actorId };
  const baseline = await readBaseline(sql, owner, current.responsibilityId);
  if (!baseline) return null;
  const receipt = buildBaselineRebind(baseline, previousRuntime, runtime); const next = receipt.next;
  await sql`INSERT INTO omni_responsibility_baseline_rebinds
    (id,tenant_id,actor_id,responsibility_id,runtime_receipt_id,revision,receipt,saved_at)
    VALUES (${receipt.id},${owner.tenantId},${owner.actorId},${current.responsibilityId},${runtime.id},${next.revision},${receipt}::jsonb,${receipt.savedAt})`;
  const rows = await sql`UPDATE omni_responsibility_baselines SET revision = ${next.revision}, responsibility_revision = ${next.target.responsibilityRevision},
      review_sha256 = ${next.target.reviewSha256}, baseline_sha256 = ${next.baselineSha256}, snapshot = ${next}::jsonb
    WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${current.responsibilityId}
      AND revision = ${baseline.revision} AND baseline_sha256 = ${baseline.baselineSha256} RETURNING *`;
  if (rows.length !== 1 || baselineFromRow(rows[0], owner, current.responsibilityId).baselineSha256 !== next.baselineSha256) throw storageInvalid();
  await appendScopedDomainEvent({ id: receipt.id, streamId: `responsibility:${owner.tenantId}:${current.responsibilityId}`, type: "responsibility.baseline.rebound",
    executionScope: createExecutionScope({ tenantId: owner.tenantId, initiatingActorId: owner.actorId, executingPrincipalType: "user", executingPrincipalId: owner.actorId,
      correlationId: runtime.id, causationId: runtime.id, purpose: "responsibility.baseline.rebind.v1" }),
    payload: baselineRebindEventPayload(receipt),
  }, { sql });
  return receipt;
}
export function baselineRebindEventPayload(receipt: BaselineRebindReceipt) {
  return { schemaVersion: 1, responsibilityId: receipt.next.target.responsibilityId, runtimeReceiptId: receipt.runtimeReceiptId,
    receiptId: receipt.id, receiptSha256: receipt.receiptSha256, previousRevision: receipt.previous.revision, revision: receipt.next.revision,
    previousBaselineSha256: receipt.previous.baselineSha256, baselineSha256: receipt.next.baselineSha256,
    observationId: receipt.next.observationId, observationCreated: false, semanticChanged: false };
}
