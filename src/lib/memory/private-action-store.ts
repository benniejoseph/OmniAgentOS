import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import { NativePrivateActionError, privateActionScopeSchema, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";

export type PrivateActionSql = ReturnType<typeof getSql>;
export type NativePrivateActionAuthority = { scope: PrivateActionScope; executionScope?: ExecutionScope };
export function nativePrivateActionFail(message: string, code = "private_memory_action_conflict", status = 409): never {
  throw new NativePrivateActionError(code, status, message);
}
export function assertNativePrivateActionMutation(authority: NativePrivateActionAuthority, purpose: string, resourceId: string): ExecutionScope {
  const e = authority.executionScope, s = authority.scope;
  if (!e || e.tenantId !== s.tenantId || e.initiatingActorId !== s.ownerActorId || e.executingPrincipalType !== "user" ||
    e.executingPrincipalId !== s.ownerActorId || e.workspaceId !== null || e.projectId !== null || e.missionId !== null || e.delegationId !== null ||
    e.contextGrantIds.length || e.capabilityGrantIds.length || e.purpose !== purpose || e.causationId !== resourceId) {
    nativePrivateActionFail("Exact private action authority is required.", "private_memory_action_authority", 403);
  }
  return e;
}
export async function requireNativePrivateActionIdentity(sql: PrivateActionSql, scope: PrivateActionScope, management = false) {
  const rows = await sql`SELECT public.omni_native_private_memory_owner_v1(${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${management}) AS allowed`;
  if (rows.length !== 1 || rows[0].allowed !== true) nativePrivateActionFail("Current private owner authority is unavailable.", "private_memory_action_owner", 403);
}
/** Closed database graphs only; helpers receive this exact transaction. */
export async function nativePrivateActionTransaction<T>(authority: NativePrivateActionAuthority, management: boolean, work: (sql: PrivateActionSql) => Promise<T>): Promise<T> {
  privateActionScopeSchema.parse(authority.scope);
  if (!hasDatabaseUrl()) nativePrivateActionFail("Durable private actions require the canonical database.", "private_memory_action_database", 503);
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(authority.scope.tenantId, [...new Set([authority.scope.ownerActorId, authority.scope.canonicalActorId])], () =>
    getSql().transaction(async (sql: PrivateActionSql) => {
      await requireNativePrivateActionIdentity(sql, authority.scope, management); return work(sql);
    }) as Promise<T>);
}
export async function lockNativePrivateActionGraph(sql: PrivateActionSql, tenantId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`memory-graph:${tenantId}`},0))`;
}
