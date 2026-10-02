import { describe, expect, it } from "vitest";
import {
  advanceSourceDocumentSweep,
  readSourceDocumentSweep,
  sourceDocumentSliceStops,
  startSourceDocumentSweep,
  type SourceDocumentSweep,
} from "@/lib/connectors/source-document-sweep";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (time: number) => new Date(time).toISOString();

function sweepAt(fields: Partial<SourceDocumentSweep> = {}): SourceDocumentSweep {
  return { since: iso(T0), after: "knowledge_b", checked: 7, removed: 2, ...fields };
}

describe("a document sweep", () => {
  it("starts when its source starts over, having checked nothing", () => {
    expect(startSourceDocumentSweep(T0)).toEqual({ since: iso(T0), checked: 0, removed: 0 });
  });

  it("moves past a slice it settled, counting what it checked and removed", () => {
    expect(advanceSourceDocumentSweep(sweepAt(), {
      listed: 50,
      lastId: "knowledge_f",
      present: 41,
      gone: 6,
    })).toEqual({
      sweep: { since: iso(T0), after: "knowledge_f", checked: 54, removed: 8 },
      finished: false,
    });
  });

  it("is finished once a slice lists fewer documents than it asks for", () => {
    expect(advanceSourceDocumentSweep(sweepAt(), {
      listed: 49,
      lastId: "knowledge_f",
      present: 3,
      gone: 0,
    }).finished).toBe(true);
    expect(advanceSourceDocumentSweep(startSourceDocumentSweep(T0), {
      listed: 0,
      present: 0,
      gone: 0,
    })).toEqual({
      sweep: { since: iso(T0), checked: 0, removed: 0 },
      finished: true,
    });
    expect(advanceSourceDocumentSweep(sweepAt(), { listed: 0, present: 0, gone: 0 }).sweep)
      .toEqual(sweepAt());
  });

  it("stops a slice that would remove documents none of its source confirms", () => {
    const fresh = startSourceDocumentSweep(T0);

    expect(sourceDocumentSliceStops(fresh, { present: 0, gone: 1 })).toBe(true);
    expect(sourceDocumentSliceStops(sweepAt({ checked: 4, removed: 4 }), { present: 0, gone: 3 }))
      .toBe(true);
    expect(sourceDocumentSliceStops(fresh, { present: 1, gone: 9 })).toBe(false);
    expect(sourceDocumentSliceStops(fresh, { present: 0, gone: 0 })).toBe(false);
  });

  it("stops a slice that would remove ten or more and confirms none present", () => {
    expect(sourceDocumentSliceStops(sweepAt(), { present: 0, gone: 10 })).toBe(true);
    expect(sourceDocumentSliceStops(sweepAt(), { present: 0, gone: 9 })).toBe(false);
    expect(sourceDocumentSliceStops(sweepAt(), { present: 1, gone: 49 })).toBe(false);
  });
});

describe("the sweep a cursor keeps", () => {
  it("reads back what it wrote", () => {
    for (const sweep of [sweepAt(), startSourceDocumentSweep(T0)]) {
      expect(readSourceDocumentSweep(JSON.parse(JSON.stringify(sweep)))).toEqual(sweep);
    }
    expect(readSourceDocumentSweep({ ...sweepAt(), since: "2026-10-01T02:00:00+02:00" }))
      .toEqual(sweepAt());
  });

  it("is none when it cannot be read", () => {
    for (const value of [
      undefined,
      null,
      "sweep",
      [],
      { ...sweepAt(), since: "never" },
      { ...sweepAt(), since: 7 },
      { ...sweepAt(), checked: 1.5 },
      { ...sweepAt(), checked: 7.5 },
      { ...sweepAt(), checked: "7" },
      { ...sweepAt(), checked: -1, removed: 0 },
      { ...sweepAt(), removed: -1 },
      { ...sweepAt(), removed: "2" },
      { ...sweepAt(), checked: 2, removed: 3 },
      { ...sweepAt(), after: "" },
      { ...sweepAt(), after: "knowledge\u0000b" },
      { ...sweepAt(), after: "a".repeat(257) },
      { ...sweepAt(), after: 7 },
    ]) {
      expect(readSourceDocumentSweep(value)).toBeUndefined();
    }
    expect(readSourceDocumentSweep({ ...sweepAt(), after: "a".repeat(256) })?.after)
      .toBe("a".repeat(256));
    expect(readSourceDocumentSweep({ ...sweepAt(), checked: 3, removed: 3 }))
      .toEqual(sweepAt({ checked: 3, removed: 3 }));
  });
});
