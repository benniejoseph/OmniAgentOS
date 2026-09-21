import { describe, expect, it } from "vitest";

import {
  createMoltbookActivityCursor,
  MoltbookConnectionError,
  moltbookDueObservationMode,
  parseMoltbookActivityCursor,
} from "@/lib/moltbook/store";

describe("Moltbook store contracts", () => {
  it("round-trips a bounded keyset cursor without accepting arbitrary offsets", () => {
    const createdAt = "2026-09-21T12:00:00.000Z";
    const id = `moltbook_activity_${"a".repeat(48)}`;
    const cursor = createMoltbookActivityCursor(createdAt, id);
    expect(parseMoltbookActivityCursor(cursor)).toEqual({ createdAt, id });
    expect(() => parseMoltbookActivityCursor(
      Buffer.from(JSON.stringify({ createdAt, id, offset: 100 })).toString("base64url"),
    )).toThrow(MoltbookConnectionError);
  });

  it("rejects malformed and cross-shape cursors", () => {
    expect(() => parseMoltbookActivityCursor("not-a-cursor"))
      .toThrow("Invalid activity cursor");
    expect(() => parseMoltbookActivityCursor(
      Buffer.from(JSON.stringify({ createdAt: "bad", id: "bad" })).toString("base64url"),
    )).toThrow("Invalid activity cursor");
  });

  it("polls home only for a fully claimed identity", () => {
    expect(moltbookDueObservationMode({
      status: "pending_claim",
      claimState: "pending",
    })).toBe("refresh");
    expect(moltbookDueObservationMode({
      status: "claimed",
      claimState: "pending",
    })).toBe("refresh");
    expect(moltbookDueObservationMode({
      status: "claimed",
      claimState: "claimed",
    })).toBe("heartbeat");
  });
});
