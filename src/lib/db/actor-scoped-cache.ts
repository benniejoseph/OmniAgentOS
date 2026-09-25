import { createHash } from "node:crypto";
import { unstable_cache } from "next/cache";
import {
  getDatabaseActorContext,
  getDatabaseTenantContext,
  runWithDatabaseActorScope,
} from "@/lib/db/client";

/**
 * `unstable_cache` for reads that row-level security filters by actor.
 *
 * Next's data cache is shared across requests, actors, and serverless
 * instances, but RLS only applies while an entry is filled. Each entry is
 * keyed by the tenant and actor scope active at the call and filled under
 * exactly that scope, so one actor's rows are never served to another. The
 * scope enters the key as a digest to keep actor ids out of cache keys and
 * logs. A call without an actor scope, including system scope, reads uncached.
 */
export function actorScopedCache<TArgs extends unknown[], TResult>(
  load: (...args: TArgs) => Promise<TResult>,
  keyParts: readonly string[],
  options: { revalidate: number },
): (...args: TArgs) => Promise<TResult> {
  return (...args) => {
    const tenantId = getDatabaseTenantContext();
    const actorIds = getDatabaseActorContext().sort();
    if (!tenantId || !actorIds.length) {
      return load(...args);
    }
    return unstable_cache(
      (...cachedArgs: TArgs) =>
        runWithDatabaseActorScope(tenantId, actorIds, () => load(...cachedArgs)),
      [...keyParts, actorScopeDigest(tenantId, actorIds)],
      options,
    )(...args);
  };
}

function actorScopeDigest(tenantId: string, actorIds: readonly string[]) {
  return createHash("sha256")
    .update(JSON.stringify([tenantId, actorIds]))
    .digest("hex");
}
