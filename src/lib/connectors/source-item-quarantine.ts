/**
 * How a source sync sets an item aside when it keeps failing, so one item
 * cannot hold its whole source in place, and how the sync tries it again.
 *
 * An item that fails three times, over at least an hour, is set aside, and
 * the source moves on past it. The sync reads a set-aside item again by its
 * id six hours later, and waits twice as long after each failure, up to a
 * week. The item leaves the list once it settles, which includes the provider
 * no longer having it. A source holds 20 items at most. With its list full, a
 * failing item holds the source in place as before, so no item is ever passed
 * over without a record of it.
 *
 * The state lives in the sync's sealed cursor, one entry per source. Only a
 * failure to process an item counts here: the caller fails the sync as before
 * on a provider failure, an interruption, or a lost lease.
 */
export const SOURCE_ITEM_QUARANTINE = Object.freeze({
  failures: 3,
  failingForMs: 60 * 60_000,
  capacity: 20,
  redrivesPerSync: 2,
  firstRedriveMs: 6 * 60 * 60_000,
  longestRedriveMs: 7 * 24 * 60 * 60_000,
});

const MAX_ITEM_ID_LENGTH = 1024;
const MAX_REVISION_LENGTH = 256;

export type FailingSourceItem = Readonly<{
  id: string;
  attempts: number;
  /** When the item first failed. */
  since: string;
}>;

export type QuarantinedSourceItem = Readonly<{
  id: string;
  /** The item's revision when it last failed, if the provider gave one. */
  revision?: string;
  /** When the item first failed. */
  since: string;
  retryAt: string;
  /** How many times the item was read again and failed again. */
  redrives: number;
}>;

export type SourceItemQuarantine = Readonly<{
  failing?: FailingSourceItem;
  held: readonly QuarantinedSourceItem[];
}>;

/** Reads a source's state from its cursor, dropping what it cannot read. */
export function readSourceItemQuarantine(value: unknown): SourceItemQuarantine {
  const state = record(value);
  const failing = record(state.failing);
  const held: QuarantinedSourceItem[] = [];
  for (const entry of Array.isArray(state.held) ? state.held : []) {
    const item = record(entry);
    const since = timestamp(item.since);
    const retryAt = timestamp(item.retryAt);
    const redrives = item.redrives;
    if (
      !isSourceItemId(item.id) ||
      !since ||
      !retryAt ||
      !Number.isSafeInteger(redrives) ||
      Number(redrives) < 0 ||
      held.some((other) => other.id === item.id)
    ) continue;
    const revision = sourceItemRevision(item.revision);
    held.push({
      id: item.id,
      ...(revision ? { revision } : {}),
      since,
      retryAt,
      redrives: Number(redrives),
    });
  }
  const since = timestamp(failing.since);
  return {
    ...(
      isSourceItemId(failing.id) &&
        since &&
        Number.isSafeInteger(failing.attempts) &&
        Number(failing.attempts) > 0
        ? {
            failing: {
              id: failing.id,
              attempts: Number(failing.attempts),
              since,
            },
          }
        : {}
    ),
    held: held.slice(0, SOURCE_ITEM_QUARANTINE.capacity),
  };
}

/** The state as the cursor keeps it, or nothing when there is none. */
export function sourceItemQuarantineValue(state: SourceItemQuarantine) {
  if (!state.failing && !state.held.length) return undefined;
  return {
    ...(state.failing ? { failing: state.failing } : {}),
    ...(state.held.length ? { held: state.held } : {}),
  };
}

export function quarantinedSourceItem(state: SourceItemQuarantine, id: string) {
  return state.held.find((item) => item.id === id);
}

/**
 * Counts a failure to process an item, and sets the item aside when it has
 * failed often enough, for long enough, and the source has room for it.
 */
export function recordSourceItemFailure(
  state: SourceItemQuarantine,
  item: Readonly<{ id: string; revision?: unknown }>,
  now: number,
): Readonly<{
  state: SourceItemQuarantine;
  failing?: FailingSourceItem;
  quarantined?: QuarantinedSourceItem;
}> {
  if (!isSourceItemId(item.id)) return { state };
  const failing: FailingSourceItem = state.failing?.id === item.id
    ? { ...state.failing, attempts: state.failing.attempts + 1 }
    : { id: item.id, attempts: 1, since: new Date(now).toISOString() };
  if (
    failing.attempts < SOURCE_ITEM_QUARANTINE.failures ||
    now - Date.parse(failing.since) < SOURCE_ITEM_QUARANTINE.failingForMs ||
    state.held.length >= SOURCE_ITEM_QUARANTINE.capacity
  ) {
    return { state: { ...state, failing }, failing };
  }
  const revision = sourceItemRevision(item.revision);
  const quarantined: QuarantinedSourceItem = {
    id: item.id,
    ...(revision ? { revision } : {}),
    since: failing.since,
    retryAt: new Date(now + SOURCE_ITEM_QUARANTINE.firstRedriveMs).toISOString(),
    redrives: 0,
  };
  return { state: { held: [...state.held, quarantined] }, failing, quarantined };
}

/**
 * Makes a set-aside item due now when its source reports it removed, or at a
 * revision other than the one that failed.
 */
export function noteSourceItemChange(
  state: SourceItemQuarantine,
  item: Readonly<{ id: string; revision?: unknown; removed: boolean }>,
  now: number,
): SourceItemQuarantine {
  const held = quarantinedSourceItem(state, item.id);
  if (
    !held ||
    Date.parse(held.retryAt) <= now ||
    (!item.removed && sourceItemRevision(item.revision) === held.revision)
  ) return state;
  return replaceHeld(state, { ...held, retryAt: new Date(now).toISOString() });
}

/** The set-aside items due again, longest waiting first, a few a sync. */
export function dueSourceItems(state: SourceItemQuarantine, now: number) {
  return state.held
    .filter((item) => Date.parse(item.retryAt) <= now)
    .sort((left, right) => Date.parse(left.retryAt) - Date.parse(right.retryAt))
    .slice(0, SOURCE_ITEM_QUARANTINE.redrivesPerSync);
}

export function releaseSourceItem(
  state: SourceItemQuarantine,
  id: string,
): SourceItemQuarantine {
  return { ...state, held: state.held.filter((item) => item.id !== id) };
}

/**
 * Waits longer for a set-aside item that failed again. An item read again
 * before it failed keeps the revision it was read at.
 */
export function deferSourceItem(
  state: SourceItemQuarantine,
  id: string,
  now: number,
  read?: Readonly<{ revision?: unknown }>,
): SourceItemQuarantine {
  const held = quarantinedSourceItem(state, id);
  if (!held) return state;
  const redrives = held.redrives + 1;
  const revision = read ? sourceItemRevision(read.revision) : held.revision;
  return replaceHeld(state, {
    id: held.id,
    ...(revision ? { revision } : {}),
    since: held.since,
    redrives,
    retryAt: new Date(now + Math.min(
      SOURCE_ITEM_QUARANTINE.longestRedriveMs,
      SOURCE_ITEM_QUARANTINE.firstRedriveMs * 2 ** redrives,
    )).toISOString(),
  });
}

/** Forgets the failing item once its source settled every item it read. */
export function settleSourceItems(state: SourceItemQuarantine): SourceItemQuarantine {
  return { held: state.held };
}

function replaceHeld(state: SourceItemQuarantine, next: QuarantinedSourceItem) {
  return {
    ...state,
    held: state.held.map((item) => item.id === next.id ? next : item),
  };
}

function isSourceItemId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ITEM_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function sourceItemRevision(value: unknown) {
  return typeof value === "string" && value
    ? value.slice(0, MAX_REVISION_LENGTH)
    : undefined;
}

function timestamp(value: unknown) {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
