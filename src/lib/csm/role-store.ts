import "server-only";

import type { AppServiceCaller } from "@/lib/app-services/contracts";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { databaseMemoryAccessScopeFromExecutionScope, setTransactionLocalDatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { buildUserPrivateMemoryAccessBindingV1, MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestMemoryAccessFromSecurityContext, type RequestMemoryAccessV1 } from "@/lib/memory/request-access";
import { saveMemoryWithCommitStatusInTransaction } from "@/lib/memory/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { CsmError } from "./contracts";
import { csmRoleSnapshotSchema, type CsmRoleSnapshot } from "./role-contracts";

const SOURCE = "app.csm.role_context.v1";
type Sql = ReturnType<typeof getSql>;
export type CsmStoredRoleContext = { revision: string; snapshot: CsmRoleSnapshot };

/** Explicit role-context access reads one typed private record, not the user's
 * general personal-memory retrieval lane or any other client's project. */
export function csmRoleAccess(caller: AppServiceCaller, write = false) {
  if (!hasDatabaseUrl()) throw new CsmError("Saved CSM role context requires the database to be available.", 503);
  const access = requestMemoryAccessFromSecurityContext(caller.context, {
    purposeId: write ? MEMORY_PURPOSE_IDS.correct : MEMORY_PURPOSE_IDS.read,
    auditPurpose: write ? "app.csm.role.write" : "app.csm.role.read",
    correlationId: caller.executionScope?.correlationId || crypto.randomUUID(),
  });
  if (!access) throw new CsmError("A signed-in user is required for private CSM role context.", 403);
  return access;
}

export async function readCsmRoleContext(access: RequestMemoryAccessV1): Promise<CsmStoredRoleContext | null> {
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: Sql) => {
    await setTransactionLocalDatabaseMemoryAccessScope(sql, access.databaseAccessScope);
    return readCurrent(sql, access);
  }) as Promise<CsmStoredRoleContext | null>;
}

export async function writeCsmRoleContext(input: {
  caller: AppServiceCaller;
  access: RequestMemoryAccessV1;
  expectedRevision: string | null;
  intent: unknown;
  change: (current: CsmRoleSnapshot | null) => CsmRoleSnapshot;
}): Promise<CsmStoredRoleContext> {
  if (!input.caller.idempotencyKey || !input.caller.executionScope) {
    throw new CsmError("An exact role-context edit intent is required.", 409);
  }
  const tenantId = input.caller.context.tenantId;
  const actorId = input.access.actorBinding.canonicalActorId;
  const requestSha256 = canonicalJsonSha256({ intent: input.intent, expectedRevision: input.expectedRevision });
  const revision = `csm_role_${canonicalJsonSha256({ tenantId, actorId, key: input.caller.idempotencyKey })}`;
  const accessScope = databaseMemoryAccessScopeFromExecutionScope(input.access.executionScope, {
    purposeId: MEMORY_PURPOSE_IDS.correct,
    auditPurpose: "Atomically save the user's reviewed CSM role context.",
  });
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: Sql) => {
    await setTransactionLocalDatabaseMemoryAccessScope(sql, accessScope);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${actorId}:csm-role`}, 0))`;
    const replay = await sql`SELECT id, content FROM omni_memories
      WHERE tenant_id = ${tenantId} AND owner_actor_id = ${actorId}
        AND visibility = 'user_private' AND source = ${SOURCE} AND id = ${revision}
        AND claim_status <> 'forgotten' LIMIT 1`;
    if (replay[0]) {
      const existing = parseRow(replay[0]);
      if (existing.snapshot.requestSha256 !== requestSha256) throw new CsmError("This edit key was already used for another change.", 409);
      return existing;
    }
    const priorAcceptance = await sql`SELECT 1 FROM omni_events
      WHERE tenant_id = ${tenantId} AND id = ${`csm_role_context_saved_${revision}`}
        AND type = 'csm.role_context.saved' LIMIT 1`;
    if (priorAcceptance.length) {
      throw new CsmError("This accepted edit is no longer readable. Reload your role context and use a new edit key.", 409);
    }
    const current = await readCurrent(sql, input.access);
    if ((current?.revision || null) !== input.expectedRevision) {
      throw new CsmError("Your CSM role context changed. Reload it before saving.", 409);
    }
    const snapshot = csmRoleSnapshotSchema.parse({ ...input.change(current?.snapshot || null), requestSha256 });
    const saved = await saveMemoryWithCommitStatusInTransaction({
      id: revision, tenantId, type: "knowledge", tier: "semantic", formationReason: "explicit_user_request",
      title: "My CSM role context", content: JSON.stringify(snapshot), tags: ["csm-role-context-v1"],
      scope: "user", source: SOURCE, assertedBy: "user", importance: 0.8, confidence: 1,
      supersedesId: current?.revision,
      accessBinding: buildUserPrivateMemoryAccessBindingV1({
        tenantId, ownerActorId: actorId, originPurpose: "app.csm.role.write",
        // Role context is loaded explicitly by the CSM compiler. Do not grant
        // ambient general-memory retrieval or copy these notes into an Agent.
        allowedPurposeIds: [MEMORY_PURPOSE_IDS.read, MEMORY_PURPOSE_IDS.write,
          MEMORY_PURPOSE_IDS.correct, MEMORY_PURPOSE_IDS.forget, MEMORY_PURPOSE_IDS.export],
      }),
      databaseAccessScope: accessScope, executionScope: input.access.executionScope,
    }, sql, { databaseAccessScopeAlreadyEntered: true });
    const persisted = parseRow({ id: saved.record.id, content: saved.record.content });
    if (current) {
      await sql`UPDATE omni_memories SET claim_status = 'superseded', valid_to = NOW(), updated_at = NOW()
        WHERE tenant_id = ${tenantId} AND owner_actor_id = ${actorId} AND id = ${current.revision}
          AND source = ${SOURCE} AND visibility = 'user_private' AND claim_status = 'active'`;
    }
    await appendScopedDomainEvent({
      id: `csm_role_context_saved_${revision}`,
      streamId: `csm-role:${canonicalJsonSha256({ tenantId, actorId })}`,
      type: "csm.role_context.saved", executionScope: input.access.executionScope,
      payload: { schemaVersion: 1, revision, previousRevision: current?.revision || null,
        requestSha256, sourceCount: persisted.snapshot.sourceLinks.length, textCharacterCount: persisted.snapshot.text.length },
    }, { sql });
    return persisted;
  }) as Promise<CsmStoredRoleContext>;
}

async function readCurrent(sql: Sql, access: RequestMemoryAccessV1) {
  const rows = await sql`SELECT id, content FROM omni_memories
    WHERE tenant_id = ${access.executionScope.tenantId} AND owner_actor_id = ${access.actorBinding.canonicalActorId}
      AND visibility = 'user_private' AND workspace_id IS NULL AND project_id IS NULL AND mission_id IS NULL
      AND source = ${SOURCE} AND claim_status = 'active'
      AND (valid_from IS NULL OR valid_from <= NOW()) AND (valid_to IS NULL OR valid_to > NOW())
      AND (retention_expires_at IS NULL OR retention_expires_at > NOW())
      AND NOT EXISTS (SELECT 1 FROM omni_memory_lifecycle_states state WHERE state.tenant_id = omni_memories.tenant_id
        AND state.memory_id = omni_memories.id AND state.archived_at IS NOT NULL)
    ORDER BY created_at DESC, id DESC LIMIT 2`;
  if (rows.length > 1) throw new CsmError("Your CSM role context has conflicting active revisions.", 409);
  return rows[0] ? parseRow(rows[0]) : null;
}

function parseRow(row: Record<string, unknown>): CsmStoredRoleContext {
  try { return { revision: String(row.id), snapshot: csmRoleSnapshotSchema.parse(JSON.parse(String(row.content))) }; }
  catch { throw new CsmError("The saved CSM role context could not be verified.", 503); }
}
