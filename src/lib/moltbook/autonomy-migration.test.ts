import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureMoltbookAutonomyV1 } from "@/lib/moltbook/autonomy-schema";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260921170000_moltbook_autonomy.sql",
);
const migration = readFileSync(migrationPath, "utf8");
const databaseClient = readFileSync(resolve(
  process.cwd(),
  "src/lib/db/client.ts",
), "utf8");
const manifest = JSON.parse(readFileSync(resolve(
  process.cwd(),
  "schema-migrations.json",
), "utf8")) as Array<{ version: number; name: string; checksum: string }>;

describe("Moltbook autonomy v194 migration", () => {
  it("registers exactly after v193 in both migration paths", async () => {
    expect(manifest.find((entry) => entry.version === 194)).toEqual({
      version: 194,
      name: "moltbook_autonomy_v1",
      checksum: "66a868eed1a0fef0eb61d8f69d0d2351605edf39711c007d5c58f1febb5cafef",
    });
    expect(migration).toContain("latest_version IS DISTINCT FROM 193");
    expect(migration).toContain("194,\n  'moltbook_autonomy_v1',\n  '66a868eed1a0fef0eb61d8f69d0d2351605edf39711c007d5c58f1febb5cafef'");
    expect(databaseClient).toContain("...databaseSchemaMigrations[193]");
    expect(databaseClient).toContain("up: ensureMoltbookAutonomyV1");

    const statements: string[] = [];
    await ensureMoltbookAutonomyV1({
      query: async (text) => {
        statements.push(text);
        return [];
      },
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("CREATE TABLE omni_moltbook_autonomy_enrollments");
    expect(statements[0]).not.toContain("INSERT INTO public.omni_schema_version");
  });

  it("accepts only the original nine tools or the exact thirteen-tool v2 boundary", () => {
    for (const toolId of [
      "moltbook.home.read",
      "moltbook.feed.read",
      "moltbook.thread.read",
      "moltbook.post.create",
      "moltbook.comment.create",
      "moltbook.post.vote",
      "moltbook.comment.upvote",
      "moltbook.agent.follow",
      "moltbook.verify",
      "moltbook.submolts.list",
      "moltbook.submolt.read",
      "moltbook.submolt.feed",
      "moltbook.submolt.subscribe",
    ]) {
      expect(migration).toContain(`'${toolId}'`);
    }
    expect(migration).toContain("cardinality(assigned_tool_ids) = 9");
    expect(migration).toContain("cardinality(assigned_tool_ids) = 13");
    expect(migration).toContain("cardinality(assigned_skill_ids) = 0");
    expect(migration).toContain("agent_memory_scope = 'session'");
    expect(migration).toContain("agent_autonomy = 'governed'");
    expect(migration).toContain("cardinality(policy.context_grant_ids) = 0");
    expect(migration).toContain("cardinality(policy.capability_grant_ids) = 0");
  });

  it("pins versioned authority and backfills the immutable connection identity", () => {
    for (const fragment of [
      "CREATE TABLE omni_moltbook_authority_versions",
      "authority_version BIGINT NOT NULL",
      "principal_generation BIGINT NOT NULL",
      "definition_version BIGINT NOT NULL",
      "policy_boundary_sha256 TEXT NOT NULL",
      "change_reason IN ('initial_connection', 'agent_rebind')",
      "Initial Moltbook authority does not match its connection pin",
      "Moltbook authority is not the current exact Agent boundary",
      "agent.status IN ('ready', 'learning')",
      "SELECT MAX(current_definition.definition_version)",
      "INSERT INTO omni_moltbook_authority_versions",
      "connection.principal_sha256",
      "connection.definition_sha256",
      "connection.policy_boundary_sha256",
    ]) {
      expect(migration).toContain(fragment);
    }
  });

  it("stores revocable mandates, leased cycles, and exact one-time action evidence", () => {
    for (const fragment of [
      "CREATE TABLE omni_moltbook_autonomy_enrollments",
      "status IN ('enabled', 'paused', 'revoked')",
      "policy_version = 'moltbook-autonomy-v1'",
      "disclosure_version = 'moltbook-autonomy-public-actions-v1'",
      "cycle_interval_seconds BETWEEN 14400 AND 86400",
      "CREATE TABLE omni_moltbook_autonomy_cycles",
      "execution_purpose = 'moltbook.autonomy.cycle.v1'",
      "CREATE UNIQUE INDEX omni_moltbook_autonomy_cycles_active_idx",
      "lease_token_sha256 TEXT NOT NULL",
      "membership_role TEXT NOT NULL",
      "membership_role IN ('operator', 'admin')",
      "CREATE TABLE omni_moltbook_autonomy_action_claims",
      "tool_input_sha256 TEXT NOT NULL",
      "effect_target_id TEXT NOT NULL",
      "idempotency_key TEXT NOT NULL",
      "status IN ('claimed', 'consumed')",
      "Moltbook autonomy action claim is immutable or already consumed",
    ]) {
      expect(migration).toContain(fragment);
    }
    expect(migration).not.toContain("GRANT DELETE ON omni_moltbook");
  });

  it("keeps interests bounded, normalized, digest-only, and append-only", () => {
    expect(migration).toContain("CREATE TABLE omni_moltbook_interest_observations");
    expect(migration).toContain("topic = lower(btrim(topic))");
    expect(migration).toContain("Moltbook interest profile cannot exceed 32 active topics");
    expect(migration).toContain("cardinality(evidence_sha256s) BETWEEN 1 AND 8");
    expect(migration).toContain("evidence_sha256s TEXT[] NOT NULL");
    expect(migration).not.toMatch(
      /provider_(?:text|content)[\s\S]*omni_moltbook_interest/i,
    );
    expect(migration).toContain("Moltbook autonomy authority, interests, and events are append-only");
  });

  it("forces actor-private RLS and grants only runtime, maintenance, and backup needs", () => {
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(1);
    expect(migration).toContain("FOREACH table_name IN ARRAY ARRAY[");
    expect(migration).toContain("AS RESTRICTIVE FOR ALL TO PUBLIC");
    expect(migration).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
    expect(migration).toContain("GRANT SELECT, INSERT ON omni_moltbook_autonomy_action_claims TO omni_runtime");
    expect(migration).toContain("GRANT SELECT, INSERT ON omni_moltbook_autonomy_cycles TO omni_maintenance");
    expect(migration).toContain("GRANT SELECT ON omni_moltbook_autonomy_events TO omni_backup");
  });
});
