import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/lib/db/client.ts"), "utf8");
const start = source.indexOf("async function ensureAgentDefinitionPersonaV1");
const end = source.indexOf("async function ensureGraphQueryTelemetryV1", start);
const migration = source.slice(start, end);

describe("agent definition persona v1 migration", () => {
  it("pins the split-identity predecessor and adds both projections", () => {
    expect(migration).toContain("version = 108");
    expect(migration).toContain("name = 'agent_identity_versions_v1'");
    expect(migration).toContain("ALTER TABLE omni_custom_agents");
    expect(migration).toContain("ALTER TABLE omni_agent_definition_versions");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS persona_profile JSONB NOT NULL");
  });

  it("installs a closed, validated behavioral schema", () => {
    expect(migration).toContain("omni_agent_persona_v1_is_valid");
    expect(migration).toContain("FROM jsonb_object_keys(value)) <> 8");
    expect(migration).toContain("jsonb_array_length(value->'allowedDomains') <= 20");
    expect(migration).toContain("count(DISTINCT lower(btrim(item #>> '{}')))");
    expect(migration).toContain("omni_agent_definition_versions_persona_profile_valid");
  });

  it("does not grant authority through persona storage", () => {
    expect(migration).not.toMatch(/GRANT[\s\S]+persona_profile/i);
    expect(migration).not.toContain("capability_grant");
    expect(migration).not.toContain("context_grant");
    expect(migration).not.toContain("tool_grant");
  });
});
