import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { parseDatabaseMemoryAccessScope, setTransactionLocalDatabaseMemoryAccessScope, type DatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import type { SqlClient } from "@/lib/db/sql-types";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { applyMemoryLifecycleInTransaction, MemoryLifecycleConflictError } from "@/lib/memory/maintenance-store";
import {
  lifecycleTokensEqual, memoryLifecycleAcceptanceSchema, memoryLifecycleIntent,
  MemoryLifecycleMutationError, memoryLifecycleReadSchema, memoryLifecycleTargetToken,
  type MemoryLifecycleAcceptance, type MemoryLifecycleMutationRequest, type MemoryLifecycleRead,
} from "@/lib/memory/lifecycle-mutation-contracts";
import { parsePersistedExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";

export type MemoryLifecycleMutationAuthority = Readonly<{
  tenantId: string; ownerActorId: string; accessScope: DatabaseMemoryAccessScope; executionScope: ExecutionScope;
}>;

type Options = { sql?: SqlClient };
function validateAuthority(value: MemoryLifecycleMutationAuthority, purposeId: string) {
  const scope = parseDatabaseMemoryAccessScope(value.accessScope);
  const execution = parsePersistedExecutionScope(value.executionScope);
  if (!execution || !/^actor:[a-f0-9-]{36}$/.test(value.ownerActorId) ||
    scope.tenantId !== value.tenantId || scope.initiatingActorId !== value.ownerActorId ||
    scope.executingPrincipalType !== "user" || scope.executingPrincipalId !== value.ownerActorId ||
    scope.purposeId !== purposeId || scope.purpose !== execution.purpose || scope.workspaceId !== null || scope.projectId !== null || scope.missionId !== null ||
    scope.contextGrantIds.length || scope.capabilityGrantIds.length ||
    execution.tenantId !== value.tenantId || execution.initiatingActorId !== value.ownerActorId ||
    execution.executingPrincipalType !== "user" || execution.executingPrincipalId !== value.ownerActorId ||
    execution.workspaceId !== null || execution.projectId !== null || execution.missionId !== null ||
    execution.contextGrantIds.length || execution.capabilityGrantIds.length || execution.delegationId !== null) {
    throw new MemoryLifecycleMutationError("memory_lifecycle_authority_invalid", 403, "Current private Memory authority is required.");
  }
  return scope;
}

async function transaction<T>(options: Options, operation: (sql: SqlClient) => Promise<T>): Promise<T> {
  if (options.sql) {
    if (!options.sql.transactionScoped) throw new Error("Memory lifecycle composition requires a managed SQL transaction.");
    return operation(options.sql);
  }
  if (!hasDatabaseUrl()) {
    throw new MemoryLifecycleMutationError("memory_lifecycle_durable_storage_unavailable", 503, "Durable Memory lifecycle storage is unavailable.");
  }
  await ensureDatabaseSchema();
  return getSql().transaction(operation) as Promise<T>;
}

function date(value: unknown) {
  if (value === null || value === undefined) return null;
  const result = value instanceof Date ? value.toISOString() : String(value);
  return new Date(result).toISOString();
}

function publicRead(row: Record<string, unknown>, authority: MemoryLifecycleMutationAuthority): MemoryLifecycleRead {
  const target = {
    tenantId: authority.tenantId, ownerActorId: authority.ownerActorId, memoryId: String(row.id),
    visibility: "user_private" as const, claimStatus: row.claim_status,
    targetRevision: Number(row.lifecycle_target_revision), lifecycleRevision: Number(row.lifecycle_revision ?? 0),
  };
  // Validate before signing; no raw Memory content is read by this adapter.
  const parsed = memoryLifecycleReadSchema.parse({
    contract: "asael-memory-lifecycle-read:1", target: { ...target, token: "0".repeat(64) },
    lifecycle: {
      policyVersion: 1, pinnedAt: date(row.pinned_at), archivedAt: date(row.archived_at),
      archiveReason: row.archive_reason ?? null, duplicateOfMemoryId: row.duplicate_of_memory_id ?? null,
      updatedAt: date(row.lifecycle_updated_at),
    },
  });
  const { token: _token, ...identity } = parsed.target;
  void _token;
  return { ...parsed, target: { ...identity, token: memoryLifecycleTargetToken(identity) } };
}

async function readCurrent(sql: SqlClient, authority: MemoryLifecycleMutationAuthority, memoryId: string) {
  const rows = await sql`
    SELECT memory.id, memory.claim_status, memory.lifecycle_target_revision,
      lifecycle.lifecycle_revision, lifecycle.pinned_at, lifecycle.archived_at,
      lifecycle.archive_reason, lifecycle.duplicate_of_memory_id, lifecycle.updated_at AS lifecycle_updated_at
    FROM omni_memories memory LEFT JOIN omni_memory_lifecycle_states lifecycle
      ON lifecycle.tenant_id = memory.tenant_id AND lifecycle.memory_id = memory.id
    WHERE memory.tenant_id = ${authority.tenantId} AND memory.id = ${memoryId}
      AND memory.access_contract_version = 1 AND memory.access_state = 'scope_bound'
      AND memory.visibility = 'user_private' AND memory.owner_actor_id = ${authority.ownerActorId}
      AND memory.claim_status <> 'forgotten'
    LIMIT 1
  `;
  return rows[0] ? publicRead(rows[0], authority) : null;
}

export async function readMemoryLifecycleTarget(authority: MemoryLifecycleMutationAuthority, memoryId: string, options: Options = {}) {
  const scope = validateAuthority(authority, MEMORY_PURPOSE_IDS.read);
  return transaction(options, async (sql) => {
    await setTransactionLocalDatabaseMemoryAccessScope(sql, scope);
    return readCurrent(sql, authority, memoryId);
  });
}

export async function submitMemoryLifecycleMutation(input: {
  authority: MemoryLifecycleMutationAuthority; memoryId: string; idempotencyKey: string; request: MemoryLifecycleMutationRequest;
}, options: Options = {}): Promise<{ acceptance: MemoryLifecycleAcceptance; replayed: boolean; current: MemoryLifecycleRead }> {
  const { authority, memoryId } = input;
  const scope = validateAuthority(authority, MEMORY_PURPOSE_IDS.maintenance);
  const intent = memoryLifecycleIntent({ ...input, tenantId: authority.tenantId, ownerActorId: authority.ownerActorId });
  return transaction(options, async (sql) => {
    await setTransactionLocalDatabaseMemoryAccessScope(sql, scope);
    // Same hierarchy as forgetting: tenant graph, exact Memory, target, ledger.
    // It also serializes reuse of a key against a different descendant target.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`memory-graph:${authority.tenantId}`}, 0))`;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${authority.tenantId}), hashtext(${`memory:${memoryId}`}))`;
    const target = await sql`
      SELECT id FROM omni_memories WHERE tenant_id = ${authority.tenantId} AND id = ${memoryId}
        AND access_contract_version = 1 AND access_state = 'scope_bound' AND visibility = 'user_private'
        AND owner_actor_id = ${authority.ownerActorId} AND claim_status <> 'forgotten'
      FOR UPDATE
    `;
    // Legacy maintenance can update an existing lifecycle row independently
    // of the target row. Hold that row before taking the token snapshot too.
    await sql`SELECT memory_id FROM omni_memory_lifecycle_states
      WHERE tenant_id = ${authority.tenantId} AND memory_id = ${memoryId} FOR UPDATE`;
    const rows = await sql`
      SELECT * FROM omni_memory_lifecycle_mutations WHERE tenant_id = ${authority.tenantId}
        AND owner_actor_id = ${authority.ownerActorId} AND idempotency_key_sha256 = ${intent.keySha256}
    `;
    const prior = rows[0];
    if (prior?.forgotten_at) {
      throw new MemoryLifecycleMutationError("memory_lifecycle_replay_forgotten", 409, "The target was forgotten. This action cannot be replayed.");
    }
    if (!target[0]) throw new MemoryLifecycleMutationError("memory_lifecycle_target_unavailable", 404, "Current private Memory was not found.");
    const current = await readCurrent(sql, authority, memoryId);
    if (!current) throw new MemoryLifecycleMutationError("memory_lifecycle_target_unavailable", 404, "Current private Memory was not found.");
    if (prior) {
      if (prior.memory_id !== memoryId || prior.request_sha256 !== intent.requestSha256) {
        throw new MemoryLifecycleMutationError("memory_lifecycle_key_conflict", 409, "This key was accepted for a different lifecycle request.");
      }
      const acceptance = memoryLifecycleAcceptanceSchema.parse(prior.acceptance);
      if (acceptance.id !== intent.acceptanceId || acceptance.memoryId !== memoryId ||
        acceptance.ownerActorId !== authority.ownerActorId || acceptance.tenantId !== authority.tenantId ||
        acceptance.action !== intent.request.action || acceptance.requestSha256 !== intent.requestSha256 ||
        acceptance.expectedTargetToken !== intent.request.expectedTargetToken ||
        acceptance.idempotencyKeySha256 !== intent.keySha256) throw new Error("Stored Memory lifecycle acceptance is inconsistent.");
      return { acceptance, replayed: true, current };
    }
    if (!lifecycleTokensEqual(current.target.token, intent.request.expectedTargetToken)) {
      throw new MemoryLifecycleMutationError("memory_lifecycle_target_changed", 409, "Memory changed. Read its current lifecycle before deciding again.");
    }
    const clock = await sql`SELECT clock_timestamp() AS now`;
    const acceptedAt = date(clock[0]?.now);
    if (!acceptedAt) throw new Error("Memory lifecycle clock is unavailable.");
    try {
      await applyMemoryLifecycleInTransaction(sql, {
        memoryId, tenantId: authority.tenantId, accessContractVersion: 1, ownerActorId: authority.ownerActorId,
        action: intent.request.action, executionScope: authority.executionScope, now: acceptedAt,
        eventId: intent.acceptanceId,
      });
    } catch (error) {
      if (error instanceof MemoryLifecycleConflictError) {
        throw new MemoryLifecycleMutationError("memory_lifecycle_state_conflict", 409, error.message);
      }
      throw error;
    }
    const updated = await readCurrent(sql, authority, memoryId);
    if (!updated) throw new Error("Accepted Memory lifecycle target disappeared.");
    const acceptance = memoryLifecycleAcceptanceSchema.parse({
      contract: "asael-memory-lifecycle-acceptance:1", id: intent.acceptanceId,
      tenantId: authority.tenantId, ownerActorId: authority.ownerActorId, memoryId, action: intent.request.action,
      idempotencyKeySha256: intent.keySha256, requestSha256: intent.requestSha256, acceptedAt,
      expectedTargetToken: intent.request.expectedTargetToken,
      targetRevision: current.target.targetRevision, beforeLifecycleRevision: current.target.lifecycleRevision,
      afterLifecycleRevision: updated.target.lifecycleRevision, lifecycle: updated.lifecycle,
      historicalTruthChanged: false, permanentDeletion: false,
    });
    await sql`
      INSERT INTO omni_memory_lifecycle_mutations (id, tenant_id, owner_actor_id, memory_id, action,
        idempotency_key_sha256, request_sha256, expected_target_token, acceptance, accepted_at)
      VALUES (${intent.acceptanceId}, ${authority.tenantId}, ${authority.ownerActorId}, ${memoryId}, ${intent.request.action},
        ${intent.keySha256}, ${intent.requestSha256}, ${intent.request.expectedTargetToken}, ${acceptance}::JSONB, ${acceptedAt})
    `;
    return { acceptance, replayed: false, current: updated };
  });
}
