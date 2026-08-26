import { unstable_cache } from "next/cache";
import { runWithDatabaseTenantScope } from "@/lib/db/client";
import {
  readSettingsStorageSnapshot,
  type ReadySettingsStorageSnapshotResult,
} from "@/lib/capabilities/settings-snapshot";

const SETTINGS_STORAGE_CACHE_VERSION = "settings-storage-snapshot-v2";
const SETTINGS_STORAGE_REVALIDATE_SECONDS = 15;
const SETTINGS_STORAGE_FILL_TIMEOUT_MS = 20_000;

class SettingsStorageCacheFillTimeoutError extends Error {
  constructor() {
    super("Settings storage cache fill timed out.");
    this.name = "SettingsStorageCacheFillTimeoutError";
  }
}

/**
 * Vercel can route consecutive requests to different function instances. Keep
 * the ready, tenant-scoped snapshot in Next's persistent data cache so a cold
 * instance does not need another database round trip. Only successful reads
 * are cached; failures reject and remain retryable.
 */
const loadPersistentSettingsStorageSnapshot = unstable_cache(
  async (tenantId: string): Promise<ReadySettingsStorageSnapshotResult> => {
    const snapshot = await withFillTimeout(
      runWithDatabaseTenantScope(tenantId, () =>
        readSettingsStorageSnapshot(tenantId),
      ),
    );
    return {
      checkedAt: new Date().toISOString(),
      snapshot,
    };
  },
  [SETTINGS_STORAGE_CACHE_VERSION],
  { revalidate: SETTINGS_STORAGE_REVALIDATE_SECONDS },
);

export function loadSharedSettingsStorageSnapshot(
  tenantId: string,
): Promise<ReadySettingsStorageSnapshotResult> {
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) {
    throw new Error("A tenant id is required for the Settings storage cache.");
  }
  return loadPersistentSettingsStorageSnapshot(normalizedTenantId);
}

async function withFillTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new SettingsStorageCacheFillTimeoutError()),
          SETTINGS_STORAGE_FILL_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
