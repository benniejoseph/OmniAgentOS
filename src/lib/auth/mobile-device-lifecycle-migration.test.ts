import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("P12.2 mobile device lifecycle migration", () => {
  it("installs durable revocation and truthful remote-wipe acknowledgement state", async () => {
    const sql = await readFile(
      new URL("../../../supabase/migrations/20260908093000_p12_2_mobile_device_lifecycle.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("revocation_reason TEXT");
    expect(sql).toContain("wipe_requested_at TIMESTAMPTZ");
    expect(sql).toContain("wipe_acknowledged_at TIMESTAMPTZ");
    expect(sql).toContain("wipe_challenge_hash TEXT");
    expect(sql).toContain("revocation_reason = 'remote_wipe'");
    expect(sql).toContain("omni_mobile_sessions_wipe_challenge_idx");
    expect(sql).toContain("mobile_device_lifecycle_v1");
  });
});
