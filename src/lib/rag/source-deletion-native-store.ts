import { z } from "zod";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { retireEntityEvidenceLineage, retireEntityMemoryLineage } from "@/lib/entities/store";
import { queueTemporalRelationProjection } from "@/lib/entities/relation-projection-queue";
import { privateActionAcceptanceId, privateActionIdSchema, privateActionShaSchema, samePrivateActionValue, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import { assertNativePrivateActionMutation, lockNativePrivateActionGraph, nativePrivateActionFail as fail, nativePrivateActionTransaction,
  type NativePrivateActionAuthority, type PrivateActionSql as Sql } from "@/lib/memory/private-action-store";
import { knowledgeDeletionTargetId } from "@/lib/rag/deletion-events";
import { buildNativeKnowledgeSourceDeletionIntent, NATIVE_KNOWLEDGE_SOURCE_DELETION_POLICY_SHA256, NATIVE_KNOWLEDGE_SOURCE_PREFIXES,
  nativeKnowledgeSourceDeletionAcceptanceSchema, nativeKnowledgeSourceDeletionIntentSchema, nativeKnowledgeSourceDeletionReviewSchema, nativeKnowledgeSourceKindSchema,
  sealNativeKnowledgeSourceDeletionAcceptance, sealNativeKnowledgeSourceDeletionPin, type NativeKnowledgeSourceDeletionRequest, type NativeKnowledgeSourceKind } from "@/lib/rag/source-deletion-native-contracts";
import { invalidateRunsForDeletedContext } from "@/lib/runs/context-invalidation";
import { deriveExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const lineageSchema = z.object({ targets: z.array(z.object({ id: privateActionIdSchema, targetRevision: z.number().int().min(1), lifecycleRevision: z.number().int().min(0),
  accessScopeSha256: privateActionShaSchema.nullable(), claimStatus: z.enum(["active","candidate","superseded","contradicted"]) }).strict()).max(2000),
  retrievalTraceIds: z.array(privateActionIdSchema).max(5001), graphNodeIds: z.array(privateActionIdSchema).max(5001), graphEdgeIds: z.array(privateActionIdSchema).max(5001),
  unsupported: z.boolean(), overflow: z.boolean() }).strict();
function readonly(authority: NativePrivateActionAuthority) { if (authority.executionScope) fail("Source deletion inspection requires read-only authority.", "knowledge_source_read", 400); }
function snapshot(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
async function lineage(sql: Sql, scope: PrivateActionScope, kind: NativeKnowledgeSourceKind, documentIds: string[], apply = false, retiredAt = new Date().toISOString()) {
  const rows = await sql`SELECT public.omni_native_knowledge_deletion_lineage_v1(${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},
    ${NATIVE_KNOWLEDGE_SOURCE_PREFIXES[kind]},${documentIds}::TEXT[],${apply},${retiredAt}::TIMESTAMPTZ) AS manifest`;
  return lineageSchema.parse(rows[0]?.manifest);
}
async function manifest(sql: Sql, scope: PrivateActionScope, kind: NativeKnowledgeSourceKind) {
  await lockNativePrivateActionGraph(sql, scope.tenantId);
  const prefix = NATIVE_KNOWLEDGE_SOURCE_PREFIXES[kind];
  const rows = await sql`SELECT document.id,document.title,document.content_hash,document.source,document.source_revision_id,document.chunk_count,document.updated_at,
    to_jsonb(item) AS source_item,to_jsonb(revision) AS source_revision,
    LEAST(item.retention_expires_at,revision.retention_expires_at) AS retention_expires_at
    FROM omni_knowledge_documents document JOIN omni_source_items item ON item.tenant_id=document.tenant_id AND item.id=document.source_item_id
    JOIN omni_source_revisions revision ON revision.tenant_id=document.tenant_id AND revision.id=document.source_revision_id AND revision.source_item_id=item.id
    WHERE document.tenant_id=${scope.tenantId} AND starts_with(document.source,${prefix})
      AND item.owner_actor_id=${scope.ownerActorId} AND revision.owner_actor_id=${scope.ownerActorId}
      AND item.visibility='user_private' AND revision.visibility='user_private'
    ORDER BY document.id COLLATE "C" LIMIT 501 FOR SHARE OF document,item`;
  if (rows.length > 500) return { review: nativeKnowledgeSourceDeletionReviewSchema.parse({ sourceKind: kind, localOnly: true,
    futureImportsMayReappear: true, eligible: false, reason: "scope_too_large", pin: null, documents: [] }), documents: [], evidence: [], lineage: null };
  const documentIds = rows.map((r) => String(r.id));
  const evidenceRows = await sql`SELECT DISTINCT evidence.id COLLATE "C" AS id,evidence.owner_actor_id,evidence.source_item_id,evidence.source_revision_id,
    evidence.evidence_content_sha256,evidence.permission_set_sha256,evidence.purpose_set_sha256,evidence.retention_expires_at
    FROM omni_knowledge_chunks chunk JOIN omni_evidence_units evidence ON evidence.tenant_id=chunk.tenant_id AND evidence.id=chunk.evidence_unit_id
    WHERE chunk.tenant_id=${scope.tenantId} AND chunk.document_id=ANY(${documentIds}::TEXT[])
    ORDER BY evidence.id COLLATE "C" LIMIT 20001`;
  if (evidenceRows.length > 20000) return { review: nativeKnowledgeSourceDeletionReviewSchema.parse({ sourceKind: kind, localOnly: true,
    futureImportsMayReappear: true, eligible: false, reason: "scope_too_large", pin: null, documents: [] }), documents: [], evidence: [], lineage: null };
  if (evidenceRows.some((row) => row.owner_actor_id !== scope.ownerActorId)) fail("The source evidence set crosses current ownership.");
  const linked = await lineage(sql, scope, kind, documentIds);
  const reason = linked.overflow ? "scope_too_large" : linked.unsupported ? "unsupported_memory_lineage" : null;
  const pin = reason ? null : sealNativeKnowledgeSourceDeletionPin({ sourceKind: kind, documentCount: rows.length, derivedMemoryCount: linked.targets.length,
    retrievalTraceCount: linked.retrievalTraceIds.length, graphNodeCount: linked.graphNodeIds.length, graphEdgeCount: linked.graphEdgeIds.length,
    manifestSha256: canonicalJsonSha256(snapshot({ documents: rows, evidence: evidenceRows, lineage: linked })), policySha256: NATIVE_KNOWLEDGE_SOURCE_DELETION_POLICY_SHA256 });
  const review = nativeKnowledgeSourceDeletionReviewSchema.parse({ sourceKind: kind, localOnly: true, futureImportsMayReappear: true,
    eligible: !reason, reason, pin, documents: rows.map((row) => { const expired = !!row.retention_expires_at && new Date(row.retention_expires_at as string).getTime() <= Date.now();
      return { id: String(row.id), title: expired ? "[Expired source]" : String(row.title), expired }; }) });
  return { review, documents: documentIds, evidence: evidenceRows, lineage: linked };
}
async function acceptance(sql: Sql, scope: PrivateActionScope, kind: NativeKnowledgeSourceKind, keySha256: string) {
  const rows = await sql`SELECT operation,resource_id,intent,acceptance FROM omni_native_private_memory_actions WHERE tenant_id=${scope.tenantId}
    AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${keySha256}`;
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0].operation !== "knowledge.source.delete") fail("This key belongs to another accepted private action.");
  const intent = nativeKnowledgeSourceDeletionIntentSchema.parse(rows[0].intent), accepted = nativeKnowledgeSourceDeletionAcceptanceSchema.parse(rows[0].acceptance), r = intent.request.review;
  if (!samePrivateActionValue(intent.scope,scope) || !samePrivateActionValue(accepted.scope,scope) || intent.keySha256 !== keySha256 || accepted.keySha256 !== keySha256 ||
    intent.resourceId !== rows[0].resource_id || accepted.resourceId !== intent.resourceId || r.sourceKind !== kind || accepted.result.sourceKind !== kind ||
    accepted.requestSha256 !== canonicalJsonSha256(intent) || accepted.reviewSha256 !== r.reviewSha256 || accepted.result.manifestSha256 !== r.manifestSha256 ||
    accepted.result.documents !== r.documentCount || accepted.result.memories !== r.derivedMemoryCount || accepted.result.retrievalTraces !== r.retrievalTraceCount ||
    accepted.result.graphNodes !== r.graphNodeCount || accepted.result.graphEdges !== r.graphEdgeCount) fail("Stored source deletion acceptance is inconsistent.");
  return { intent, acceptance: accepted };
}
export async function reviewNativeKnowledgeSourceDeletion(authority: NativePrivateActionAuthority, sourceKind: NativeKnowledgeSourceKind) {
  readonly(authority); const kind = nativeKnowledgeSourceKindSchema.parse(sourceKind);
  return nativePrivateActionTransaction(authority,false, async (sql) => (await manifest(sql,authority.scope,kind)).review);
}
export async function readNativeKnowledgeSourceDeletion(authority: NativePrivateActionAuthority, sourceKind: NativeKnowledgeSourceKind, keySha256: string) {
  readonly(authority); const kind = nativeKnowledgeSourceKindSchema.parse(sourceKind); privateActionShaSchema.parse(keySha256);
  return nativePrivateActionTransaction(authority,false, async (sql) => (await acceptance(sql,authority.scope,kind,keySha256))?.acceptance ?? null);
}
export async function deleteNativeKnowledgeSource(input: { authority: NativePrivateActionAuthority; sourceKind: NativeKnowledgeSourceKind;
  request: NativeKnowledgeSourceDeletionRequest; idempotencyKey: string }) {
  const { authority } = input, scope = authority.scope;
  const intent = buildNativeKnowledgeSourceDeletionIntent({ ...input, scope });
  const execution = assertNativePrivateActionMutation(authority,"knowledge.delete_source",knowledgeDeletionTargetId(NATIVE_KNOWLEDGE_SOURCE_PREFIXES[input.sourceKind]));
  return nativePrivateActionTransaction(authority,true,async (sql) => {
    await lockNativePrivateActionGraph(sql,scope.tenantId);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`private-action:${scope.tenantId}:${scope.ownerActorId}:${intent.keySha256}`},0))`;
    const replay = await acceptance(sql,scope,input.sourceKind,intent.keySha256);
    if (replay) { if (!samePrivateActionValue(intent,replay.intent)) fail("This key already accepted another source deletion."); return { acceptance: replay.acceptance, replayed: true }; }
    const current = await manifest(sql,scope,input.sourceKind), pin = current.review.pin;
    if (!pin || !current.lineage || !samePrivateActionValue(pin,intent.request.review)) fail("The complete local source set changed or exceeds this action's authority. Review it again.");
    const acceptedAt = new Date().toISOString();
    const retired = await lineage(sql,scope,input.sourceKind,current.documents,true,acceptedAt);
    if (!samePrivateActionValue(retired,current.lineage)) fail("The source lineage changed during deletion.");
    await invalidateRunsForDeletedContext({ tenantId: scope.tenantId, retrievalTraceIds: retired.retrievalTraceIds, executionScope: execution,
      sourceKind: "knowledge", sourceReference: NATIVE_KNOWLEDGE_SOURCE_PREFIXES[input.sourceKind], sql });
    if (current.evidence.length) await retireEntityEvidenceLineage({ tenantId: scope.tenantId, ownerActorId: scope.ownerActorId,
      evidenceUnitIds: current.evidence.map((row) => String(row.id)), executionScope: deriveExecutionScope(execution,{ purpose: "entity.source.lifecycle.v1" }), retiredAt: acceptedAt, sql });
    if (retired.targets.length) await retireEntityMemoryLineage({ tenantId: scope.tenantId, ownerActorId: scope.canonicalActorId,
      memoryIds: retired.targets.map((row) => row.id), executionScope: deriveExecutionScope(execution,{ purpose: "memory.forget.v1" }), retiredAt: acceptedAt, sql });
    for (const ownerActorId of [...new Set([...(current.evidence.length ? [scope.ownerActorId] : []),...(retired.targets.length ? [scope.canonicalActorId] : [])])]) await queueTemporalRelationProjection({ tenantId: scope.tenantId,
      ownerActorId, executionScope: execution, sql });
    const deleted = await sql`DELETE FROM omni_knowledge_documents WHERE tenant_id=${scope.tenantId} AND id=ANY(${current.documents}::TEXT[]) RETURNING id`;
    if (deleted.length !== current.documents.length) fail("The exact reviewed document set was not deleted.");
    const accepted = sealNativeKnowledgeSourceDeletionAcceptance({ contract: "asael-knowledge-source-deletion-acceptance:1", id: privateActionAcceptanceId(scope,intent.keySha256),
      scope, operation: intent.operation, resourceId: intent.resourceId, keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), reviewSha256: pin.reviewSha256,
      acceptedAt, result: { sourceKind: input.sourceKind, localOnly: true, manifestSha256: pin.manifestSha256, documents: pin.documentCount, memories: pin.derivedMemoryCount,
        retrievalTraces: pin.retrievalTraceCount, graphNodes: pin.graphNodeCount, graphEdges: pin.graphEdgeCount } });
    await sql`INSERT INTO omni_native_private_memory_actions(tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,operation,resource_id,request_sha256,intent,acceptance,accepted_at)
      VALUES(${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},${intent.operation},${intent.resourceId},${accepted.requestSha256},
        ${intent}::JSONB,${accepted}::JSONB,${acceptedAt})`;
    await appendScopedDomainEvent({ id: accepted.id, streamId: `native-private-memory:${scope.ownerActorId}`, type: "private_memory.native_action.accepted",
      executionScope: execution, payload: { schemaVersion: 1, operation: intent.operation, acceptanceSha256: accepted.acceptanceSha256, requestSha256: accepted.requestSha256 } },{ sql });
    return { acceptance: accepted, replayed: false };
  });
}
