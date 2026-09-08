import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Loop v2 context-text engine migration", () => {
  it("admits only the three exact canary engine configurations", async () => {
    const sql = await readFile(
      new URL(
        "../../../supabase/migrations/20260908143000_loop_v2_context_text_engine.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(sql).toContain("loop_v2_context_text_engine_v1");
    expect(sql).toContain("agent_loop_v2_read_only_canary_1");
    expect(sql).toContain("agent_loop_v2_model_text_canary_1");
    expect(sql).toContain("agent_loop_v2_context_text_canary_1");
    expect(sql).toContain(
      "70581030987f63fde99ded6d0c718945647c5ff5ff68aa3108a7473510135404",
    );
    expect(sql).toContain("VALIDATE CONSTRAINT");
    expect(sql).toContain("version, name, checksum, applied_at");
    expect(sql).not.toMatch(/INSERT INTO omni_tenant_capability_rollouts/i);
    expect(sql).not.toMatch(/GRANT\s+(?:ALL|DELETE|TRUNCATE)\b/i);
  });
});
