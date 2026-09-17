import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260917170000_p13_3_retire_isolated_browser.sql",
);
const migration = fs.readFileSync(migrationPath, "utf8");
const schemaRunner = fs.readFileSync(
  path.join(process.cwd(), "src/lib/db/client.ts"),
  "utf8",
);

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
    expect(migration).toContain(
      "ON public.omni_browser_profiles FROM omni_runtime",
    );
    expect(migration).toContain(
      "ON public.omni_browser_takeovers FROM omni_maintenance",
    );
    expect(migration).toContain("has_any_column_privilege(");
    expect(migration).toContain("Isolated browser runtime authority is still granted");
    expect(migration).toContain(
      "Isolated browser maintenance mutation authority is still granted",
    );
    const retirementRunner = schemaRunner.slice(
      schemaRunner.indexOf("async function ensureIsolatedBrowserRuntimeRetirementV1"),
      schemaRunner.indexOf("async function ensureActorRlsPolicyRepairV1"),
    );
    expect(retirementRunner).toContain(
      "ON omni_browser_profiles FROM omni_runtime",
    );
    expect(retirementRunner).toContain(
      "ON omni_browser_takeovers FROM omni_maintenance",
    );
    expect(retirementRunner).toContain("has_any_column_privilege(");
  });

  it("disables known browser connectors and scrubs sealed credentials", () => {
    expect(migration).toContain("UPDATE public.omni_mcp_tools tool");
    expect(migration).toContain("UPDATE public.omni_mcp_connectors");
    expect(migration).toContain("omniagent-os-browser[.]fly[.]dev(:443)?");
    expect(migration).toContain("api[.]browser-use[.]com(:443)?");
    expect(migration).toContain("playwright[^?#]*/mcp/*([?#].*)?$");
    expect(migration).toContain("([?#].*)?$");
    expect(migration).toContain("sealed_credential = NULL");
    expect(migration).toContain("OR auth_token_env IS NOT NULL");
    expect(migration).toContain("OR credential_version IS NOT NULL");
    expect(migration).toContain("OR credential_origin IS NOT NULL");
    expect(migration).toContain("status = 'disabled'");
    expect(migration).toContain("Retired browser connector authority or credential remains");
    expect(migration).toContain("Retired browser tool authority remains active");
    expect(migration).toContain("tool.input_schema::text");
    expect(migration).toContain("computer[._[:space:]-]*use");
  });

  it("keeps generic task and database tools outside the SQL browser classifier", () => {
    const classifierPatterns = [...migration.matchAll(
      /~\n\s+'(\(\^\|\[\^a-z0-9\]\)[^']+)'/g,
    )].map((match) => new RegExp(match[1], "i"));
    expect(classifierPatterns.length).toBeGreaterThanOrEqual(2);
    const [surfacePattern, actionPattern] = classifierPatterns;
    const isBrowserControl = (signal: string) => {
      const normalized = signal.replace(/[\s_]+/g, " ");
      return surfacePattern.test(normalized) && actionPattern.test(normalized);
    };

    expect(isBrowserControl(
      'query_table Read a database table {"type":"object"}',
    )).toBe(false);
    expect(isBrowserControl(
      'send_task Send work to a background task queue {"type":"object"}',
    )).toBe(false);
    expect(isBrowserControl(
      'perform_action Click a CSS selector in the active browser tab',
    )).toBe(true);
    expect(isBrowserControl(
      'perform Type into the current browser tab',
    )).toBe(true);
    expect(isBrowserControl(
      'perform Click screen coordinates',
    )).toBe(true);
    expect(isBrowserControl(
      'perform {"css_selector":"#submit","type_text":"hello"}',
    )).toBe(true);
    expect(isBrowserControl(
      'perform {"css__selector":"#submit","type   text":"hello"}',
    )).toBe(true);
    expect(isBrowserControl(
      'perform {"css_ selector":"#submit","type_ text":"hello"}',
    )).toBe(true);
    expect(migration).toContain(
      "regexp_replace(lower(concat_ws(",
    );
    expect(migration).toContain("'[[:space:]_]+', ' ', 'g'");
    expect(migration).not.toContain("'send_task'");
    expect(migration).not.toContain("|type|");
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
