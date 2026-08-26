import { createHash } from "node:crypto";
import { revalidateTag, unstable_cache } from "next/cache";

const TODAY_SNAPSHOT_CACHE_VERSION = "today-snapshot-v1";
const TODAY_SNAPSHOT_REVALIDATE_SECONDS = 15;

export type TodaySnapshotCacheScope = {
  tenantId: string;
  actorId: string;
};

/**
 * Cache the private Today projection without putting owner identifiers in tags.
 * Tenant and actor remain explicit key parts so entries can never cross scopes.
 */
export function loadCachedTodaySnapshot<T>(
  { tenantId, actorId }: TodaySnapshotCacheScope,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = unstable_cache(
    loader,
    [TODAY_SNAPSHOT_CACHE_VERSION, tenantId, actorId],
    {
      revalidate: TODAY_SNAPSHOT_REVALIDATE_SECONDS,
      tags: [
        todaySnapshotOwnerCacheTag({ tenantId, actorId }),
        todaySnapshotTenantCacheTag(tenantId),
      ],
    },
  );
  return cached();
}

/**
 * Route handlers use immediate expiry to preserve read-your-own-writes after a
 * successful mutation. The next request blocks for fresh data instead of
 * receiving stale-while-revalidate content.
 */
export function invalidateTodaySnapshot(scope: TodaySnapshotCacheScope) {
  revalidateTag(todaySnapshotOwnerCacheTag(scope), { expire: 0 });
}

/**
 * Tenant-wide sources such as memories can invalidate every owner projection
 * without knowing which actor currently has the dashboard open.
 */
export function invalidateTodaySnapshotsForTenant(tenantId: string) {
  revalidateTag(todaySnapshotTenantCacheTag(tenantId), { expire: 0 });
}

export function todaySnapshotOwnerCacheTag({
  tenantId,
  actorId,
}: TodaySnapshotCacheScope) {
  return `today-owner:${digestScope(`${tenantId}\u0000${actorId}`)}`;
}

export function todaySnapshotTenantCacheTag(tenantId: string) {
  return `today-tenant:${digestScope(tenantId)}`;
}

function digestScope(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
