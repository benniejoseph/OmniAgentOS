import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("P9.3 trash migration", () => {
  it("preserves the exact governed request actor instead of requiring a canonical auth-user ID", async () => {
    const migration = await readFile(
      new URL("../../../supabase/migrations/20260907090000_p9_3_trash_lifecycle.sql", import.meta.url),
      "utf8",
    );
    const databaseClient = await readFile(
      new URL("../db/client.ts", import.meta.url),
      "utf8",
    );
    const embeddedMigration = extractEmbeddedMigration(
      databaseClient,
      "ensureTrashLifecycleV1",
    );

    expect(migration).toContain("owner_actor_id TEXT NOT NULL");
    expect(migration).toContain(
      "omni_actor_scope_v1_allows(tenant_id, owner_actor_id)",
    );
    expect(migration).not.toMatch(
      /FOREIGN KEY \(owner_actor_id\)\s+REFERENCES omni_auth_users \(actor_id\)/,
    );
    expect(embeddedMigration).not.toMatch(
      /FOREIGN KEY \(owner_actor_id\)\s+REFERENCES omni_auth_users \(actor_id\)/,
    );
  });
});

function extractEmbeddedMigration(source: string, functionName: string) {
  const start = source.indexOf(`async function ${functionName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}
