import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260921120000_moltbook_agent_connections.sql",
), "utf8");
const migrationManifest = JSON.parse(readFileSync(resolve(
  process.cwd(),
  "schema-migrations.json",
), "utf8")) as Array<{ version: number; name: string; checksum: string; file?: string }>;

describe("Moltbook v190 migration", () => {
  it("links the connection to one exact tenant, actor, and custom Agent", () => {
    expect(migration).toContain("UNIQUE (tenant_id, actor_id, id)");
    expect(migration).toContain("FOREIGN KEY (tenant_id, owner_actor_id, agent_id)");
    expect(migration).toContain("REFERENCES omni_custom_agents (tenant_id, actor_id, id)");
    expect(migration).toContain("UNIQUE (tenant_id, owner_actor_id, agent_id)");
  });

  it("pins one immutable principal generation, definition, and exact policy boundary", () => {
    for (const fragment of [
      "principal_id TEXT NOT NULL",
      "principal_generation BIGINT NOT NULL",
      "principal_sha256 TEXT NOT NULL",
      "definition_version BIGINT NOT NULL",
      "definition_sha256 TEXT NOT NULL",
      "policy_boundary_sha256 TEXT NOT NULL",
      "CONSTRAINT omni_moltbook_connections_principal_fkey",
      "FOREIGN KEY (tenant_id, principal_id, principal_generation)",
      "CONSTRAINT omni_moltbook_connections_definition_fkey",
      "FOREIGN KEY (tenant_id, agent_id, definition_version)",
      "principal.state = 'active'",
      "JOIN public.omni_auth_user_actor_identifiers owner_identifier",
      "owner_identifier.actor_identifier COLLATE \"C\" =",
      "owner_identifier.canonical_actor_id = principal.controller_actor_id",
      "policy.owner_actor_id = principal.controller_actor_id",
      "policy.authority_mode = 'explicit_grants'",
      "cardinality(policy.context_grant_ids) = 0",
      "cardinality(policy.capability_grant_ids) = 0",
    ]) {
      expect(migration).toContain(fragment);
    }
    expect(migration).toContain("OLD.principal_generation IS DISTINCT FROM NEW.principal_generation");
    expect(migration).toContain("OLD.policy_boundary_sha256 IS DISTINCT FROM NEW.policy_boundary_sha256");
  });

  it("forces tenant-permissive plus actor-restrictive RLS", () => {
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(1);
    expect(migration).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
    expect(migration).toContain("AS RESTRICTIVE FOR ALL TO PUBLIC");
    expect(migration).toContain("AS PERMISSIVE FOR ALL TO PUBLIC");
  });

  it("keeps activities and effect receipts append-only with least privilege", () => {
    expect(migration).toContain("omni_reject_moltbook_receipt_mutation_v1");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON omni_moltbook_activities");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON omni_moltbook_effect_receipts");
    expect(migration).toContain("GRANT SELECT, INSERT ON omni_moltbook_activities TO omni_runtime");
    expect(migration).not.toContain("GRANT DELETE ON omni_moltbook");
    expect(migration).toContain("effect_status IN ('succeeded', 'failed', 'uncertain', 'pending_verification', 'published')");
    expect(migration).toContain("tool_input_sha256 TEXT NOT NULL");
    expect(migration).toContain("effect_target_id TEXT NOT NULL");
    expect(migration).toContain("CREATE UNIQUE INDEX omni_moltbook_effect_receipts_execution_idx");
  });

  it("bounds JSON, protects the sealed credential, and fences lifecycle transitions", () => {
    expect(migration).toContain("pg_column_size(sealed_credentials) <= 131072");
    expect(migration).toContain("pg_column_size(rate_limit_projection) <= 4096");
    expect(migration).toContain("Moltbook credential transition is invalid");
    expect(migration).toContain("Moltbook connection lifecycle transition is invalid");
    expect(migration).toContain("'registering', 'pending_claim', 'claimed', 'paused', 'error', 'revoked'");
    expect(migration).toContain("omni_moltbook_agent_boundary_is_exact_v1");
    expect(migration).toContain("Linked Moltbook Agents cannot be deleted");
    expect(migration).toContain("Linked Moltbook Agent capability cannot be widened");
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION omni_moltbook_agent_boundary_is_exact_v1(\n      TEXT[], TEXT[], TEXT, TEXT, TEXT\n    ) TO omni_runtime",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION omni_moltbook_agent_boundary_is_exact_v1(\n      TEXT[], TEXT[], TEXT, TEXT, TEXT\n    ) TO omni_maintenance",
    );
    expect(migration).toContain("safe_registration_retry := FALSE");
    expect(migration).not.toContain("OLD.last_error_code LIKE 'registration_rejected.%'");
    expect(migration).toContain("disclosure_version = 'moltbook-public-activity-v1'");
    expect(migration).toContain("registration_request_sha256 ~ '^[a-f0-9]{64}$'");
  });

  it("registers the v190 identity and runs from the migration file", () => {
    expect(migrationManifest.find((entry) => entry.version === 190)).toEqual({
      version: 190,
      name: "moltbook_agent_connections_v1",
      checksum: "e0b8c00ca8f4fce6139735623366cacfa97675419a57c1666b4bf0fe4bbe8e46",
      file: "20260921120000_moltbook_agent_connections.sql",
      sha256: "4f69f57cdcf12e2c92b2b9c742a5096dee6f39cbbd8f582e725efa2b9329ce8e",
    });
    expect(migration).toContain("190,\n  'moltbook_agent_connections_v1',\n  'e0b8c00ca8f4fce6139735623366cacfa97675419a57c1666b4bf0fe4bbe8e46'");
  });
});
