import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { buildNativeCognitionBuildIntent, cognitionBuildAcceptanceId, NATIVE_COGNITION_BUILD_POLICY_SHA256, nativeCognitionBuildAcceptanceSchema,
  nativeCognitionBuildIntentSchema, nativeCognitionBuildProcessingSchema, nativeCognitionBuildReviewSchema, sealNativeCognitionBuildAcceptance, sealNativeCognitionBuildPin,
  type NativeCognitionBuildAcceptance, type NativeCognitionBuildIntent, type NativeCognitionBuildRequest } from "@/lib/knowledge/cognification-build-native-contracts";
import { cognitionGenerationId, partitionCognificationBatches, type CognificationBatchPlan } from "@/lib/knowledge/cognification-runtime";
import { recordFromRow, saveKnowledgeCognition, type KnowledgeCognitionRecord } from "@/lib/knowledge/cognification-store";
import { parseCognificationCandidateBatchV1, type CognificationCandidateBatchV1 } from "@/lib/knowledge/cognification-contract";
import { privateActionIdSchema, privateActionShaSchema, samePrivateActionValue, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import { assertNativePrivateActionMutation, lockNativePrivateActionGraph, nativePrivateActionFail as fail, nativePrivateActionTransaction,
  type NativePrivateActionAuthority, type PrivateActionSql as Sql } from "@/lib/memory/private-action-store";
import { enqueueOperationJob, type OperationJobRecord } from "@/lib/operations/job-queue";
import { getActorOwnedKnowledgeForCognition } from "@/lib/rag/store";
import { deriveExecutionScope, parsePersistedExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { resolveRuntimeModelAssignment } from "@/lib/settings/runtime-models";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { KNOWLEDGE_COGNIFY_PURPOSE_ID } from "@/lib/sources/purposes";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const plannedBatch = z.object({ batchId: z.string().regex(/^cognition_batch_[a-f0-9]{48}$/),batchIndex: z.number().int().min(0).max(2047),
  batchInputSha256: privateActionShaSchema,reusedCandidateSha256: privateActionShaSchema.nullable() }).strict();
const planSchema = z.array(plannedBatch).min(1).max(2048).refine((v) => v.every((b,i) => b.batchIndex === i) && new Set(v.map((b) => b.batchId)).size === v.length);
type Plan = z.infer<typeof planSchema>;
export type NativeCognitionBuildAccepted = { intent: NativeCognitionBuildIntent; acceptance: NativeCognitionBuildAcceptance; plan: Plan };
const readonly = (a: NativePrivateActionAuthority) => { if (a.executionScope) fail("Build inspection requires read-only authority.","cognition_build_read",400); };
const model = (scope: PrivateActionScope) => resolveRuntimeModelAssignment({ tenantId: scope.tenantId,actorId: scope.ownerActorId,scope: "memory",tier: "reasoning",requiredFeature: "json_schema" });

async function sourcePlan(sql: Sql,scope: PrivateActionScope,documentId: string,generationId: string) {
  privateActionIdSchema.parse(documentId); await lockNativePrivateActionGraph(sql,scope.tenantId);
  const rows = await sql`SELECT to_jsonb(document) AS document,to_jsonb(item) AS item,to_jsonb(revision) AS revision FROM omni_knowledge_documents document
    JOIN omni_source_items item ON item.tenant_id=document.tenant_id AND item.id=document.source_item_id AND item.current_revision_id=document.source_revision_id
    JOIN omni_source_revisions revision ON revision.tenant_id=document.tenant_id AND revision.id=document.source_revision_id AND revision.source_item_id=item.id
    WHERE document.tenant_id=${scope.tenantId} AND document.id=${documentId} AND item.owner_actor_id=${scope.ownerActorId} AND revision.owner_actor_id=${scope.ownerActorId}
      AND item.visibility='user_private' AND revision.visibility='user_private' FOR SHARE OF document,item`;
  const source = rows.length === 1 ? await getActorOwnedKnowledgeForCognition({ tenantId: scope.tenantId,actorId: scope.ownerActorId,documentId,sql }) : null;
  if (!source) fail("The exact current source no longer permits cognition.","cognition_build_source",404);
  const document = { id: documentId,title: source.document.title,sourceItemId: source.sourceItemId,sourceRevisionId: source.sourceRevisionId,retentionExpiresAt: source.retentionExpiresAt };
  const chunks = source.chunks.map((c) => { if (!c.evidenceUnitId) fail("The source evidence is incomplete."); return { id: c.id,index: c.chunkIndex,content: c.content,evidenceUnitId: c.evidenceUnitId }; });
  const batches = partitionCognificationBatches({ document,chunks,generationId });
  const sourcePlanSha256 = sourceContractSha256({ schemaVersion: 1,documentId,sourceItemId: document.sourceItemId,sourceRevisionId: document.sourceRevisionId,generationId,
    retentionExpiresAt: document.retentionExpiresAt,batches: batches.map((b) => ({ batchId: b.batchId,batchIndex: b.batchIndex,batchInputSha256: b.batchInputSha256,evidenceUnitIds: [...b.evidenceUnitIds] })) });
  const sourcePolicySha256 = canonicalJsonSha256({ ...rows[0],retentionExpiresAt: document.retentionExpiresAt,
    chunks: chunks.map((c) => ({ id: c.id,evidenceUnitId: c.evidenceUnitId,contentSha256: canonicalJsonSha256(c.content) })) });
  return { document,chunks,batches,sourcePlanSha256,sourcePolicySha256 };
}
function verifyCandidate(record: KnowledgeCognitionRecord,batch: CognificationBatchPlan,document: { id: string;sourceItemId: string;sourceRevisionId: string;retentionExpiresAt: string | null }) {
  const c = record.candidate;
  if (c.documentId !== document.id || c.sourceItemId !== document.sourceItemId || c.sourceRevisionId !== document.sourceRevisionId || c.retentionExpiresAt !== document.retentionExpiresAt ||
    c.batchId !== batch.batchId || c.batchIndex !== batch.batchIndex || c.batchCount !== batch.batchCount || c.generationId !== batch.generationId ||
    c.firstChunkIndex !== batch.firstChunkIndex || c.lastChunkIndex !== batch.lastChunkIndex || c.chunkCount !== batch.chunkCount || c.inputCharacterCount !== batch.inputCharacterCount ||
    c.batchInputSha256 !== batch.batchInputSha256 || !samePrivateActionValue(c.evidenceUnitIds,batch.evidenceUnitIds)) fail("A saved source map belongs to another generation plan.");
}
async function planEvidence(sql: Sql,scope: PrivateActionScope,value: Awaited<ReturnType<typeof sourcePlan>>) {
  const rows = await sql`SELECT * FROM omni_knowledge_cognition_candidates WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId}
    AND id=ANY(${value.batches.map((b) => b.batchId)}::TEXT[]) ORDER BY batch_index FOR SHARE`;
  const records = new Map(rows.map((row) => { const r = recordFromRow(row); return [r.candidate.batchId,r] as const; }));
  return planSchema.parse(value.batches.map((b) => { const r = records.get(b.batchId); if (r) verifyCandidate(r,b,value.document);
    return { batchId: b.batchId,batchIndex: b.batchIndex,batchInputSha256: b.batchInputSha256,reusedCandidateSha256: r?.candidate.contractSha256 ?? null }; }));
}
async function accepted(sql: Sql,scope: PrivateActionScope,keySha256: string): Promise<NativeCognitionBuildAccepted | null> {
  const rows = await sql`SELECT intent,acceptance,plan FROM omni_knowledge_native_cognition_builds WHERE tenant_id=${scope.tenantId}
    AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${keySha256}`;
  if (!rows.length) return null; if (rows.length !== 1) fail("Accepted cognition build identity is ambiguous.");
  const intent = nativeCognitionBuildIntentSchema.parse(rows[0].intent),acceptance = nativeCognitionBuildAcceptanceSchema.parse(rows[0].acceptance),plan = planSchema.parse(rows[0].plan);
  const pin = intent.request.review;
  if (!samePrivateActionValue(intent.scope,scope) || !samePrivateActionValue(acceptance.scope,scope) || intent.keySha256 !== keySha256 || acceptance.keySha256 !== keySha256 ||
    acceptance.documentId !== intent.documentId || acceptance.requestSha256 !== canonicalJsonSha256(intent) || acceptance.reviewSha256 !== pin.reviewSha256 ||
    acceptance.sourcePlanSha256 !== pin.sourcePlanSha256 || acceptance.totalBatches !== plan.length || pin.batchCount !== plan.length ||
    acceptance.reusedBatches !== plan.filter((b) => b.reusedCandidateSha256 !== null).length || acceptance.reusedBatches !== pin.existingReviewCount ||
    canonicalJsonSha256(plan.filter((b) => b.reusedCandidateSha256 !== null).map((b) => ({ batchId: b.batchId,candidateSha256: b.reusedCandidateSha256 }))) !== pin.existingReviewManifestSha256)
    fail("Stored cognition build acceptance is inconsistent.");
  return { intent,acceptance,plan };
}
async function legacyPending(sql: Sql,scope: PrivateActionScope,documentId: string,plan: Plan) {
  const missing = plan.filter((b) => !b.reusedCandidateSha256).map((b) => b.batchIndex);
  const rows = await sql`SELECT id FROM omni_operation_jobs WHERE tenant_id=${scope.tenantId} AND type='knowledge.cognify'
    AND payload->>'actorId'=${scope.ownerActorId} AND COALESCE(payload->'request'->>'documentId',payload->'executionScope'->>'causationId')=${documentId} AND NOT (payload ? 'nativeCognitionBuild')
    AND (status IN ('queued','running') OR status IN ('failed','quarantined','canceled') AND (
      COALESCE(payload->'request'->>'batchIndex',payload->'progress'->>'batchIndex') IS NULL
      OR COALESCE(payload->'request'->>'batchIndex',payload->'progress'->>'batchIndex')=ANY(${missing.map(String)}::TEXT[]))) LIMIT 1`;
  return rows.length > 0;
}
async function buildReview(sql: Sql,scope: PrivateActionScope,documentId: string,runtime: Awaited<ReturnType<typeof model>>) {
  const value = await sourcePlan(sql,scope,documentId,cognitionGenerationId(runtime)),plan = await planEvidence(sql,scope,value);
  const existing = plan.filter((b) => b.reusedCandidateSha256 !== null),pin = sealNativeCognitionBuildPin({ documentId,sourceItemId: value.document.sourceItemId,
    sourceRevisionId: value.document.sourceRevisionId,retentionExpiresAt: value.document.retentionExpiresAt,sourcePolicySha256: value.sourcePolicySha256,
    generationId: cognitionGenerationId(runtime),sourcePlanSha256: value.sourcePlanSha256,batchCount: plan.length,existingReviewCount: existing.length,
    existingReviewManifestSha256: canonicalJsonSha256(existing.map((b) => ({ batchId: b.batchId,candidateSha256: b.reusedCandidateSha256 }))),policySha256: NATIVE_COGNITION_BUILD_POLICY_SHA256 });
  const prior = await sql`SELECT idempotency_key_sha256,source_plan_sha256 FROM omni_knowledge_native_cognition_builds WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId}
    AND document_id=${documentId} LIMIT 101`;
  let held = prior.length > 100 || prior.some((row) => row.source_plan_sha256 === value.sourcePlanSha256);
  for (const row of prior) { if (held) break; const previous = await accepted(sql,scope,String(row.idempotency_key_sha256));
    held = !previous || (await processing(sql,previous)).phase !== "completed"; }
  const reason = !runtime.configured ? "model_unavailable" : existing.length === plan.length ? "already_completed" : held ? "already_accepted"
    : await legacyPending(sql,scope,documentId,plan) ? "legacy_work_unconfirmed" : null;
  return { value,plan,review: nativeCognitionBuildReviewSchema.parse({ documentId,title: value.document.title,pin,eligible: reason === null,reason,
    model: { provider: runtime.provider ?? null,model: runtime.model ?? null } }) };
}
async function queue(sql: Sql,scope: PrivateActionScope,buildId: string,batch: Plan[number],execution: ExecutionScope) {
  return enqueueOperationJob({ tenantId: scope.tenantId,type: "knowledge.cognify",dedupeKey: `${buildId}:${batch.batchId}`,dedupeMode: "idempotent",maxAttempts: 1,
    payload: { actorId: scope.ownerActorId,nativeCognitionBuild: { acceptanceId: buildId,batchIndex: batch.batchIndex },
      executionScope: deriveExecutionScope(execution,{ executingPrincipalType: "system",executingPrincipalId: "background-operations-worker",purpose: KNOWLEDGE_COGNIFY_PURPOSE_ID }),
      progress: { stage: "queued",batchIndex: batch.batchIndex } } },{ sql });
}
async function processing(sql: Sql,value: NativeCognitionBuildAccepted) {
  const { acceptance: a,plan } = value;
  const rows = await sql`SELECT batch_id,candidate_sha256,next_job_id FROM omni_knowledge_native_cognition_effects
    WHERE tenant_id=${a.scope.tenantId} AND owner_actor_id=${a.scope.ownerActorId} AND build_id=${a.id} AND state='committed' ORDER BY batch_index`;
  const completed = new Map(plan.filter((b) => b.reusedCandidateSha256).map((b) => [b.batchId,b.reusedCandidateSha256!]));
  for (const row of rows) completed.set(String(row.batch_id),String(row.candidate_sha256));
  const actual = await sql`SELECT id,contract_sha256 FROM omni_knowledge_cognition_candidates WHERE tenant_id=${a.scope.tenantId} AND owner_actor_id=${a.scope.ownerActorId}
    AND id=ANY(${[...completed.keys()]}::TEXT[])`;
  const verified = new Set(actual.filter((r) => completed.get(String(r.id)) === r.contract_sha256).map((r) => String(r.id)));
  const reviewIds = plan.filter((b) => verified.has(b.batchId)).map((b) => b.batchId),reusedBatches = plan.filter((b) => b.reusedCandidateSha256 && verified.has(b.batchId)).length;
  const missing = plan.find((b) => !completed.has(b.batchId));
  let phase: "queued" | "processing" | "completed" | "reconciliation_required" | "blocked" = "completed",reason: "source_changed" | "provider_effect_unconfirmed" | "job_unavailable" | null = null;
  if (verified.size !== completed.size) { phase = "blocked"; reason = "source_changed"; }
  else if (missing) {
    const started = await sql`SELECT job.id,job.status,job.lease_expires_at,effect.state FROM omni_knowledge_native_cognition_effects effect
      JOIN omni_operation_jobs job ON job.tenant_id=effect.tenant_id AND job.id=effect.job_id
      WHERE effect.tenant_id=${a.scope.tenantId} AND effect.build_id=${a.id} AND effect.batch_id=${missing.batchId}`;
    if (started.length) {
      const running = started[0].status === "running" && new Date(started[0].lease_expires_at as string).getTime() > Date.now();
      phase = running ? "processing" : "reconciliation_required"; reason = running ? null : "provider_effect_unconfirmed";
    } else {
      const prior = plan.filter((b) => !b.reusedCandidateSha256 && b.batchIndex < missing.batchIndex).at(-1);
      const jobId = prior ? rows.find((r) => r.batch_id === prior.batchId)?.next_job_id : a.operationJobId;
      const jobs = jobId ? await sql`SELECT status,lease_expires_at FROM omni_operation_jobs WHERE tenant_id=${a.scope.tenantId} AND id=${String(jobId)}` : [];
      const active = jobs.length === 1 && (jobs[0].status === "queued" || jobs[0].status === "running" && new Date(jobs[0].lease_expires_at as string).getTime() > Date.now());
      phase = active ? "queued" : "reconciliation_required"; reason = active ? null : "job_unavailable";
    }
  }
  return nativeCognitionBuildProcessingSchema.parse({ phase,totalBatches: plan.length,completedBatches: reviewIds.length,reusedBatches,reviewIds,reason,automaticRetryAllowed: false });
}
export async function reviewNativeKnowledgeCognitionBuild(authority: NativePrivateActionAuthority,documentId: string) {
  readonly(authority); const runtime = await model(authority.scope);
  return nativePrivateActionTransaction(authority,false,async (sql) => (await buildReview(sql,authority.scope,documentId,runtime)).review);
}
export async function readNativeKnowledgeCognitionBuild(authority: NativePrivateActionAuthority,documentId: string,keySha256: string) {
  readonly(authority); privateActionShaSchema.parse(keySha256);
  return nativePrivateActionTransaction(authority,false,async (sql) => {
    const value = await accepted(sql,authority.scope,keySha256);
    if (value && value.intent.documentId !== documentId) fail("This build key belongs to another document.");
    const current = await getActorOwnedKnowledgeForCognition({ tenantId: authority.scope.tenantId,actorId: authority.scope.ownerActorId,documentId,sql });
    if (!current) fail("The exact owned source is unavailable.","cognition_build_source",404);
    return { acceptance: value?.acceptance ?? null,processing: value ? await processing(sql,value) : null };
  });
}
export async function submitNativeKnowledgeCognitionBuild(input: { authority: NativePrivateActionAuthority;documentId: string;request: NativeCognitionBuildRequest;idempotencyKey: string }) {
  const scope = input.authority.scope,intent = buildNativeCognitionBuildIntent({ ...input,scope });
  const execution = assertNativePrivateActionMutation(input.authority,"knowledge.cognition.queue",input.documentId),runtime = await model(scope);
  return nativePrivateActionTransaction(input.authority,true,async (sql) => {
    await lockNativePrivateActionGraph(sql,scope.tenantId);
    const replay = await accepted(sql,scope,intent.keySha256);
    if (replay) { if (!samePrivateActionValue(replay.intent,intent)) fail("This key accepted another cognition build.");
      await sourcePlan(sql,scope,input.documentId,intent.request.review.generationId);
      return { acceptance: replay.acceptance,processing: await processing(sql,replay),replayed: true }; }
    const current = await buildReview(sql,scope,input.documentId,runtime);
    if (!current.review.eligible || !samePrivateActionValue(current.review.pin,intent.request.review)) fail("The reviewed source build changed or has unresolved work.");
    const first = current.plan.find((b) => !b.reusedCandidateSha256); if (!first) fail("Every reviewed source map already exists.");
    const id = cognitionBuildAcceptanceId(scope,intent.keySha256),job = await queue(sql,scope,id,first,execution),acceptedAt = new Date().toISOString();
    const acceptance = sealNativeCognitionBuildAcceptance({ contract: "asael-knowledge-cognition-build-acceptance:1",id,scope,documentId: input.documentId,
      keySha256: intent.keySha256,requestSha256: canonicalJsonSha256(intent),reviewSha256: intent.request.review.reviewSha256,sourcePlanSha256: current.value.sourcePlanSha256,
      operationJobId: job.id,totalBatches: current.plan.length,reusedBatches: current.review.pin.existingReviewCount,acceptedAt });
    await sql`INSERT INTO omni_knowledge_native_cognition_builds(id,tenant_id,owner_actor_id,canonical_actor_id,document_id,idempotency_key_sha256,source_plan_sha256,intent,acceptance,plan,accepted_at)
      VALUES(${id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${input.documentId},${intent.keySha256},${current.value.sourcePlanSha256},
        ${intent}::JSONB,${acceptance}::JSONB,${current.plan}::JSONB,${acceptedAt})`;
    await appendScopedDomainEvent({ id,streamId: `native-cognition-build:${scope.ownerActorId}`,type: "knowledge.cognition.native.build.accepted",executionScope: execution,
      payload: { schemaVersion: 1,acceptanceSha256: acceptance.acceptanceSha256,requestSha256: acceptance.requestSha256 } },{ sql });
    return { acceptance,processing: await processing(sql,{ intent,acceptance,plan: current.plan }),replayed: false };
  });
}

const markerSchema = z.object({ acceptanceId: z.string().regex(/^cognition-build-acceptance:[a-f0-9]{64}$/),batchIndex: z.number().int().min(0).max(2047) }).strict();
export async function loadNativeCognitionBuildJob(job: OperationJobRecord): Promise<NativeCognitionBuildAccepted> {
  await ensureDatabaseSchema();
  const marker = markerSchema.parse(job.payload.nativeCognitionBuild),actor = String(job.payload.actorId ?? "");
  const rows = await getSql()`SELECT intent FROM omni_knowledge_native_cognition_builds WHERE tenant_id=${job.tenantId} AND owner_actor_id=${actor} AND id=${marker.acceptanceId}`;
  if (rows.length !== 1) fail("The native build receipt is unavailable.","cognition_build_missing",404);
  const intent = nativeCognitionBuildIntentSchema.parse(rows[0].intent);
  return nativePrivateActionTransaction({ scope: intent.scope },true,async (sql) => {
    const value = await accepted(sql,intent.scope,intent.keySha256); if (!value) fail("Native build acceptance disappeared."); return value;
  });
}
async function jobPlan(sql: Sql,value: NativeCognitionBuildAccepted,job: OperationJobRecord,generationId: string) {
  const { acceptance: a,intent,plan } = value,marker = markerSchema.parse(job.payload.nativeCognitionBuild),execution = parsePersistedExecutionScope(job.payload.executionScope);
  if (job.type !== "knowledge.cognify" || marker.acceptanceId !== a.id || job.tenantId !== a.scope.tenantId || job.payload.actorId !== a.scope.ownerActorId ||
    !execution || execution.tenantId !== a.scope.tenantId || execution.initiatingActorId !== a.scope.ownerActorId || execution.executingPrincipalType !== "system" ||
    execution.executingPrincipalId !== "background-operations-worker" || execution.purpose !== KNOWLEDGE_COGNIFY_PURPOSE_ID || execution.causationId !== a.documentId ||
    execution.workspaceId || execution.projectId || execution.missionId || execution.delegationId || execution.contextGrantIds.length || execution.capabilityGrantIds.length)
    fail("Native cognition job authority is invalid.","cognition_build_authority",403);
  const batch = plan[marker.batchIndex]; if (!batch || batch.reusedCandidateSha256) fail("Native cognition job names a reused or absent batch.");
  const previous = plan.filter((b) => !b.reusedCandidateSha256 && b.batchIndex < batch.batchIndex).at(-1);
  const previousRows = previous ? await sql`SELECT next_job_id FROM omni_knowledge_native_cognition_effects WHERE tenant_id=${a.scope.tenantId}
    AND build_id=${a.id} AND batch_id=${previous.batchId} AND state='committed'` : [];
  if ((previous ? previousRows[0]?.next_job_id : a.operationJobId) !== job.id) fail("Native cognition job lacks its exact committed scheduling predecessor.");
  const current = await sourcePlan(sql,a.scope,a.documentId,generationId),pin = intent.request.review;
  if (generationId !== pin.generationId || current.sourcePolicySha256 !== pin.sourcePolicySha256 || current.sourcePlanSha256 !== pin.sourcePlanSha256 ||
    current.document.retentionExpiresAt !== pin.retentionExpiresAt) fail("The native build source or model generation changed.","cognition_build_changed",409);
  const jobs = await sql`SELECT id FROM omni_operation_jobs WHERE tenant_id=${job.tenantId} AND id=${job.id} AND status='running' AND max_attempts=1
    AND lease_owner=${job.leaseOwner ?? ""} AND lease_expires_at>clock_timestamp()
    AND payload->>'actorId'=${a.scope.ownerActorId} AND payload->'nativeCognitionBuild'=${marker}::JSONB
    AND payload->'executionScope'=${execution}::JSONB FOR UPDATE`;
  if (jobs.length !== 1) fail("The exact native cognition worker lease is unavailable.","cognition_build_lease",409);
  return { ...current,batch,execution };
}
export async function claimNativeCognitionBuildEffect(value: NativeCognitionBuildAccepted,job: OperationJobRecord) {
  const generationId = cognitionGenerationId(await model(value.acceptance.scope));
  return nativePrivateActionTransaction({ scope: value.acceptance.scope },true,async (sql) => {
    const current = await jobPlan(sql,value,job,generationId),claimId = randomUUID();
    const rows = await sql`INSERT INTO omni_knowledge_native_cognition_effects(build_id,tenant_id,owner_actor_id,batch_id,batch_index,job_id,claim_id,state,claimed_at)
      VALUES(${value.acceptance.id},${value.acceptance.scope.tenantId},${value.acceptance.scope.ownerActorId},${current.batch.batchId},${current.batch.batchIndex},${job.id},${claimId},'started',clock_timestamp())
      ON CONFLICT DO NOTHING RETURNING claim_id`;
    if (rows.length !== 1) fail("This paid cognition effect already started. It requires exact recovery.","cognition_build_reconciliation_required",409);
    await appendScopedDomainEvent({ id: `cognition-build-claim:${claimId}`,streamId: `native-cognition-build:${value.acceptance.scope.ownerActorId}`,
      type: "knowledge.cognition.native.build.claimed",executionScope: current.execution,payload: { schemaVersion: 1,buildId: value.acceptance.id,batchId: current.batch.batchId,claimId } },{ sql });
    return { claimId,document: current.document,chunks: current.chunks,batchIndex: current.batch.batchIndex,executionScope: current.execution };
  });
}
export async function recheckNativeCognitionBuildEffect(value: NativeCognitionBuildAccepted,job: OperationJobRecord,claimId: string) {
  const generationId = cognitionGenerationId(await model(value.acceptance.scope));
  return nativePrivateActionTransaction({ scope: value.acceptance.scope },true,async (sql) => {
    const current = await jobPlan(sql,value,job,generationId);
    const rows = await sql`SELECT claim_id FROM omni_knowledge_native_cognition_effects WHERE tenant_id=${job.tenantId} AND build_id=${value.acceptance.id}
      AND batch_id=${current.batch.batchId} AND job_id=${job.id} AND claim_id=${claimId} AND state='started'`;
    if (rows.length !== 1) fail("The exact started cognition claim changed.");
  });
}
export async function commitNativeCognitionBuildEffect(value: NativeCognitionBuildAccepted,job: OperationJobRecord,claimId: string,candidateInput: CognificationCandidateBatchV1) {
  const candidate = parseCognificationCandidateBatchV1(candidateInput),generationId = cognitionGenerationId(await model(value.acceptance.scope));
  return nativePrivateActionTransaction({ scope: value.acceptance.scope },true,async (sql) => {
    const current = await jobPlan(sql,value,job,generationId);
    const rows = await sql`SELECT claim_id FROM omni_knowledge_native_cognition_effects WHERE tenant_id=${job.tenantId} AND build_id=${value.acceptance.id}
      AND batch_id=${current.batch.batchId} AND job_id=${job.id} AND claim_id=${claimId} AND state='started' FOR UPDATE`;
    if (rows.length !== 1) fail("The exact paid cognition claim cannot be committed.");
    const saved = await saveKnowledgeCognition(candidate,{ executionScope: current.execution,sql });
    const batch = current.batches[current.batch.batchIndex]; if (!batch) fail("The accepted batch disappeared."); verifyCandidate(saved,batch,current.document);
    const next = value.plan.find((b) => b.batchIndex > current.batch.batchIndex && !b.reusedCandidateSha256);
    const nextJob = next ? await queue(sql,value.acceptance.scope,value.acceptance.id,next,current.execution) : null;
    const updated = await sql`UPDATE omni_knowledge_native_cognition_effects SET state='committed',candidate_id=${candidate.batchId},candidate_sha256=${candidate.contractSha256},
      next_job_id=${nextJob?.id ?? null},committed_at=clock_timestamp() WHERE tenant_id=${job.tenantId} AND build_id=${value.acceptance.id} AND batch_id=${candidate.batchId}
      AND claim_id=${claimId} AND state='started' RETURNING claim_id`;
    if (updated.length !== 1) fail("Native cognition output was not acknowledged.");
    await appendScopedDomainEvent({ id: `cognition-build-commit:${claimId}`,streamId: `native-cognition-build:${value.acceptance.scope.ownerActorId}`,
      type: "knowledge.cognition.native.build.committed",executionScope: current.execution,
      payload: { schemaVersion: 1,buildId: value.acceptance.id,batchId: candidate.batchId,candidateSha256: candidate.contractSha256,nextJobId: nextJob?.id ?? null } },{ sql });
    return { resourceId: candidate.batchId,cognitionId: candidate.batchId,batchIndex: candidate.batchIndex,batchCount: candidate.batchCount,status: "pending_review",nextJobId: nextJob?.id ?? null };
  });
}

/** The legacy queue shares the admission fence, but receives no native grant. */
export async function withNativeCognitionLegacyFence<T>(tenantId: string,actorId: string,documentId: string,work: (sql?: Sql) => Promise<T>): Promise<T> {
  if (!hasDatabaseUrl()) return work(); await ensureDatabaseSchema();
  return runWithDatabaseActorScope(tenantId,[actorId],() => getSql().transaction(async (sql: Sql) => {
    await lockNativePrivateActionGraph(sql,tenantId);
    const rows = await sql`SELECT id FROM omni_knowledge_native_cognition_builds WHERE tenant_id=${tenantId} AND owner_actor_id=${actorId} AND document_id=${documentId} LIMIT 1`;
    if (rows.length) fail("This document has a native paid-work receipt. Use its exact recovery.","cognition_build_native_pending",409);
    return work(sql);
  }) as Promise<T>);
}
