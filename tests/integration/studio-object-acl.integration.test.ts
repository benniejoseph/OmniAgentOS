/**
 * Opt-in PostgreSQL proof of the Studio ACL repair. Use an empty schema-only
 * database: no application rows are copied, and each fixture rolls back.
 */
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  applySqlMigrationFile,
  readSqlMigrationFile,
  type SqlMigrationLedgerRow,
} from "@/lib/db/sql-migration-files";

type ManifestRow = SqlMigrationLedgerRow & { file?: string; sha256?: string };
type AclRow = {
  object_name: string;
  grantee: string;
  privilege: string;
  grantable: boolean;
};
const enabled = process.env.ASAEL_STUDIO_ACL_DATABASE === "1";
const candidate = enabled ? describe : describe.skip;
const tables = [
  "omni_studio_budget_reservations",
  "omni_studio_records",
  "omni_studio_run_events",
] as const;
const roles = [
  "anon", "authenticated", "service_role", "omni_runtime",
  "omni_maintenance", "omni_backup", "studio_acl_delegate_fixture",
  "studio_acl_column_fixture",
] as const;
const tenant = "studio-acl-fixture";
const actor = "actor:00000000-0000-4000-8000-000000000001";
let manifest: ManifestRow[];

async function apply(sql: postgres.TransactionSql, version: 261 | 262) {
  const row = manifest.find((entry) => entry.version === version);
  if (!row?.file || !row.sha256) throw new Error(`Missing migration ${version}`);
  const migration = await readSqlMigrationFile({
    file: row.file, sha256: row.sha256, migrations: [row],
  });
  const adapter: Parameters<typeof applySqlMigrationFile>[0] = {
    unsafe: (statement, params) => sql.unsafe<Record<string, unknown>[]>(
      statement,
      (params ?? []).map((value) => {
        if (typeof value !== "string") throw new Error("Migration settings must be strings.");
        return value;
      }),
    ),
  };
  await applySqlMigrationFile(adapter, migration, [row], []);
}

test("Studio 262 is an additive, checksum-pinned migration after unchanged 261", async () => {
  manifest = JSON.parse(await readFile("schema-migrations.json", "utf8"));
  const predecessor = manifest.find((entry) => entry.version === 261)!;
  expect(predecessor.checksum).toBe("4c7759ec2b4a57d0a85f9470292cdfa810e2b20c570b73c61b4ddcda3698c6e5");
  for (const version of [261, 262]) {
    const row = manifest.find((entry) => entry.version === version)!;
    const file = await readSqlMigrationFile({ file: row.file!, sha256: row.sha256!, migrations: [row] });
    expect(file.ledger).toEqual([{ version, name: row.name, checksum: row.checksum }]);
    expect(file.statements.some((statement) => /ALTER\s+DEFAULT\s+PRIVILEGES/i.test(statement))).toBe(false);
  }
});

candidate("Studio object ACL forward repair", () => {
  let admin: ReturnType<typeof postgres>;
  let baselineVersion: number;

  beforeAll(async () => {
    manifest = JSON.parse(await readFile("schema-migrations.json", "utf8"));
    const address = process.env.ASAEL_STUDIO_ACL_DATABASE_URL;
    if (!address) throw new Error("Set ASAEL_STUDIO_ACL_DATABASE_URL for the isolated test.");
    const url = new URL(address);
    if (url.hostname !== "127.0.0.1" ||
      !/^\/asael_studio_acl_[a-z0-9_]+$/.test(url.pathname) ||
      url.searchParams.get("sslmode") !== "disable") {
      throw new Error("Only an explicitly named disposable loopback ACL database is allowed.");
    }
    admin = postgres(address, { max: 1, prepare: false, ssl: false, onnotice: () => undefined });
    const [identity] = await admin`SELECT current_database() AS database, rolsuper
      FROM pg_roles WHERE rolname=current_user`;
    expect(identity.rolsuper).toBe(true);
    for (const table of tables) {
      const [count] = await admin.unsafe(`SELECT count(*)::int AS count FROM public.${table}`);
      expect(count.count).toBe(0);
    }
    const [ledger] = await admin`SELECT max(version) AS version FROM public.omni_schema_version`;
    if (ledger.version === null) {
      // Schema-only clones intentionally contain no rows. Seed only the trusted
      // migration ledger, never copied auth, workspace, flow or provider records.
      await admin.begin(async (sql) => {
        for (const row of manifest.filter((entry) => entry.version <= 261)) {
          await sql`INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
            VALUES(${row.version},${row.name},${row.checksum},clock_timestamp())`;
        }
      });
    } else {
      expect([261, 262]).toContain(ledger.version);
    }
    baselineVersion = ledger.version ?? 261;
  });

  afterAll(async () => { await admin?.end(); });

  async function fixture(work: (sql: postgres.TransactionSql) => Promise<void>) {
    const rollback = new Error("Rollback isolated Studio ACL fixture");
    await expect(admin.begin(async (sql) => {
      await sql`SET LOCAL lock_timeout='3s'`;
      await sql`SET LOCAL statement_timeout='15s'`;
      await sql`SELECT set_config('omni.system_scope','true',true),
        set_config('omni.system_reason','isolated Studio ACL regression',true)`;
      await work(sql);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await admin`SELECT max(version) AS version FROM public.omni_schema_version`)
      .toEqual([{ version: baselineVersion }]);
    for (const table of tables) {
      expect(await admin.unsafe(`SELECT count(*)::int AS count FROM public.${table}`))
        .toEqual([{ count: 0 }]);
    }
  }

  async function recreate261(sql: postgres.TransactionSql, hostile: boolean) {
    for (const role of roles) {
      const [found] = await sql`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${role}) AS exists`;
      if (!found.exists) await sql.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    }
    await sql`GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role,omni_runtime,
      omni_maintenance,omni_backup,studio_acl_delegate_fixture,studio_acl_column_fixture`;
    await sql`DROP TABLE public.omni_studio_budget_reservations,public.omni_studio_records,
      public.omni_studio_run_events`;
    await sql`DROP FUNCTION public.omni_protect_studio_record_v1(),
      public.omni_studio_authority_v1(TEXT,TEXT,TEXT,TEXT),
      public.omni_studio_budget_totals_v1(TEXT,TEXT,TIMESTAMPTZ)`;
    await sql`DELETE FROM public.omni_schema_version WHERE version>=261`;
    for (const namespace of ["", "IN SCHEMA public"]) {
      for (const objectType of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
        await sql.unsafe(`ALTER DEFAULT PRIVILEGES ${namespace} REVOKE ALL ON ${objectType}
          FROM PUBLIC,${roles.join(",")} CASCADE`);
      }
    }
    if (hostile) {
      for (const objectType of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
        await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ${objectType}
          TO anon,authenticated,service_role,omni_runtime,omni_maintenance,omni_backup WITH GRANT OPTION`);
      }
    }
    await apply(sql, 261);
  }

  function defaults(sql: postgres.TransactionSql) {
    return sql`SELECT defaclrole::text AS owner,defaclnamespace::text AS namespace,
      defaclobjtype,defaclacl::text AS acl FROM pg_default_acl ORDER BY 1,2,3`;
  }

  async function structure(sql: postgres.TransactionSql) {
    return {
      relations: await sql`SELECT oid::text AS oid,relname,relowner::text AS owner,relkind,
        relrowsecurity,relforcerowsecurity,relreplident FROM pg_class
        WHERE oid IN ('public.omni_studio_records'::regclass,
          'public.omni_studio_run_events'::regclass,'public.omni_studio_budget_reservations'::regclass,
          'public.omni_studio_run_events_seq_seq'::regclass) ORDER BY relname`,
      columns: await sql`SELECT relation.relname,attribute.attnum,attribute.attname,
        attribute.atttypid::text,attribute.atttypmod,attribute.attnotnull,
        pg_get_expr(value.adbin,value.adrelid) AS default_value
        FROM pg_class relation JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
        LEFT JOIN pg_attrdef value ON value.adrelid=relation.oid AND value.adnum=attribute.attnum
        WHERE relation.oid IN ('public.omni_studio_records'::regclass,
          'public.omni_studio_run_events'::regclass,'public.omni_studio_budget_reservations'::regclass)
          AND attribute.attnum>0 AND NOT attribute.attisdropped ORDER BY 1,2`,
      constraints: await sql`SELECT conrelid::regclass::text AS relation,conname,
        pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN
        ('public.omni_studio_records'::regclass,'public.omni_studio_run_events'::regclass,
          'public.omni_studio_budget_reservations'::regclass) ORDER BY 1,2`,
      indexes: await sql`SELECT indexrelid::text AS oid,pg_get_indexdef(indexrelid) AS definition
        FROM pg_index WHERE indrelid IN ('public.omni_studio_records'::regclass,
          'public.omni_studio_run_events'::regclass,'public.omni_studio_budget_reservations'::regclass)
        ORDER BY indexrelid`,
      policies: await sql`SELECT polrelid::regclass::text AS relation,polname,polcmd,polpermissive,
        polroles::text,pg_get_expr(polqual,polrelid) AS using_expression,
        pg_get_expr(polwithcheck,polrelid) AS check_expression FROM pg_policy WHERE polrelid IN
        ('public.omni_studio_records'::regclass,'public.omni_studio_run_events'::regclass,
          'public.omni_studio_budget_reservations'::regclass) ORDER BY 1,2`,
      functions: await sql`SELECT oid::text AS oid,proname,proowner::text AS owner,
        pg_get_functiondef(oid) AS definition FROM pg_proc WHERE oid IN
        ('public.omni_protect_studio_record_v1()'::regprocedure,
          'public.omni_studio_authority_v1(TEXT,TEXT,TEXT,TEXT)'::regprocedure,
          'public.omni_studio_budget_totals_v1(TEXT,TEXT,TIMESTAMPTZ)'::regprocedure) ORDER BY proname`,
      trigger: await sql`SELECT oid::text AS oid,pg_get_triggerdef(oid) AS definition,tgenabled
        FROM pg_trigger WHERE tgrelid='public.omni_studio_records'::regclass AND NOT tgisinternal`,
      sequence: await sql`SELECT last_value::text,is_called FROM public.omni_studio_run_events_seq_seq`,
    };
  }

  function acl(sql: postgres.TransactionSql) {
    return sql<AclRow[]>`SELECT relation.relname AS object_name,COALESCE(role.rolname,'PUBLIC') AS grantee,
      privilege.privilege_type AS privilege,privilege.is_grantable AS grantable
      FROM pg_class relation CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,
        acldefault(CASE WHEN relation.relkind='S' THEN 's' ELSE 'r' END::"char",relation.relowner))) privilege
      LEFT JOIN pg_roles role ON role.oid=privilege.grantee
      WHERE relation.oid IN ('public.omni_studio_records'::regclass,
        'public.omni_studio_run_events'::regclass,'public.omni_studio_budget_reservations'::regclass,
        'public.omni_studio_run_events_seq_seq'::regclass) AND privilege.grantee<>relation.relowner
      UNION ALL SELECT procedure.proname,COALESCE(role.rolname,'PUBLIC'),privilege.privilege_type,
        privilege.is_grantable FROM pg_proc procedure
        CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) privilege
        LEFT JOIN pg_roles role ON role.oid=privilege.grantee
        WHERE procedure.oid IN ('public.omni_protect_studio_record_v1()'::regprocedure,
          'public.omni_studio_authority_v1(TEXT,TEXT,TEXT,TEXT)'::regprocedure,
          'public.omni_studio_budget_totals_v1(TEXT,TEXT,TIMESTAMPTZ)'::regprocedure)
          AND privilege.grantee<>procedure.proowner ORDER BY 1,2,3`;
  }

  async function expectClosed(sql: postgres.TransactionSql) {
    const expected: AclRow[] = [];
    for (const table of tables) {
      for (const role of ["omni_runtime", "omni_maintenance", "omni_backup"]) {
        const privileges = role === "omni_backup" ? ["SELECT"]
          : table === "omni_studio_records" ? ["SELECT", "INSERT", "UPDATE"] : ["SELECT", "INSERT"];
        for (const privilege of privileges) expected.push({ object_name: table, grantee: role, privilege, grantable: false });
      }
    }
    for (const role of ["omni_runtime", "omni_maintenance", "omni_backup"]) {
      for (const privilege of role === "omni_backup" ? ["SELECT"] : ["SELECT", "USAGE"]) {
        expected.push({ object_name: "omni_studio_run_events_seq_seq", grantee: role, privilege, grantable: false });
      }
    }
    for (const fn of ["omni_studio_authority_v1", "omni_studio_budget_totals_v1"]) {
      expected.push({ object_name: fn, grantee: "omni_runtime", privilege: "EXECUTE", grantable: false });
    }
    const key = (row: typeof expected[number]) => `${row.object_name}:${row.grantee}:${row.privilege}`;
    expect((await acl(sql)).map((row) => ({ ...row })).sort((a,b) => key(a).localeCompare(key(b))))
      .toEqual(expected.sort((a,b) => key(a).localeCompare(key(b))));
    expect(await sql`SELECT count(*)::int AS count FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid=attribute.attrelid
      CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
      WHERE relation.oid IN ('public.omni_studio_records'::regclass,
        'public.omni_studio_run_events'::regclass,'public.omni_studio_budget_reservations'::regclass)
        AND privilege.grantee<>relation.relowner`).toEqual([{ count: 0 }]);
    for (const role of ["anon", "authenticated", "service_role", "studio_acl_delegate_fixture", "studio_acl_column_fixture"]) {
      expect(await sql`SELECT has_any_column_privilege(${role},'public.omni_studio_records','SELECT,INSERT,UPDATE,REFERENCES') AS record,
        has_sequence_privilege(${role},'public.omni_studio_run_events_seq_seq','SELECT,USAGE,UPDATE') AS sequence,
        has_function_privilege(${role},'public.omni_protect_studio_record_v1()','EXECUTE') AS trigger`)
        .toEqual([{ record: false, sequence: false, trigger: false }]);
    }
  }

  async function seedRows(sql: postgres.TransactionSql) {
    await sql`INSERT INTO public.omni_studio_records(tenant_id,actor_id,kind,id,state,body)
      VALUES(${tenant},${actor},'flow','flow-fixture','active','{"value":{"name":"Keep this flow"}}')`;
    await sql`INSERT INTO public.omni_studio_run_events(tenant_id,actor_id,run_id,type,message)
      VALUES(${tenant},${actor},'run-fixture','run.accepted','Preserve this event')`;
    await sql`INSERT INTO public.omni_studio_budget_reservations(tenant_id,reservation_id,maximum_microusd)
      VALUES(${tenant},${"1".repeat(64)},2500000)`;
  }

  async function rows(sql: postgres.TransactionSql) {
    return {
      records: await sql`SELECT * FROM public.omni_studio_records ORDER BY id`,
      events: await sql`SELECT * FROM public.omni_studio_run_events ORDER BY seq`,
      budget: await sql`SELECT * FROM public.omni_studio_budget_reservations ORDER BY reservation_id`,
    };
  }

  async function runtimePermissionProof(sql: postgres.TransactionSql) {
    const [runtime] = await sql`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='omni_runtime'`;
    expect(runtime).toEqual({ rolsuper: false, rolbypassrls: false });
    await sql.savepoint(async (scoped) => {
      await scoped`SET LOCAL ROLE omni_runtime`;
      await scoped`SELECT set_config('omni.system_scope','false',true),
        set_config('omni.tenant_id',${tenant},true),set_config('omni.actor_scope_v1',
          ${JSON.stringify({ version: 1, tenantId: tenant, actorIds: [actor] })},true)`;
      expect(await scoped`SELECT id FROM public.omni_studio_records`).toEqual([{ id: "flow-fixture" }]);
      await scoped`UPDATE public.omni_studio_records SET state='archived' WHERE id='flow-fixture'`;
      await scoped`INSERT INTO public.omni_studio_run_events(tenant_id,actor_id,run_id,type,message)
        VALUES(${tenant},${actor},'run-runtime','run.started','Runtime append succeeds')`;
      for (const statement of [
        "DELETE FROM public.omni_studio_records",
        "UPDATE public.omni_studio_run_events SET message='changed'",
        "DELETE FROM public.omni_studio_run_events",
        "UPDATE public.omni_studio_budget_reservations SET maximum_microusd=0",
        "DELETE FROM public.omni_studio_budget_reservations",
        "TRUNCATE public.omni_studio_records",
        "SELECT setval('public.omni_studio_run_events_seq_seq',999)",
      ]) {
        await expect(scoped.savepoint((denied) => denied.unsafe(statement)))
          .rejects.toMatchObject({ code: "42501" });
      }
      await scoped`SELECT set_config('omni.tenant_id','different-tenant',true)`;
      expect(await scoped`SELECT id FROM public.omni_studio_records`).toEqual([]);
      await scoped`SET LOCAL ROLE NONE`;
    });
  }

  test("262 preserves a clean populated 261 schema and permits only scoped runtime work", async () => {
    await fixture(async (sql) => {
      await recreate261(sql, false);
      await seedRows(sql);
      const before = await structure(sql), saved = await rows(sql), defaultPrivileges = await defaults(sql);
      await apply(sql, 262);
      await expectClosed(sql);
      expect(await structure(sql)).toEqual(before);
      expect(await rows(sql)).toEqual(saved);
      expect(await defaults(sql)).toEqual(defaultPrivileges);
      await runtimePermissionProof(sql);
    });
  });

  test("262 reproduces and removes inherited provider, maintenance, sequence and trigger grants", async () => {
    await fixture(async (sql) => {
      await recreate261(sql, true);
      // These effective privileges reproduce the production catalog mismatch.
      expect(await sql`SELECT has_table_privilege('anon','public.omni_studio_records','TRUNCATE') AS provider_truncate,
        has_table_privilege('omni_runtime','public.omni_studio_records','DELETE') AS runtime_delete,
        has_table_privilege('omni_maintenance','public.omni_studio_run_events','UPDATE') AS event_update,
        has_table_privilege('omni_runtime','public.omni_studio_budget_reservations','UPDATE') AS budget_update,
        has_sequence_privilege('omni_runtime','public.omni_studio_run_events_seq_seq','UPDATE') AS sequence_update,
        has_function_privilege('authenticated','public.omni_protect_studio_record_v1()','EXECUTE') AS trigger_execute,
        has_function_privilege('authenticated','public.omni_studio_authority_v1(TEXT,TEXT,TEXT,TEXT)','EXECUTE') AS authority_execute`)
        .toEqual([{ provider_truncate: true, runtime_delete: true, event_update: true,
          budget_update: true, sequence_update: true, trigger_execute: true, authority_execute: false }]);
      // Independent column grants and delegated grant options must not survive
      // a table-only REVOKE, or be restored by a later inherited permission.
      await sql`GRANT SELECT(body),UPDATE(state) ON public.omni_studio_records
        TO studio_acl_column_fixture WITH GRANT OPTION`;
      await sql`GRANT SELECT(body) ON public.omni_studio_records TO PUBLIC`;
      await sql`SET LOCAL ROLE anon`;
      await sql`GRANT DELETE ON public.omni_studio_records TO studio_acl_delegate_fixture WITH GRANT OPTION`;
      await sql`GRANT UPDATE ON public.omni_studio_run_events_seq_seq TO studio_acl_delegate_fixture`;
      await sql`GRANT EXECUTE ON FUNCTION public.omni_protect_studio_record_v1() TO studio_acl_delegate_fixture`;
      await sql`SET LOCAL ROLE NONE`;
      await sql`CREATE TABLE public.studio_acl_unrelated_fixture(id INTEGER)`;
      const unrelated = await sql`SELECT relacl::text AS acl FROM pg_class WHERE oid='public.studio_acl_unrelated_fixture'::regclass`;
      await seedRows(sql);
      const before = await structure(sql), saved = await rows(sql), defaultPrivileges = await defaults(sql);
      await apply(sql, 262);
      await expectClosed(sql);
      expect(await structure(sql)).toEqual(before);
      expect(await rows(sql)).toEqual(saved);
      expect(await defaults(sql)).toEqual(defaultPrivileges);
      expect(await sql`SELECT relacl::text AS acl FROM pg_class WHERE oid='public.studio_acl_unrelated_fixture'::regclass`)
        .toEqual(unrelated);
      await runtimePermissionProof(sql);
    });
  });

  test("262 accepts an already reconciled 261 ACL without changing the contract", async () => {
    await fixture(async (sql) => {
      await recreate261(sql, true);
      await apply(sql, 262);
      await sql`DELETE FROM public.omni_schema_version WHERE version=262`;
      const before = await structure(sql), permissions = await acl(sql);
      await apply(sql, 262);
      expect(await structure(sql)).toEqual(before);
      expect(await acl(sql)).toEqual(permissions);
      await expectClosed(sql);
    });
  });

  test("262 rejects a changed predecessor atomically", async () => {
    await fixture(async (sql) => {
      await recreate261(sql, true);
      await sql`UPDATE public.omni_schema_version SET checksum=${"0".repeat(64)} WHERE version=261`;
      const before = await acl(sql);
      await expect(sql.savepoint((scoped) => apply(scoped, 262)))
        .rejects.toMatchObject({ cause: { code: "55000" } });
      expect(await acl(sql)).toEqual(before);
      expect(await sql`SELECT count(*)::int AS count FROM public.omni_schema_version WHERE version=262`)
        .toEqual([{ count: 0 }]);
    });
  });

  test.each([
    ["search path", "ALTER FUNCTION public.omni_protect_studio_record_v1() SET search_path=public,pg_catalog"],
    ["function body", "CREATE OR REPLACE FUNCTION public.omni_protect_studio_record_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$BEGIN RETURN NEW; END$$"],
    ["forced RLS", "ALTER TABLE public.omni_studio_records NO FORCE ROW LEVEL SECURITY"],
  ])("262 rejects an altered %s before changing ACLs", async (_name, mutation) => {
    await fixture(async (sql) => {
      await recreate261(sql, true);
      await sql.unsafe(mutation);
      const before = await acl(sql);
      await expect(sql.savepoint((scoped) => apply(scoped, 262)))
        .rejects.toMatchObject({ cause: { code: "55000" } });
      expect(await acl(sql)).toEqual(before);
      expect(await sql`SELECT count(*)::int AS count FROM public.omni_schema_version WHERE version=262`)
        .toEqual([{ count: 0 }]);
    });
  });
});
