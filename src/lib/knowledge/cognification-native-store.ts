import { databaseMemoryAccessScopeFromExecutionScope, setTransactionLocalDatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { collectCognificationEvidenceRefs, renderCognificationCandidateReview } from "@/lib/knowledge/cognification-contract";
import { recordFromRow, reviewKnowledgeCognition, type KnowledgeCognitionRecord } from "@/lib/knowledge/cognification-store";
import { buildKnowledgeCognitionNativeIntent, KNOWLEDGE_COGNITION_NATIVE_POLICY_SHA256, knowledgeCognitionNativeAcceptanceSchema,
  knowledgeCognitionNativeIdSchema, knowledgeCognitionNativeIntentSchema, knowledgeCognitionNativeRecordSchema, sealKnowledgeCognitionNativeAcceptance,
  sealKnowledgeCognitionNativePin, type KnowledgeCognitionNativeAcceptance,
  type KnowledgeCognitionNativeRecord, type KnowledgeCognitionNativeRequest } from "@/lib/knowledge/cognification-native-contracts";
import { buildUserPrivateMemoryAccessBindingV1, MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { privateActionAcceptanceId, privateActionShaSchema, samePrivateActionValue, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import { assertNativePrivateActionMutation, lockNativePrivateActionGraph, nativePrivateActionFail as fail, nativePrivateActionTransaction,
  type NativePrivateActionAuthority, type PrivateActionSql as Sql } from "@/lib/memory/private-action-store";
import { saveMemoryWithCommitStatusInTransaction, type CreateMemoryInput } from "@/lib/memory/store";
import { memoryTierRetentionExpiresAt } from "@/lib/memory/tier-policy";
import type { MemoryRecord } from "@/lib/memory/types";
import { getActorOwnedKnowledgeForCognition } from "@/lib/rag/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type Current = { record: KnowledgeCognitionRecord; view: KnowledgeCognitionNativeRecord };
function readOnly(authority: NativePrivateActionAuthority) {
  if (authority.executionScope) fail("Source-map reads require read-only authority.", "knowledge_cognition_read", 400);
}
async function current(sql: Sql, scope: PrivateActionScope, reviewId: string): Promise<Current | null> {
  // The shared graph fence precedes source/document/candidate parent locks,
  // matching Knowledge ingestion/deletion and Memory writers.
  await lockNativePrivateActionGraph(sql, scope.tenantId);
  const first = await sql`SELECT document_id,source_item_id FROM omni_knowledge_cognition_candidates
    WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND id=${reviewId}`;
  if (first.length !== 1) return null;
  const sourceRows = await sql`SELECT to_jsonb(item) AS item,to_jsonb(revision) AS revision FROM omni_source_items item
    JOIN omni_source_revisions revision ON revision.tenant_id=item.tenant_id AND revision.id=item.current_revision_id
    WHERE item.tenant_id=${scope.tenantId} AND item.id=${String(first[0].source_item_id)} AND item.owner_actor_id=${scope.ownerActorId}
      AND revision.owner_actor_id=${scope.ownerActorId} AND item.visibility='user_private' AND revision.visibility='user_private'
    FOR SHARE OF item`;
  if (sourceRows.length !== 1) return null;
  const documents = await sql`SELECT id FROM omni_knowledge_documents WHERE tenant_id=${scope.tenantId}
    AND id=${String(first[0].document_id)} AND source_item_id=${String(first[0].source_item_id)} FOR SHARE`;
  if (documents.length !== 1) return null;
  const rows = await sql`SELECT * FROM omni_knowledge_cognition_candidates WHERE tenant_id=${scope.tenantId}
    AND owner_actor_id=${scope.ownerActorId} AND id=${reviewId} FOR UPDATE`;
  if (rows.length !== 1) return null;
  const record = recordFromRow(rows[0]), c = record.candidate;
  if (c.documentId !== first[0].document_id || c.sourceItemId !== first[0].source_item_id ||
    c.retentionExpiresAt && Date.parse(c.retentionExpiresAt) <= Date.now()) return null;
  const source = await getActorOwnedKnowledgeForCognition({ tenantId: scope.tenantId, actorId: scope.ownerActorId, documentId: c.documentId, sql });
  if (!source) return null;
  const allowed: ("confirm" | "dismiss")[] = [];
  if (record.status === "pending_review") {
    if (source.sourceRevisionId === c.sourceRevisionId && source.retentionExpiresAt === c.retentionExpiresAt) allowed.push("confirm");
    allowed.push("dismiss");
  }
  const sourcePolicySha256 = canonicalJsonSha256({ ...sourceRows[0], retentionExpiresAt: source.retentionExpiresAt,
    chunks: source.chunks.map((chunk) => ({ id: chunk.id, evidenceUnitId: chunk.evidenceUnitId, sourceRevisionId: chunk.sourceRevisionId,
      contentSha256: canonicalJsonSha256(chunk.content) })) });
  const pin = sealKnowledgeCognitionNativePin({ candidateId: c.batchId, candidateSha256: c.contractSha256,
    documentId: c.documentId, sourceItemId: source.sourceItemId, sourceRevisionId: source.sourceRevisionId, sourcePolicySha256,
    retentionExpiresAt: source.retentionExpiresAt, reviewStateSha256: canonicalJsonSha256({ status: record.status,
      reviewDecision: record.reviewDecision, reviewedAt: record.reviewedAt, updatedAt: record.updatedAt }),
    policySha256: KNOWLEDGE_COGNITION_NATIVE_POLICY_SHA256 });
  const view = knowledgeCognitionNativeRecordSchema.parse({ id: c.batchId, documentId: c.documentId, sourceTitle: source.document.title,
    status: record.status, decision: record.reviewDecision, createdAt: record.createdAt, updatedAt: record.updatedAt, reviewedAt: record.reviewedAt,
    batchIndex: c.batchIndex, batchCount: c.batchCount, summary: { text: c.summary.text, confidenceBasisPoints: c.summary.confidenceBasisPoints,
      evidence: c.summary.evidence.map(({ quote }) => ({ quote })) }, topics: c.topics.map(({ label }) => ({ label })),
    claims: c.claims.map(({ statement }) => ({ statement })), entities: c.entities.map(({ canonicalLabel }) => ({ canonicalLabel })),
    relations: c.relations.map(({ statement }) => ({ statement })), allowedDecisions: allowed, review: allowed.length ? pin : null,
    projection: record.status !== "confirmed" ? "not_requested" : record.projectedMemoryId ? "completed" : "unconfirmed" });
  return { record, view };
}
async function accepted(sql: Sql, scope: PrivateActionScope, keySha256: string) {
  const rows = await sql`SELECT operation,resource_id,intent,acceptance FROM omni_native_private_memory_actions
    WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${keySha256}`;
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0].operation !== "knowledge.cognition.decide") fail("This key belongs to another accepted private action.");
  const intent = knowledgeCognitionNativeIntentSchema.parse(rows[0].intent), acceptance = knowledgeCognitionNativeAcceptanceSchema.parse(rows[0].acceptance);
  if (!samePrivateActionValue(intent.scope, scope) || !samePrivateActionValue(acceptance.scope, scope) || intent.keySha256 !== keySha256 ||
    acceptance.keySha256 !== keySha256 || intent.resourceId !== rows[0].resource_id || acceptance.resourceId !== intent.resourceId ||
    acceptance.requestSha256 !== canonicalJsonSha256(intent) || acceptance.reviewSha256 !== intent.request.review.reviewSha256 ||
    acceptance.result.decision !== intent.request.decision) fail("Stored source-map acceptance is inconsistent.");
  return { intent, acceptance };
}
function verifyObserved(value: Current, acceptance: KnowledgeCognitionNativeAcceptance) {
  if (value.record.status !== acceptance.result.status || value.record.reviewDecision !== acceptance.result.decision ||
    value.record.reviewedAt !== acceptance.acceptedAt || value.record.candidate.batchId !== acceptance.resourceId) fail("Current source-map state precedes its acceptance.");
}
export async function listNativeKnowledgeCognitionReviews(authority: NativePrivateActionAuthority, input: { status: "pending_review" | "confirmed" | "dismissed"; limit: number }) {
  readOnly(authority);
  return nativePrivateActionTransaction(authority, false, async (sql) => {
    const rows = await sql`SELECT id FROM omni_knowledge_cognition_candidates WHERE tenant_id=${authority.scope.tenantId}
      AND owner_actor_id=${authority.scope.ownerActorId} AND status=${input.status} ORDER BY created_at DESC,id COLLATE "C" LIMIT ${input.limit}`;
    const reviews: KnowledgeCognitionNativeRecord[] = [];
    for (const row of rows) { const value = await current(sql, authority.scope, String(row.id)); if (value) reviews.push(value.view); }
    return reviews;
  });
}
export async function readNativeKnowledgeCognitionReview(authority: NativePrivateActionAuthority, reviewId: string) {
  readOnly(authority); knowledgeCognitionNativeIdSchema.parse(reviewId);
  return nativePrivateActionTransaction(authority, false, async (sql) => (await current(sql, authority.scope, reviewId))?.view ?? null);
}
export async function readNativeKnowledgeCognitionDecision(authority: NativePrivateActionAuthority, reviewId: string, keySha256: string) {
  readOnly(authority); knowledgeCognitionNativeIdSchema.parse(reviewId); privateActionShaSchema.parse(keySha256);
  return nativePrivateActionTransaction(authority, false, async (sql) => {
    const value = await current(sql, authority.scope, reviewId);
    if (!value) fail("The exact owned source map is unavailable.", "knowledge_cognition_not_found", 404);
    const stored = await accepted(sql, authority.scope, keySha256);
    if (stored && stored.acceptance.resourceId !== reviewId) fail("This key belongs to another source map.");
    if (stored) verifyObserved(value, stored.acceptance);
    return { review: value.view, acceptance: stored?.acceptance ?? null };
  });
}
function reviewedMemoryInput(value: Current, scope: PrivateActionScope, executionScope: NonNullable<NativePrivateActionAuthority["executionScope"]>): CreateMemoryInput {
  const c = value.record.candidate;
  const memoryExecutionScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.canonicalActorId,
    executingPrincipalType: "user", executingPrincipalId: scope.canonicalActorId, correlationId: executionScope.correlationId,
    causationId: c.batchId, purpose: "knowledge.cognition.review.confirm" });
  const retention = [c.retentionExpiresAt, memoryTierRetentionExpiresAt("summary", value.record.createdAt)].filter((v): v is string => !!v).sort()[0];
  if (retention && Date.parse(retention) <= Date.now()) fail("The reviewed source map has expired.");
  return { id: `memory:${c.batchId}`, tenantId: scope.tenantId, type: "knowledge", tier: "summary", formationReason: "source_cognition",
    title: `Reviewed source map · ${value.view.sourceTitle}`.slice(0,240), content: renderCognificationCandidateReview(c).replace(
      "Cognification review candidate — not canonical until confirmed", "Reviewed source cognition"), tags: ["cognified","reviewed","source-map"],
    scope: "user", source: `cognify-reviewed:${c.batchId}`, importance: 0.78, confidence: c.summary.confidenceBasisPoints/10000,
    claimStatus: "active", assertedBy: "user", evidenceRefs: [`knowledge:${c.documentId}`,`source-revision:${c.sourceRevisionId}`,
      `cognition-review:${c.batchId}`,`model-usage:${c.modelAttribution.usageReceiptId}`,...collectCognificationEvidenceRefs(c)],
    retentionExpiresAt: retention, accessBinding: buildUserPrivateMemoryAccessBindingV1({ tenantId: scope.tenantId,
      ownerActorId: scope.canonicalActorId, originPurpose: "knowledge.cognition.review.confirm", accessBoundAt: value.record.createdAt }),
    databaseAccessScope: databaseMemoryAccessScopeFromExecutionScope(memoryExecutionScope, { purposeId: MEMORY_PURPOSE_IDS.correct,
      auditPurpose: "knowledge.cognition.review.confirm" }), executionScope: memoryExecutionScope, formationOrigin: "reviewed_source_cognition" };
}
export async function decideNativeKnowledgeCognition(input: { authority: NativePrivateActionAuthority; reviewId: string;
  request: KnowledgeCognitionNativeRequest; idempotencyKey: string }) {
  const { authority } = input, scope = authority.scope;
  const executionScope = assertNativePrivateActionMutation(authority, "knowledge.cognition.review", input.reviewId);
  const intent = buildKnowledgeCognitionNativeIntent({ ...input, scope });
  return nativePrivateActionTransaction(authority, true, async (sql) => {
    await lockNativePrivateActionGraph(sql, scope.tenantId);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`private-action:${scope.tenantId}:${scope.ownerActorId}:${intent.keySha256}`},0))`;
    const value = await current(sql, scope, input.reviewId);
    if (!value) fail("The exact owned source map is unavailable.", "knowledge_cognition_not_found", 404);
    const replay = await accepted(sql, scope, intent.keySha256);
    if (replay) {
      if (!samePrivateActionValue(replay.intent, intent)) fail("This key already accepted a different source-map decision.");
      verifyObserved(value, replay.acceptance);
      return { review: value.view, acceptance: replay.acceptance, replayed: true, memory: null as MemoryRecord | null, memoryExecutionScope: null as CreateMemoryInput["executionScope"] | null };
    }
    if (!value.view.review || !samePrivateActionValue(value.view.review, intent.request.review) || !value.view.allowedDecisions.includes(intent.request.decision)) {
      fail("The source or review changed. Refresh the exact source map before deciding.");
    }
    let memory: MemoryRecord | null = null, memoryExecutionScope: CreateMemoryInput["executionScope"] | null = null;
    if (intent.request.decision === "confirm") {
      const memoryInput = reviewedMemoryInput(value, scope, executionScope);
      await setTransactionLocalDatabaseMemoryAccessScope(sql, memoryInput.databaseAccessScope!);
      const existing = await sql`SELECT id FROM omni_memories WHERE tenant_id=${scope.tenantId} AND id=${memoryInput.id} FOR UPDATE`;
      if (existing.length) fail("A Memory already exists for this source map without this accepted decision.");
      const saved = await saveMemoryWithCommitStatusInTransaction(memoryInput, sql, { databaseAccessScopeAlreadyEntered: true });
      if (!saved.inserted) fail("The reviewed Memory was not newly committed.");
      memory = saved.record; memoryExecutionScope = memoryInput.executionScope;
      const target = await sql`SELECT lifecycle_target_revision FROM omni_memories WHERE tenant_id=${scope.tenantId} AND id=${memory.id}`;
      if (target.length !== 1 || Number(target[0].lifecycle_target_revision) !== 1) fail("The reviewed Memory was not created at its first revision.");
    }
    const reviewed = await reviewKnowledgeCognition({ id: input.reviewId, tenantId: scope.tenantId, actorId: scope.ownerActorId,
      decision: intent.request.decision, reviewedBy: scope.ownerActorId, reviewMetadata: { reviewSurface: "native_source_map",
        canonicalOwnerActorId: scope.canonicalActorId, nativeKeySha256: intent.keySha256 }, executionScope, sql });
    const acceptance = sealKnowledgeCognitionNativeAcceptance({ contract: "asael-knowledge-cognition-acceptance:1",
      id: privateActionAcceptanceId(scope, intent.keySha256), operation: intent.operation, scope, resourceId: input.reviewId, keySha256: intent.keySha256,
      requestSha256: canonicalJsonSha256(intent), reviewSha256: intent.request.review.reviewSha256, acceptedAt: reviewed.reviewedAt!,
      result: { decision: intent.request.decision, status: intent.request.decision === "confirm" ? "confirmed" : "dismissed",
        memoryId: memory?.id ?? null, memoryTargetRevision: memory ? 1 : null } });
    await sql`INSERT INTO omni_native_private_memory_actions(tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,operation,resource_id,
      request_sha256,intent,acceptance,source_document_id,cognition_review_id,target_memory_id,accepted_at)
      VALUES(${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},${intent.operation},${input.reviewId},
        ${acceptance.requestSha256},${intent}::JSONB,${acceptance}::JSONB,${value.record.candidate.documentId},${input.reviewId},${memory?.id ?? null},${acceptance.acceptedAt})`;
    await appendScopedDomainEvent({ id: acceptance.id, streamId: `native-private-memory:${scope.ownerActorId}`,
      type: "private_memory.native_action.accepted", executionScope, payload: { schemaVersion: 1, operation: intent.operation,
        acceptanceSha256: acceptance.acceptanceSha256, requestSha256: acceptance.requestSha256 } }, { sql });
    const refreshed = await current(sql, scope, input.reviewId);
    if (!refreshed) fail("The source map could not be observed after its decision.");
    return { review: refreshed.view, acceptance, replayed: false, memory, memoryExecutionScope };
  });
}
