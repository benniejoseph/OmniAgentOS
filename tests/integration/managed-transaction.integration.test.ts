import postgres from "postgres";
import type { SqlClient } from "@/lib/db/sql-types";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";

function inTransaction<T>(work: (sql: SqlClient) => Promise<T>): Promise<T> {
  return getSql().transaction(work) as Promise<T>;
}

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;

databaseDescribe("managed adoption on an actual one-connection pool", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await closeDatabaseClient();
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    admin = postgres(databaseUrl!, { max: 1, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    // Test-only table in the guarded disposable schema; production schema and
    // migrations are unchanged. Actual FORCE RLS runs as the serving role.
    await admin`CREATE TABLE atlas_transaction_probe (id text PRIMARY KEY, tenant_id text NOT NULL, actor_id text NOT NULL)`;
    await admin`ALTER TABLE atlas_transaction_probe ENABLE ROW LEVEL SECURITY`;
    await admin`ALTER TABLE atlas_transaction_probe FORCE ROW LEVEL SECURITY`;
    await admin`CREATE POLICY scoped_probe ON atlas_transaction_probe USING (
      tenant_id = current_setting('omni.tenant_id', true) AND
      public.omni_actor_scope_v1_allows_validated(public.omni_current_actor_scope_v1(), tenant_id, actor_id)
    ) WITH CHECK (
      tenant_id = current_setting('omni.tenant_id', true) AND
      public.omni_actor_scope_v1_allows_validated(public.omni_current_actor_scope_v1(), tenant_id, actor_id)
    )`;
    await admin`GRANT SELECT, INSERT ON atlas_transaction_probe TO omni_runtime`;
    await admin`INSERT INTO atlas_transaction_probe VALUES
      ('owner-row','tenant-a','owner'),('alias-row','tenant-a','validated-alias'),
      ('foreign-actor','tenant-a','other'),('foreign-tenant','tenant-b','owner')`;
  });
  afterAll(async () => { await closeDatabaseClient(); await admin?.end(); vi.unstubAllEnvs(); });

  test("serializes narrowed RLS reads and nested writes on the same backend, restoring parent scope", async () => {
    const observed = await runWithDatabaseActorScope("tenant-a", ["owner", "validated-alias"], () => inTransaction(async (sql) => {
      await sql`SET LOCAL ROLE omni_runtime`;
      const [outer] = await sql`SELECT pg_backend_pid() AS pid, current_user AS role`;
      const reads = await runWithManagedDatabaseTransaction(sql, async () => Promise.all(
        ["owner", "validated-alias"].map((actor) => runWithDatabaseActorScope("tenant-a", [actor], () => inTransaction(async (nested) => {
          const [backend] = await nested`SELECT pg_backend_pid() AS pid, pg_sleep(0.01)`;
          const rows = await getSql()`SELECT id,actor_id FROM atlas_transaction_probe ORDER BY id`;
          await nested`INSERT INTO atlas_transaction_probe VALUES (${`committed-${actor}`},'tenant-a',${actor})`;
          return { actor, pid: backend.pid, rows };
        }))),
      ));
      const after = await sql`SELECT id FROM atlas_transaction_probe ORDER BY id`;
      return { outer, reads, after };
    }));
    expect(observed.outer.role).toBe("omni_runtime");
    for (const read of observed.reads) {
      expect(read.pid).toBe(observed.outer.pid);
      expect(read.rows).toHaveLength(1);
      expect(read.rows[0].actor_id).toBe(read.actor);
    }
    expect(observed.after.map((row) => row.id)).toEqual(["alias-row", "committed-owner", "committed-validated-alias", "owner-row"]);
    expect(await admin`SELECT id FROM atlas_transaction_probe WHERE id LIKE 'committed-%'`).toHaveLength(2);
  });

  test("a caught falsy nested failure rolls back the owner write and releases the only connection", async () => {
    await expect(runWithDatabaseActorScope("tenant-a", ["owner"], () => inTransaction(async (sql) => {
      await sql`SET LOCAL ROLE omni_runtime`;
      await sql`INSERT INTO atlas_transaction_probe VALUES ('rolled-back','tenant-a','owner')`;
      try {
        await runWithManagedDatabaseTransaction(sql, async () => {
          try { await inTransaction(() => Promise.reject(null)); } catch { /* Owner must still roll back. */ }
        });
      } catch { /* Catching the rejection grants no commit authority. */ }
    }))).rejects.toBeNull();
    expect(await admin`SELECT id FROM atlas_transaction_probe WHERE id = 'rolled-back'`).toHaveLength(0);
    const rows = await runWithDatabaseActorScope("tenant-a", ["owner"], () => inTransaction(async (sql) => {
      await sql`SET LOCAL ROLE omni_runtime`;
      return sql`SELECT id FROM atlas_transaction_probe ORDER BY id`;
    }));
    expect(rows.map((row) => row.id)).toEqual(["committed-owner", "owner-row"]);
  });

  test("caught wider scope and extra memory installers cannot commit prior work", async () => {
    for (const attempt of [
      () => runWithDatabaseActorScope("tenant-a", ["other"], () => getSql()`SELECT id FROM atlas_transaction_probe`),
      () => getSql()`SELECT set_config('omni.memory_access_scope_v1','{}',true)`,
    ]) {
      await expect(runWithDatabaseActorScope("tenant-a", ["owner"], () => inTransaction(async (sql) => {
        await sql`SET LOCAL ROLE omni_runtime`;
        await sql`INSERT INTO atlas_transaction_probe VALUES ('forbidden-commit','tenant-a','owner')`;
        try { await runWithManagedDatabaseTransaction(sql, attempt); } catch { /* Poison survives catch. */ }
      }))).rejects.toBeDefined();
      expect(await admin`SELECT id FROM atlas_transaction_probe WHERE id = 'forbidden-commit'`).toHaveLength(0);
    }
  });
});
