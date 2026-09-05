import { describe, expect, it } from "vitest";
import { canonicalSourceSyncTimestamp } from "@/lib/connectors/source-sync-checkpoints";

describe("canonical source sync timestamps", () => {
  it("preserves milliseconds from PostgreSQL Date values", () => {
    const value = new Date("2026-09-05T12:20:10.123Z");

    expect(canonicalSourceSyncTimestamp(value)).toBe(
      "2026-09-05T12:20:10.123Z",
    );
  });

  it("normalizes provider timestamp strings", () => {
    expect(canonicalSourceSyncTimestamp("2026-09-05T17:50:10.123+05:30"))
      .toBe("2026-09-05T12:20:10.123Z");
  });

  it("rejects invalid provider timestamps", () => {
    expect(() => canonicalSourceSyncTimestamp("not-a-timestamp")).toThrow(
      "Source sync provider timestamp is invalid.",
    );
  });
});
