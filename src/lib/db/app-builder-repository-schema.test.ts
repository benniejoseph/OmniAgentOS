import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const readMigration = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), "supabase/migrations", file), "utf8");

describe("App Builder repository schema migrations", () => {
  it("keeps the deployment URL repair bounded to the literal Vercel host", () => {
    const migration = readMigration(
      "20260915173000_app_builder_deployment_url_constraint_repair.sql",
    );

    expect(migration).toContain("[.]vercel[.]app");
    expect(migration).toContain(
      "App Builder deployment URL constraint repair is invalid",
    );
  });

  it("preserves repository workspace capacity and exact event kinds", () => {
    const migration = readMigration(
      "20260915190000_app_builder_repository_workspaces.sql",
    );

    expect(migration).toContain("file_count BETWEEN 1 AND 10000");
    expect(migration).toContain("app_builder.repository.checked_out");
    expect(migration).toContain("app_builder.release.production_healthy");
  });

  it("preserves exact Git preview constraints and postflight", () => {
    const migration = readMigration(
      "20260916093000_app_builder_repository_git_previews.sql",
    );

    expect(migration).toContain("file_count BETWEEN 1 AND 10000");
    expect(migration).toContain(
      "App Builder repository Git preview capacity is invalid",
    );
  });
});
