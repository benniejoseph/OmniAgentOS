import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
const sql = readFileSync(new URL("../../../supabase/migrations/20261004200000_meeting_commitment_resolution_intents.sql", import.meta.url), "utf8");

describe("Meeting commitment resolution admission migration", () => {
  it("fences its exact predecessor and declares a self-consistent new version only", () => {
    expect(sql).toContain("IS DISTINCT FROM 219");
    expect(sql).toContain("responsibility_notifications_v1");
    const checksum = sql.match(/VALUES \(220,'meeting_commitment_resolution_intents_v1','([a-f0-9]{64})'/)?.[1];
    expect(checksum).toBeDefined();
    expect(createHash("sha256").update(sql.replaceAll(checksum!, "0".repeat(64))).digest("hex")).toBe(checksum);
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?omni_schema_version/i);
  });
  it("keeps decisions and phase evidence append-only under canonical owner and tenant RLS", () => {
    for (const table of ["omni_meeting_commitment_resolution_intents", "omni_meeting_commitment_resolution_progress"]) expect(sql).toContain(table);
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("omni_actor_scope_v1_allows_canonical(tenant_id,owner_actor_id)");
    expect(sql).toContain("omni_meeting_write_v1_allows");
    expect(sql).toContain("omni_meeting_access_v1_allows");
    expect(sql).toContain("BEFORE UPDATE OR DELETE");
    expect(sql).toContain("BEFORE TRUNCATE");
    expect(sql).toContain("GRANT SELECT, INSERT");
    expect(sql).not.toMatch(/GRANT[^;]*(?:UPDATE|DELETE|TRUNCATE)/);
  });
  it("enforces unique pre-effect admission and phase ordering at direct SQL writes too", () => {
    expect(sql).toContain("PRIMARY KEY (tenant_id,workspace_id,proposal_id)");
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended(NEW.tenant_id");
    expect(sql).toContain("Legacy accepted evidence cannot acquire a new decision identity");
    expect(sql).toContain("NEW.phase_order <> cardinality(phases) + 1");
    expect(sql).toContain("'interrupted' = ANY(phases)");
    expect(sql).toContain("Resolution differs from its immutable request or child acknowledgements");
    expect(sql).toContain("BEFORE INSERT ON public.omni_meeting_commitment_resolutions");
    expect(sql).not.toMatch(/lease_expires|takeover_at|retry_after/i);
  });
});
