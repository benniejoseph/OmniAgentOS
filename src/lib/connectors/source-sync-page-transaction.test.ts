import { describe, expect, it } from "vitest";
import { evaluateSourceSyncPageRetry } from "@/lib/connectors/source-sync-page-transaction";

describe("source sync page transaction fault model", () => {
  it("rolls back a partial page and commits its retry exactly once", () => {
    expect(evaluateSourceSyncPageRetry({
      initialCursor: "cursor:page-1",
      itemIds: ["source:item-1", "source:item-2"],
      nextCursor: "cursor:page-2",
      failAfterItemId: "source:item-1",
      retryCount: 1,
    })).toEqual({
      attemptCount: 2,
      committedIds: ["source:item-1", "source:item-2"],
      committedCursor: "cursor:page-2",
      cursorAdvancedBeforeCommit: false,
      duplicateCount: 0,
      lostCount: 0,
      completed: true,
    });
  });

  it("keeps the original cursor and exposes lost work when no retry is available", () => {
    expect(evaluateSourceSyncPageRetry({
      initialCursor: "cursor:page-1",
      itemIds: ["source:item-1", "source:item-2"],
      nextCursor: "cursor:page-2",
      failAfterItemId: "source:item-1",
      retryCount: 0,
    })).toMatchObject({
      committedIds: [],
      committedCursor: "cursor:page-1",
      cursorAdvancedBeforeCommit: false,
      lostCount: 2,
      completed: false,
    });
  });

  it("rejects duplicate page identities instead of hiding them", () => {
    expect(() => evaluateSourceSyncPageRetry({
      initialCursor: "cursor:page-1",
      itemIds: ["source:item-1", "source:item-1"],
      nextCursor: "cursor:page-2",
      retryCount: 1,
    })).toThrow(/unique/i);
  });
});
