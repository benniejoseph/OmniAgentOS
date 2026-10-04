import { parseDatabaseMemoryAccessScope, setTransactionLocalDatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { buildNativeMemoryDeterministicIntent, nativeMemoryDeterministicAcceptanceSchema, nativeMemoryDeterministicIntentSchema,
  nativeMemoryDeterministicOperation, nativeMemoryGraphRebuildReviewSchema, nativeMemoryMaintenanceReviewSchema,
  NATIVE_MEMORY_GRAPH_POLICY_SHA256, NATIVE_MEMORY_MAINTENANCE_POLICY_SHA256, sealNativeMemoryGraphRebuildPin, sealNativeMemoryMaintenancePin,
  type NativeMemoryDeterministicKind, type NativeMemoryDeterministicRequest } from "@/lib/memory/deterministic-native-contracts";
import { privateMemoryGraphProjectionWithinBounds, rebuildPrivateMemoryGraphInTransaction } from "@/lib/memory/graph";
import { planMemoryMaintenance } from "@/lib/memory/lifecycle";
import { applyMemoryMaintenancePlanInTransaction } from "@/lib/memory/maintenance-store";
import { privateActionAcceptanceId, privateActionShaSchema, samePrivateActionValue, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import { assertNativePrivateActionMutation, lockNativePrivateActionGraph, nativePrivateActionFail as fail, nativePrivateActionTransaction,
  requireNativePrivateActionIdentity, type NativePrivateActionAuthority, type PrivateActionSql as Sql } from "@/lib/memory/private-action-store";
import { memoryFromRow } from "@/lib/memory/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

function readOnly(authority: NativePrivateActionAuthority) { if (authority.executionScope) fail("Private Memory inspection requires read-only authority.", "private_memory_action_read", 400); }
function memoryScope(scope: PrivateActionScope, purposeId: string, purpose: string) {
  return parseDatabaseMemoryAccessScope({ version: 1, tenantId: scope.tenantId, initiatingActorId: scope.canonicalActorId, executingPrincipalType: "user",
    executingPrincipalId: scope.canonicalActorId, workspaceId: null, projectId: null, missionId: null, contextGrantIds: [], capabilityGrantIds: [], purposeId, purpose });
}
function snapshot(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
/** A closed local scope transition, after exact current management and reviewed
 * source checks. Never accepts an inherited scope or installs system scope. */
async function clearReadScope(sql: Sql, expected: ReturnType<typeof memoryScope>) {
  const before = await sql`SELECT public.omni_current_memory_access_scope_v1() AS scope`;
  if (!samePrivateActionValue(before[0]?.scope, expected)) fail("Private Memory read scope changed before the closed mutation.");
  await sql`SELECT set_config('omni.memory_access_scope_v1','',TRUE)`;
  const after = await sql`SELECT NULLIF(current_setting('omni.memory_access_scope_v1',TRUE),'') AS scope`;
  if (after.length !== 1 || after[0].scope !== null) fail("Private Memory scope cleanup was not confirmed.");
}

async function sources(sql: Sql, scope: PrivateActionScope, kind: NativeMemoryDeterministicKind) {
  // All Memory INSERT/UPDATE, lifecycle writes and trace INSERT/UPDATE/DELETE
  // acquire this same statement fence before tuple locks. No limited read is
  // allowed to masquerade as the complete supported source cohort.
  await lockNativePrivateActionGraph(sql, scope.tenantId);
  const access = memoryScope(scope, MEMORY_PURPOSE_IDS.read, `api.memory.${kind}.native.review`);
  await setTransactionLocalDatabaseMemoryAccessScope(sql, access);
  const now = new Date().toISOString(), limit = kind === "maintenance" ? 500 : 2000;
  const rows = await sql`SELECT memory.*,COALESCE(lifecycle.lifecycle_revision,0) AS native_lifecycle_revision,
    lifecycle.pinned_at AS lifecycle_pinned_at,lifecycle.archived_at AS lifecycle_archived_at,
    lifecycle.archive_reason AS lifecycle_archive_reason,lifecycle.duplicate_of_memory_id AS lifecycle_duplicate_of_memory_id
    FROM omni_memories memory LEFT JOIN omni_memory_lifecycle_states lifecycle ON lifecycle.tenant_id=memory.tenant_id AND lifecycle.memory_id=memory.id
    WHERE memory.tenant_id=${scope.tenantId} AND memory.owner_actor_id=${scope.canonicalActorId}
      AND memory.access_contract_version=1 AND memory.access_state='scope_bound' AND memory.visibility='user_private' AND memory.scope='user'
      AND memory.owner_agent_id IS NULL AND memory.workspace_id IS NULL AND memory.project_id IS NULL AND memory.mission_id IS NULL
      AND memory.claim_status<>'forgotten' AND memory.forgotten_at IS NULL
      AND NOT public.omni_memory_ids_have_deletion_barrier(memory.tenant_id,ARRAY[memory.id])
      AND (${kind}<>'maintenance' OR memory.allowed_purpose_ids @> ARRAY['memory.maintenance.v1']::TEXT[])
      AND (${kind}<>'graph' OR (memory.claim_status='active' AND lifecycle.archived_at IS NULL
        AND (memory.valid_from IS NULL OR memory.valid_from<=${now}::TIMESTAMPTZ)
        AND (memory.valid_to IS NULL OR memory.valid_to>${now}::TIMESTAMPTZ)
        AND (memory.retention_expires_at IS NULL OR memory.retention_expires_at>${now}::TIMESTAMPTZ)))
    ORDER BY memory.id COLLATE "C" LIMIT ${limit + 1}`;
  const excluded = kind === "maintenance" ? await sql`SELECT count(*) AS count FROM omni_memories memory
    WHERE memory.tenant_id=${scope.tenantId} AND memory.owner_actor_id=${scope.canonicalActorId} AND memory.access_contract_version=1
      AND memory.access_state='scope_bound' AND memory.visibility='user_private' AND memory.scope='user'
      AND memory.owner_agent_id IS NULL AND memory.workspace_id IS NULL AND memory.project_id IS NULL AND memory.mission_id IS NULL
      AND memory.claim_status<>'forgotten' AND memory.forgotten_at IS NULL AND NOT memory.allowed_purpose_ids @> ARRAY['memory.maintenance.v1']::TEXT[]` : [];
  const excludedMemoryCount = Number(excluded[0]?.count ?? 0);
  const records = rows.length > limit ? [] : rows.map(memoryFromRow);
  const memoryIds = records.map((record) => record.id);
  const traceRows = kind === "graph" && rows.length <= limit ? await sql`SELECT * FROM omni_retrieval_traces trace
    WHERE trace.tenant_id=${scope.tenantId} AND trace.owner_actor_id=${scope.canonicalActorId}
      AND trace.access_contract_version=1 AND trace.access_state='scope_bound' AND trace.visibility='user_private'
      AND trace.owner_agent_id IS NULL AND trace.workspace_id IS NULL AND trace.project_id IS NULL AND trace.mission_id IS NULL
      AND cardinality(trace.memory_ids)>0 AND trace.memory_ids<@${memoryIds}::TEXT[]
      AND NOT public.omni_memory_ids_have_deletion_barrier(trace.tenant_id,trace.memory_ids)
    ORDER BY trace.id COLLATE "C" LIMIT 1001` : [];
  const overflow = rows.length > limit || traceRows.length > 1000 ||
    kind === "graph" && !privateMemoryGraphProjectionWithinBounds(records, traceRows, scope.tenantId);
  const inventory = rows.map((row, index) => ({ memoryId: row.id, targetRevision: Number(row.lifecycle_target_revision),
    lifecycleRevision: Number(row.native_lifecycle_revision), record: records[index] }));
  const plan = planMemoryMaintenance(records, now);
  const review = kind === "maintenance" ? nativeMemoryMaintenanceReviewSchema.parse({ eligible: !overflow,
    reason: overflow ? "scope_too_large" : null, excludedMemoryCount,
    pin: overflow ? null : sealNativeMemoryMaintenancePin({ policyVersion: 1, eligibleMemoryCount: records.length,
      inventorySha256: canonicalJsonSha256(snapshot(inventory)), planSha256: canonicalJsonSha256(plan), policySha256: NATIVE_MEMORY_MAINTENANCE_POLICY_SHA256 }) })
    : nativeMemoryGraphRebuildReviewSchema.parse({ eligible: !overflow, reason: overflow ? "scope_too_large" : null,
      pin: overflow ? null : sealNativeMemoryGraphRebuildPin({ memoryCount: records.length, traceCount: traceRows.length,
        sourceManifestSha256: canonicalJsonSha256(snapshot({ memories: inventory, traces: traceRows })), graphPolicySha256: NATIVE_MEMORY_GRAPH_POLICY_SHA256 }) });
  return { review, access, records, traceRows, plan };
}
async function accepted(sql: Sql, scope: PrivateActionScope, kind: NativeMemoryDeterministicKind, keySha256: string) {
  const rows = await sql`SELECT operation,resource_id,intent,acceptance FROM omni_native_private_memory_actions
    WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${keySha256}`;
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0].operation !== nativeMemoryDeterministicOperation(kind)) fail("This key belongs to another private action.");
  const intent = nativeMemoryDeterministicIntentSchema.parse(rows[0].intent), acceptance = nativeMemoryDeterministicAcceptanceSchema.parse(rows[0].acceptance);
  if (!samePrivateActionValue(intent.scope, scope) || !samePrivateActionValue(acceptance.scope, scope) || intent.keySha256 !== keySha256 ||
    intent.resourceId !== rows[0].resource_id || acceptance.resourceId !== intent.resourceId || acceptance.keySha256 !== keySha256 ||
    acceptance.operation !== intent.operation || acceptance.requestSha256 !== canonicalJsonSha256(intent) || acceptance.reviewSha256 !== intent.request.review.reviewSha256 ||
    (intent.operation === "memory.maintenance.run" && acceptance.operation === "memory.maintenance.run" && acceptance.result.scanned !== intent.request.review.eligibleMemoryCount) ||
    (intent.operation === "memory.graph.rebuild" && acceptance.operation === "memory.graph.rebuild" &&
      (acceptance.result.memoryCount !== intent.request.review.memoryCount || acceptance.result.traceCount !== intent.request.review.traceCount))) fail("Stored private Memory acceptance is inconsistent.");
  return { intent, acceptance };
}
async function review(authority: NativePrivateActionAuthority, kind: NativeMemoryDeterministicKind) {
  readOnly(authority); return nativePrivateActionTransaction(authority, false, async (sql) => (await sources(sql, authority.scope, kind)).review);
}
async function read(authority: NativePrivateActionAuthority, kind: NativeMemoryDeterministicKind, keySha256: string) {
  readOnly(authority); privateActionShaSchema.parse(keySha256);
  return nativePrivateActionTransaction(authority, false, async (sql) => (await accepted(sql, authority.scope, kind, keySha256))?.acceptance ?? null);
}
async function submit(input: { authority: NativePrivateActionAuthority; kind: NativeMemoryDeterministicKind; request: NativeMemoryDeterministicRequest; idempotencyKey: string }) {
  const { authority, kind } = input, scope = authority.scope;
  const intent = buildNativeMemoryDeterministicIntent({ ...input, scope });
  const execution = assertNativePrivateActionMutation(authority, kind === "maintenance" ? "api.memory.maintenance.run" : "api.memory.graph.rebuild", intent.resourceId);
  return nativePrivateActionTransaction(authority, true, async (sql) => {
    await lockNativePrivateActionGraph(sql, scope.tenantId);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`private-action:${scope.tenantId}:${scope.ownerActorId}:${intent.keySha256}`},0))`;
    const replay = await accepted(sql, scope, kind, intent.keySha256);
    if (replay) { if (!samePrivateActionValue(replay.intent, intent)) fail("This key accepted another reviewed request."); return { acceptance: replay.acceptance, replayed: true }; }
    const current = await sources(sql, scope, kind);
    if (!current.review.pin || !samePrivateActionValue(current.review.pin, intent.request.review)) fail("The complete private Memory inventory or current plan changed. Review it again.");
    await requireNativePrivateActionIdentity(sql, scope, true);
    await clearReadScope(sql, current.access);
    const writeScope = memoryScope(scope, kind === "maintenance" ? MEMORY_PURPOSE_IDS.maintenance : MEMORY_PURPOSE_IDS.write, execution.purpose!);
    await setTransactionLocalDatabaseMemoryAccessScope(sql, writeScope);
    if (kind === "maintenance") {
      const ids = current.records.map((record) => record.id);
      const locked = await sql`SELECT id FROM omni_memories WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.canonicalActorId}
        AND id=ANY(${ids}::TEXT[]) ORDER BY id COLLATE "C" FOR UPDATE`;
      if (locked.length !== ids.length) fail("Current maintenance purpose no longer covers the exact inventory.");
    }
    const refreshedPlan = planMemoryMaintenance(current.records);
    if (kind === "maintenance" && !samePrivateActionValue(refreshedPlan, current.plan)) fail("The time-sensitive maintenance plan changed before commit.");
    const effectiveNow = Date.now();
    if (kind === "graph" && current.records.some((record) =>
      record.validFrom && Date.parse(record.validFrom)>effectiveNow || record.validTo && Date.parse(record.validTo)<=effectiveNow ||
      record.retentionExpiresAt && Date.parse(record.retentionExpiresAt)<=effectiveNow)) fail("A graph source expired before commit.");
    const result = kind === "maintenance" ? await applyMemoryMaintenancePlanInTransaction(sql, current.records, refreshedPlan)
      : await rebuildPrivateMemoryGraphInTransaction(sql, { tenantId: scope.tenantId, ownerActorId: scope.canonicalActorId,
        memories: current.records, traceRows: current.traceRows, writeScope, source: "native-private-reviewed" });
    const acceptedAt = new Date().toISOString();
    const body = { contract: kind === "maintenance" ? "asael-memory-maintenance-acceptance:1" : "asael-memory-graph-rebuild-acceptance:1",
      id: privateActionAcceptanceId(scope, intent.keySha256), scope, operation: intent.operation, resourceId: intent.resourceId, keySha256: intent.keySha256,
      requestSha256: canonicalJsonSha256(intent), reviewSha256: intent.request.review.reviewSha256, acceptedAt, result };
    const acceptance = nativeMemoryDeterministicAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
    await sql`INSERT INTO omni_native_private_memory_actions(tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,operation,resource_id,request_sha256,intent,acceptance,accepted_at)
      VALUES(${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${intent.keySha256},${intent.operation},${intent.resourceId},${acceptance.requestSha256},
        ${intent}::JSONB,${acceptance}::JSONB,${acceptedAt})`;
    await appendScopedDomainEvent({ id: acceptance.id, streamId: `native-private-memory:${scope.ownerActorId}`, type: "private_memory.native_action.accepted",
      executionScope: execution, payload: { schemaVersion: 1, operation: intent.operation, acceptanceSha256: acceptance.acceptanceSha256,
        requestSha256: acceptance.requestSha256, result } }, { sql });
    return { acceptance, replayed: false };
  });
}
export const reviewNativeMemoryMaintenance = (authority: NativePrivateActionAuthority) => review(authority, "maintenance");
export const reviewNativeMemoryGraphRebuild = (authority: NativePrivateActionAuthority) => review(authority, "graph");
export const readNativeMemoryMaintenanceRun = (authority: NativePrivateActionAuthority, key: string) => read(authority, "maintenance", key);
export const readNativeMemoryGraphRebuild = (authority: NativePrivateActionAuthority, key: string) => read(authority, "graph", key);
type Submit = Omit<Parameters<typeof submit>[0], "kind">;
export const runNativeMemoryMaintenance = (input: Submit) => submit({ ...input, kind: "maintenance" });
export const rebuildNativeMemoryGraph = (input: Submit) => submit({ ...input, kind: "graph" });
