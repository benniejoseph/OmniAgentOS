import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260917170000_p13_3_retire_isolated_browser.sql",
);
const migration = fs.readFileSync(migrationPath, "utf8");

describe("isolated browser runtime retirement migration", () => {
  it("revokes active browser authority without deleting audit history", () => {
    expect(migration).toContain("UPDATE public.omni_browser_takeovers");
    expect(migration).toContain("UPDATE public.omni_browser_profiles");
    expect(migration).toContain("SET state = 'revoked'");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+public\.omni_browser_/i);
    expect(migration).not.toMatch(/DROP\s+TABLE\s+.*omni_browser_/i);
  });

  it("removes runtime mutations and preserves read-only audit access", () => {
    for (const table of [
      "omni_browser_profiles",
      "omni_browser_profile_bindings",
      "omni_browser_takeovers",
    ]) {
      expect(migration).toContain(
        `REVOKE ALL ON TABLE public.${table} FROM omni_runtime`,
      );
      expect(migration).toContain(
        `GRANT SELECT ON TABLE public.${table} TO omni_runtime`,
      );
    }
    expect(migration).toContain("Isolated browser runtime authority is still granted");
  });

  it("disables known browser connectors and scrubs sealed credentials", () => {
    expect(migration).toContain("UPDATE public.omni_mcp_tools tool");
    expect(migration).toContain("UPDATE public.omni_mcp_connectors");
    expect(migration).toContain("https://omniagent-os-browser.fly.dev/mcp");
    expect(migration).toContain("https://api.browser-use.com/%");
    expect(migration).toContain("sealed_credential = NULL");
    expect(migration).toContain("status = 'disabled'");
    expect(migration).toContain("Retired browser connector authority or credential remains");
  });

  it("records the exact ordered schema marker", () => {
    expect(migration).toContain("latest_version IS DISTINCT FROM 180");
    expect(migration).toContain("181,");
    expect(migration).toContain("'isolated_browser_runtime_retirement_v1'");
    expect(migration).toContain(
      "'2d8bfc80ac843fe49ca79024022b873f5046a68822892ace7ff78d393025cf4d'",
    );
  });
});
