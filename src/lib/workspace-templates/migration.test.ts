import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260908000000_p10_5_workspace_templates.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("P10.5 workspace template migration", () => {
  it("keeps published versions and project snapshots append-only", () => {
    expect(migration).toContain("omni_workspace_template_versions_immutable");
    expect(migration).toContain("omni_workspace_template_instantiations_immutable");
    expect(migration).toContain("Published template versions and instantiations are immutable");
    expect(migration).toContain("active_template_version <> OLD.active_template_version + 1");
  });

  it("requires exact tenant and workspace membership scope", () => {
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("omni_actor_scope_v1_allows_canonical");
    expect(migration).toContain("membership.access_level IN (''contributor'', ''manager'')");
    expect(migration).toContain("REFERENCES omni_work_projects");
  });

  it("gives runtime only the operations required by the lifecycle", () => {
    expect(migration).toContain("GRANT SELECT, INSERT ON omni_workspace_template_versions TO omni_runtime");
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE ON omni_workspace_template_channels TO omni_runtime");
    expect(migration).toContain("GRANT SELECT, INSERT ON omni_workspace_template_instantiations TO omni_runtime");
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE");
  });

  it("records ordered migration 132", () => {
    expect(migration).toContain("version = 131");
    expect(migration).toContain("132,");
    expect(migration).toContain("workspace_templates_v1");
  });
});
