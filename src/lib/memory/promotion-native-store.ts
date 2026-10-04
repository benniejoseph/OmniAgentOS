import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { parseDatabaseMemoryAccessScope, setTransactionLocalDatabaseMemoryAccessScope, type DatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  isVerifiedPromotionEpisode, memoryClaimFingerprint, memoryPromotedRecordId, memoryPromotionDecisionSchema,
  verifiedMemoryOccurrenceKey, type MemoryPromotionReview,
} from "@/lib/memory/lifecycle";
import {
  MEMORY_PROMOTION_NATIVE_ACCEPTANCE_CONTRACT, MEMORY_PROMOTION_NATIVE_POLICY_SHA256,
  MemoryPromotionNativeError, memoryPromotionNativeAcceptanceSchema, memoryPromotionNativeIdSchema,
  memoryPromotionNativeIntent, memoryPromotionNativeRequestDigest, memoryPromotionNativeReviewToken,
  memoryPromotionNativeSourceTargetsSchema, memoryPromotionNativeStoredDecisionSchema, memoryPromotionNativeTokensEqual,
  type MemoryPromotionNativeAcceptance, type MemoryPromotionNativeRequest, type MemoryPromotionNativeSourceTarget,
} from "@/lib/memory/promotion-native-contracts";
import { memoryFromRow, saveMemoryWithCommitStatusInTransaction } from "@/lib/memory/store";
import type { MemoryRecord } from "@/lib/memory/types";
import { parsePersistedExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type Sql = ReturnType<typeof getSql>;
type Row = Record<string, unknown>;
export type MemoryPromotionNativeAuthority = Readonly<{
  tenantId: string; ownerActorId: string; accessScope: DatabaseMemoryAccessScope; executionScope: ExecutionScope;
}>;
export type PrivateMemoryPromotionRead = Readonly<{
  review: MemoryPromotionReview;
  canonical: MemoryRecord;
  sourceTargets: MemoryPromotionNativeSourceTarget[];
  reviewToken: string | null;
  policySha256: string;
  sourceManifestSha256: string;
  allowedDecisions: ("promote" | "dismiss")[];
  acceptance: MemoryPromotionNativeAcceptance | null;
}>;

function validateAuthority(authority: MemoryPromotionNativeAuthority, purpose: string) {
  const scope = parseDatabaseMemoryAccessScope(authority.accessScope);
  const execution = parsePersistedExecutionScope(authority.executionScope);
  if (!execution || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(authority.tenantId) ||
    !/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(authority.ownerActorId) ||
    scope.tenantId !== authority.tenantId || scope.initiatingActorId !== authority.ownerActorId ||
    scope.executingPrincipalType !== "user" || scope.executingPrincipalId !== authority.ownerActorId ||
    scope.purposeId !== purpose || scope.purpose !== execution.purpose ||
    !(purpose === MEMORY_PURPOSE_IDS.write
      ? execution.purpose === "api.memory.promotions.decide"
      : ["api.memory.promotions.read", "api.memory.promotions.list"].includes(execution.purpose)) ||
    scope.workspaceId !== null || scope.projectId !== null || scope.missionId !== null ||
    scope.contextGrantIds.length || scope.capabilityGrantIds.length ||
    execution.tenantId !== authority.tenantId || execution.initiatingActorId !== authority.ownerActorId ||
    execution.executingPrincipalType !== "user" || execution.executingPrincipalId !== authority.ownerActorId ||
    execution.workspaceId !== null || execution.projectId !== null || execution.missionId !== null ||
    execution.contextGrantIds.length || execution.capabilityGrantIds.length || execution.delegationId !== null) {
    throw new MemoryPromotionNativeError("memory_promotion_authority_invalid", 403, "Current private Memory authority is required.");
  }
  return scope;
}

async function transaction<T>(authority: MemoryPromotionNativeAuthority, purpose: string, work: (sql: Sql) => Promise<T>): Promise<T> {
  const scope = validateAuthority(authority, purpose);
  if (!hasDatabaseUrl()) throw new MemoryPromotionNativeError("memory_promotion_storage_unavailable", 503, "Durable private Memory promotion is unavailable.");
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: Sql) => {
    await setTransactionLocalDatabaseMemoryAccessScope(sql, scope);
    return work(sql);
  }) as Promise<T>;
}

function record(value: unknown): Row | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
}
function timestamp(value: unknown) { return new Date(value as string).toISOString(); }
function memoryAllowed(row: Row, authority: MemoryPromotionNativeAuthority) {
  return memoryPromotionNativeIdSchema.safeParse(row.id).success && row.tenant_id === authority.tenantId &&
    row.access_contract_version === 1 && row.access_state === "scope_bound" && row.visibility === "user_private" && row.scope === "user" &&
    row.owner_actor_id === authority.ownerActorId && row.owner_agent_id == null && row.workspace_id == null &&
    row.project_id == null && row.mission_id == null && row.claim_status !== "forgotten" && !row.forgotten_at &&
    Array.isArray(row.allowed_purpose_ids) && row.allowed_purpose_ids.includes(MEMORY_PURPOSE_IDS.read);
}

function current(row: Row, authority: MemoryPromotionNativeAuthority) {
  const ids = Array.isArray(row.source_memory_ids) ? row.source_memory_ids.map(String) : [];
  const sources = Array.isArray(row.source_memories) ? row.source_memories.map(record).filter((item): item is Row => !!item) : [];
  const promoted = record(row.promoted_memory);
  if (!memoryPromotionNativeIdSchema.safeParse(row.id).success || row.tenant_id !== authority.tenantId ||
    row.access_contract_version !== 1 || row.owner_actor_id !== authority.ownerActorId || row.policy_version !== 1 ||
    row.target_tier !== "procedural" || !/^[a-f0-9]{64}$/.test(String(row.source_claim_sha256)) || row.deletion_barrier === true ||
    ids.length < 2 || ids.length > 50 || ids.some((id, index) => !memoryPromotionNativeIdSchema.safeParse(id).success ||
      (index > 0 && ids[index - 1] >= id)) || !ids.includes(String(row.canonical_memory_id)) ||
    sources.length !== ids.length || sources.some((source, index) => source.id !== ids[index] || !memoryAllowed(source, authority)) ||
    (row.promoted_memory_id != null && (!promoted || promoted.id !== row.promoted_memory_id || !memoryAllowed(promoted, authority))) ||
    !["pending", "resolved"].includes(String(row.status))) return null;
  const review: MemoryPromotionReview = {
    id: String(row.id), tenantId: authority.tenantId, ownerActorId: authority.ownerActorId, policyVersion: 1,
    status: row.status as "pending" | "resolved", sourceMemoryIds: ids, canonicalMemoryId: String(row.canonical_memory_id),
    sourceClaimSha256: String(row.source_claim_sha256), targetTier: "procedural",
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
    ...(row.decision ? { decision: memoryPromotionDecisionSchema.parse(row.decision) } : {}),
    ...(row.promoted_memory_id ? { promotedMemoryId: String(row.promoted_memory_id) } : {}),
    ...(row.resolved_at ? { resolvedAt: timestamp(row.resolved_at) } : {}),
  };
  return { review, sources, promoted, canonical: memoryFromRow(sources.find((source) => source.id === review.canonicalMemoryId)!) };
}

function storedAcceptance(row: Row, value: NonNullable<ReturnType<typeof current>>) {
  if (row.native_decision == null) return null;
  const { intent, acceptance } = memoryPromotionNativeStoredDecisionSchema.parse(row.native_decision);
  const review = value.review;
  if (intent.requestSha256 !== memoryPromotionNativeRequestDigest({ tenantId: intent.tenantId, ownerActorId: intent.ownerActorId, request: intent.request }) ||
    review.status !== "resolved" || acceptance.tenantId !== review.tenantId || acceptance.ownerActorId !== review.ownerActorId ||
    acceptance.reviewId !== review.id || acceptance.canonicalMemoryId !== review.canonicalMemoryId ||
    acceptance.decision !== review.decision || acceptance.promotedMemoryId !== (review.promotedMemoryId ?? null) ||
    acceptance.resolvedAt !== review.resolvedAt || acceptance.sourceTargets.map((target) => target.memoryId).join("\0") !== review.sourceMemoryIds.join("\0") ||
    (value.promoted && Number(value.promoted.lifecycle_target_revision) < (acceptance.promotedTargetRevision ?? 0))) {
    throw new Error("Stored private Memory promotion acceptance is inconsistent.");
  }
  return acceptance;
}

async function readCurrent(sql: Sql, authority: MemoryPromotionNativeAuthority, row: Row, lock: boolean): Promise<PrivateMemoryPromotionRead | null> {
  const value = current(row, authority);
  if (!value) return null;
  const metadata = await sql`SELECT * FROM public.omni_memory_promotion_source_snapshot_v1(
    ${authority.tenantId},${authority.ownerActorId},${[...value.review.sourceMemoryIds]}::TEXT[],${lock})`;
  const byId = new Map(metadata.map((item) => [String(item.memory_id), item]));
  const sourceTargets = memoryPromotionNativeSourceTargetsSchema.parse(value.sources.map((source) => {
    const lifecycle = byId.get(String(source.id));
    if (!lifecycle) throw new Error("Private Memory promotion source snapshot is incomplete.");
    const memory = memoryFromRow(source);
    return { memoryId: memory.id, claimStatus: memory.claimStatus, targetRevision: Number(source.lifecycle_target_revision),
      lifecycleRevision: Number(lifecycle.lifecycle_revision), sourcePolicySha256: canonicalJsonSha256(memory.accessBinding) };
  }));
  const allowedDecisions: ("promote" | "dismiss")[] = [];
  const acceptance = storedAcceptance(row, value);
  if (acceptance && sourceTargets.some((target, index) => {
    const accepted = acceptance.sourceTargets[index];
    return target.targetRevision < accepted.targetRevision || target.lifecycleRevision < accepted.lifecycleRevision ||
      (target.targetRevision === accepted.targetRevision && target.sourcePolicySha256 !== accepted.sourcePolicySha256);
  })) throw new Error("Current Memory promotion sources precede their accepted revisions.");
  if (value.review.status === "pending" && value.sources.every((source) =>
    Array.isArray(source.allowed_purpose_ids) && source.allowed_purpose_ids.includes(MEMORY_PURPOSE_IDS.write))) {
    const now = Date.now();
    const records = value.sources.map(memoryFromRow);
    const promotable = records.every((memory) => {
      const lifecycle = byId.get(memory.id)!;
      return isVerifiedPromotionEpisode(memory) && memoryClaimFingerprint(memory) === value.review.sourceClaimSha256 &&
        (!memory.validFrom || Date.parse(memory.validFrom) <= now) && (!memory.validTo || Date.parse(memory.validTo) > now) &&
        (!memory.retentionExpiresAt || Date.parse(memory.retentionExpiresAt) > now) &&
        (!lifecycle.archived_at || (memory.id !== value.review.canonicalMemoryId &&
          lifecycle.archive_reason === "exact_duplicate" && lifecycle.duplicate_of_memory_id === value.review.canonicalMemoryId));
    }) && new Set(records.map(verifiedMemoryOccurrenceKey)).size >= 2;
    if (promotable) allowedDecisions.push("promote");
    allowedDecisions.push("dismiss");
  }
  return {
    review: value.review, canonical: memoryFromRow({
      ...value.sources.find((source) => source.id === value.review.canonicalMemoryId)!,
      lifecycle_pinned_at: byId.get(value.review.canonicalMemoryId)?.pinned_at,
      lifecycle_archived_at: byId.get(value.review.canonicalMemoryId)?.archived_at,
      lifecycle_archive_reason: byId.get(value.review.canonicalMemoryId)?.archive_reason,
      lifecycle_duplicate_of_memory_id: byId.get(value.review.canonicalMemoryId)?.duplicate_of_memory_id,
    }), sourceTargets, allowedDecisions,
    policySha256: MEMORY_PROMOTION_NATIVE_POLICY_SHA256, sourceManifestSha256: canonicalJsonSha256(sourceTargets),
    reviewToken: allowedDecisions.length ? memoryPromotionNativeReviewToken({ tenantId: authority.tenantId,
      ownerActorId: authority.ownerActorId, reviewId: value.review.id, canonicalMemoryId: value.review.canonicalMemoryId,
      sourceClaimSha256: value.review.sourceClaimSha256, sourceTargets, allowedDecisions }) : null,
    acceptance,
  };
}

async function exactRow(sql: Sql, authority: MemoryPromotionNativeAuthority, reviewId: string) {
  const rows = await sql`SELECT review.*,
    (SELECT jsonb_agg(to_jsonb(promotion_source) ORDER BY promotion_source.id COLLATE "C") FROM omni_memories promotion_source
      WHERE promotion_source.tenant_id=review.tenant_id AND promotion_source.id=ANY(review.source_memory_ids)) AS source_memories,
    to_jsonb(promoted) AS promoted_memory,
    public.omni_memory_ids_have_deletion_barrier(review.tenant_id,
      review.source_memory_ids || CASE WHEN review.promoted_memory_id IS NULL THEN ARRAY[]::TEXT[] ELSE ARRAY[review.promoted_memory_id] END) AS deletion_barrier
    FROM omni_memory_promotion_reviews review
    LEFT JOIN omni_memories promoted ON promoted.tenant_id=review.tenant_id AND promoted.id=review.promoted_memory_id
    WHERE review.tenant_id=${authority.tenantId} AND review.owner_actor_id=${authority.ownerActorId}
      AND review.access_contract_version=1 AND review.id=${reviewId} LIMIT 1`;
  return rows[0];
}

export async function getPrivateMemoryPromotionReview(authority: MemoryPromotionNativeAuthority, reviewId: string): Promise<PrivateMemoryPromotionRead | null> {
  memoryPromotionNativeIdSchema.parse(reviewId);
  return transaction(authority, MEMORY_PURPOSE_IDS.read, async (sql) => {
    const row = await exactRow(sql, authority, reviewId);
    return row ? readCurrent(sql, authority, row, false) : null;
  });
}

export async function listPrivateMemoryPromotionReviews(authority: MemoryPromotionNativeAuthority,
  options: { status?: "pending" | "resolved" | "all"; limit?: number } = {}): Promise<PrivateMemoryPromotionRead[]> {
  const status = options.status === "all" || options.status === "resolved" ? options.status : "pending";
  const limit = Math.min(Math.max(Math.trunc(options.limit || 25), 1), 50);
  return transaction(authority, MEMORY_PURPOSE_IDS.read, async (sql) => {
    const rows = await sql`SELECT id FROM omni_memory_promotion_reviews
      WHERE tenant_id=${authority.tenantId} AND owner_actor_id=${authority.ownerActorId} AND access_contract_version=1
        AND (${status}='all' OR status=${status}) ORDER BY (status='pending') DESC,updated_at DESC,id LIMIT ${limit}`;
    const results: PrivateMemoryPromotionRead[] = [];
    for (const item of rows) {
      const row = await exactRow(sql, authority, String(item.id));
      const read = row ? await readCurrent(sql, authority, row, false) : null;
      if (read) results.push(read);
    }
    return results;
  });
}

/** Acceptance, new procedural Memory, and typed decision event share one commit. */
export async function resolvePrivateMemoryPromotionReview(input: {
  authority: MemoryPromotionNativeAuthority; reviewId: string; idempotencyKey: string; request: MemoryPromotionNativeRequest;
}): Promise<PrivateMemoryPromotionRead & { acceptance: MemoryPromotionNativeAcceptance; newlyApplied: boolean; promotedMemory: MemoryRecord | null }> {
  const { authority, reviewId } = input;
  if (authority.executionScope.causationId !== reviewId) {
    throw new MemoryPromotionNativeError("memory_promotion_authority_invalid", 403, "Promotion authority must name the exact review.");
  }
  const intent = memoryPromotionNativeIntent({ ...input, tenantId: authority.tenantId, ownerActorId: authority.ownerActorId });
  return transaction(authority, MEMORY_PURPOSE_IDS.write, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`memory-graph:${authority.tenantId}`},0))`;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`memory-promotion:${authority.tenantId}:${authority.ownerActorId}:${intent.keySha256}`},0))`;
    // Source identity is immutable. Lock parents before the review, matching
    // forget and lifecycle writers, then re-read everything under those locks.
    const observed = await sql`SELECT source_memory_ids,promoted_memory_id FROM omni_memory_promotion_reviews
      WHERE tenant_id=${authority.tenantId} AND owner_actor_id=${authority.ownerActorId} AND access_contract_version=1 AND id=${reviewId}`;
    if (!observed[0]) throw new MemoryPromotionNativeError("memory_promotion_unavailable", 404, "Current private Memory proposal was not found.");
    const sourceIds = Array.isArray(observed[0].source_memory_ids) ? observed[0].source_memory_ids.map(String) : [];
    const parentIds = [...sourceIds, ...(observed[0].promoted_memory_id ? [String(observed[0].promoted_memory_id)] : [])].sort();
    await sql`SELECT id FROM omni_memories WHERE tenant_id=${authority.tenantId} AND id=ANY(${parentIds}::TEXT[]) ORDER BY id COLLATE "C" FOR UPDATE`;
    const locked = await sql`SELECT id FROM omni_memory_promotion_reviews
      WHERE tenant_id=${authority.tenantId} AND owner_actor_id=${authority.ownerActorId} AND access_contract_version=1 AND id=${reviewId} FOR UPDATE`;
    if (!locked[0]) throw new MemoryPromotionNativeError("memory_promotion_unavailable", 404, "Current private Memory proposal was not found.");
    const row = await exactRow(sql, authority, reviewId);
    const before = row ? await readCurrent(sql, authority, row, true) : null;
    if (!before) throw new MemoryPromotionNativeError("memory_promotion_unavailable", 404, "Current private Memory proposal was not found.");
    const priorKeys = await sql`SELECT id FROM omni_memory_promotion_reviews
      WHERE tenant_id=${authority.tenantId} AND owner_actor_id=${authority.ownerActorId}
        AND native_decision->'intent'->>'idempotencyKeySha256'=${intent.keySha256} LIMIT 1`;
    if (priorKeys[0] && priorKeys[0].id !== reviewId) {
      throw new MemoryPromotionNativeError("memory_promotion_key_conflict", 409, "This key was accepted for another proposal.");
    }
    if (before.acceptance) {
      if (before.acceptance.id !== intent.acceptanceId || before.acceptance.requestSha256 !== intent.requestSha256) {
        throw new MemoryPromotionNativeError("memory_promotion_key_conflict", 409, "This proposal already has a different accepted request.");
      }
      return { ...before, acceptance: before.acceptance, newlyApplied: false, promotedMemory: null };
    }
    if (before.review.status !== "pending") {
      throw new MemoryPromotionNativeError("memory_promotion_already_resolved", 409, "This proposal was resolved without this native acceptance.");
    }
    if (!before.reviewToken || !before.allowedDecisions.includes(intent.request.decision) ||
      !memoryPromotionNativeTokensEqual(before.reviewToken, intent.request.expectedReviewToken) ||
      before.policySha256 !== intent.request.expectedPolicySha256 || before.sourceManifestSha256 !== intent.request.expectedSourceManifestSha256) {
      throw new MemoryPromotionNativeError("memory_promotion_target_changed", 409, "The proposal or its current source eligibility changed. Review it again.");
    }
    const now = new Date().toISOString();
    let promotedMemory: MemoryRecord | null = null, promotedTargetRevision: number | null = null;
    if (intent.request.decision === "promote") {
      const canonical = before.canonical;
      const saved = await saveMemoryWithCommitStatusInTransaction({
        id: memoryPromotedRecordId(reviewId), tenantId: authority.tenantId, type: "procedure", tier: "procedural",
        formationReason: "maintenance_promotion", title: canonical.title, content: canonical.content,
        tags: canonical.tags, scope: canonical.scope, source: `memory-promotion:${reviewId}`,
        importance: Math.max(0.8, canonical.importance), confidence: Math.min(1, (canonical.confidence ?? 0.8) + 0.05),
        claimStatus: "active", assertedBy: canonical.assertedBy,
        evidenceRefs: before.review.sourceMemoryIds.map((id) => `memory:${id}`),
        validFrom: canonical.validFrom, validTo: canonical.validTo,
        promotedFromTier: "episodic", promotedAt: now, embedding: canonical.embedding,
        accessBinding: canonical.accessBinding, databaseAccessScope: authority.accessScope, executionScope: authority.executionScope,
      }, sql, { databaseAccessScopeAlreadyEntered: true });
      if (!saved.inserted) throw new MemoryPromotionNativeError("memory_promotion_target_conflict", 409, "The procedural target exists without this acceptance.");
      if (saved.record.title !== canonical.title || saved.record.content !== canonical.content ||
        saved.record.assertedBy !== canonical.assertedBy ||
        canonicalJsonSha256(saved.record.accessBinding) !== canonicalJsonSha256(canonical.accessBinding)) {
        throw new MemoryPromotionNativeError("memory_promotion_target_changed", 409, "The reviewed source cannot be promoted without changing its claim or authority.");
      }
      promotedMemory = saved.record;
      const targets = await sql`SELECT lifecycle_target_revision FROM omni_memories WHERE tenant_id=${authority.tenantId} AND id=${saved.record.id}`;
      promotedTargetRevision = Number(targets[0]?.lifecycle_target_revision);
    }
    const acceptance = memoryPromotionNativeAcceptanceSchema.parse({
      contract: MEMORY_PROMOTION_NATIVE_ACCEPTANCE_CONTRACT, id: intent.acceptanceId,
      tenantId: authority.tenantId, ownerActorId: authority.ownerActorId, reviewId,
      canonicalMemoryId: before.review.canonicalMemoryId, decision: intent.request.decision,
      idempotencyKeySha256: intent.keySha256, requestSha256: intent.requestSha256,
      expectedReviewToken: intent.request.expectedReviewToken, policySha256: before.policySha256,
      sourceManifestSha256: before.sourceManifestSha256, sourceTargets: before.sourceTargets,
      promotedMemoryId: promotedMemory?.id ?? null, promotedTargetRevision, resolvedAt: now,
    });
    const nativeDecision = memoryPromotionNativeStoredDecisionSchema.parse({ intent: intent.stored, acceptance });
    await sql`UPDATE omni_memory_promotion_reviews SET status='resolved',decision=${acceptance.decision},
      promoted_memory_id=${acceptance.promotedMemoryId},resolved_at=${now},updated_at=${now},native_decision=${nativeDecision}::JSONB
      WHERE tenant_id=${authority.tenantId} AND id=${reviewId}`;
    await appendScopedDomainEvent({ id: acceptance.id, streamId: `memory-promotion:${reviewId}`, type: "memory.promotion.reviewed",
      executionScope: authority.executionScope, payload: { schemaVersion: 1, nativeAcceptanceId: acceptance.id, reviewId,
        decision: acceptance.decision, sourceMemoryCount: before.sourceTargets.length, promotedMemoryId: acceptance.promotedMemoryId } }, { sql });
    const afterRow = await exactRow(sql, authority, reviewId);
    const after = afterRow ? await readCurrent(sql, authority, afterRow, true) : null;
    if (!after?.acceptance) throw new Error("Accepted Memory promotion could not be read in its transaction.");
    return { ...after, acceptance: after.acceptance, newlyApplied: true, promotedMemory };
  });
}
