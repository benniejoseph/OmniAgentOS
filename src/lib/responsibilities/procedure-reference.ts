import type { SqlClient } from "@/lib/db/sql-types";
import { databaseMemoryAccessScopeFromExecutionScope, setTransactionLocalDatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { parseSavedProcedureContractV1, SAVED_PROCEDURE_V1_TAG, type SavedProcedure } from "@/lib/workflows/saved-procedures";
import { ResponsibilityError, type ResponsibilityOwner } from "./state";

/** Raw manager transaction only, BEFORE adoption. A private procedure is read
 * through the existing exact canonical user-purpose RLS contract. Every path
 * clears and verifies the GUC before a Meeting/audit callback can be adopted.
 * Runtime keeps the memory and archival locks until that outer transaction ends.
 */
export async function readOwnedResponsibilityProcedures(sql: SqlClient, owner: ResponsibilityOwner, input: { lock: boolean; now: string }): Promise<readonly SavedProcedure[]> {
  if (!sql.transactionScoped) throw unavailable();
  const scope = databaseMemoryAccessScopeFromExecutionScope(createExecutionScope({ tenantId: owner.tenantId, initiatingActorId: owner.actorId,
    executingPrincipalType: "user", executingPrincipalId: owner.actorId, correlationId: "responsibility-procedure-read", purpose: "responsibility.procedure.read.v1" }),
  { purposeId: MEMORY_PURPOSE_IDS.read, auditPurpose: "Read the exact owner's saved responsibility procedure." });
  await setTransactionLocalDatabaseMemoryAccessScope(sql, scope);
  let readFailure: { error: unknown } | undefined;
  try {
    const rows = input.lock
      ? await sql`SELECT memory.id,memory.content FROM omni_memories memory WHERE memory.tenant_id = ${owner.tenantId}
          AND memory.owner_actor_id = ${owner.actorId} AND memory.access_contract_version = 1 AND memory.visibility = 'user_private'
          AND memory.type = 'procedure' AND memory.scope = 'workspace' AND memory.claim_status = 'active' AND memory.asserted_by IN ('user','system')
          AND ${SAVED_PROCEDURE_V1_TAG} = ANY(memory.tags) AND (memory.valid_from IS NULL OR memory.valid_from <= ${input.now}::timestamptz)
          AND (memory.valid_to IS NULL OR memory.valid_to > ${input.now}::timestamptz) AND (memory.retention_expires_at IS NULL OR memory.retention_expires_at > ${input.now}::timestamptz)
          ORDER BY memory.updated_at DESC,memory.id LIMIT 129 FOR UPDATE`
      : await sql`SELECT memory.id,memory.content FROM omni_memories memory WHERE memory.tenant_id = ${owner.tenantId}
          AND memory.owner_actor_id = ${owner.actorId} AND memory.access_contract_version = 1 AND memory.visibility = 'user_private'
          AND memory.type = 'procedure' AND memory.scope = 'workspace' AND memory.claim_status = 'active' AND memory.asserted_by IN ('user','system')
          AND ${SAVED_PROCEDURE_V1_TAG} = ANY(memory.tags) AND (memory.valid_from IS NULL OR memory.valid_from <= ${input.now}::timestamptz)
          AND (memory.valid_to IS NULL OR memory.valid_to > ${input.now}::timestamptz) AND (memory.retention_expires_at IS NULL OR memory.retention_expires_at > ${input.now}::timestamptz)
          ORDER BY memory.updated_at DESC,memory.id LIMIT 129`;
    if (rows.length > 128) throw unavailable();
    const results: SavedProcedure[] = [];
    for (const row of rows) {
      // Locking the memory also fences a first lifecycle insert through the FK.
      // Lock/recheck existing lifecycle rows to fence concurrent archival.
      const lifecycle = input.lock
        ? await sql`SELECT archived_at FROM omni_memory_lifecycle_states WHERE tenant_id = ${owner.tenantId} AND memory_id = ${String(row.id)} FOR SHARE`
        : await sql`SELECT archived_at FROM omni_memory_lifecycle_states WHERE tenant_id = ${owner.tenantId} AND memory_id = ${String(row.id)}`;
      if (lifecycle.length > 1) throw unavailable();
      if (lifecycle.some((item) => item.archived_at !== null)) continue;
      try {
        const procedure = parseSavedProcedureContractV1(JSON.parse(String(row.content)), String(row.id));
        if (procedure) results.push(procedure);
      } catch { /* Untrusted malformed saved content grants no procedure. */ }
    }
    return results;
  } catch (error) {
    readFailure = { error };
    throw error;
  } finally {
    try {
      await sql`SELECT set_config('omni.memory_access_scope_v1', '', TRUE)`;
      const cleared = await sql`SELECT NULLIF(current_setting('omni.memory_access_scope_v1', TRUE),'') AS memory_scope`;
      if (cleared.length !== 1 || cleared[0].memory_scope !== null) throw new Error("Responsibility procedure scope cleanup was not confirmed; the transaction must roll back.");
    } catch (error) {
      // A failed SQL read can abort the transaction before cleanup. Retain that
      // original cause while ensuring callers cannot commit a domain refusal.
      if (readFailure) throw new AggregateError([readFailure.error, error], "Responsibility procedure read and scope cleanup failed; the transaction must roll back.");
      throw error;
    }
  }
}
function unavailable() { return new ResponsibilityError("The exact private saved procedure could not be read safely.", 409, "responsibility_procedure_unavailable"); }
