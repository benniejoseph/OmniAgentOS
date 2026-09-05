export type SourceSyncPageRetryProbe = Readonly<{
  initialCursor: string;
  itemIds: readonly string[];
  nextCursor: string;
  failAfterItemId?: string;
  retryCount: number;
}>;

export type SourceSyncPageRetryResult = Readonly<{
  attemptCount: number;
  committedIds: readonly string[];
  committedCursor: string;
  cursorAdvancedBeforeCommit: boolean;
  duplicateCount: number;
  lostCount: number;
  completed: boolean;
}>;

/**
 * Side-effect-free fault-injection model for the canonical page transaction.
 * Each attempt stages item and cursor changes together. A mid-page failure
 * discards the complete stage; only a fully settled page becomes visible.
 */
export function evaluateSourceSyncPageRetry(
  probe: SourceSyncPageRetryProbe,
): SourceSyncPageRetryResult {
  const initialCursor = boundedValue(probe.initialCursor, "initial cursor");
  const nextCursor = boundedValue(probe.nextCursor, "next cursor");
  const itemIds = probe.itemIds.map((id) => boundedValue(id, "item ID"));
  if (itemIds.length > 1_000) throw new Error("Source sync page exceeds 1,000 items.");
  if (new Set(itemIds).size !== itemIds.length) {
    throw new Error("Source sync page item IDs must be unique.");
  }
  if (!Number.isSafeInteger(probe.retryCount) || probe.retryCount < 0 || probe.retryCount > 20) {
    throw new Error("Source sync retry count must be between 0 and 20.");
  }
  const failAfterItemId = probe.failAfterItemId
    ? boundedValue(probe.failAfterItemId, "failure item ID")
    : undefined;
  if (failAfterItemId && !itemIds.includes(failAfterItemId)) {
    throw new Error("Source sync failure item must belong to the page.");
  }

  let committedIds: string[] = [];
  let committedCursor = initialCursor;
  let attemptCount = 0;
  let cursorAdvancedBeforeCommit = false;
  for (let attempt = 0; attempt <= probe.retryCount; attempt += 1) {
    attemptCount += 1;
    const stagedIds: string[] = [];
    let failed = false;
    for (const id of itemIds) {
      stagedIds.push(id);
      if (attempt === 0 && id === failAfterItemId) {
        failed = true;
        break;
      }
    }
    if (failed) {
      cursorAdvancedBeforeCommit ||= committedCursor !== initialCursor;
      continue;
    }
    committedIds = stagedIds;
    committedCursor = nextCursor;
    break;
  }

  const uniqueCommittedIds = new Set(committedIds);
  return Object.freeze({
    attemptCount,
    committedIds: Object.freeze([...committedIds]),
    committedCursor,
    cursorAdvancedBeforeCommit,
    duplicateCount: committedIds.length - uniqueCommittedIds.size,
    lostCount: itemIds.filter((id) => !uniqueCommittedIds.has(id)).length,
    completed: committedIds.length === itemIds.length && committedCursor === nextCursor,
  });
}

function boundedValue(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 4_000) {
    throw new Error(`Source sync ${label} must be non-empty and bounded.`);
  }
  return normalized;
}
