import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/lib/db/client.ts"), "utf8");
const start = source.indexOf("async function ensureAgentIdentityVersionsV1");
const end = source.indexOf("async function ensureGraphQueryTelemetryV1", start);
const migration = source.slice(start, end);

describe("agent identity versions v1 migration", () => {
  it("pins the exact predecessor and reuses the existing execution principal", () => {
    expect(migration).toContain("version = 107");
    expect(migration).toContain("name = 'graph_query_telemetry_v1'");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS omni_agent_definition_versions");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS omni_agent_principal_policies");
    expect(migration).not.toContain("CREATE TABLE IF NOT EXISTS omni_agent_principals");
    expect(migration).toContain("INSERT INTO omni_tenant_execution_principals");
  });

  it("backfills only canonically owned definitions and holds ambiguity", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS omni_agent_identity_backfill_holds");
    expect(migration).toContain("'missing_controller'");
    expect(migration).toContain("'ambiguous_controller'");
    expect(migration).toContain("HAVING COUNT(DISTINCT identifier.canonical_actor_id) = 1");
    expect(migration).toContain("Agent identity backfill parity is incomplete");
  });

  it("keeps definition and principal policy history append-only", () => {
    expect(migration).toContain("omni_protect_agent_identity_history_v1");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON omni_agent_definition_versions");
    expect(migration).toContain("BEFORE TRUNCATE ON omni_agent_definition_versions");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON omni_agent_principal_policies");
    expect(migration).toContain("BEFORE TRUNCATE ON omni_agent_principal_policies");
  });

  it("requires a matching policy before activation", () => {
    expect(migration).toContain("omni_validate_agent_principal_activation_v1");
    expect(migration).toContain("Agent principal activation requires an exact policy version");
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS omni_execution_principal_activation_hold_check");
    expect(migration).toContain("principal.state = 'held'");
    expect(migration).toContain("SET state = 'active'");
  });

  it("enforces actor-private rows and keeps diagnostic holds system-only", () => {
    expect(migration).toContain("ALTER TABLE omni_agent_definition_versions FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE omni_agent_principal_policies FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("omni_agent_definition_versions_actor");
    expect(migration).toContain("omni_agent_principal_policies_actor");
    expect(migration).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
    expect(migration).toContain("omni_agent_identity_backfill_holds_system");
    expect(migration).toContain("USING (omni_system_scope_enabled())");
  });

  it("allows append and lifecycle operations without broad mutation grants", () => {
    expect(migration).toContain("GRANT SELECT, INSERT ON omni_agent_definition_versions TO omni_runtime");
    expect(migration).toContain("GRANT SELECT, INSERT ON omni_agent_principal_policies TO omni_runtime");
    expect(migration).toContain("GRANT UPDATE (\n          state, lifecycle_revision, activated_by_actor_id, revoked_by_actor_id");
    expect(migration).toContain("Agent identity runtime grants are too broad");
    expect(migration).not.toContain("GRANT DELETE ON omni_agent_definition_versions");
    expect(migration).not.toContain("GRANT UPDATE ON omni_agent_principal_policies");
  });
});
