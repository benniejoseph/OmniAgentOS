import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260908010000_p10_8_meeting_commitment_conversion.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("P10.8 meeting commitment conversion migration", () => {
  it("stores immutable proposals and one immutable resolution", () => {
    expect(migration).toContain("omni_meeting_commitment_proposals_immutable");
    expect(migration).toContain("omni_meeting_commitment_resolutions_immutable");
    expect(migration).toContain("Meeting commitment evidence is immutable");
    expect(migration).toContain("PRIMARY KEY (tenant_id, workspace_id, proposal_id)");
  });

  it("inherits meeting read and write authority without update or delete grants", () => {
    expect(migration).toContain("omni_meeting_access_v1_allows");
    expect(migration).toContain("omni_meeting_write_v1_allows");
    expect(migration).toContain("AS RESTRICTIVE FOR SELECT");
    expect(migration).toContain("GRANT SELECT, INSERT ON omni_meeting_commitment_proposals");
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE");
    expect(migration).not.toContain("GRANT SELECT, INSERT, DELETE");
  });

  it("requires the P10.7 predecessor and records migration 136", () => {
    expect(migration).toContain("version = 135");
    expect(migration).toContain("136,");
    expect(migration).toContain("meeting_commitment_conversion_v1");
  });
});
