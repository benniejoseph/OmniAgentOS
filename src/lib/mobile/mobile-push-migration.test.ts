import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("P12.5 mobile push delivery migration", () => {
  it("installs encrypted actor-private registrations and a leased causal outbox", async () => {
    const sql = await readFile(
      new URL(
        "../../../supabase/migrations/20260908123000_p12_5_mobile_push_delivery.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain("mobile_push_delivery_v1");
    expect(sql).toContain("omni_mobile_push_registrations");
    expect(sql).toContain("token_bundle JSONB NOT NULL");
    expect(sql).toContain("omni_mobile_push_deliveries");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
    expect(sql).toContain("'approval', 'work_item', 'meeting', 'customer', 'run'");
    expect(sql).toContain("(acknowledged_at IS NOT NULL) = (status = 'acknowledged')");
    expect(sql).not.toMatch(/GRANT\s+(?:ALL|DELETE|TRUNCATE)\b/i);
  });

  it("appends immutable actor-scoped app receipts after the Jev shadow pilot", async () => {
    const sql = await readFile(
      new URL(
        "../../../supabase/migrations/20260918140000_mobile_push_receipt_canary.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain("latest_version IS DISTINCT FROM 184");
    expect(sql).toContain("version = 184");
    expect(sql).toContain("semantic_decision_shadow_pilot_v1");
    expect(sql).toContain(
      "142047c12f42ba8135d7bfd95edde467ebcedf4d42f5c69937b4fe797a865223",
    );
    expect(sql).toContain("omni_mobile_push_delivery_receipts");
    expect(sql).toContain("provider_accepted_at");
    expect(sql).toContain("'received', 'opened', 'action'");
    expect(sql).toContain("'approval', 'work_item', 'meeting', 'customer', 'run', 'canary'");
    expect(sql).toContain("AS RESTRICTIVE FOR ALL TO PUBLIC");
    expect(sql).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
    expect(sql).toContain("omni_mobile_push_delivery_receipts_immutable");
    expect(sql).toContain("omni_mobile_push_delivery_receipts_no_truncate");
    expect(sql).toContain(
      "VALUES (\n  185,\n  'mobile_push_receipt_canary_v1'",
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:ALL|UPDATE|DELETE|TRUNCATE)\s+ON\s+(?:TABLE\s+)?public\.omni_mobile_push_delivery_receipts/i,
    );
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
  });
});
