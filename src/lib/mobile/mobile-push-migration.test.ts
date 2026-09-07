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
});
