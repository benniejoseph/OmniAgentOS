import "server-only";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import { canonicalActorIdFromExactRequestBinding, type CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import type { ModelAssignment, ModelCatalogEntry, RedactedProviderConnection } from "./types";

export class RuntimeModelOwnerScopeError extends Error {
  constructor() {
    super("The verified model Settings owner or its saved routing is ambiguous.");
    this.name = "RuntimeModelOwnerScopeError";
  }
}

export type RuntimeSettingsOwnerScope = Readonly<{
  tenantId: string;
  actorIds: readonly string[];
}>;

/** The binding is server-derived; no email or alias is inferred from a request. */
export function runtimeSettingsOwnerScope(input: {
  tenantId: string;
  actorId: string;
  requestActorBinding?: CanonicalRequestActorBindingV1;
}): RuntimeSettingsOwnerScope | undefined {
  const binding = input.requestActorBinding;
  if (!binding) return undefined;
  const legacy = binding.legacyOwnerActorIds?.[0];
  if (typeof legacy !== "string" || !legacy || legacy !== legacy.trim() || legacy.length > 320 ||
      /[\p{Cc}\p{Cf}]/u.test(legacy) || !Array.isArray(binding.legacyOwnerActorIds) ||
      !Array.isArray(binding.readableOwnerActorIds) ||
      canonicalActorIdFromExactRequestBinding(legacy, binding) !== binding.canonicalActorId ||
      (input.actorId !== binding.canonicalActorId && input.actorId !== legacy) ||
      !input.tenantId || input.tenantId !== input.tenantId.trim()) throw new RuntimeModelOwnerScopeError();
  // Existing authenticated email-coordinate calls keep their exact-owner path.
  if (input.actorId !== binding.canonicalActorId) return undefined;
  return Object.freeze({ tenantId: input.tenantId, actorIds: Object.freeze([binding.canonicalActorId, legacy]) });
}

export function withRuntimeSettingsOwner<T>(scope: RuntimeSettingsOwnerScope | undefined, work: () => Promise<T>): Promise<T> {
  return scope ? runWithDatabaseActorScope(scope.tenantId, scope.actorIds, work) : work();
}

/** Preserve persisted owners for credential AAD; conflicting rows never win by order. */
export function assertRuntimeSettingsOwners(scope: RuntimeSettingsOwnerScope, snapshots: readonly {
  actorId: string;
  assignments: ModelAssignment[];
  catalog: ModelCatalogEntry[];
  connections: RedactedProviderConnection[];
}[]) {
  const assignmentKeys = new Set<string>(), catalogKeys = new Set<string>(), connectionKeys = new Set<string>();
  const ids = new Set<string>();
  for (const snapshot of snapshots) {
    if (!scope.actorIds.includes(snapshot.actorId)) throw new RuntimeModelOwnerScopeError();
    function check<T extends { id: string; tenantId: string; actorId: string }>(
      kind: string, records: T[], keys: Set<string>, key: (record: T) => string,
    ) {
      for (const record of records) {
        // Each exact-owner reader must return only the row owner it was asked for.
        if (record.tenantId !== scope.tenantId || record.actorId !== snapshot.actorId || !record.id || ids.has(`${kind}\0${record.id}`)) {
          throw new RuntimeModelOwnerScopeError();
        }
        const identity = key(record);
        if (keys.has(identity)) throw new RuntimeModelOwnerScopeError();
        keys.add(identity); ids.add(`${kind}\0${record.id}`);
      }
    }
    check("assignment", snapshot.assignments, assignmentKeys, row => row.scope);
    check("catalog", snapshot.catalog, catalogKeys, row => `${row.provider}\0${row.modelId}`);
    check("connection", snapshot.connections, connectionKeys, row => row.provider);
  }
}
