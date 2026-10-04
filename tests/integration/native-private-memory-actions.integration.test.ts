import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithDatabaseTenantScope } from "@/lib/db/client";
import { ASAEL_ONTOLOGY_VERSION_ID } from "@/lib/entities/ontology";
import { buildCognificationCandidateBatchV1, deriveCognificationBatchId, deriveCognificationCandidateId } from "@/lib/knowledge/cognification-contract";
import { saveKnowledgeCognition } from "@/lib/knowledge/cognification-store";
import { decideNativeKnowledgeCognition, readNativeKnowledgeCognitionDecision, readNativeKnowledgeCognitionReview } from "@/lib/knowledge/cognification-native-store";
import type { KnowledgeCognitionNativeRequest } from "@/lib/knowledge/cognification-native-contracts";
import { claimNativeCognitionBuildEffect,commitNativeCognitionBuildEffect,loadNativeCognitionBuildJob,readNativeKnowledgeCognitionBuild,
  reviewNativeKnowledgeCognitionBuild,submitNativeKnowledgeCognitionBuild } from "@/lib/knowledge/cognification-build-native-store";
import { partitionCognificationBatches } from "@/lib/knowledge/cognification-runtime";
import { getOperationJob } from "@/lib/operations/job-queue";
import type { PrivateActionScope } from "@/lib/memory/private-action-contracts";
import { knowledgeDeletionTargetId } from "@/lib/rag/deletion-events";
import { deleteNativeKnowledgeSource, readNativeKnowledgeSourceDeletion, reviewNativeKnowledgeSourceDeletion } from "@/lib/rag/source-deletion-native-store";
import type { NativeKnowledgeSourceDeletionRequest } from "@/lib/rag/source-deletion-native-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { persistCanonicalSourceWrite } from "@/lib/sources/store";
import { buildCanonicalTextSourceWrite, contentSha256Hex } from "@/lib/sources/text-lineage";

vi.mock("@/lib/settings/runtime-models",() => ({ resolveRuntimeModelAssignment: async () => ({ scope: "memory",source: "tenant_assignment",configured: true,
  provider: "openai",model: "fixture-memory-model",allowCrossProviderFallback: false,assignmentId: "fixture-memory-assignment",assignmentRevision: 1,
  assignmentConfigurationSha256: "c".repeat(64) }) }));

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", owner = "private-actions@example.test", canonical = `actor:${user}`;
const role = "private_actions_test_runtime", capturedAt = "2026-10-01T00:00:00.123Z", content = "This synthetic source has one reviewable statement.";

// All product operations use a real serving role. Fixtures contain no provider
// calls and never grant access to the private actor identifier registry.
integration("native source-map and complete local source deletion", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient(); admin = postgres(databaseUrl!, { max: 3, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    // Legacy capabilities normally supplied at deployment. Immutable source
    // revisions receive SELECT only; native readers lock their mutable parent.
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_source_revisions,omni_evidence_units,
      omni_knowledge_chunks,omni_agent_runs,omni_tool_executions TO ${role}`);
    await admin.unsafe(`GRANT SELECT,UPDATE ON omni_source_items TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON omni_knowledge_documents,omni_memories TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE ON omni_operation_jobs TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events TO ${role}`);
    await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${role}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${user},${owner},'fixture-only')`;
    await closeDatabaseClient(); const url = new URL(databaseUrl!); url.username = role; url.password = password;
    vi.stubEnv("DATABASE_URL",url.toString()); vi.stubEnv("NODE_ENV","production"); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX","2"); vi.stubEnv("VERCEL","");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET",randomBytes(32).toString("hex"));
    await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("private-proof",[owner,canonical],() => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_native_private_memory_actions') AS receipt_rls,
      has_table_privilege(current_user,'omni_auth_user_actor_identifiers','SELECT') AS private_registry_read
      FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toMatchObject({ role, rolsuper: false, rolbypassrls: false, receipt_rls: true, private_registry_read: false });
  },180_000);
  afterAll(async () => { await closeDatabaseClient(); vi.unstubAllEnvs(); if (admin) {
    if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE ${role}`); } await admin.end(); } });
  async function fixtureTransaction<T>(scope: PrivateActionScope,work: (sql: ReturnType<typeof getSql>) => Promise<T>): Promise<T> {
    return await admin.begin(async (tx) => {
      await tx`SELECT set_config('omni.tenant_id',${scope.tenantId},TRUE),set_config('omni.actor_scope_v1',${JSON.stringify({ version: 1,tenantId: scope.tenantId,actorIds: [scope.ownerActorId,scope.canonicalActorId] })},TRUE),
        set_config('omni.system_scope','false',TRUE)`;
      const tagged = (strings: TemplateStringsArray,...params: unknown[]) => tx(strings,...params as never[]);
      const sql = Object.assign(tagged,{ transactionScoped: true, query: (text: string,params?: unknown[]) => tx.unsafe(text,(params ?? []) as never[]),
        unsafe: (text: string,params?: unknown[]) => tx.unsafe(text,(params ?? []) as never[]), transaction: async () => { throw new Error("Fixture already in transaction."); } }) as unknown as ReturnType<typeof getSql>;
      return work(sql);
    }) as T;
  }
  async function account(tag: string): Promise<PrivateActionScope> {
    const tenantId = `private-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},${tag},${tenantId})`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${`${tenantId}:member`},${tenantId},${user},'operator')`;
    return { tenantId, ownerActorId: owner, canonicalActorId: canonical };
  }
  async function source(scope: PrivateActionScope, tag: string) {
    const documentId = `${scope.tenantId}:document:${tag}`, chunkId = `${documentId}:chunk:0`;
    const executionScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: owner, executingPrincipalType: "user", executingPrincipalId: owner,
      correlationId: tag, purpose: "connector.sync" });
    const write = buildCanonicalTextSourceWrite({ lineage: { executionScope, connectionId: `${scope.tenantId}:google`, adapterId: "google.personal_sync.mail",
      externalItemId: tag, sourceKind: "email", capturedAt, visibility: "user_private" }, content, normalizedContent: content,
      chunks: [{ index: 0, content, characterStart: 0, characterEnd: content.length }] });
    const output = write.adapterOutput, sourceItemId = output.sourceItem.sourceItemId, sourceRevisionId = output.sourceRevision.sourceRevisionId;
    await fixtureTransaction(scope,async (sql) => {
      await persistCanonicalSourceWrite(sql,write,{ documentId });
      await sql`INSERT INTO omni_knowledge_documents(id,tenant_id,title,source,source_type,content_hash,chunk_count,total_characters,source_item_id,source_revision_id)
        VALUES(${documentId},${scope.tenantId},${tag},${`google:mail:${tag}`},'text',${output.sourceRevision.contentSha256},1,${content.length},${sourceItemId},${sourceRevisionId})`;
      await sql`INSERT INTO omni_knowledge_chunks(id,tenant_id,document_id,chunk_index,title,content,source,character_count,source_revision_id,evidence_unit_id)
        VALUES(${chunkId},${scope.tenantId},${documentId},0,${tag},${content},${`google:mail:${tag}`},${content.length},${sourceRevisionId},${write.evidenceUnitIdsByChunkIndex[0]})`;
    });
    const batchInputSha256 = sourceContractSha256({ documentId,content });
    const batchId = deriveCognificationBatchId({ documentId,sourceItemId,sourceRevisionId,retentionExpiresAt: null,batchIndex: 0,batchInputSha256 });
    const summaryBody = { text: content, confidenceBasisPoints: 8800, evidence: [{ evidenceUnitId: write.evidenceUnitIdsByChunkIndex[0], chunkId, chunkIndex: 0,
      quote: content, quoteSha256: contentSha256Hex(content), coordinateSpace: "evidence_content" as const, offsetUnit: "utf16_code_unit" as const,
      startOffset: 0,endOffsetExclusive: content.length }] };
    const candidate = buildCognificationCandidateBatchV1({ batchId,tenantId: scope.tenantId,ownerActorId: owner,documentId,sourceItemId,sourceRevisionId,
      retentionExpiresAt: null,batchIndex: 0,batchCount: 1,firstChunkIndex: 0,lastChunkIndex: 0,chunkCount: 1,inputCharacterCount: content.length,batchInputSha256,
      evidenceUnitIds: [...write.evidenceUnitIdsByChunkIndex],ontologyVersionId: ASAEL_ONTOLOGY_VERSION_ID,topics: [],claims: [],entities: [],relations: [],
      summary: { candidateId: deriveCognificationCandidateId("summary",summaryBody),...summaryBody },
      modelAttribution: { provider: "openai",model: "fixture-model",routingSource: "tenant_assignment",assignmentScope: "memory",assignmentId: "fixture-assignment",
        assignmentRevision: 1,assignmentConfigurationSha256: sourceContractSha256({ fixture: true }),credentialSource: "tenant_vault",usageReceiptRecorded: true,usageReceiptId: `usage:${batchId}` } });
    await fixtureTransaction(scope,(sql) => saveKnowledgeCognition(candidate,{ executionScope,sql }));
    const viewed = await readNativeKnowledgeCognitionReview({ scope },batchId); if (!viewed?.review) throw new Error("Fixture review is unavailable.");
    return { scope,documentId,batchId,request: { contract: "asael-knowledge-cognition-decision:1",decision: "confirm",review: viewed.review } as KnowledgeCognitionNativeRequest };
  }
  function decide(f: Awaited<ReturnType<typeof source>>, key = "confirm-once", request = f.request) {
    return decideNativeKnowledgeCognition({ authority: { scope: f.scope, executionScope: createExecutionScope({ tenantId: f.scope.tenantId,initiatingActorId: owner,
      executingPrincipalType: "user",executingPrincipalId: owner,correlationId: key,causationId: f.batchId,purpose: "knowledge.cognition.review" }) },reviewId: f.batchId,request,idempotencyKey: key });
  }
  async function deletionRequest(scope: PrivateActionScope): Promise<NativeKnowledgeSourceDeletionRequest> {
    const view = await reviewNativeKnowledgeSourceDeletion({ scope },"mail"); if (!view.pin) throw new Error(`No deletion pin: ${view.reason}`);
    return { contract: "asael-knowledge-source-delete:1",review: view.pin };
  }
  function remove(scope: PrivateActionScope,request: NativeKnowledgeSourceDeletionRequest,key = "delete-once") {
    return deleteNativeKnowledgeSource({ authority: { scope,executionScope: createExecutionScope({ tenantId: scope.tenantId,initiatingActorId: owner,
      executingPrincipalType: "user",executingPrincipalId: owner,correlationId: key,causationId: knowledgeDeletionTargetId("google:mail:"),purpose: "knowledge.delete_source" }) },sourceKind: "mail",request,idempotencyKey: key });
  }
  async function buildRequest(f: Awaited<ReturnType<typeof source>>) {
    const review = await reviewNativeKnowledgeCognitionBuild({ scope: f.scope },f.documentId);
    expect(review.eligible).toBe(true);
    return { contract: "asael-knowledge-cognition-build:1" as const,review: review.pin };
  }
  function build(f: Awaited<ReturnType<typeof source>>,request: Awaited<ReturnType<typeof buildRequest>>,key = "build-once") {
    return submitNativeKnowledgeCognitionBuild({ authority: { scope: f.scope,executionScope: createExecutionScope({ tenantId: f.scope.tenantId,initiatingActorId: owner,
      executingPrincipalType: "user",executingPrincipalId: owner,correlationId: key,causationId: f.documentId,purpose: "knowledge.cognition.queue" }) },
      documentId: f.documentId,request,idempotencyKey: key });
  }
  async function leasedBuild(f: Awaited<ReturnType<typeof source>>,jobId: string) {
    await admin`UPDATE omni_operation_jobs SET status='running',attempt=1,lease_owner='fixture-worker',lease_expires_at=clock_timestamp()+INTERVAL '5 minutes'
      WHERE tenant_id=${f.scope.tenantId} AND id=${jobId}`;
    const job = await runWithDatabaseActorScope(f.scope.tenantId,[owner,canonical],() => getOperationJob(jobId,{ tenantId: f.scope.tenantId }));
    if (!job) throw new Error("Exact build job missing");
    const accepted = await runWithDatabaseActorScope(f.scope.tenantId,[owner,canonical],() => loadNativeCognitionBuildJob(job));
    return { job,accepted };
  }
  test("same-key confirmation commits once and exact recovery never repeats Memory or projection effects", async () => {
    const f = await source(await account("confirm"),"one"), results = await Promise.all([decide(f),decide(f)]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false,true]); expect(results[0].acceptance).toEqual(results[1].acceptance);
    expect(results.filter((r) => r.memory !== null)).toHaveLength(1);
    const recovered = await readNativeKnowledgeCognitionDecision({ scope: f.scope },f.batchId,results[0].acceptance.keySha256);
    expect(recovered.acceptance).toEqual(results[0].acceptance); expect(recovered.review.projection).toBe("unconfirmed");
    await expect(decide(f,"confirm-once",{ ...f.request,decision: "dismiss" })).rejects.toMatchObject({ status: 409 });
    expect((await admin`SELECT count(*)::INTEGER AS count FROM omni_memories WHERE tenant_id=${f.scope.tenantId}`)[0].count).toBe(1);
    expect((await admin`SELECT count(*)::INTEGER AS count FROM omni_events WHERE tenant_id=${f.scope.tenantId} AND type='private_memory.native_action.accepted'`)[0].count).toBe(1);
    expect(await runWithDatabaseTenantScope(f.scope.tenantId,() => getSql()`SELECT acceptance FROM omni_native_private_memory_actions`)).toEqual([]);
    await expect(readNativeKnowledgeCognitionDecision({ scope: { ...f.scope,ownerActorId: "someone@example.test" } },f.batchId,results[0].acceptance.keySha256)).rejects.toMatchObject({ status: 403 });
  });
  test("acceptance-event failure rolls back Memory creation and review decision together", async () => {
    const f = await source(await account("rollback"),"one");
    await admin`CREATE FUNCTION private_actions_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type='private_memory.native_action.accepted' AND NEW.tenant_id='private-rollback' THEN RAISE EXCEPTION 'fixture acceptance event failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER private_actions_fixture_failure BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION private_actions_fixture_failure()`;
    try { await expect(decide(f)).rejects.toMatchObject({ code: "P0001" });
      expect((await readNativeKnowledgeCognitionReview({ scope: f.scope },f.batchId))?.status).toBe("pending_review");
      expect(await admin`SELECT id FROM omni_memories WHERE tenant_id=${f.scope.tenantId}`).toEqual([]);
      expect(await admin`SELECT acceptance FROM omni_native_private_memory_actions WHERE tenant_id=${f.scope.tenantId}`).toEqual([]);
    } finally { await admin`DROP TRIGGER private_actions_fixture_failure ON omni_events`; await admin`DROP FUNCTION private_actions_fixture_failure()`; }
  });
  test("complete deletion rejects a stale set, retires unprojected confirmed Memory and recovers after source removal", async () => {
    const scope = await account("delete"), first = await source(scope,"one"), confirmation = await decide(first);
    const stale = await deletionRequest(scope); expect(stale.review.derivedMemoryCount).toBe(1);
    await source(scope,"two"); await expect(remove(scope,stale)).rejects.toMatchObject({ status: 409 });
    const request = await deletionRequest(scope), result = await remove(scope,request);
    expect(result.acceptance.result).toMatchObject({ documents: 2,memories: 1,localOnly: true });
    expect(await admin`SELECT id FROM omni_knowledge_documents WHERE tenant_id=${scope.tenantId}`).toEqual([]);
    expect((await admin`SELECT content,claim_status FROM omni_memories WHERE id=${confirmation.acceptance.result.memoryId}`)[0]).toEqual({ content: "",claim_status: "superseded" });
    expect(await admin`SELECT acceptance FROM omni_native_private_memory_actions WHERE tenant_id=${scope.tenantId} AND operation='knowledge.cognition.decide'`).toEqual([]);
    expect(await readNativeKnowledgeSourceDeletion({ scope },"mail",result.acceptance.keySha256)).toEqual(result.acceptance);
    await source(scope,"later-import"); expect((await remove(scope,request)).replayed).toBe(true);
    expect((await admin`SELECT count(*)::INTEGER AS count FROM omni_knowledge_documents WHERE tenant_id=${scope.tenantId}`)[0].count).toBe(1);
  });
  test("a failed deletion acceptance rolls back the complete local set", async () => {
    const scope = await account("delete-rollback"), f = await source(scope,"one"); await decide(f);
    const request = await deletionRequest(scope);
    await admin`CREATE FUNCTION private_delete_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type='private_memory.native_action.accepted' AND NEW.tenant_id='private-delete-rollback' AND NEW.payload->>'operation'='knowledge.source.delete'
        THEN RAISE EXCEPTION 'fixture deletion event failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER private_delete_fixture_failure BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION private_delete_fixture_failure()`;
    try { await expect(remove(scope,request)).rejects.toMatchObject({ code: "P0001" });
      expect((await admin`SELECT count(*)::INTEGER AS count FROM omni_knowledge_documents WHERE tenant_id=${scope.tenantId}`)[0].count).toBe(1);
      expect((await admin`SELECT claim_status FROM omni_memories WHERE id=${`memory:${f.batchId}`}`)[0].claim_status).toBe("active");
      expect((await admin`SELECT count(*)::INTEGER AS count FROM omni_native_private_memory_actions WHERE tenant_id=${scope.tenantId} AND operation='knowledge.cognition.decide'`)[0].count).toBe(1);
    } finally { await admin`DROP TRIGGER private_delete_fixture_failure ON omni_events`; await admin`DROP FUNCTION private_delete_fixture_failure()`; }
  });
  test("paid build atomically queues once, claims once and recovers without requeueing uncertain work",async () => {
    const f = await source(await account("paid-once"),"one"),request = await buildRequest(f);
    const results = await Promise.all([build(f,request),build(f,request)]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false,true]); expect(results[0].acceptance).toEqual(results[1].acceptance);
    expect(results[0].processing.phase).toBe("queued");
    const a = results[0].acceptance,{ job,accepted } = await leasedBuild(f,a.operationJobId);
    const claim = await claimNativeCognitionBuildEffect(accepted,job); expect(claim.claimId).toBeTruthy();
    await expect(claimNativeCognitionBuildEffect(accepted,job)).rejects.toMatchObject({ status: 409,code: "cognition_build_reconciliation_required" });
    await admin`UPDATE omni_operation_jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL WHERE id=${job.id}`;
    const recovered = await readNativeKnowledgeCognitionBuild({ scope: f.scope },f.documentId,a.keySha256);
    expect(recovered.acceptance).toEqual(a); expect(recovered.processing).toMatchObject({ phase: "reconciliation_required",automaticRetryAllowed: false });
    await expect(build(f,request,"different-key")).rejects.toMatchObject({ status: 409 });
    expect((await build(f,request)).replayed).toBe(true);
    expect((await admin`SELECT count(*)::INTEGER AS count FROM omni_operation_jobs WHERE tenant_id=${f.scope.tenantId}`)[0].count).toBe(1);
    expect(await runWithDatabaseTenantScope(f.scope.tenantId,() => getSql()`SELECT id FROM omni_knowledge_native_cognition_builds`)).toEqual([]);
    await expect(readNativeKnowledgeCognitionBuild({ scope: { ...f.scope,ownerActorId: "other@example.test" } },f.documentId,a.keySha256)).rejects.toMatchObject({ status: 403 });
    await remove(f.scope,await deletionRequest(f.scope));
    expect(await admin`SELECT id FROM omni_knowledge_native_cognition_builds WHERE tenant_id=${f.scope.tenantId}`).toEqual([]);
    expect(await admin`SELECT claim_id FROM omni_knowledge_native_cognition_effects WHERE tenant_id=${f.scope.tenantId}`).toEqual([]);
  });
  test("paid build admission failure rolls back its job and exact receipt",async () => {
    const f = await source(await account("paid-rollback"),"one"),request = await buildRequest(f);
    await admin`CREATE FUNCTION private_paid_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type='knowledge.cognition.native.build.accepted' AND NEW.tenant_id='private-paid-rollback' THEN RAISE EXCEPTION 'fixture paid admission failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER private_paid_fixture_failure BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION private_paid_fixture_failure()`;
    try { await expect(build(f,request)).rejects.toMatchObject({ code: "P0001" });
      expect(await admin`SELECT id FROM omni_knowledge_native_cognition_builds WHERE tenant_id=${f.scope.tenantId}`).toEqual([]);
      expect(await admin`SELECT id FROM omni_operation_jobs WHERE tenant_id=${f.scope.tenantId}`).toEqual([]);
    } finally { await admin`DROP TRIGGER private_paid_fixture_failure ON omni_events`; await admin`DROP FUNCTION private_paid_fixture_failure()`; }
  });
  test("paid output event failure rolls back candidate settlement and preserves the once-only claim",async () => {
    const f = await source(await account("paid-output"),"one"),request = await buildRequest(f),submitted = await build(f,request);
    const { job,accepted } = await leasedBuild(f,submitted.acceptance.operationJobId),claim = await claimNativeCognitionBuildEffect(accepted,job);
    const [batch] = partitionCognificationBatches({ document: claim.document,chunks: claim.chunks,generationId: request.review.generationId });
    const summaryBody = { text: content,confidenceBasisPoints: 8800,evidence: [{ evidenceUnitId: claim.chunks[0].evidenceUnitId,chunkId: claim.chunks[0].id,chunkIndex: 0,
      quote: content,quoteSha256: contentSha256Hex(content),coordinateSpace: "evidence_content" as const,offsetUnit: "utf16_code_unit" as const,startOffset: 0,endOffsetExclusive: content.length }] };
    const candidate = buildCognificationCandidateBatchV1({ batchId: batch.batchId,tenantId: f.scope.tenantId,ownerActorId: owner,documentId: f.documentId,
      sourceItemId: claim.document.sourceItemId,sourceRevisionId: claim.document.sourceRevisionId,retentionExpiresAt: claim.document.retentionExpiresAt,generationId: request.review.generationId,
      batchIndex: batch.batchIndex,batchCount: batch.batchCount,firstChunkIndex: batch.firstChunkIndex,lastChunkIndex: batch.lastChunkIndex,chunkCount: batch.chunkCount,
      inputCharacterCount: batch.inputCharacterCount,batchInputSha256: batch.batchInputSha256,evidenceUnitIds: [...batch.evidenceUnitIds],ontologyVersionId: ASAEL_ONTOLOGY_VERSION_ID,
      topics: [],claims: [],entities: [],relations: [],summary: { candidateId: deriveCognificationCandidateId("summary",summaryBody),...summaryBody },
      modelAttribution: { provider: "openai",model: "fixture-memory-model",routingSource: "tenant_assignment",assignmentScope: "memory",assignmentId: "fixture-memory-assignment",
        assignmentRevision: 1,assignmentConfigurationSha256: "c".repeat(64),credentialSource: "tenant_vault",usageReceiptRecorded: true,usageReceiptId: `usage:${batch.batchId}` } });
    await admin`CREATE FUNCTION private_paid_output_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type='knowledge.cognition.native.build.committed' AND NEW.tenant_id='private-paid-output' THEN RAISE EXCEPTION 'fixture paid output failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER private_paid_output_failure BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION private_paid_output_failure()`;
    try { await expect(commitNativeCognitionBuildEffect(accepted,job,claim.claimId,candidate)).rejects.toMatchObject({ code: "P0001" });
      expect(await admin`SELECT id FROM omni_knowledge_cognition_candidates WHERE tenant_id=${f.scope.tenantId} AND id=${batch.batchId}`).toEqual([]);
      expect((await admin`SELECT state,candidate_id,next_job_id FROM omni_knowledge_native_cognition_effects WHERE build_id=${accepted.acceptance.id}`)[0])
        .toEqual({ state: "started",candidate_id: null,next_job_id: null });
      await expect(claimNativeCognitionBuildEffect(accepted,job)).rejects.toMatchObject({ code: "cognition_build_reconciliation_required" });
    } finally { await admin`DROP TRIGGER private_paid_output_failure ON omni_events`; await admin`DROP FUNCTION private_paid_output_failure()`; }
  });
});
