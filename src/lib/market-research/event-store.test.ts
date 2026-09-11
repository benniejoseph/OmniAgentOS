import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("market event persistence", () => {
  it("uses the database clock for constraint-safe immutable timestamps", async () => {
    const source = await readFile(new URL("./event-store.ts", import.meta.url), "utf8");

    expect(source).toContain("'release_date_only', source.source_sha256,\n        NOW()");
    expect(source).toContain("source.payload_sha256, NOW()");
    expect(source).toContain("market.macro_observation.initial_release_observed");
    expect(source).not.toContain("event.importedAt)}::TIMESTAMPTZ[]");
  });
});
