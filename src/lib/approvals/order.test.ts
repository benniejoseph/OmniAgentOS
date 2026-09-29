import { describe, expect, it } from "vitest";
import {
  APPROVAL_RISK_STEP_MS,
  APPROVAL_SOURCE_RANK,
  ApprovalCursorError,
  approvalAfterSqlValues,
  approvalPriorityMs,
  approvalSourceAfter,
  compareApprovalSourceRows,
  decodeApprovalCursor,
  encodeApprovalCursor,
  isAfterApprovalPosition,
  mergeApprovalPages,
  type ApprovalClassRank,
  type ApprovalOrderKey,
  type ApprovalSourceAfter,
  type ApprovalSourcePage,
  type ApprovalSourceRank,
} from "@/lib/approvals/order";

const DAY = 24 * 60 * 60 * 1000;

function key(
  sourceRank: ApprovalSourceRank,
  priorityMs: number,
  id: string,
  classRank: ApprovalClassRank = 1,
): ApprovalOrderKey {
  return { classRank, priorityMs, sourceRank, id };
}

function page(
  keys: ApprovalOrderKey[],
  options: { exhausted?: boolean; last?: ApprovalOrderKey } = {},
): ApprovalSourcePage<string> {
  return {
    entries: keys.map((entryKey) => ({ item: entryKey.id, key: entryKey })),
    last: options.last ?? keys.at(-1),
    exhausted: options.exhausted ?? true,
  };
}

function rawCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("approval priority", () => {
  it("moves an item one day earlier per risk level", () => {
    expect(APPROVAL_RISK_STEP_MS).toBe(DAY);
    expect(approvalPriorityMs(10 * DAY, 0)).toBe(10 * DAY);
    expect(approvalPriorityMs(10 * DAY, 1)).toBe(9 * DAY);
    expect(approvalPriorityMs(10 * DAY, 3)).toBe(7 * DAY);
    expect(approvalPriorityMs(10 * DAY + 0.9, 2.7)).toBe(8 * DAY);
  });

  it("reads a missing time or risk as zero", () => {
    expect(approvalPriorityMs(Number.NaN, 2)).toBe(-2 * DAY);
    expect(approvalPriorityMs(5 * DAY, Number.NaN)).toBe(5 * DAY);
    expect(approvalPriorityMs(Number.POSITIVE_INFINITY, 1)).toBe(-DAY);
  });
});

describe("approval source order", () => {
  it("orders by class, then priority, then id", () => {
    const rows = [
      { classRank: 1 as const, priorityMs: 5, id: "b" },
      { classRank: 1 as const, priorityMs: 5, id: "a" },
      { classRank: 1 as const, priorityMs: 4, id: "z" },
      { classRank: 0 as const, priorityMs: 9, id: "y" },
    ];
    expect([...rows].sort(compareApprovalSourceRows).map((row) => row.id))
      .toEqual(["y", "z", "a", "b"]);
  });

  it("compares ids by code unit, the way COLLATE \"C\" does", () => {
    const rows = [
      { classRank: 1 as const, priorityMs: 0, id: "a" },
      { classRank: 1 as const, priorityMs: 0, id: "B" },
      { classRank: 1 as const, priorityMs: 0, id: "_" },
      { classRank: 1 as const, priorityMs: 0, id: "0" },
    ];
    expect([...rows].sort(compareApprovalSourceRows).map((row) => row.id))
      .toEqual(["0", "B", "_", "a"]);
  });

  it("resumes a source by class, priority, and its tie rule", () => {
    const after = (tie: ApprovalSourceAfter["tie"], tieId = "m"): ApprovalSourceAfter => ({
      classRank: 1,
      priorityMs: 100,
      tie,
      tieId,
    });
    const row = (classRank: ApprovalClassRank, priorityMs: number, id: string) => ({
      classRank,
      priorityMs,
      id,
    });

    expect(isAfterApprovalPosition(row(0, 999, "a"), undefined)).toBe(true);
    expect(isAfterApprovalPosition(row(0, 999, "z"), after("all"))).toBe(false);
    expect(isAfterApprovalPosition(row(1, 99, "z"), after("all"))).toBe(false);
    expect(isAfterApprovalPosition(row(1, 101, "a"), after("none"))).toBe(true);
    expect(isAfterApprovalPosition(row(1, 100, "a"), after("all"))).toBe(true);
    expect(isAfterApprovalPosition(row(1, 100, "z"), after("none"))).toBe(false);
    expect(isAfterApprovalPosition(row(1, 100, "m"), after("id"))).toBe(false);
    expect(isAfterApprovalPosition(row(1, 100, "l"), after("id"))).toBe(false);
    expect(isAfterApprovalPosition(row(1, 100, "n"), after("id"))).toBe(true);
    expect(
      isAfterApprovalPosition(row(0, 5, "a"), { ...after("all"), classRank: 0 }),
    ).toBe(false);
    expect(
      isAfterApprovalPosition(row(1, -5, "a"), { ...after("all"), classRank: 0 }),
    ).toBe(true);
  });

  it("gives each source the tie rule its rank implies", () => {
    const cursor = key(APPROVAL_SOURCE_RANK.workflow, 42, "run-7");

    expect(approvalSourceAfter(undefined, APPROVAL_SOURCE_RANK.tool)).toBeUndefined();
    expect(approvalSourceAfter(cursor, APPROVAL_SOURCE_RANK.tool)).toEqual({
      classRank: 1,
      priorityMs: 42,
      tie: "none",
      tieId: "",
    });
    expect(approvalSourceAfter(cursor, APPROVAL_SOURCE_RANK.workflow)).toEqual({
      classRank: 1,
      priorityMs: 42,
      tie: "id",
      tieId: "run-7",
    });
    expect(approvalSourceAfter(cursor, APPROVAL_SOURCE_RANK.slo_policy)).toEqual({
      classRank: 1,
      priorityMs: 42,
      tie: "all",
      tieId: "",
    });
  });

  it("binds the same rule for the SQL predicate", () => {
    expect(approvalAfterSqlValues(undefined)).toEqual({
      set: false,
      classRank: 0,
      priorityMs: 0,
      tieMode: 0,
      tieId: "",
    });
    expect(approvalAfterSqlValues({
      classRank: 0,
      priorityMs: -7,
      tie: "none",
      tieId: "ignored",
    })).toEqual({ set: true, classRank: 0, priorityMs: -7, tieMode: 0, tieId: "" });
    expect(approvalAfterSqlValues({
      classRank: 1,
      priorityMs: 8,
      tie: "all",
      tieId: "ignored",
    })).toEqual({ set: true, classRank: 1, priorityMs: 8, tieMode: 1, tieId: "" });
    expect(approvalAfterSqlValues({
      classRank: 1,
      priorityMs: 8,
      tie: "id",
      tieId: "exec-3",
    })).toEqual({ set: true, classRank: 1, priorityMs: 8, tieMode: 2, tieId: "exec-3" });
  });
});

describe("approval cursors", () => {
  it("round-trips a position", () => {
    const position = key(APPROVAL_SOURCE_RANK.slo_policy, -1_700_000_000_123, "change_9", 0);
    const cursor = encodeApprovalCursor(position);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeApprovalCursor(cursor)).toEqual(position);
  });

  it("round-trips an id outside ASCII", () => {
    const position = key(APPROVAL_SOURCE_RANK.workflow, 0, "résumé-✓");

    expect(decodeApprovalCursor(encodeApprovalCursor(position))).toEqual(position);
  });

  it.each([
    ["an empty value", ""],
    ["characters outside base64url", "abc+/="],
    ["text that is not JSON", Buffer.from("not json").toString("base64url")],
    ["another version", rawCursor({ v: 2, c: 1, p: 0, k: 0, i: "a" })],
    ["an extra field", rawCursor({ v: 1, c: 1, p: 0, k: 0, i: "a", t: "tenant" })],
    ["a missing field", rawCursor({ v: 1, c: 1, p: 0, i: "a" })],
    ["an unknown class", rawCursor({ v: 1, c: 2, p: 0, k: 0, i: "a" })],
    ["an unknown source", rawCursor({ v: 1, c: 1, p: 0, k: 3, i: "a" })],
    ["a fractional priority", rawCursor({ v: 1, c: 1, p: 0.5, k: 0, i: "a" })],
    ["an unsafe priority", rawCursor({ v: 1, c: 1, p: 2 ** 60, k: 0, i: "a" })],
    ["a string priority", rawCursor({ v: 1, c: 1, p: "0", k: 0, i: "a" })],
    ["an empty id", rawCursor({ v: 1, c: 1, p: 0, k: 0, i: "" })],
    ["an id over 256 characters", rawCursor({ v: 1, c: 1, p: 0, k: 0, i: "x".repeat(257) })],
    ["an array", rawCursor([1, 1, 0, 0, "a"])],
  ])("rejects %s", (_label, value) => {
    expect(() => decodeApprovalCursor(value)).toThrow(ApprovalCursorError);
    expect(() => decodeApprovalCursor(value)).toThrow("The approvals cursor is invalid.");
  });

  it("accepts the longest id a cursor can carry", () => {
    const position = key(APPROVAL_SOURCE_RANK.tool, 0, "x".repeat(256));
    expect(decodeApprovalCursor(encodeApprovalCursor(position))).toEqual(position);
  });

  it("accepts the longest cursor it can write", () => {
    const position = key(
      APPROVAL_SOURCE_RANK.slo_policy,
      Number.MIN_SAFE_INTEGER,
      "\u0000".repeat(256),
      0,
    );
    const cursor = encodeApprovalCursor(position);

    expect(cursor).toHaveLength(2_112);
    expect(decodeApprovalCursor(cursor)).toEqual(position);
  });

  it("refuses a cursor longer than any it writes, even one that decodes", () => {
    const position = '{"v":1,"c":1,"p":0,"k":0,"i":"a"}';
    const padded = Buffer.from(`${position}${" ".repeat(1_552)}`).toString("base64url");

    expect(padded).toHaveLength(2_114);
    expect(JSON.parse(Buffer.from(padded, "base64url").toString("utf8")))
      .toEqual(JSON.parse(position));
    expect(() => decodeApprovalCursor(padded)).toThrow(ApprovalCursorError);
  });

  it("refuses the standard base64 alphabet and padding", () => {
    const cursor = encodeApprovalCursor(key(APPROVAL_SOURCE_RANK.tool, 0, "~~~???"));
    const standard = cursor.replaceAll("-", "+").replaceAll("_", "/");

    expect(cursor).toMatch(/-/);
    expect(cursor).toMatch(/_/);
    expect(cursor.length % 4).not.toBe(0);
    for (const value of [standard, `${cursor}${"=".repeat(4 - (cursor.length % 4))}`]) {
      expect(Buffer.from(value, "base64url").equals(Buffer.from(cursor, "base64url")))
        .toBe(true);
      expect(() => decodeApprovalCursor(value)).toThrow(ApprovalCursorError);
    }
  });
});

describe("approval page merge", () => {
  it("merges exhausted sources in order and ends without a cursor", () => {
    const merged = mergeApprovalPages([
      page([key(0, 30, "tool-b"), key(0, 50, "tool-c")]),
      page([key(1, 40, "run-a")]),
      page([key(2, 10, "change-a", 0), key(2, 60, "change-b")]),
    ], 10);

    expect(merged.entries.map((entry) => entry.item)).toEqual([
      "change-a",
      "tool-b",
      "run-a",
      "tool-c",
      "change-b",
    ]);
    expect(merged.nextCursor).toBeNull();
  });

  it("stops at the limit with the last row as the cursor", () => {
    const merged = mergeApprovalPages([
      page([key(0, 30, "tool-b"), key(0, 50, "tool-c")]),
      page([key(1, 40, "run-a")]),
    ], 2);

    expect(merged.entries.map((entry) => entry.item)).toEqual(["tool-b", "run-a"]);
    expect(merged.nextCursor).toEqual(key(1, 40, "run-a"));
  });

  it("holds back rows past a source that stopped at its limit", () => {
    const merged = mergeApprovalPages([
      page([key(0, 10, "tool-a"), key(0, 20, "tool-b")], { exhausted: false }),
      page([key(1, 15, "run-a"), key(1, 25, "run-b")]),
      page([key(2, 5, "change-a"), key(2, 99, "change-b")]),
    ], 10);

    expect(merged.entries.map((entry) => entry.item)).toEqual([
      "change-a",
      "tool-a",
      "run-a",
      "tool-b",
    ]);
    expect(merged.nextCursor).toEqual(key(0, 20, "tool-b"));
  });

  it("takes the earliest last row of the sources that stopped", () => {
    const merged = mergeApprovalPages([
      page([key(0, 10, "tool-a"), key(0, 40, "tool-b")], { exhausted: false }),
      page([key(1, 20, "run-a")], { exhausted: false, last: key(1, 30, "run-dropped") }),
      page([key(2, 25, "change-a"), key(2, 35, "change-b")]),
    ], 10);

    expect(merged.entries.map((entry) => entry.item)).toEqual([
      "tool-a",
      "run-a",
      "change-a",
    ]);
    expect(merged.nextCursor).toEqual(key(1, 30, "run-dropped"));
  });

  it("returns the horizon as the cursor when every row before it was dropped", () => {
    const merged = mergeApprovalPages([
      page([], { exhausted: false, last: key(0, 10, "tool-dropped") }),
      page([key(1, 20, "run-a")]),
    ], 5);

    expect(merged.entries).toEqual([]);
    expect(merged.nextCursor).toEqual(key(0, 10, "tool-dropped"));
  });

  it("breaks a tie between sources by source rank, never by id", () => {
    const merged = mergeApprovalPages([
      page([key(2, 10, "a-change")]),
      page([key(1, 10, "m-run")]),
      page([key(0, 10, "z-tool")]),
    ], 10);

    expect(merged.entries.map((entry) => entry.item)).toEqual([
      "z-tool",
      "m-run",
      "a-change",
    ]);
  });

  it("keeps a source's own order for rows that tie", () => {
    const merged = mergeApprovalPages([
      page([key(0, 10, "tool-b"), key(0, 10, "tool-a")]),
    ], 10);

    expect(merged.entries.map((entry) => entry.item)).toEqual(["tool-b", "tool-a"]);
  });

  it("refuses a source that stopped without naming its last row", () => {
    expect(() =>
      mergeApprovalPages([
        { entries: [], exhausted: false },
      ], 5)
    ).toThrow("An approvals source stopped at its limit without a last row.");
  });

  it("returns at least one row for a limit below one", () => {
    for (const limit of [0, -3]) {
      const merged = mergeApprovalPages([
        page([key(0, 1, "tool-a"), key(0, 2, "tool-b")]),
      ], limit);

      expect(merged.entries.map((entry) => entry.item)).toEqual(["tool-a"]);
      expect(merged.nextCursor).toEqual(key(0, 1, "tool-a"));
    }
  });

  it("reads a fractional limit as the whole rows it allows", () => {
    const merged = mergeApprovalPages([
      page([key(0, 1, "tool-a"), key(0, 2, "tool-b"), key(0, 3, "tool-c")]),
    ], 2.5);

    expect(merged.entries.map((entry) => entry.item)).toEqual(["tool-a", "tool-b"]);
    expect(merged.nextCursor).toEqual(key(0, 2, "tool-b"));
  });

  it("ends without a cursor when the last page is exactly full", () => {
    const merged = mergeApprovalPages([
      page([key(0, 1, "tool-a")]),
      page([key(1, 2, "run-a")]),
    ], 2);

    expect(merged.entries.map((entry) => entry.item)).toEqual(["tool-a", "run-a"]);
    expect(merged.nextCursor).toBeNull();
  });

  it("pages through random sources without skipping or repeating a row", () => {
    const random = seededRandom(0x5eed);
    for (let round = 0; round < 300; round += 1) {
      const sources = ([0, 1, 2] as const).map((sourceRank) =>
        randomSourceRows(random, sourceRank)
      );
      const expected = sources
        .flat()
        .filter((row) => !row.dropped)
        .sort(compareFullOrder)
        .map((row) => `${row.sourceRank}:${row.id}`);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const position: ApprovalOrderKey | undefined = cursor
          ? decodeApprovalCursor(cursor)
          : undefined;
        const limit = 1 + Math.floor(random() * 4);
        const merged: ReturnType<typeof mergeApprovalPages<string>> = mergeApprovalPages(
          sources.map((rows, sourceRank) =>
            simulatedSourcePage(
              rows,
              approvalSourceAfter(position, sourceRank as ApprovalSourceRank),
              limit,
            )
          ),
          limit,
        );
        expect(merged.entries.length).toBeLessThanOrEqual(limit);
        seen.push(...merged.entries.map((entry) => entry.item));
        cursor = merged.nextCursor ? encodeApprovalCursor(merged.nextCursor) : null;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(40);
      } while (cursor);

      expect(seen).toEqual(expected);
    }
  });
});

type SimulatedRow = ApprovalOrderKey & { dropped: boolean };

function randomSourceRows(random: () => number, sourceRank: ApprovalSourceRank) {
  const count = Math.floor(random() * 7);
  const prefixes = ["z", "m", "a"];
  const rows: SimulatedRow[] = [];
  const ids = new Set<string>();
  while (rows.length < count) {
    const id = `${prefixes[sourceRank]}${Math.floor(random() * 20)}`;
    if (ids.has(id)) continue;
    ids.add(id);
    rows.push({
      classRank: random() < 0.25 ? 0 : 1,
      priorityMs: Math.floor(random() * 3) * DAY,
      sourceRank,
      id,
      dropped: random() < 0.2,
    });
  }
  return rows;
}

/** A source query: its order, the cursor, one row past the limit, then its own checks. */
function simulatedSourcePage(
  rows: SimulatedRow[],
  after: ApprovalSourceAfter | undefined,
  limit: number,
): ApprovalSourcePage<string> {
  const read = rows
    .filter((row) => isAfterApprovalPosition(row, after))
    .sort(compareApprovalSourceRows)
    .slice(0, limit + 1);
  const toKey = ({ dropped: _dropped, ...rowKey }: SimulatedRow): ApprovalOrderKey => rowKey;
  return {
    entries: read
      .filter((row) => !row.dropped)
      .map((row) => ({ item: `${row.sourceRank}:${row.id}`, key: toKey(row) })),
    last: read.length ? toKey(read[read.length - 1]) : undefined,
    exhausted: read.length <= limit,
  };
}

function compareFullOrder(left: ApprovalOrderKey, right: ApprovalOrderKey) {
  return left.classRank - right.classRank ||
    left.priorityMs - right.priorityMs ||
    left.sourceRank - right.sourceRank ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
