import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import type { SqlClient, SqlRow } from "@/lib/db/sql-types";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { instantSchema } from "./contracts";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY } from "./comparison-policy";
import {
  responsibilityBaselineSchema, responsibilityObservationReceiptSchema, responsibilityObservationRequestSchema,
  type ResponsibilityBaseline, type ResponsibilityObservationReceipt, type ResponsibilityObservationRequest, type ResponsibilityObservationResult,
} from "./observation-contracts";
import { assertAdmittedObservationPlan, createResponsibilityObservationPipeline, responsibilityObservationEventPayload, type AuthoritativeResponsibilityReader } from "./observation-state";
import { idempotencySha256, notFound, ResponsibilityError, storageInvalid, verifiedRecord, type ResponsibilityOwner } from "./state";

export type TransactionalObservationReader = (input: Parameters<AuthoritativeResponsibilityReader>[0], sql: SqlClient) => Promise<unknown>;
export type ResponsibilityObservationStore = {
  history(owner: ResponsibilityOwner, id: string, limit: number): Promise<{ receipts: ResponsibilityObservationReceipt[]; baseline: ResponsibilityBaseline | null; hasMore: boolean }>;
  observe(owner: ResponsibilityOwner, request: ResponsibilityObservationRequest, key: string, read: TransactionalObservationReader, now: string): Promise<ResponsibilityObservationResult>;
};

async function scoped<T>(owner: ResponsibilityOwner, callback: () => Promise<T>) {
  if (!hasDatabaseUrl()) throw new ResponsibilityError("Responsibility observations require durable database storage.", 503, "responsibility_storage_unavailable");
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(owner.tenantId, [owner.actorId], callback);
}

/** Bounded receipt history only. Reading never observes sources or advances a head. */
export async function readResponsibilityObservationHistory(owner: ResponsibilityOwner, id: string, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw conflict("responsibility_limit_invalid", 400);
  return scoped(owner, async () => await getSql().transaction(async (sql: SqlClient) => {
    await lockOwner(sql, owner);
    await readDraft(sql, owner, id);
    const rows = await sql`SELECT * FROM omni_responsibility_observations
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${id}
      ORDER BY saved_at DESC, id ASC LIMIT ${limit + 1}`;
    return { receipts: rows.slice(0, limit).map((row) => receiptFromRow(row, owner, id)),
      baseline: await readBaseline(sql, owner, id), hasMore: rows.length > limit };
  }) as { receipts: ResponsibilityObservationReceipt[]; baseline: ResponsibilityBaseline | null; hasMore: boolean });
}

/** Internal admission only: all reads run inside the owner/CAS transaction.
 * The supplied adapter is server code, never request JSON. Its Meeting head
 * locks protect exact revision, visibility and consent until the co-commit.
 * This writer has no scheduler, tool, model, delivery or activation path.
 */
export async function recordResponsibilityObservation(owner: ResponsibilityOwner, input: ResponsibilityObservationRequest, key: string, read: TransactionalObservationReader, now: string): Promise<ResponsibilityObservationResult> {
  return scoped(owner, async () => await getSql().transaction((sql: SqlClient) =>
    recordResponsibilityObservationWithSql(sql, owner, input, key, read, now)) as ResponsibilityObservationResult);
}

/** Joins an already-owned transaction for the generation-fenced read-only
 * runtime. It never opens or commits a transaction, and retains the same owner,
 * review, baseline, source and immutable replay checks as manual admission. */
export async function recordResponsibilityObservationWithSql(sql: SqlClient, owner: ResponsibilityOwner, input: ResponsibilityObservationRequest, key: string, read: TransactionalObservationReader, now: string): Promise<ResponsibilityObservationResult> {
  if (!sql.transactionScoped) throw new ResponsibilityError("Observation admission requires a managed transaction.", 503, "responsibility_transaction_required");
  const request = responsibilityObservationRequestSchema.parse(input);
  const keySha256 = idempotencySha256(key);
  const requestSha256 = canonicalJsonSha256({ owner, request });
  const observedAt = instantSchema.parse(now);
    await lockOwner(sql, owner);
    const rows = await sql`SELECT * FROM omni_responsibility_observations
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND idempotency_sha256 = ${keySha256} LIMIT 2`;
    if (rows.length > 1) throw storageInvalid();
    if (rows[0]) {
      const receipt = receiptFromRow(rows[0], owner);
      if (receipt.requestSha256 !== requestSha256) throw conflict("responsibility_observation_idempotency_conflict");
      // Replay stays inspectable after draft edits, source revocation or expiry.
      return { receipt, currentBaseline: await readBaseline(sql, owner, request.responsibilityId), replayed: true };
    }
    const record = await readDraft(sql, owner, request.responsibilityId);
    if (record.state !== "reviewed" || !record.review || record.revision !== request.expectedResponsibilityRevision || record.review.reviewSha256 !== request.expectedReviewSha256 ||
      request.policySha256 !== RESPONSIBILITY_MEETING_COMPARISON_POLICY.policySha256) throw conflict("responsibility_observation_review_changed");
    const baseline = await readBaseline(sql, owner, record.id);
    if ((baseline?.revision ?? 0) !== request.expectedBaselineRevision) throw conflict("responsibility_baseline_revision_conflict");
    // The managed SQL client owns transaction control. A non-SQL adapter
    // failure becomes safe failed evidence in the pipeline. A SQL failure
    // aborts this transaction: its subsequent write rejects and the manager
    // rolls everything back, so no receipt or baseline advancement is claimed.
    const flow = createResponsibilityObservationPipeline({ record, policySha256: request.policySha256,
      readAuthoritativeSource: (source) => read(source, sql) });
    const plan = flow.plan(await flow.read({ observationKey: key, observedAt }), baseline, request.expectedBaselineRevision);
    assertAdmittedObservationPlan(plan);
    const body = { schemaVersion: 1 as const, request, requestSha256, plan, savedAt: observedAt };
    const receipt = verifiedObservationReceipt({ ...body, receiptSha256: canonicalJsonSha256(body) });
    const target = plan.observation.target;
    await sql`INSERT INTO omni_responsibility_observations
      (schema_version, id, tenant_id, actor_id, responsibility_id, idempotency_sha256, request_sha256,
       responsibility_revision, review_sha256, expected_baseline_revision, policy_sha256, outcome, receipt, saved_at)
      VALUES (1, ${plan.observation.id}, ${owner.tenantId}, ${owner.actorId}, ${record.id}, ${keySha256}, ${requestSha256},
        ${target.responsibilityRevision}, ${target.reviewSha256}, ${plan.expectedBaselineRevision}, ${plan.observation.policySha256}, ${plan.outcome}, ${receipt}::jsonb, ${receipt.savedAt})`;
    if (plan.change) {
      const change = plan.change;
      await sql`INSERT INTO omni_responsibility_changes
        (schema_version, id, tenant_id, actor_id, responsibility_id, observation_id, change_sha256, snapshot, saved_at)
        VALUES (1, ${change.id}, ${owner.tenantId}, ${owner.actorId}, ${record.id}, ${plan.observation.id}, ${change.changeSha256}, ${change}::jsonb, ${receipt.savedAt})`;
    }
    if (plan.nextBaseline) {
      const next = plan.nextBaseline;
      const saved = baseline ? await sql`UPDATE omni_responsibility_baselines
        SET revision = ${next.revision}, responsibility_revision = ${target.responsibilityRevision}, review_sha256 = ${target.reviewSha256},
          policy_sha256 = ${next.policySha256}, observation_id = ${next.observationId}, baseline_sha256 = ${next.baselineSha256}, snapshot = ${next}::jsonb, accepted_at = ${next.acceptedAt}
        WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${record.id} AND revision = ${request.expectedBaselineRevision} RETURNING *`
        : await sql`INSERT INTO omni_responsibility_baselines
          (schema_version, tenant_id, actor_id, responsibility_id, revision, responsibility_revision, review_sha256, policy_sha256, observation_id, baseline_sha256, snapshot, accepted_at)
          VALUES (1, ${owner.tenantId}, ${owner.actorId}, ${record.id}, ${next.revision}, ${target.responsibilityRevision}, ${target.reviewSha256}, ${next.policySha256}, ${next.observationId}, ${next.baselineSha256}, ${next}::jsonb, ${next.acceptedAt}) RETURNING *`;
      if (saved.length !== 1 || baselineFromRow(saved[0], owner, record.id).baselineSha256 !== next.baselineSha256) throw conflict("responsibility_baseline_revision_conflict");
    }
    await appendScopedDomainEvent({ id: plan.observation.id, streamId: `responsibility:${owner.tenantId}:${record.id}`, type: "responsibility.observation.recorded",
      executionScope: createExecutionScope({ tenantId: owner.tenantId, initiatingActorId: owner.actorId, executingPrincipalType: "user", executingPrincipalId: owner.actorId,
        correlationId: plan.observation.id, purpose: "responsibility.observation.v1" }), payload: responsibilityObservationEventPayload(plan),
    }, { sql });
    return { receipt, currentBaseline: plan.nextBaseline ?? baseline, replayed: false };
}

async function lockOwner(sql: SqlClient, owner: ResponsibilityOwner) {
  // Identical to 6.1; draft review changes cannot race the observation co-commit.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["responsibility-draft:1", owner.tenantId, owner.actorId])}, 0))`;
}
async function readDraft(sql: SqlClient, owner: ResponsibilityOwner, id: string) {
  const rows = await sql`SELECT * FROM omni_responsibilities WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND id = ${id} FOR UPDATE`;
  if (!rows.length) throw notFound();
  if (rows.length !== 1) throw storageInvalid();
  const row = rows[0]; const record = verifiedRecord(row.snapshot);
  if (row.schema_version !== 1 || row.tenant_id !== owner.tenantId || row.actor_id !== owner.actorId || row.id !== id || record.id !== id ||
    record.tenantId !== owner.tenantId || record.actorId !== owner.actorId || Number(row.revision) !== record.revision || row.state !== record.state || row.draft_sha256 !== record.draftSha256 ||
    instant(row.created_at) !== record.createdAt || instant(row.updated_at) !== record.updatedAt) throw storageInvalid();
  return record;
}
async function readBaseline(sql: SqlClient, owner: ResponsibilityOwner, id: string) {
  const rows = await sql`SELECT * FROM omni_responsibility_baselines WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND responsibility_id = ${id} FOR UPDATE`;
  if (rows.length > 1) throw storageInvalid();
  return rows[0] ? baselineFromRow(rows[0], owner, id) : null;
}
export function verifiedObservationReceipt(value: unknown): ResponsibilityObservationReceipt {
  const checked = responsibilityObservationReceiptSchema.safeParse(value);
  if (!checked.success) throw storageInvalid();
  const receipt = checked.data; const { receiptSha256, ...body } = receipt;
  const { observationSha256, ...observationBody } = receipt.plan.observation;
  const { request, plan } = receipt; const target = plan.observation.target;
  const owner = { tenantId: target.tenantId, actorId: target.actorId };
  if (receiptSha256 !== canonicalJsonSha256(body) || observationSha256 !== canonicalJsonSha256(observationBody) ||
    plan.observation.id !== `responsibility-observation:${canonicalJsonSha256([target, plan.observation.observationKeySha256])}` ||
    receipt.requestSha256 !== canonicalJsonSha256({ owner, request }) || request.responsibilityId !== target.responsibilityId || request.expectedResponsibilityRevision !== target.responsibilityRevision ||
    request.expectedReviewSha256 !== target.reviewSha256 || request.policySha256 !== plan.observation.policySha256 || request.expectedBaselineRevision !== plan.expectedBaselineRevision || receipt.savedAt !== plan.observation.observedAt) throw storageInvalid();
  const advancing = ["baseline_established", "no_change", "material_change"].includes(plan.outcome);
  const complete = plan.observation.state === "complete";
  if (complete !== Boolean(plan.observation.semantic) || (complete && (plan.observation.failureReasons.length || plan.observation.sources.some((source) => source.state !== "accepted"))) ||
    (!complete && (!plan.observation.failureReasons.length || (plan.outcome !== plan.observation.state && !(plan.outcome === "insufficient_evidence" && plan.reasons.includes("observation_outdated")))))) throw storageInvalid();
  if (advancing !== Boolean(plan.nextBaseline) || (plan.outcome === "material_change") !== Boolean(plan.change) ||
    (advancing && (plan.observation.state !== "complete" || !plan.observation.semantic)) ||
    (plan.outcome === "baseline_established" && plan.expectedBaselineRevision !== 0) ||
    (["material_change", "no_change"].includes(plan.outcome) && plan.expectedBaselineRevision === 0)) throw storageInvalid();
  if (plan.observation.semantic) verifySemantic(plan.observation.semantic);
  if (plan.nextBaseline) {
    const next = verifiedBaseline(plan.nextBaseline);
    if (next.revision !== plan.expectedBaselineRevision + 1 || canonicalJsonSha256(next.target) !== canonicalJsonSha256(target) || next.policySha256 !== request.policySha256 ||
      next.observationId !== plan.observation.id || next.observationSha256 !== observationSha256 || next.acceptedAt !== receipt.savedAt || canonicalJsonSha256(next.semantic) !== canonicalJsonSha256(plan.observation.semantic)) throw storageInvalid();
  }
  if (plan.change) {
    const { changeSha256, ...change } = plan.change;
    if (changeSha256 !== canonicalJsonSha256(change) || canonicalJsonSha256(change.target) !== canonicalJsonSha256(target) || change.policySha256 !== request.policySha256 ||
      change.observationId !== plan.observation.id || change.semanticSha256 !== plan.observation.semantic?.semanticSha256 ||
      change.id !== `responsibility-change:${canonicalJsonSha256([target, request.policySha256, change.previousBaselineSha256, change.semanticSha256])}`) throw storageInvalid();
  }
  return receipt;
}
function receiptFromRow(row: SqlRow, owner: ResponsibilityOwner, id?: string) {
  const receipt = verifiedObservationReceipt(row.receipt); const observation = receipt.plan.observation;
  if (row.schema_version !== 1 || row.tenant_id !== owner.tenantId || row.actor_id !== owner.actorId || observation.target.tenantId !== owner.tenantId || observation.target.actorId !== owner.actorId ||
    (id !== undefined && observation.target.responsibilityId !== id) || row.responsibility_id !== observation.target.responsibilityId || row.id !== observation.id || row.idempotency_sha256 !== observation.observationKeySha256 ||
    row.request_sha256 !== receipt.requestSha256 || Number(row.responsibility_revision) !== observation.target.responsibilityRevision || row.review_sha256 !== observation.target.reviewSha256 ||
    Number(row.expected_baseline_revision) !== receipt.plan.expectedBaselineRevision || row.policy_sha256 !== observation.policySha256 || row.outcome !== receipt.plan.outcome || instant(row.saved_at) !== receipt.savedAt) throw storageInvalid();
  return receipt;
}
function baselineFromRow(row: SqlRow, owner: ResponsibilityOwner, id: string) {
  const baseline = verifiedBaseline(row.snapshot);
  if (row.schema_version !== 1 || row.tenant_id !== owner.tenantId || row.actor_id !== owner.actorId || row.responsibility_id !== id || baseline.target.tenantId !== owner.tenantId || baseline.target.actorId !== owner.actorId || baseline.target.responsibilityId !== id ||
    Number(row.revision) !== baseline.revision || Number(row.responsibility_revision) !== baseline.target.responsibilityRevision || row.review_sha256 !== baseline.target.reviewSha256 ||
    row.policy_sha256 !== baseline.policySha256 || row.observation_id !== baseline.observationId || row.baseline_sha256 !== baseline.baselineSha256 || instant(row.accepted_at) !== baseline.acceptedAt) throw storageInvalid();
  return baseline;
}
function verifiedBaseline(value: unknown) {
  const checked = responsibilityBaselineSchema.safeParse(value); if (!checked.success) throw storageInvalid();
  const { baselineSha256, ...body } = checked.data;
  if (canonicalJsonSha256(body) !== baselineSha256) throw storageInvalid(); verifySemantic(body.semantic);
  return checked.data;
}
function verifySemantic(value: ResponsibilityBaseline["semantic"]) { const { semanticSha256, ...body } = value; if (canonicalJsonSha256(body) !== semanticSha256) throw storageInvalid(); }
function instant(value: unknown) { return value instanceof Date ? value.toISOString() : value; }
function conflict(code: string, status: 400 | 409 = 409) { return new ResponsibilityError("The responsibility observation request or baseline changed.", status, code); }
