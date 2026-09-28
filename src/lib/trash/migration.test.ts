import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("P9.3 trash migration", () => {
  it("preserves the exact governed request actor instead of requiring a canonical auth-user ID", async () => {
    const migration = await readFile(
      new URL("../../../supabase/migrations/20260907090000_p9_3_trash_lifecycle.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("owner_actor_id TEXT NOT NULL");
    expect(migration).toContain(
      "omni_actor_scope_v1_allows(tenant_id, owner_actor_id)",
    );
    expect(migration).not.toMatch(
      /FOREIGN KEY \(owner_actor_id\)\s+REFERENCES omni_auth_users \(actor_id\)/,
    );
  });
});
