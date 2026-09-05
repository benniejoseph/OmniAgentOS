import { describe, expect, it } from "vitest";
import {
  canonicalDriveMetadataSha256,
  canonicalDriveSourceTimestamps,
} from "@/lib/connectors/google-drive-canonical";

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

  it("changes canonical metadata when a file moves between parents", () => {
    const file = {
      version: "7",
      headRevisionId: "revision-7",
      mimeType: "application/pdf",
      parents: ["folder-a", "folder-b"],
      createdTime: "2026-09-05T12:00:00.000Z",
      modifiedTime: "2026-09-05T12:30:00.000Z",
      md5Checksum: "provider-checksum",
      size: "2048",
    };
    const itemKey = "a".repeat(64);
    const original = canonicalDriveMetadataSha256(file, itemKey);
    const reordered = canonicalDriveMetadataSha256({
      ...file,
      parents: ["folder-b", "folder-a"],
    }, itemKey);
    const moved = canonicalDriveMetadataSha256({
      ...file,
      parents: ["folder-c"],
    }, itemKey);

    expect(reordered).toBe(original);
    expect(moved).not.toBe(original);
  });
});
