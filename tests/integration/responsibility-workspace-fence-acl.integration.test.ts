import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeDatabaseClient, databaseSchemaMigrations, ensureDatabaseSchema } from "@/lib/db/client";
import { verifyResponsibilityWorkspaceFence } from "@/lib/db/responsibility-workspace-fence";
import { applySqlMigrationFile, readSqlMigrationFile } from "@/lib/db/sql-migration-files";
import { removeEmptyProjectTaskCommitmentsForReplay } from "./helpers/native-catalog-replay";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const extraRoles = ["anon", "authenticated", "service_role", "omni_maintenance"] as const;
const files = {
  254: "20261013150000_responsibility_workspace_read_fence.sql",
  255: "20261013160000_responsibility_workspace_fence_acl_repair.sql",
} as const;

databaseDescribe("Responsibility workspace fence default-privilege repair", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 1, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
  });
  afterAll(async () => { await closeDatabaseClient(); await admin?.end(); });

  async function apply(sql: postgres.TransactionSql, version: keyof typeof files) {
    const row = databaseSchemaMigrations.find((migration) => migration.version === version);
    if (!row) throw new Error(`Missing migration ${version}`);
    const migration = await readSqlMigrationFile({ file: files[version], sha256: row.checksum, migrations: [row] });
    const adapter: Parameters<typeof applySqlMigrationFile>[0] = { unsafe: (statement, params) => {
      const values = (params ?? []).map((value) => {
        if (typeof value !== "string") throw new Error("Migration settings must be strings.");
        return value;
      });
      return sql.unsafe<Record<string, unknown>[]>(statement, values);
    } };
    await applySqlMigrationFile(adapter, migration, [row], []);
  }

  async function rollbackFixture(work: (sql: postgres.TransactionSql) => Promise<void>) {
    const rollback = new Error("Rollback isolated workspace fence ACL fixture");
    await expect(admin.begin(async (sql) => {
      await removeEmptyProjectTaskCommitmentsForReplay(sql);
      await work(sql);
      throw rollback;
    })).rejects.toBe(rollback);
    await verifyResponsibilityWorkspaceFence((query, parameters) => admin.unsafe(query, (parameters ?? []) as never[]));
    expect(await admin`SELECT version,name,checksum FROM omni_schema_version WHERE version IS NOT NULL ORDER BY version`)
      .toEqual(databaseSchemaMigrations);
  }

  function catalog(sql: postgres.TransactionSql) {
    return sql`SELECT procedure.oid::text AS oid, pg_get_userbyid(procedure.proowner) AS owner,
      pg_get_functiondef(procedure.oid) AS definition,
      ARRAY(SELECT CASE WHEN privilege.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END
        FROM aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) privilege
        LEFT JOIN pg_roles grantee ON grantee.oid=privilege.grantee
        WHERE privilege.privilege_type='EXECUTE' ORDER BY 1) AS grantees,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) privilege
        JOIN pg_roles grantee ON grantee.oid=privilege.grantee
        WHERE grantee.rolname='omni_runtime' AND privilege.is_grantable) AS runtime_grantable
      FROM pg_proc procedure
      WHERE procedure.oid='public.omni_lock_responsibility_workspace_v1(text,text,text)'::regprocedure`;
  }

  function defaults(sql: postgres.TransactionSql) {
    return sql`SELECT defaclrole::regrole::text AS owner, defaclnamespace, defaclobjtype, defaclacl::text AS acl
      FROM pg_default_acl WHERE defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      ORDER BY defaclnamespace,defaclobjtype`;
  }

  async function expectClosed(sql: postgres.TransactionSql) {
    const [current] = await catalog(sql);
    expect(current.grantees).toEqual([current.owner, "omni_runtime"].sort());
    expect(current.runtime_grantable).toBe(false);
    await verifyResponsibilityWorkspaceFence((query, parameters) => sql.unsafe(query, (parameters ?? []) as never[]));
    expect(await sql`SELECT has_any_column_privilege('omni_runtime','public.omni_tenant_workspaces','UPDATE') AS workspace_update,
      has_any_column_privilege('omni_runtime','public.omni_tenant_workspace_memberships','UPDATE') AS membership_update`)
      .toEqual([{ workspace_update: false, membership_update: false }]);
    return current;
  }

  test("255 closes named grants inherited by 254 without altering defaults, function code or other functions", async () => {
    await rollbackFixture(async (sql) => {
      await sql`DROP FUNCTION public.omni_lock_responsibility_workspace_v1(TEXT,TEXT,TEXT)`;
      await sql`DELETE FROM public.omni_schema_version WHERE version IN (254,255)`;
      for (const role of extraRoles) {
        const [exists] = await sql`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${role}) AS exists`;
        if (!exists.exists) await sql.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      }
      await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role,omni_runtime,omni_maintenance`;
      const defaultPrivileges = await defaults(sql);
      await sql`CREATE FUNCTION public.workspace_acl_unrelated_fixture() RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS 'SELECT TRUE'`;
      const unrelated = await sql`SELECT proacl::text AS acl FROM pg_proc WHERE oid='public.workspace_acl_unrelated_fixture()'::regprocedure`;
      await apply(sql, 254);
      const [before] = await catalog(sql);
      for (const role of extraRoles) expect(before.grantees).toContain(role);
      await expect(verifyResponsibilityWorkspaceFence((query, parameters) => sql.unsafe(query, (parameters ?? []) as never[])))
        .rejects.toThrow("Responsibility workspace read fence does not match this release");

      await apply(sql, 255);
      const after = await expectClosed(sql);
      expect(after.oid).toBe(before.oid);
      expect(after.owner).toBe(before.owner);
      expect(after.definition).toBe(before.definition);
      expect(await defaults(sql)).toEqual(defaultPrivileges);
      expect(await sql`SELECT proacl::text AS acl FROM pg_proc WHERE oid='public.workspace_acl_unrelated_fixture()'::regprocedure`)
        .toEqual(unrelated);

      // Execute as each actual role, rather than trusting only an ACL listing.
      await sql`GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role,omni_runtime,omni_maintenance`;
      for (const role of extraRoles) {
        await expect(sql.savepoint(async (scoped) => {
          await scoped.unsafe(`SET LOCAL ROLE ${role}`);
          await scoped`SELECT public.omni_lock_responsibility_workspace_v1('fixture-tenant','invalid-actor','fixture-workspace')`;
        })).rejects.toMatchObject({ code: "42501" });
      }
      const runtime = await sql.savepoint(async (scoped) => {
        await scoped`SET LOCAL ROLE omni_runtime`;
        const result = await scoped`SELECT current_user AS role,
          public.omni_lock_responsibility_workspace_v1('fixture-tenant','invalid-actor','fixture-workspace') AS allowed`;
        await scoped`SET LOCAL ROLE NONE`;
        return result;
      });
      expect(runtime).toEqual([{ role: "omni_runtime", allowed: false }]);
      expect(await sql`SELECT version FROM public.omni_schema_version WHERE version IN (254,255) ORDER BY version`)
        .toEqual([{ version: 254 }, { version: 255 }]);
    });
  });

  test("255 accepts an already-reconciled 254 catalog without changing its function or permissions", async () => {
    await rollbackFixture(async (sql) => {
      await sql`DELETE FROM public.omni_schema_version WHERE version=255`;
      const before = await expectClosed(sql);
      const defaultPrivileges = await defaults(sql);
      await apply(sql, 255);
      expect(await expectClosed(sql)).toEqual(before);
      expect(await defaults(sql)).toEqual(defaultPrivileges);
      expect(await sql`SELECT count(*)::int AS count FROM public.omni_schema_version WHERE version=255`)
        .toEqual([{ count: 1 }]);
    });
  });

  test("255 removes PUBLIC execution and runtime grant option while keeping scoped runtime calls", async () => {
    await rollbackFixture(async (sql) => {
      await sql`DELETE FROM public.omni_schema_version WHERE version=255`;
      await sql`GRANT EXECUTE ON FUNCTION public.omni_lock_responsibility_workspace_v1(TEXT,TEXT,TEXT) TO PUBLIC`;
      await sql`GRANT EXECUTE ON FUNCTION public.omni_lock_responsibility_workspace_v1(TEXT,TEXT,TEXT) TO omni_runtime WITH GRANT OPTION`;
      const [before] = await catalog(sql);
      expect(before.grantees).toContain("PUBLIC");
      expect(before.runtime_grantable).toBe(true);
      await apply(sql, 255);
      const after = await expectClosed(sql);
      expect(after.oid).toBe(before.oid);
      expect(after.definition).toBe(before.definition);
      await sql`GRANT USAGE ON SCHEMA public TO omni_runtime`;
      const result = await sql.savepoint(async (scoped) => {
        await scoped`SET LOCAL ROLE omni_runtime`;
        const rows = await scoped`SELECT current_user AS role,
          public.omni_lock_responsibility_workspace_v1('fixture-tenant','invalid-actor','fixture-workspace') AS allowed`;
        await scoped`SET LOCAL ROLE NONE`;
        return rows;
      });
      expect(result).toEqual([{ role: "omni_runtime", allowed: false }]);
    });
  });

  test("255 refuses an altered function contract atomically", async () => {
    await rollbackFixture(async (sql) => {
      await sql`DELETE FROM public.omni_schema_version WHERE version=255`;
      await sql`ALTER FUNCTION public.omni_lock_responsibility_workspace_v1(TEXT,TEXT,TEXT) SET search_path=public,pg_catalog`;
      const before = await catalog(sql);
      await expect(sql.savepoint((scoped) => apply(scoped, 255))).rejects.toMatchObject({ cause: { code: "55000" } });
      expect(await catalog(sql)).toEqual(before);
      expect(await sql`SELECT count(*)::int AS count FROM public.omni_schema_version WHERE version=255`)
        .toEqual([{ count: 0 }]);
    });
  });

  test("255 refuses a changed predecessor before changing ACLs", async () => {
    await rollbackFixture(async (sql) => {
      await sql`DELETE FROM public.omni_schema_version WHERE version=255`;
      await sql`UPDATE public.omni_schema_version SET checksum=${"0".repeat(64)} WHERE version=254`;
      const before = await catalog(sql);
      await expect(sql.savepoint((scoped) => apply(scoped, 255))).rejects.toMatchObject({ cause: { code: "55000" } });
      expect(await catalog(sql)).toEqual(before);
      expect(await sql`SELECT count(*)::int AS count FROM public.omni_schema_version WHERE version=255`)
        .toEqual([{ count: 0 }]);
    });
  });
});
