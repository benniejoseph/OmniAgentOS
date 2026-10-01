/**
 * How a source sync checks the documents it already holds once a source
 * starts over from a fresh listing, so a document whose item left the source
 * meanwhile does not stay in knowledge.
 *
 * A source starts over when its provider refuses the change position the sync
 * kept, and on its first sync after a reconnect. A fresh listing covers only a
 * recent window, and no listing shows an item that left, so the sync reads
 * each document created before the start again by its item's id, a slice of
 * 50 a sync in id order, and removes the ones the provider no longer offers.
 *
 * Removing a document also forgets what was learned from it, so the sweep
 * stops, and removes nothing, when a slice would remove documents without the
 * provider confirming any of the source's documents present, or would remove
 * ten or more and confirm none present.
 *
 * The state lives in the sync's sealed cursor, one entry per source.
 */
export const SOURCE_DOCUMENT_SWEEP = Object.freeze({
  slice: 50,
  concurrency: 5,
  stopAt: 10,
});

const MAX_DOCUMENT_ID_LENGTH = 256;

export type SourceDocumentSweep = Readonly<{
  /** When the source started over. A document created since is current. */
  since: string;
  /** The last document checked, in id order. */
  after?: string;
  /** Documents the provider answered for, present or not. */
  checked: number;
  removed: number;
}>;

export type SourceDocumentSlice = Readonly<{
  /** How many documents the slice listed. */
  listed: number;
  lastId?: string;
  present: number;
  /** Documents the provider no longer offers. */
  gone: number;
}>;

/** Reads a source's sweep from its cursor, or none when it cannot. */
export function readSourceDocumentSweep(
  value: unknown,
): SourceDocumentSweep | undefined {
  const state = record(value);
  const since = timestamp(state.since);
  const { checked, removed } = state;
  if (
    !since ||
    !count(checked) ||
    !count(removed) ||
    Number(removed) > Number(checked) ||
    (state.after !== undefined && !isDocumentId(state.after))
  ) return undefined;
  return {
    since,
    ...(isDocumentId(state.after) ? { after: state.after } : {}),
    checked: Number(checked),
    removed: Number(removed),
  };
}

export function startSourceDocumentSweep(now: number): SourceDocumentSweep {
  return { since: new Date(now).toISOString(), checked: 0, removed: 0 };
}

/**
 * Whether a slice stops the sweep instead of removing what it found gone: it
 * would remove documents, confirms none present, and either the provider has
 * confirmed none of the source's documents present yet or the slice would
 * remove ten or more.
 */
export function sourceDocumentSliceStops(
  sweep: SourceDocumentSweep,
  slice: Pick<SourceDocumentSlice, "present" | "gone">,
) {
  return slice.gone > 0 &&
    slice.present === 0 &&
    (
      sweep.checked === sweep.removed ||
      slice.gone >= SOURCE_DOCUMENT_SWEEP.stopAt
    );
}

/**
 * The sweep past a slice it settled. It is finished once a slice lists fewer
 * documents than it asked for.
 */
export function advanceSourceDocumentSweep(
  sweep: SourceDocumentSweep,
  slice: SourceDocumentSlice,
): Readonly<{ sweep: SourceDocumentSweep; finished: boolean }> {
  const after = slice.lastId ?? sweep.after;
  return {
    sweep: {
      since: sweep.since,
      ...(after ? { after } : {}),
      checked: sweep.checked + slice.present + slice.gone,
      removed: sweep.removed + slice.gone,
    },
    finished: slice.listed < SOURCE_DOCUMENT_SWEEP.slice,
  };
}

function count(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isDocumentId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DOCUMENT_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value);
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
