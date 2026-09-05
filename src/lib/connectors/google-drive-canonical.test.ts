import { describe, expect, it } from "vitest";
import { canonicalDriveSourceTimestamps } from "@/lib/connectors/google-drive-canonical";

describe("canonical Drive source timestamps", () => {
  it("preserves a valid provider timestamp sequence", () => {
    expect(canonicalDriveSourceTimestamps(
      "2026-09-05T12:00:00.000Z",
      "2026-09-05T12:30:00.000Z",
    )).toEqual({
      sourceCreatedAt: "2026-09-05T12:00:00.000Z",
      sourceUpdatedAt: "2026-09-05T12:30:00.000Z",
    });
  });

  it("omits a contradictory created timestamp from provider metadata", () => {
    expect(canonicalDriveSourceTimestamps(
      "2026-09-05T12:30:00.000Z",
      "2026-09-05T12:00:00.000Z",
    )).toEqual({
      sourceCreatedAt: null,
      sourceUpdatedAt: "2026-09-05T12:00:00.000Z",
    });
  });
});
