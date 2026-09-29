import { z } from "zod";

/**
 * The order of the approvals list, shared by every source that feeds it.
 *
 * Reconciliations come first: their approval is already recorded and the
 * action stopped part way. Everything else waits in priority order, where an
 * item's priority is the time it started waiting minus one step per risk
 * level. A risk-three request therefore sorts with a risk-zero request made
 * three days before it, so the oldest and riskiest items stay at the top.
 * The step is a constant, so an item's position never changes while it
 * waits and a cursor stays valid between pages.
 */
export const APPROVAL_RISK_STEP_MS = 24 * 60 * 60 * 1000;

/** Workflow runs wait for approval at this risk level. */
export const WORKFLOW_APPROVAL_RISK_LEVEL = 2;

/** Sources in the order they sort when two items share a priority. */
export const APPROVAL_SOURCE_RANK = {
  tool: 0,
  workflow: 1,
  slo_policy: 2,
} as const;

export type ApprovalSourceRank =
  (typeof APPROVAL_SOURCE_RANK)[keyof typeof APPROVAL_SOURCE_RANK];

/** 0 for a reconciliation, 1 for anything else. */
export type ApprovalClassRank = 0 | 1;

export type ApprovalOrderKey = {
  classRank: ApprovalClassRank;
  priorityMs: number;
  sourceRank: ApprovalSourceRank;
  id: string;
};

/**
 * Where one source resumes after a cursor. Rows of that source sort after
 * the cursor when their class and priority do. For rows at the cursor's
 * class and priority, `tie` decides: "all" when the source sorts after the
 * cursor's source, "none" when it sorts before, and "id" (an id after
 * `tieId`) when the cursor came from this source.
 */
export type ApprovalSourceAfter = {
  classRank: ApprovalClassRank;
  priorityMs: number;
  tie: "all" | "none" | "id";
  tieId: string;
};

export class ApprovalCursorError extends Error {
  constructor(message = "The approvals cursor is invalid.") {
    super(message);
    this.name = "ApprovalCursorError";
  }
}

export function approvalPriorityMs(waitingSinceMs: number, riskLevel: number) {
  const since = Number.isFinite(waitingSinceMs) ? Math.trunc(waitingSinceMs) : 0;
  const risk = Number.isFinite(riskLevel) ? Math.trunc(riskLevel) : 0;
  return since - risk * APPROVAL_RISK_STEP_MS;
}

/**
 * Orders rows of one source: class, then priority, then id by UTF-16 code
 * unit. The database orders ids with COLLATE "C" instead; the two agree on
 * ASCII ids, and rows from the database are never reordered by this.
 */
export function compareApprovalSourceRows(
  left: { classRank: ApprovalClassRank; priorityMs: number; id: string },
  right: { classRank: ApprovalClassRank; priorityMs: number; id: string },
) {
  return left.classRank - right.classRank ||
    left.priorityMs - right.priorityMs ||
    compareIds(left.id, right.id);
}

export function isAfterApprovalPosition(
  row: { classRank: ApprovalClassRank; priorityMs: number; id: string },
  after: ApprovalSourceAfter | undefined,
) {
  if (!after) return true;
  if (row.classRank !== after.classRank) return row.classRank > after.classRank;
  if (row.priorityMs !== after.priorityMs) return row.priorityMs > after.priorityMs;
  return after.tie === "all" ||
    (after.tie === "id" && compareIds(row.id, after.tieId) > 0);
}

export function approvalSourceAfter(
  cursor: ApprovalOrderKey | undefined,
  sourceRank: ApprovalSourceRank,
): ApprovalSourceAfter | undefined {
  if (!cursor) return undefined;
  return {
    classRank: cursor.classRank,
    priorityMs: cursor.priorityMs,
    tie: sourceRank > cursor.sourceRank
      ? "all"
      : sourceRank < cursor.sourceRank
        ? "none"
        : "id",
    tieId: sourceRank === cursor.sourceRank ? cursor.id : "",
  };
}

/**
 * Bind values for the keyset predicate each source's query uses:
 *
 *   NOT set OR (class_rank, priority_ms) > (classRank, priorityMs)
 *   OR ((class_rank, priority_ms) = (classRank, priorityMs)
 *       AND (tieMode = 1 OR (tieMode = 2 AND id > tieId)))
 */
export function approvalAfterSqlValues(after: ApprovalSourceAfter | undefined) {
  return {
    set: Boolean(after),
    classRank: after?.classRank ?? 0,
    priorityMs: after?.priorityMs ?? 0,
    tieMode: after?.tie === "all" ? 1 : after?.tie === "id" ? 2 : 0,
    tieId: after?.tie === "id" ? after.tieId : "",
  };
}

const cursorSchema = z.object({
  v: z.literal(1),
  c: z.union([z.literal(0), z.literal(1)]),
  p: z.number().int(),
  k: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  i: z.string().min(1).max(256),
}).strict();

// Long enough for every cursor encodeApprovalCursor writes for an id the
// schema accepts: JSON writes a code unit in at most six bytes.
const MAX_CURSOR_LENGTH = 2_112;

/**
 * Cursors are not signed. Each one only names a position in the order, and
 * every read is scoped to the caller's tenant, so a forged cursor can skip
 * or repeat the caller's own items but cannot reach anyone else's.
 */
export function encodeApprovalCursor(key: ApprovalOrderKey) {
  return Buffer.from(JSON.stringify({
    v: 1,
    c: key.classRank,
    p: key.priorityMs,
    k: key.sourceRank,
    i: key.id,
  })).toString("base64url");
}

export function decodeApprovalCursor(value: string): ApprovalOrderKey {
  if (
    !value ||
    value.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new ApprovalCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new ApprovalCursorError();
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) throw new ApprovalCursorError();
  return {
    classRank: result.data.c,
    priorityMs: result.data.p,
    sourceRank: result.data.k,
    id: result.data.i,
  };
}

export type ApprovalSourcePage<T> = {
  /** Rows that are still pending, in the source's order. */
  entries: Array<{ item: T; key: ApprovalOrderKey }>;
  /** The last row the source read, including one a check dropped. */
  last?: ApprovalOrderKey;
  /** True when the source read every row after the cursor. */
  exhausted: boolean;
};

/**
 * Merges one page from each source. A source that stopped at its limit has
 * only been read up to its last row, so rows past the earliest such row are
 * held back for the next page: another source may have unread rows before
 * them. The cursor returned names the last position this page covers.
 *
 * Rows are compared by class, priority and source only, and a stable sort
 * keeps each source's own order, so ids are never compared across sources
 * or collations.
 */
export function mergeApprovalPages<T>(
  pages: ReadonlyArray<ApprovalSourcePage<T>>,
  limit: number,
): { entries: Array<{ item: T; key: ApprovalOrderKey }>; nextCursor: ApprovalOrderKey | null } {
  const boundedLimit = Math.max(1, Math.trunc(limit) || 1);
  let horizon: ApprovalOrderKey | undefined;
  for (const page of pages) {
    if (page.exhausted) continue;
    if (!page.last) {
      throw new Error("An approvals source stopped at its limit without a last row.");
    }
    if (!horizon || compareAcrossSources(page.last, horizon) < 0) {
      horizon = page.last;
    }
  }
  const candidates = pages
    .flatMap((page) => page.entries)
    .filter((entry) => !horizon || compareAcrossSources(entry.key, horizon) <= 0)
    .sort((left, right) => compareAcrossSources(left.key, right.key));
  const entries = candidates.slice(0, boundedLimit);
  return {
    entries,
    nextCursor: candidates.length > boundedLimit
      ? entries[boundedLimit - 1].key
      : horizon ?? null,
  };
}

function compareAcrossSources(left: ApprovalOrderKey, right: ApprovalOrderKey) {
  return left.classRank - right.classRank ||
    left.priorityMs - right.priorityMs ||
    left.sourceRank - right.sourceRank;
}

function compareIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
