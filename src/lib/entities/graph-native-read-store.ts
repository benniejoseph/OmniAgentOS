import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import { parseEntityAccessBinding, parseEntityRecord } from "@/lib/entities/registry";
import type { RequestEntityAccessV1 } from "@/lib/entities/request-access";
import { canonicalActorIdFromExactRequestBinding } from "@/lib/security/canonical-actor";
import { NativePrivateActionError } from "@/lib/memory/private-action-contracts";

/** Exact heads only: no unbounded registry/alias/history materialization. */
export async function readNativeGraphEntities(access: RequestEntityAccessV1, input: { id?: string; limit: number }) {
  const binding = parseEntityAccessBinding(access.accessBinding), scope = access.executionScope;
  const actor = canonicalActorIdFromExactRequestBinding(access.actorBinding.legacyOwnerActorIds[0], access.actorBinding);
  if (!actor || actor !== binding.ownerActorId || actor !== scope.initiatingActorId || scope.tenantId !== binding.tenantId ||
    scope.executingPrincipalType !== "user" || scope.executingPrincipalId !== actor || scope.purpose !== "entity.read.v1" ||
    scope.workspaceId !== null || scope.projectId !== null || scope.missionId !== null || scope.delegationId !== null ||
    scope.contextGrantIds.length || scope.capabilityGrantIds.length || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 201 ||
    (input.id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(input.id))) {
    throw new NativePrivateActionError("memory_graph_authority", 403, "The exact private entity read scope is required.");
  }
  if (!hasDatabaseUrl()) throw new NativePrivateActionError("memory_graph_database", 503, "Private graph inspection requires the canonical database.");
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(scope.tenantId, [actor], async () => {
    const rows = await getSql()`SELECT contract FROM omni_entity_records
      WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${actor} AND access_scope_sha256=${binding.accessScopeSha256}
        AND state='active' AND (${input.id === undefined} OR id=${input.id ?? ""}) ORDER BY id COLLATE "C" LIMIT ${input.limit}`;
    const records = rows.map((row) => parseEntityRecord(row.contract));
    if (records.length > input.limit || records.some((record) => record.state !== "active" || record.accessBinding.tenantId !== scope.tenantId ||
      record.accessBinding.ownerActorId !== actor || record.accessBinding.accessScopeSha256 !== binding.accessScopeSha256 ||
      (input.id !== undefined && record.entityId !== input.id))) throw new Error("Private entity heads differ from their current scope.");
    return records;
  });
}
