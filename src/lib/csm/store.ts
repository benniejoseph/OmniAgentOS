import "server-only";

import type { AppServiceCaller } from "@/lib/app-services/contracts";
import { ensureDatabaseSchema, getSql } from "@/lib/db/client";
import { databaseMemoryAccessScopeFromExecutionScope, setTransactionLocalDatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { buildProjectSharedMemoryAccessBindingV1, MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestSharedMemoryAccessFromSecurityContext, type RequestSharedMemoryAccessV1 } from "@/lib/memory/shared-context";
import { saveMemoryWithCommitStatusInTransaction } from "@/lib/memory/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { CsmError, csmSnapshotSchema, type CsmSnapshot } from "./contracts";

const SOURCE = "app.csm.project_context.v1";
type Sql = ReturnType<typeof getSql>;
export type CsmStoredContext = { revision: string; snapshot: CsmSnapshot };

/** Content-free optional-context probe, used only after ordinary Project
 * ownership has been checked. Every accepted CSM snapshot and this durable
 * event commit atomically, so absence means no CSM profile has been accepted.
 * Presence is not permission: shared-memory authority is still required. */
export async function hasCsmContextHistory(tenantId: string, projectId: string): Promise<boolean> {
  await ensureDatabaseSchema();
  const rows = await getSql()`SELECT 1 FROM omni_events
    WHERE tenant_id = ${tenantId} AND stream_id = ${`csm-project:${projectId}`}
      AND type = 'csm.context.saved' LIMIT 1`;
  return rows.length > 0;
}

export async function csmProjectAccess(caller: AppServiceCaller, projectId: string, write = false) {
  const access = await requestSharedMemoryAccessFromSecurityContext(caller.context, {
    scope: "project", projectId,
    correlationId: caller.executionScope?.correlationId || crypto.randomUUID(),
    purposeId: write ? MEMORY_PURPOSE_IDS.write : MEMORY_PURPOSE_IDS.read,
    auditPurpose: write ? "Save an explicitly reviewed client brief or source link." : "Read the selected project's client context.",
  });
  if (write && !access.authority.canWrite) throw new CsmError("Client context write access is required.", 403);
  return access;
}

export async function readCsmContext(access: RequestSharedMemoryAccessV1): Promise<CsmStoredContext | null> {
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: Sql) => {
    await setTransactionLocalDatabaseMemoryAccessScope(sql, access.databaseAccessScope);
    return readCurrent(sql, access);
  }) as Promise<CsmStoredContext | null>;
}

/** One immutable Memory snapshot per accepted intent. Supersession and its
 * typed event are committed together; CAS and a project lock prevent lost edits.
 * Only references are stored here, never private source bodies or copied grants. */
export async function writeCsmContext(input: {
  caller: AppServiceCaller;
  access: RequestSharedMemoryAccessV1;
  projectId: string;
  expectedRevision: string | null;
  intent: unknown;
  change: (current: CsmSnapshot | null) => CsmSnapshot;
}): Promise<CsmStoredContext> {
  if (!input.caller.idempotencyKey || !input.caller.executionScope) {
    throw new CsmError("An exact client edit intent is required.", 409);
  }
  const tenantId = input.caller.context.tenantId;
  const requestSha256 = canonicalJsonSha256({ projectId: input.projectId, intent: input.intent, expectedRevision: input.expectedRevision });
  const revision = `csm_${canonicalJsonSha256({ tenantId, actorId: input.access.actorBinding.canonicalActorId,
    projectId: input.access.authority.projectId, key: input.caller.idempotencyKey })}`;
  const accessScope = databaseMemoryAccessScopeFromExecutionScope(input.access.executionScope, {
    purposeId: MEMORY_PURPOSE_IDS.correct,
    auditPurpose: "Atomically replace the reviewed client context revision.",
  });
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: Sql) => {
    await setTransactionLocalDatabaseMemoryAccessScope(sql, accessScope);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${input.access.authority.projectId}:csm`}, 0))`;
    const replay = await sql`SELECT id, content FROM omni_memories
      WHERE tenant_id = ${tenantId} AND id = ${revision} AND source = ${SOURCE}
        AND project_id = ${input.access.authority.projectId} AND claim_status <> 'forgotten' LIMIT 1`;
    if (replay[0]) {
      const existing = parseRow(replay[0], input.projectId);
      if (existing.snapshot.requestSha256 !== requestSha256) throw new CsmError("This edit key was already used for another change.", 409);
      return existing;
    }
    const current = await readCurrent(sql, input.access);
    if ((current?.revision || null) !== input.expectedRevision) {
      throw new CsmError("Client context changed. Reload it before saving your edit.", 409);
    }
    const snapshot = csmSnapshotSchema.parse({ ...input.change(current?.snapshot || null), requestSha256 });
    if (snapshot.projectId !== input.projectId) throw new CsmError("Client context belongs to another project.", 409);
    const saved = await saveMemoryWithCommitStatusInTransaction({
      id: revision, tenantId, type: "knowledge", tier: "semantic", formationReason: "explicit_user_request",
      title: "Client success brief and source references", content: JSON.stringify(snapshot),
      tags: ["csm-client-context-v1"], scope: "project", source: SOURCE,
      assertedBy: "user", importance: 0.8, confidence: 1,
      supersedesId: current?.revision,
      accessBinding: buildProjectSharedMemoryAccessBindingV1({
        tenantId, ownerActorId: input.access.actorBinding.canonicalActorId,
        workspaceId: input.access.authority.workspaceId, projectId: input.access.authority.projectId!,
        originPurpose: "app.csm.context.write",
      }),
      databaseAccessScope: accessScope, executionScope: input.access.executionScope,
    }, sql, { databaseAccessScopeAlreadyEntered: true });
    // Parse the stored, redacted representation before committing it as current.
    const persisted = parseRow({ id: saved.record.id, content: saved.record.content }, input.projectId);
    if (current) {
      await sql`UPDATE omni_memories SET claim_status = 'superseded', valid_to = NOW(), updated_at = NOW()
        WHERE tenant_id = ${tenantId} AND id = ${current.revision} AND project_id = ${input.access.authority.projectId}
          AND source = ${SOURCE} AND claim_status = 'active'`;
    }
    await appendScopedDomainEvent({
      id: `csm_context_saved_${revision}`, streamId: `csm-project:${input.projectId}`,
      type: "csm.context.saved", executionScope: input.access.executionScope,
      payload: { schemaVersion: 1, projectId: input.projectId, revision, previousRevision: current?.revision || null,
        requestSha256, sourceCount: persisted.snapshot.sourceLinks.length },
    }, { sql });
    return persisted;
  }) as Promise<CsmStoredContext>;
}

async function readCurrent(sql: Sql, access: RequestSharedMemoryAccessV1) {
  const rows = await sql`SELECT id, content FROM omni_memories
    WHERE tenant_id = ${access.authority.tenantId} AND project_id = ${access.authority.projectId}
      AND visibility = 'project_shared' AND source = ${SOURCE} AND claim_status = 'active'
      AND (valid_from IS NULL OR valid_from <= NOW()) AND (valid_to IS NULL OR valid_to > NOW())
      AND (retention_expires_at IS NULL OR retention_expires_at > NOW())
      AND NOT EXISTS (SELECT 1 FROM omni_memory_lifecycle_states state WHERE state.tenant_id = omni_memories.tenant_id
        AND state.memory_id = omni_memories.id AND state.archived_at IS NOT NULL)
    ORDER BY created_at DESC, id DESC LIMIT 2`;
  if (rows.length > 1) throw new CsmError("Client context has conflicting active revisions.", 409);
  return rows[0] ? parseRow(rows[0], access.authority.requestedProjectId || access.authority.projectId!) : null;
}

function parseRow(row: Record<string, unknown>, projectId: string): CsmStoredContext {
  try {
    const snapshot = csmSnapshotSchema.parse(JSON.parse(String(row.content)));
    if (snapshot.projectId !== projectId) throw new Error("Project mismatch");
    return { revision: String(row.id), snapshot };
  } catch {
    throw new CsmError("The saved client context could not be verified.", 503);
  }
}
