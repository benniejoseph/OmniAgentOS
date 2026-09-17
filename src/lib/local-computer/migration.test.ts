import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260917110000_p13_3_local_computer_runtime.sql",
  import.meta.url,
);

describe("local Computer Use migration", () => {
  it("adds device-bound actor-private routing without a helper credential", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("latest_version IS DISTINCT FROM 178");
    expect(migration).toContain("omni_local_computer_devices");
    expect(migration).toContain("omni_local_computer_sessions");
    expect(migration).toContain("omni_local_computer_commands");
    expect(migration).toContain("native_contract_version >= 11");
    expect(migration).toContain("input_sha256 TEXT NOT NULL");
    expect(migration).not.toContain("input JSONB NOT NULL");
    expect(migration).toContain("pg_column_size(result) <= 2097152");
    expect(migration).toContain("omni_local_computer_commands_actor_scope");
    expect(migration).toContain("VALUES (\n  179,\n  'p13_3_local_computer_runtime_v1'");
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });
});
