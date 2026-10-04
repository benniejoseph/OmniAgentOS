import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";
import { removeEmptyResponsibilityRuntimeForReplay } from "./helpers/responsibility-replay";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closeDatabaseClient, ensureDatabaseSchema } from "@/lib/db/client";
import { applySqlMigrationFile, parseSqlMigrationFile, splitSqlStatements } from "@/lib/db/sql-migration-files";

const databaseUrl = process.env.DATABASE_URL;
const resetAllowed = process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true";
const databaseDescribe = databaseUrl && resetAllowed ? describe : describe.skip;
// Local runs opt in with matching client tools. Required CI uses its pinned
// PG17 service container and fails instead of skipping if neither is supplied.
const pgBin = process.env.OMNIAGENT_INTEGRATION_PG_BIN;
const pgContainer = process.env.OMNIAGENT_INTEGRATION_PG_CONTAINER;
const requirePlainRestore = process.env.CI === "true";
const manifest = JSON.parse(fs.readFileSync("schema-migrations.json", "utf8")) as Array<{
  version: number; name: string; checksum: string; file?: string;
}>;
const registeredMarkers = manifest.map(({ version, name, checksum }) => ({ version, name, checksum }));
const migration = (version: number) => {
  const row = manifest.find((item) => item.version === version)!;
  const source = fs.readFileSync(path.join("supabase/migrations", row.file!), "utf8");
  return { row, source, parsed: parseSqlMigrationFile(row.file!, source) };
};
const validation = migration(214);
const targets = [...validation.source.matchAll(
  /\('(omni_\w+)',\n +'(omni_\w+)',\n +'((?:[^']|'')*)'\)/g,
)].map(([, table, name, definition]) => ({
  table, name, definition: definition.replaceAll("''", "'"),
}));
// Reparse the original BETWEEN syntax: PostgreSQL flattens a literal nested
// AND on input, whereas BETWEEN's generated AND retains its tree grouping.
const fixtureDefinition = (name: string, definition: string) =>
  name === "omni_mobile_push_deliveries_deep_link_check"
    ? "CHECK (char_length(deep_link) BETWEEN 2 AND 1000 AND left(deep_link, 1) = '/')"
    : definition;
const signatures = [
  "public.omni_source_id_array_is_canonical(text[],integer)",
  "public.omni_jsonb_safe_integer_value(jsonb)",
  "public.omni_evidence_locator_v1_is_allowlisted(jsonb)",
];
const locators = [
  { kind: "text_span", offsetUnit: "unicode_code_point", startOffset: 0,
    endOffsetExclusive: 8, containerLength: 8, containerSha256: "a".repeat(64) },
  { kind: "page", pageNumber: 2, pageCount: 3 },
  { kind: "sheet_range", sheetKeySha256: "a".repeat(64), startRow: 1,
    endRowExclusive: 3, startColumn: 1, endColumnExclusive: 2,
    sheetRowCount: 2, sheetColumnCount: 1 },
  { kind: "slide", slideNumber: 2, slideCount: 3, elementKeySha256: null },
  { kind: "email_section", section: "body", sectionIndex: 0, partKeySha256: null },
  { kind: "image_region", coordinateUnit: "pixel", x: 1, y: 2,
    width: 5, height: 6, imageWidth: 10, imageHeight: 10 },
  { kind: "media_time_range", mediaKind: "audio", startMilliseconds: 0,
    endMillisecondsExclusive: 100, durationMilliseconds: 200 },
];
type Transaction = postgres.TransactionSql;

async function apply(transaction: Transaction, version: number) {
  const { row, parsed } = migration(version);
  await applySqlMigrationFile({
    unsafe: (text, params) => transaction.unsafe(
      text, params as Parameters<Transaction["unsafe"]>[1],
    ),
  }, parsed, [row], []);
}
async function rollbackOnly(admin: ReturnType<typeof postgres>, operation: (transaction: Transaction) => Promise<void>) {
  const rollback = new Error("rollback synthetic migration fixture");
  await expect(admin.begin(async (transaction) => {
    await operation(transaction);
    throw rollback;
  })).rejects.toBe(rollback);
}

// These historical fixtures always roll back. Remove the exact later additive
// schema together with its ledger so the target migration sees its predecessor.
// Never make production CREATE statements idempotent to accommodate a fixture.
// The ledger follows the manifest; new physical additions still need reviewed
// teardown here before their marker can be removed from a historical fixture.
async function prepareHistoricalReplay(transaction: Transaction, version: 213 | 214) {
  expect(await transaction`
    SELECT version, name, checksum FROM public.omni_schema_version
    WHERE version IS NOT NULL ORDER BY version
  `).toEqual(registeredMarkers);
  if (manifest.some((migration) => migration.version === 221)) {
    expect(await transaction`
      SELECT count(*)::int AS populated_intents
      FROM public.omni_customer_account_revisions
      WHERE request_intent IS NOT NULL OR request_sha256 IS NOT NULL
    `).toEqual([{ populated_intents: 0 }]);
    await transaction`
      ALTER TABLE public.omni_customer_account_revisions
        DROP CONSTRAINT omni_customer_account_exact_intent,
        DROP COLUMN request_intent,
        DROP COLUMN request_sha256
    `;
  }
  await removeEmptyResponsibilityRuntimeForReplay(transaction);
  expect(await transaction`
    SELECT (SELECT count(*)::int FROM public.omni_responsibility_observations) AS observations,
      (SELECT count(*)::int FROM public.omni_responsibility_baselines) AS baselines,
      (SELECT count(*)::int FROM public.omni_responsibility_changes) AS changes
  `).toEqual([{ observations: 0, baselines: 0, changes: 0 }]);
  await transaction`DROP TABLE public.omni_responsibility_changes`;
  await transaction`DROP TABLE public.omni_responsibility_baselines`;
  await transaction`DROP TABLE public.omni_responsibility_observations`;
  await transaction`DROP FUNCTION public.omni_require_responsibility_observation_commit_v1()`;
  await transaction`DROP FUNCTION public.omni_protect_responsibility_changes_v1()`;
  await transaction`DROP FUNCTION public.omni_protect_responsibility_baselines_v1()`;
  await transaction`DROP FUNCTION public.omni_protect_responsibility_observations_v1()`;
  expect(await transaction`
    SELECT (SELECT count(*)::int FROM public.omni_responsibilities) AS drafts,
      (SELECT count(*)::int FROM public.omni_responsibility_mutations) AS receipts
  `).toEqual([{ drafts: 0, receipts: 0 }]);
  await transaction`DROP TABLE public.omni_responsibility_mutations`;
  await transaction`DROP TABLE public.omni_responsibilities`;
  await transaction`DROP FUNCTION public.omni_require_responsibility_receipt_v1()`;
  await transaction`DROP FUNCTION public.omni_protect_responsibility_mutations_v1()`;
  await transaction`DROP FUNCTION public.omni_protect_responsibility_drafts_v1()`;
  expect(await transaction`
    SELECT
      (SELECT count(*)::int FROM public.omni_companion_preferences) AS preferences,
      (SELECT count(*)::int FROM public.omni_companion_preference_mutations) AS receipts
  `).toEqual([{ preferences: 0, receipts: 0 }]);
  await transaction`DROP TABLE public.omni_companion_preference_mutations`;
  await transaction`DROP TABLE public.omni_companion_preferences`;
  await transaction`DROP FUNCTION public.omni_protect_companion_preference_mutations_v1()`;
  await transaction`DROP FUNCTION public.omni_protect_companion_preferences_v1()`;
  await transaction`DELETE FROM public.omni_schema_version WHERE version >= ${version}`;
  expect(await transaction`
    SELECT max(version)::int AS latest FROM public.omni_schema_version
  `).toEqual([{ latest: version - 1 }]);
}

function runPostgresTool(
  tool: "pg_dump" | "pg_restore",
  args: string[],
  input: number | "ignore",
  output: number | "ignore",
) {
  if (!pgBin && !pgContainer) throw new Error("Plain restore requires matching PostgreSQL client tools");
  if (pgContainer && !/^[a-f0-9]{12,64}$/.test(pgContainer)) {
    throw new Error("The integration PostgreSQL container must be its exact Docker ID");
  }
  execFileSync(
    pgContainer ? "docker" : path.join(pgBin!, tool),
    pgContainer ? ["exec", "-i", pgContainer, tool, ...args] : args,
    { stdio: [input, output, "pipe"], timeout: 60_000 },
  );
}

async function functionAttributes(sql: ReturnType<typeof postgres> | Transaction) {
  return sql`
    SELECT oid::text, proname, proowner::text, proacl::text, provolatile,
      proisstrict, prosecdef, proparallel, proleakproof, proconfig,
      pg_get_function_identity_arguments(oid) AS arguments,
      pg_get_function_result(oid) AS result
    FROM pg_proc WHERE oid = ANY(${signatures}::regprocedure[])
    ORDER BY proname
  `;
}
async function targetStates(sql: ReturnType<typeof postgres> | Transaction) {
  return sql`
    SELECT relation.relname AS table_name, conname, convalidated
    FROM pg_constraint JOIN pg_class relation ON relation.oid = conrelid
    WHERE relation.relnamespace = 'public'::regnamespace
      AND conname = ANY(${targets.map((target) => target.name)}::text[])
    ORDER BY relation.relname, conname
  `;
}

databaseDescribe("Postgres restore and deferred validation follow-ups", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    admin = postgres(databaseUrl!, {
      max: 1, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require",
      onnotice: () => undefined,
    });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
  });
  afterAll(async () => {
    await closeDatabaseClient();
    await admin?.end();
  });

  test("v213 keeps function identities, ownership, grants and attributes", async () => {
    await rollbackOnly(admin, async (transaction) => {
      // A non-default ACL must survive CREATE OR REPLACE too.
      await transaction.unsafe(`REVOKE EXECUTE ON FUNCTION ${signatures[0]} FROM PUBLIC`);
      const before = await functionAttributes(transaction);
      await prepareHistoricalReplay(transaction, 213);
      await apply(transaction, 213);
      expect(await functionAttributes(transaction)).toEqual(before);
    });
  });

  test("validates IDs, numbers and every locator kind with an empty caller search_path", async () => {
    await admin.begin(async (transaction) => {
      await transaction`SELECT set_config('search_path', '', true)`;
      const [ids] = await transaction`
        SELECT public.omni_source_id_array_is_canonical(ARRAY['grant-a','grant-b'], 128) AS valid,
          public.omni_source_id_array_is_canonical(ARRAY['grant-b','grant-a'], 128) AS unordered,
          public.omni_source_id_array_is_canonical(ARRAY['grant-a','grant-a'], 128) AS duplicate,
          public.omni_source_id_array_is_canonical(ARRAY[' bad '], 128) AS malformed,
          public.omni_source_id_array_is_canonical(NULL, 128) AS absent,
          public.omni_jsonb_safe_integer_value('9007199254740991'::jsonb)::text AS maximum,
          public.omni_jsonb_safe_integer_value('9007199254740992'::jsonb) AS overflow,
          public.omni_jsonb_safe_integer_value('1.5'::jsonb) AS fractional,
          public.omni_jsonb_safe_integer_value('null'::jsonb) AS empty
      `;
      expect(ids).toEqual({ valid: true, unordered: false, duplicate: false,
        malformed: false, absent: false, maximum: "9007199254740991",
        overflow: null, fractional: null, empty: null });
      for (const locator of locators) {
        const [result] = await transaction`
          SELECT public.omni_evidence_locator_v1_is_allowlisted(${transaction.json(locator)}::jsonb) AS valid,
            public.omni_evidence_locator_v1_is_allowlisted(${transaction.json({ ...locator, unexpected: true })}::jsonb) AS extra
        `;
        expect(result).toEqual({ valid: true, extra: false });
      }
      const [invalid] = await transaction`
        SELECT public.omni_evidence_locator_v1_is_allowlisted(
          '{"kind":"image_region","coordinateUnit":"pixel","x":9,"y":0,"width":2,"height":1,"imageWidth":10,"imageHeight":10}'::jsonb
        ) AS out_of_bounds
      `;
      expect(invalid.out_of_bounds).toBe(false);
    });
  });

  test("the operator preflight is read-only and returns exactly 44 count-only results", async () => {
    const statements = splitSqlStatements(fs.readFileSync("scripts/sql/schema-v214-preflight.sql", "utf8"));
    const connection = await admin.reserve();
    let counts: postgres.Row[] = [];
    try {
      for (const statement of statements) {
        const rows = await connection.unsafe(statement);
        if (rows[0]?.violating_rows !== undefined) counts = [...rows];
      }
      expect(counts).toHaveLength(44);
      expect(counts.every((row) => row.validated && Number(row.violating_rows) === 0)).toBe(true);
      expect(Object.keys(counts[0]).sort()).toEqual([
        "constraint_name", "table_name", "validated", "violating_rows",
      ]);
    } finally {
      await connection`ROLLBACK`;
      connection.release();
    }
  });

  test("v214 accepts already-valid targets without acquiring validation locks", async () => {
    const before = await targetStates(admin);
    expect(before).toHaveLength(44);
    expect(before.every((target) => target.convalidated)).toBe(true);
    await rollbackOnly(admin, async (transaction) => {
      await prepareHistoricalReplay(transaction, 214);
      await apply(transaction, 214);
      expect(await targetStates(transaction)).toEqual(before);
      expect(await transaction`
        SELECT relation FROM pg_locks
        WHERE pid = pg_backend_pid() AND mode = 'ShareUpdateExclusiveLock'
      `).toHaveLength(0);
    });
  });

  test("v214 validates all 44 NOT VALID targets and leaves later deferred checks alone", async () => {
    await rollbackOnly(admin, async (transaction) => {
      for (const { table, name, definition } of targets) {
        await transaction.unsafe(`ALTER TABLE public.${table} DROP CONSTRAINT ${name}`);
        await transaction.unsafe(`ALTER TABLE public.${table} ADD CONSTRAINT ${name} ${fixtureDefinition(name, definition)} NOT VALID`);
      }
      expect((await targetStates(transaction)).every((target) => !target.convalidated)).toBe(true);
      await prepareHistoricalReplay(transaction, 214);
      await apply(transaction, 214);
      expect((await targetStates(transaction)).every((target) => target.convalidated)).toBe(true);
      const later = await transaction`
        SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('omni_oauth_grants_sync_backoff_check', 'omni_operation_jobs_lease_lapses_check')
        ORDER BY conname
      `;
      expect(later).toEqual([
        { conname: "omni_oauth_grants_sync_backoff_check", convalidated: false },
        { conname: "omni_operation_jobs_lease_lapses_check", convalidated: false },
      ]);
    });
  });

  test.each(["missing", "drifted"])("v214 rejects a %s target and rolls back its ledger", async (variant) => {
    const before = await targetStates(admin);
    await expect(admin.begin(async (transaction) => {
      await prepareHistoricalReplay(transaction, 214);
      await transaction`ALTER TABLE public.omni_model_assignments DROP CONSTRAINT omni_model_assignments_revision_check`;
      if (variant === "drifted") {
        await transaction`ALTER TABLE public.omni_model_assignments ADD CONSTRAINT omni_model_assignments_revision_check CHECK (assignment_revision >= 0)`;
      }
      await apply(transaction, 214);
    })).rejects.toMatchObject({ cause: {
      code: "55000",
      message: "Validation target omni_model_assignments.omni_model_assignments_revision_check is missing or differs from its recorded definition",
    } });
    expect(await targetStates(admin)).toEqual(before);
    expect(await admin`SELECT version FROM public.omni_schema_version WHERE version = 214`).toHaveLength(1);
  });

  test("v214 fails on an invalid legacy row without repairing it or retaining partial validation", async () => {
    await rollbackOnly(admin, async (transaction) => {
      await prepareHistoricalReplay(transaction, 214);
      for (const { table, name, definition } of targets) {
        await transaction.unsafe(`ALTER TABLE public.${table} DROP CONSTRAINT ${name}`);
        if (name === "omni_model_assignments_revision_check") {
          // The historical TypeScript bootstrap also supplied this redundant
          // range check; remove it only inside the synthetic rollback fixture.
          await transaction`ALTER TABLE public.omni_model_assignments DROP CONSTRAINT omni_model_assignments_assignment_revision_check`;
          await transaction`
            INSERT INTO public.omni_model_assignments
              (id, tenant_id, actor_id, scope, provider, model_id, assignment_revision)
            VALUES ('validation-invalid-row', 'validation-tenant', 'validation-actor',
              'main_agent', 'openai', 'synthetic-model', 0)
          `;
        }
        await transaction.unsafe(`ALTER TABLE public.${table} ADD CONSTRAINT ${name} ${fixtureDefinition(name, definition)} NOT VALID`);
      }
      await expect(transaction.savepoint((savepoint) => apply(savepoint, 214)))
        .rejects.toMatchObject({ cause: { code: "23514" } });
      expect((await targetStates(transaction)).every((target) => !target.convalidated)).toBe(true);
      expect(await transaction`SELECT version FROM public.omni_schema_version WHERE version = 214`).toHaveLength(0);
      expect(await transaction`
        SELECT assignment_revision FROM public.omni_model_assignments
        WHERE id = 'validation-invalid-row'
      `).toEqual([{ assignment_revision: 0 }]);
    });
  });

  (pgBin || pgContainer || requirePlainRestore ? test : test.skip)("plain pg_dump/pg_restore copies populated evidence without the restore-drill workaround", async () => {
    const destination = `asael_plain_restore_${process.pid}_${randomUUID().slice(0, 8)}`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "asael-plain-restore-"));
    const archive = path.join(directory, "synthetic.dump");
    const restoredUrl = new URL(databaseUrl!);
    restoredUrl.pathname = `/${destination}`;
    let restored: ReturnType<typeof postgres> | undefined;
    try {
      // Synthetic evidence rows exercise the same grant and locator validators
      // as omni_evidence_units; no production backup or data is used.
      await admin`
        CREATE TABLE public.source_validator_restore_evidence (
          id text PRIMARY KEY,
          permission_grant_ids text[] NOT NULL CHECK (public.omni_source_id_array_is_canonical(permission_grant_ids, 128)),
          locator jsonb NOT NULL CHECK (public.omni_evidence_locator_v1_is_allowlisted(locator))
        )
      `;
      for (const [index, locator] of locators.entries()) {
        await admin`
          INSERT INTO public.source_validator_restore_evidence VALUES
            (${`evidence-${index}`}, ARRAY['grant-a','grant-b'], ${admin.json(locator)}::jsonb)
        `;
      }
      const before = await admin`SELECT * FROM public.source_validator_restore_evidence ORDER BY id`;
      await admin.unsafe(`CREATE DATABASE ${destination}`);
      // No section splitting, ALTER FUNCTION, search_path patch, or injected SQL.
      const dumpOutput = fs.openSync(archive, "wx", 0o600);
      try {
        runPostgresTool("pg_dump", ["--format=custom", "--dbname", databaseUrl!], "ignore", dumpOutput);
      } finally {
        fs.closeSync(dumpOutput);
      }
      const restoreInput = fs.openSync(archive, "r");
      try {
        runPostgresTool("pg_restore", ["--exit-on-error", "--dbname", restoredUrl.href], restoreInput, "ignore");
      } finally {
        fs.closeSync(restoreInput);
      }
      restored = postgres(restoredUrl.href, {
        max: 1, prepare: false,
        ssl: restoredUrl.searchParams.get("sslmode") === "disable" ? false : "require",
      });
      expect(await restored`SELECT * FROM public.source_validator_restore_evidence ORDER BY id`).toEqual(before);
      const withoutOid = (rows: postgres.Row[]) => rows.map((row) => ({ ...row, oid: undefined }));
      expect(withoutOid(await functionAttributes(restored)))
        .toEqual(withoutOid(await functionAttributes(admin)));
    } finally {
      await restored?.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${destination} WITH (FORCE)`);
      await admin`DROP TABLE IF EXISTS public.source_validator_restore_evidence`;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
