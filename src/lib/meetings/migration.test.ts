import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260908003000_p10_6_meeting_domain.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("P10.6 meeting domain migration", () => {
  it("keeps revisions immutable and advances the projection monotonically", () => {
    expect(migration).toContain("omni_meeting_revisions_immutable");
    expect(migration).toContain("Meeting revisions are immutable");
    expect(migration).toContain("NEW.current_revision <> OLD.current_revision + 1");
    expect(migration).toContain("REFERENCES omni_meeting_revisions");
  });

  it("enforces the strictest current access scope over all history", () => {
    expect(migration).toContain("omni_meeting_access_v1_allows");
    expect(migration).toContain("omni_meeting_write_v1_allows");
    expect(migration).toContain("AS RESTRICTIVE FOR SELECT");
    expect(migration).toContain("FROM omni_meetings meeting");
    expect(migration).toContain("meeting.effective_access_class");
    expect(migration).toContain("omni_actor_scope_v1_allows_canonical");
    expect(migration).not.toMatch(
      /FROM public\.omni_work_project_memberships membership[\s\S]{0,300}membership\.subject_kind/,
    );
  });

  it("limits runtime writes to revisions and the current projection", () => {
    expect(migration).toContain(
      "GRANT SELECT, INSERT ON omni_meeting_revisions TO omni_runtime",
    );
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE ON omni_meetings TO omni_runtime",
    );
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE");
  });

  it("records ordered migration 134", () => {
    expect(migration).toContain("version = 133");
    expect(migration).toContain("134,");
    expect(migration).toContain("meeting_domain_v1");
  });
});
