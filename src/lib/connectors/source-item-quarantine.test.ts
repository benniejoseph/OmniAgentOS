import { describe, expect, it } from "vitest";
import {
  deferSourceItem,
  dueSourceItems,
  noteSourceItemChange,
  quarantinedSourceItem,
  readSourceItemQuarantine,
  recordSourceItemFailure,
  releaseSourceItem,
  settleSourceItems,
  sourceItemQuarantineValue,
  type QuarantinedSourceItem,
  type SourceItemQuarantine,
} from "@/lib/connectors/source-item-quarantine";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (time: number) => new Date(time).toISOString();
const EMPTY: SourceItemQuarantine = { held: [] };

function heldItem(id: string, fields: Partial<QuarantinedSourceItem> = {}): QuarantinedSourceItem {
  return {
    id,
    revision: `revision-${id}`,
    since: iso(T0 - 9 * HOUR),
    retryAt: iso(T0 + HOUR),
    redrives: 0,
    ...fields,
  };
}

// Fails `id` at each of the given times, from `state`.
function failAt(state: SourceItemQuarantine, id: string, times: number[]) {
  let result: ReturnType<typeof recordSourceItemFailure> = { state };
  for (const time of times) {
    result = recordSourceItemFailure(result.state, { id, revision: "revision-7" }, time);
  }
  return result;
}

describe("an item that fails", () => {
  it("is counted from its first failure", () => {
    expect(recordSourceItemFailure(EMPTY, { id: "item-a" }, T0)).toEqual({
      state: { held: [], failing: { id: "item-a", attempts: 1, since: iso(T0) } },
      failing: { id: "item-a", attempts: 1, since: iso(T0) },
    });
  });

  it("is set aside on its third failure, an hour after its first", () => {
    const result = failAt(EMPTY, "item-a", [T0, T0 + MINUTE, T0 + HOUR]);

    expect(result).toEqual({
      state: {
        held: [{
          id: "item-a",
          revision: "revision-7",
          since: iso(T0),
          retryAt: iso(T0 + 7 * HOUR),
          redrives: 0,
        }],
      },
      failing: { id: "item-a", attempts: 3, since: iso(T0) },
      quarantined: {
        id: "item-a",
        revision: "revision-7",
        since: iso(T0),
        retryAt: iso(T0 + 7 * HOUR),
        redrives: 0,
      },
    });
  });

  it("is held, not set aside, within the hour", () => {
    const result = failAt(EMPTY, "item-a", [T0, T0 + MINUTE, T0 + HOUR - 1]);

    expect(result).toEqual({
      state: { held: [], failing: { id: "item-a", attempts: 3, since: iso(T0) } },
      failing: { id: "item-a", attempts: 3, since: iso(T0) },
    });
  });

  it("is held, not set aside, after fewer than three failures", () => {
    const result = failAt(EMPTY, "item-a", [T0, T0 + 5 * HOUR]);

    expect(result.quarantined).toBeUndefined();
    expect(result.state).toEqual({
      held: [],
      failing: { id: "item-a", attempts: 2, since: iso(T0) },
    });
  });

  it("starts its count again when another item fails", () => {
    const first = failAt(EMPTY, "item-a", [T0, T0 + MINUTE]);

    const result = recordSourceItemFailure(first.state, { id: "item-b" }, T0 + 2 * HOUR);

    expect(result.failing).toEqual({ id: "item-b", attempts: 1, since: iso(T0 + 2 * HOUR) });
  });

  it("is held, not set aside, while its source holds as many items as it keeps", () => {
    const nineteen = { held: Array.from({ length: 19 }, (_, index) => heldItem(`held-${index}`)) };
    const twenty = { held: [...nineteen.held, heldItem("held-19")] };

    expect(failAt(nineteen, "item-a", [T0, T0 + MINUTE, T0 + HOUR]).state.held)
      .toHaveLength(20);
    const full = failAt(twenty, "item-a", [T0, T0 + MINUTE, T0 + HOUR]);
    expect(full.quarantined).toBeUndefined();
    expect(full.state).toEqual({
      held: twenty.held,
      failing: { id: "item-a", attempts: 3, since: iso(T0) },
    });
  });

  it("keeps a bounded revision, and none it was not given", () => {
    const failing = { held: [], failing: { id: "item-a", attempts: 2, since: iso(T0 - HOUR) } };

    expect(recordSourceItemFailure(failing, { id: "item-a", revision: "r".repeat(300) }, T0)
      .quarantined?.revision).toBe("r".repeat(256));
    for (const revision of [undefined, "", 7]) {
      expect(recordSourceItemFailure(failing, { id: "item-a", revision }, T0).quarantined)
        .not.toHaveProperty("revision");
    }
  });

  it("is not counted when it has no id the cursor can keep", () => {
    const state = { held: [heldItem("held-a")] };

    for (const id of ["", "a\u0000b", "a\nb", "i".repeat(1025)]) {
      expect(recordSourceItemFailure(state, { id }, T0)).toEqual({ state });
    }
    expect(recordSourceItemFailure(state, { id: "i".repeat(1024) }, T0).failing?.attempts)
      .toBe(1);
  });
});

describe("a set-aside item", () => {
  it("is due again once its time comes, longest waiting first, two a sync", () => {
    const state = {
      held: [
        heldItem("late", { retryAt: iso(T0 - HOUR) }),
        heldItem("not-yet", { retryAt: iso(T0 + 1) }),
        heldItem("now", { retryAt: iso(T0) }),
        heldItem("earliest", { retryAt: iso(T0 - 2 * HOUR) }),
      ],
    };

    expect(dueSourceItems(state, T0).map((item) => item.id)).toEqual(["earliest", "late"]);
    expect(dueSourceItems({ held: state.held.slice(1, 3) }, T0).map((item) => item.id))
      .toEqual(["now"]);
    expect(dueSourceItems(state, T0 - 3 * HOUR)).toEqual([]);
  });

  it("is due now when its source reports it changed or removed", () => {
    const state = { held: [heldItem("other"), heldItem("item-a")] };
    const dueNow = { held: [heldItem("other"), heldItem("item-a", { retryAt: iso(T0) })] };

    expect(noteSourceItemChange(state, { id: "item-a", revision: "revision-8", removed: false }, T0))
      .toEqual(dueNow);
    expect(noteSourceItemChange(state, { id: "item-a", revision: "revision-item-a", removed: true }, T0))
      .toEqual(dueNow);
    expect(noteSourceItemChange(state, { id: "item-a", removed: false }, T0)).toEqual(dueNow);
  });

  it("waits when its source reports it unchanged, and stays due when it already is", () => {
    const state = { held: [heldItem("item-a")] };
    const due = { held: [heldItem("item-a", { retryAt: iso(T0 - 1) })] };
    const unversioned = { held: [heldItem("item-a", { revision: undefined })] };

    expect(noteSourceItemChange(state, { id: "item-a", revision: "revision-item-a", removed: false }, T0))
      .toBe(state);
    expect(noteSourceItemChange(due, { id: "item-a", revision: "revision-8", removed: true }, T0))
      .toBe(due);
    expect(noteSourceItemChange(unversioned, { id: "item-a", removed: false }, T0)).toBe(unversioned);
    expect(noteSourceItemChange(state, { id: "item-b", revision: "revision-8", removed: true }, T0))
      .toBe(state);
  });

  it("waits twice as long after each failure, up to a week", () => {
    let state: SourceItemQuarantine = { held: [heldItem("other"), heldItem("item-a")] };
    const waits: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      state = deferSourceItem(state, "item-a", T0);
      const item = quarantinedSourceItem(state, "item-a");
      expect(item?.redrives).toBe(attempt + 1);
      waits.push((Date.parse(String(item?.retryAt)) - T0) / HOUR);
    }

    expect(waits).toEqual([12, 24, 48, 96, 168, 168, 168]);
    expect(state.held[0]).toEqual(heldItem("other"));
    expect(quarantinedSourceItem(state, "item-a")).toMatchObject({
      id: "item-a",
      since: iso(T0 - 9 * HOUR),
    });
  });

  it("keeps the revision it was last read at", () => {
    const state = { held: [heldItem("item-a")] };

    expect(quarantinedSourceItem(deferSourceItem(state, "item-a", T0), "item-a")?.revision)
      .toBe("revision-item-a");
    expect(quarantinedSourceItem(
      deferSourceItem(state, "item-a", T0, { revision: "revision-9" }),
      "item-a",
    )?.revision).toBe("revision-9");
    expect(quarantinedSourceItem(deferSourceItem(state, "item-a", T0, {}), "item-a"))
      .not.toHaveProperty("revision");
    expect(deferSourceItem(state, "item-b", T0)).toBe(state);
  });

  it("leaves the list once it settles, as the failing item does", () => {
    const state = {
      failing: { id: "item-b", attempts: 1, since: iso(T0) },
      held: [heldItem("other"), heldItem("item-a")],
    };

    expect(releaseSourceItem(state, "item-a")).toEqual({
      failing: state.failing,
      held: [heldItem("other")],
    });
    expect(settleSourceItems(state)).toEqual({ held: state.held });
  });
});

describe("the state a cursor keeps", () => {
  it("is nothing when nothing fails", () => {
    expect(sourceItemQuarantineValue(EMPTY)).toBeUndefined();
    const failing = { id: "item-a", attempts: 1, since: iso(T0) };
    expect(sourceItemQuarantineValue({ failing, held: [] })).toEqual({ failing });
    expect(sourceItemQuarantineValue({ held: [heldItem("item-a")] }))
      .toEqual({ held: [heldItem("item-a")] });
  });

  it("reads back what it wrote", () => {
    const state = {
      failing: { id: "item-b", attempts: 2, since: iso(T0) },
      held: [heldItem("item-a"), heldItem("item-c", { revision: undefined, redrives: 3 })],
    };

    expect(readSourceItemQuarantine(JSON.parse(JSON.stringify(sourceItemQuarantineValue(state)))))
      .toEqual({
        failing: state.failing,
        held: [
          heldItem("item-a"),
          { id: "item-c", since: iso(T0 - 9 * HOUR), retryAt: iso(T0 + HOUR), redrives: 3 },
        ],
      });
  });

  it("drops what it cannot read", () => {
    const valid = heldItem("item-a");

    expect(readSourceItemQuarantine({
      failing: { id: "item-b", attempts: 0, since: iso(T0) },
      held: [
        valid,
        { ...valid, id: "dropped-since", since: "not a time" },
        { ...valid, id: "dropped-retry", retryAt: 7 },
        { ...valid, id: "dropped-redrives", redrives: 1.5 },
        { ...valid, id: "dropped-negative", redrives: -1 },
        { ...valid, id: "a\u0007b" },
        { ...valid, revision: "duplicate" },
        "not an item",
        { ...valid, id: "kept", since: "2026-10-01T02:00:00+02:00", revision: 7 },
      ],
    })).toEqual({
      held: [
        valid,
        { id: "kept", since: iso(T0), retryAt: valid.retryAt, redrives: 0 },
      ],
    });
    for (const value of [undefined, null, "state", [], { held: "list" }]) {
      expect(readSourceItemQuarantine(value)).toEqual(EMPTY);
    }
    for (const failing of [
      { id: "item-b", attempts: 1.5, since: iso(T0) },
      { id: "item-b", attempts: 1, since: "never" },
      { id: "", attempts: 1, since: iso(T0) },
    ]) {
      expect(readSourceItemQuarantine({ failing })).toEqual(EMPTY);
    }
    expect(readSourceItemQuarantine({ failing: { id: "item-b", attempts: 1, since: iso(T0) } }))
      .toEqual({ held: [], failing: { id: "item-b", attempts: 1, since: iso(T0) } });
  });

  it("keeps as many set-aside items as a source may hold", () => {
    const held = Array.from({ length: 23 }, (_, index) => heldItem(`held-${index}`));

    expect(readSourceItemQuarantine({ held }).held).toEqual(held.slice(0, 20));
  });
});
