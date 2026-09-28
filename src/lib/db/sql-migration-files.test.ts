import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSchemaMigrationSteps } from "@/lib/db/client";
import {
  applySqlMigrationFile,
  describeSqlStatement,
  parseSqlMigrationFile,
  readSqlMigrationFile,
  splitSqlStatements,
  sqlMigrationFileDigest,
  sqlMigrationFilePath,
  type SqlMigrationFileEntry,
  type SqlMigrationLedgerRow,
} from "@/lib/db/sql-migration-files";

type ManifestEntry = SqlMigrationLedgerRow & { file?: string; sha256?: string };

const migrationsDirectory = path.join(process.cwd(), "supabase", "migrations");
const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as ManifestEntry[];
const ledgerRow = ({ version, name, checksum }: ManifestEntry) => ({
  version,
  name,
  checksum,
});
const byVersion = (left: SqlMigrationLedgerRow, right: SqlMigrationLedgerRow) =>
  left.version - right.version;
const mappedFiles = [
  ...new Set(manifest.flatMap((entry) => (entry.file ? [entry.file] : []))),
];
const fileEntry = (file: string): SqlMigrationFileEntry => {
  const entries = manifest.filter((entry) => entry.file === file);
  return { file, sha256: String(entries[0]?.sha256), migrations: entries.map(ledgerRow) };
};
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const ZEROS = "0".repeat(64);
// Files the runner never executes. The backup-role grants predate the ledger,
// and market_deterministic_backtests_v1 now repairs that role's table grants.
const UNVERSIONED_FILES = ["20260905093000_backup_role_public_table_grants.sql"];

const FILE = "20990101000000_example.sql";
const ROW = { version: 300, name: "example_v1", checksum: "a".repeat(64) };
const EXAMPLE = `-- An example migration; it wraps itself in a transaction.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SELECT set_config('omni.example', 'on', true);
CREATE TABLE public.example (id integer);
INSERT INTO omni_schema_version (version, name, checksum)
VALUES (300, 'example_v1', '${"a".repeat(64)}');
COMMIT;
`;

describe("SQL statement splitting", () => {
  it("splits only on top-level semicolons and drops empty statements", () => {
    const statements = [
      "SELECT 'a;b', 'it''s; fine';",
      'SELECT "odd;name" FROM t;',
      "SELECT E'escaped \\' quote; still inside';",
      "SELECT E'it''s \\' still; inside';",
      "SELECT e'lower \\' case; inside';",
      "SELECT 'C:\\', 'x;y';",
      "SELECT 1 WHERE path LIKE'C:\\';",
      "DO $body$ BEGIN PERFORM 1; END $body$;",
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;",
      "SELECT foo$bar$baz FROM t;",
      "/* outer /* inner; */ still comment; */ SELECT 2;",
      "CREATE RULE r AS ON INSERT TO t DO ALSO (SELECT 1; SELECT 2);",
      "-- trailing; comment",
      ";",
    ];

    expect(splitSqlStatements(statements.join("\n"))).toEqual([
      "SELECT 'a;b', 'it''s; fine'",
      'SELECT "odd;name" FROM t',
      "SELECT E'escaped \\' quote; still inside'",
      "SELECT E'it''s \\' still; inside'",
      "SELECT e'lower \\' case; inside'",
      "SELECT 'C:\\', 'x;y'",
      "SELECT 1 WHERE path LIKE'C:\\'",
      "DO $body$ BEGIN PERFORM 1; END $body$",
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$",
      "SELECT foo$bar$baz FROM t",
      "/* outer /* inner; */ still comment; */ SELECT 2",
      "CREATE RULE r AS ON INSERT TO t DO ALSO (SELECT 1; SELECT 2)",
    ]);
  });

  it.each([
    ["SELECT (1;", "SQL has an unclosed parenthesis."],
    ["SELECT 1);", "SQL has an unmatched closing parenthesis."],
    ["SELECT 1 /* open", "SQL has an unterminated block comment."],
    ["SELECT /* a /* b */ still open", "SQL has an unterminated block comment."],
    ["SELECT 'open", "SQL has an unterminated ' quote."],
    ['SELECT "open', 'SQL has an unterminated " quote.'],
    ["DO $body$ BEGIN", "SQL has an unterminated $body$ quote."],
  ])("rejects %j", (text, message) => {
    expect(() => splitSqlStatements(text)).toThrow(message);
  });

  it("describes a statement by its first line, bounded", () => {
    expect(
      describeSqlStatement("-- why\n/* more */  CREATE   TABLE a (\n  id integer)"),
    ).toBe("CREATE TABLE a (");
    const long = `SELECT ${"x".repeat(100)}`;
    expect(describeSqlStatement(long)).toBe(`${long.slice(0, 77)}...`);
    const exact = `SELECT ${"x".repeat(73)}`;
    expect(describeSqlStatement(exact)).toBe(exact);
  });
});

describe("SQL migration file parsing", () => {
  it("removes the file's own transaction and reads its ledger rows and settings", () => {
    const migration = parseSqlMigrationFile(
      FILE,
      `-- Header; with a semicolon.
BEGIN TRANSACTION;
SET LOCAL lock_timeout = '5s';
SET CONSTRAINTS ALL DEFERRED;
SELECT set_config('omni.system_scope', 'true', true);
CREATE FUNCTION public.example() RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  RETURN 1;
END;
$$;
COMMENT ON FUNCTION public.example() IS 'Never VACUUM; never COMMIT CONCURRENTLY';
INSERT INTO public.omni_schema_version (version, name, checksum)
VALUES
  (301, 'first_v1', '${"b".repeat(64)}'),
  (302, 'second_v1', '${"c".repeat(64)}');
COMMIT WORK;
`,
    );

    expect(migration.statements).toHaveLength(6);
    expect(migration.statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(migration.statements[5]).toMatch(/^INSERT INTO public\.omni_schema_version/);
    expect(migration.ledger).toEqual([
      { version: 301, name: "first_v1", checksum: "b".repeat(64) },
      { version: 302, name: "second_v1", checksum: "c".repeat(64) },
    ]);
    expect(migration.settings).toEqual(["lock_timeout", "omni.system_scope"]);
    expect(Object.isFrozen(migration)).toBe(true);
    expect(Object.isFrozen(migration.statements)).toBe(true);
    expect(Object.isFrozen(migration.ledger)).toBe(true);
  });

  it("runs a file without its own transaction whole", () => {
    const migration = parseSqlMigrationFile(
      FILE,
      `CREATE TABLE a (id integer);
INSERT INTO omni_schema_version VALUES (303, 'third_v1', '${"d".repeat(64)}');`,
    );

    expect(migration.statements).toEqual([
      "CREATE TABLE a (id integer)",
      `INSERT INTO omni_schema_version VALUES (303, 'third_v1', '${"d".repeat(64)}')`,
    ]);
    expect(migration.ledger).toEqual([
      { version: 303, name: "third_v1", checksum: "d".repeat(64) },
    ]);
    expect(migration.settings).toEqual([]);
  });

  it.each([
    [
      "BEGIN;\nSELECT 1;",
      "must begin with a plain BEGIN and end with a plain COMMIT, or have neither.",
    ],
    [
      "SELECT 1;\nCOMMIT;",
      "must begin with a plain BEGIN and end with a plain COMMIT, or have neither.",
    ],
    [
      "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;\nSELECT 1;\nCOMMIT;",
      "must begin with a plain BEGIN and end with a plain COMMIT, or have neither.",
    ],
    ["BEGIN;\nCOMMIT;", "has no statements."],
    ["-- only a comment\n", "has no statements."],
    [
      "BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\nCOMMIT;",
      "statement 3 (COMMIT) controls the transaction.",
    ],
    [
      "SAVEPOINT before_change;\nSELECT 1;",
      "statement 1 (SAVEPOINT before_change) controls the transaction.",
    ],
    ["START TRANSACTION;", "statement 1 (START TRANSACTION) controls the transaction."],
    ["SELECT 1;\nROLLBACK;", "statement 2 (ROLLBACK) controls the transaction."],
    [
      "SET search_path = public;",
      "statement 1 (SET search_path = public) changes session state.",
    ],
    ["RESET ALL;", "statement 1 (RESET ALL) changes session state."],
    ["DISCARD ALL;", "statement 1 (DISCARD ALL) changes session state."],
    [
      "SET LOCAL ROLE omni_runtime;",
      "statement 1 (SET LOCAL ROLE omni_runtime) changes session state.",
    ],
    [
      "SET LOCAL SESSION AUTHORIZATION omni_runtime;",
      "statement 1 (SET LOCAL SESSION AUTHORIZATION omni_runtime) changes session state.",
    ],
    [
      "SET SESSION AUTHORIZATION omni_runtime;",
      "statement 1 (SET SESSION AUTHORIZATION omni_runtime) changes session state.",
    ],
    [
      "VACUUM ANALYZE public.example;",
      "statement 1 (VACUUM ANALYZE public.example) cannot run inside the migration transaction.",
    ],
    [
      "CREATE INDEX CONCURRENTLY example_idx ON public.example (id);",
      "statement 1 (CREATE INDEX CONCURRENTLY example_idx ON public.example (id)) cannot run inside the migration transaction.",
    ],
    [
      "INSERT INTO omni_schema_version (version, name, checksum)\nSELECT version + 1, name, checksum FROM omni_schema_version;",
      "writes omni_schema_version without a literal version row.",
    ],
  ])("rejects %j", (text, message) => {
    expect(() => parseSqlMigrationFile(FILE, text)).toThrow(`${FILE} ${message}`);
  });

  it.each([
    "CREATE INDEX idx$concurrently ON public.example (id)",
    "CREATE INDEX idx2concurrently ON public.example (id)",
    "CREATE INDEX äconcurrently ON public.example (id)",
  ])("reads a keyword inside a longer identifier as part of it (%j)", (statement) => {
    expect(parseSqlMigrationFile(FILE, `${statement};`).statements).toEqual([statement]);
  });

  it.each([
    "../20260926090000_example.sql",
    "20260926090000_example.sql/../../outside.sql",
    "2026092609000_example.sql",
    "20260926090000_Example.sql",
    "20260926090000_example.SQL",
  ])("refuses the file name %j", (file) => {
    expect(() => sqlMigrationFilePath(file)).toThrow(
      `Invalid SQL migration file name: ${file}.`,
    );
  });

  it("reads migration files from supabase/migrations", async () => {
    const file = "20260926090000_memory_forget_lineage_closure.sql";

    expect(sqlMigrationFilePath(file)).toBe(path.join(migrationsDirectory, file));
    expect((await readSqlMigrationFile(fileEntry(file))).ledger).toEqual(
      manifest.filter((entry) => entry.file === file).map(ledgerRow),
    );
  });
});

describe("SQL migration file digests", () => {
  const checksum = "c".repeat(64);

  it("hashes the file with each of its own checksums replaced by zeros", () => {
    const text = `-- café
INSERT INTO omni_schema_version VALUES (300, 'example_v1', '${checksum}');
SELECT 1 FROM omni_schema_version WHERE checksum = '${checksum}';
SELECT '${"d".repeat(64)}';
`;

    expect(sqlMigrationFileDigest(text, [checksum])).toBe(
      sha256(`-- café
INSERT INTO omni_schema_version VALUES (300, 'example_v1', '${ZEROS}');
SELECT 1 FROM omni_schema_version WHERE checksum = '${ZEROS}';
SELECT '${"d".repeat(64)}';
`),
    );
    expect(sqlMigrationFileDigest(text, [])).toBe(sha256(text));
  });

  it("lets a file record its own digest as its checksum", () => {
    const sealed = `INSERT INTO omni_schema_version VALUES (300, 'example_v1', '${ZEROS}');`;
    const digest = sha256(sealed);

    expect(sqlMigrationFileDigest(sealed.replace(ZEROS, digest), [digest])).toBe(digest);
  });

  it.each(["", "C".repeat(64), "c".repeat(63), "c".repeat(65), `${checksum} `])(
    "refuses the checksum %j",
    (invalid) => {
      expect(() => sqlMigrationFileDigest(`SELECT '${checksum}';`, [invalid])).toThrow(
        `Migration checksum ${JSON.stringify(invalid)} is not a SHA-256 digest.`,
      );
    },
  );

  describe("when the runner reads a file", () => {
    const file = "20260926090000_memory_forget_lineage_closure.sql";
    const original = fs.readFileSync(path.join(migrationsDirectory, file), "utf8");
    const [{ checksum: recorded }] = fileEntry(file).migrations;
    let root = "";
    const write = (content: string | Buffer) =>
      fs.writeFileSync(path.join(root, "supabase", "migrations", file), content);

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "omniagent-sql-migration-"));
      fs.mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
      vi.spyOn(process, "cwd").mockReturnValue(root);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("reads a copy that matches the manifest sha256", async () => {
      write(original);

      expect((await readSqlMigrationFile(fileEntry(file))).ledger).toEqual(
        fileEntry(file).migrations,
      );
    });

    it.each([
      ["an added statement", original.replace(/COMMIT;\s*$/, "DROP TABLE public.memories;\nCOMMIT;\n")],
      ["an added byte order mark", `\ufeff${original}`],
      ["a changed checksum", original.replaceAll(recorded, "e".repeat(64))],
    ])("refuses a file with %s", async (_, changed) => {
      expect(changed).not.toBe(original);
      write(changed);

      await expect(readSqlMigrationFile(fileEntry(file))).rejects.toThrow(
        `${file} has sha256 ${sha256(changed.replaceAll(recorded, ZEROS))}, but schema-migrations.json expects ${fileEntry(file).sha256}. A migration file must not change once a database may have run it; make the change in a new migration.`,
      );
    });

    it("refuses a file that is not UTF-8", async () => {
      write(Buffer.concat([Buffer.from(original), Buffer.from([0xff])]));

      await expect(readSqlMigrationFile(fileEntry(file))).rejects.toThrow(
        `${file} is not valid UTF-8.`,
      );
    });
  });
});

describe("SQL migration file execution", () => {
  it("runs each statement, restores changed settings, and checks the rows it wrote", async () => {
    const database = fakeDatabase({ search_path: '"$user", public', lock_timeout: "0" });

    await applySqlMigrationFile(database.sql, parseSqlMigrationFile(FILE, EXAMPLE), [ROW], [
      "lock_timeout",
      "search_path",
    ]);

    expect(database.calls).toEqual([
      "read settings lock_timeout, search_path, omni.example",
      "SET LOCAL search_path = pg_catalog, public",
      "SELECT set_config('omni.example', 'on', true)",
      "CREATE TABLE public.example (id integer)",
      expect.stringMatching(/^INSERT INTO omni_schema_version/),
      "read settings lock_timeout, search_path, omni.example",
      'restore search_path="$user", public',
      "restore omni.example=",
      "read ledger 300",
    ]);
    expect(Object.fromEntries(database.settings)).toEqual({
      search_path: '"$user", public',
      lock_timeout: "0",
      "omni.example": "",
    });
  });

  it("runs nothing when the file declares rows the manifest does not expect", async () => {
    const database = fakeDatabase({});
    const expected = { ...ROW, checksum: "b".repeat(64) };

    await expect(
      applySqlMigrationFile(database.sql, parseSqlMigrationFile(FILE, EXAMPLE), [expected], []),
    ).rejects.toThrow(
      `${FILE} declares migration ledger rows [300:example_v1:${"a".repeat(64)}], but schema-migrations.json expects [300:example_v1:${"b".repeat(64)}].`,
    );
    expect(database.calls).toEqual([]);
  });

  it.each([[[]], [[{ ...ROW, version: 1.5 }]]])(
    "runs nothing without valid expected versions (%j)",
    async (expected) => {
      const database = fakeDatabase({});

      await expect(
        applySqlMigrationFile(database.sql, parseSqlMigrationFile(FILE, EXAMPLE), expected, []),
      ).rejects.toThrow(`${FILE} has no valid expected versions.`);
      expect(database.calls).toEqual([]);
    },
  );

  it("compares ledger rows in any order", async () => {
    const rows = [
      { version: 301, name: "first_v1", checksum: "b".repeat(64) },
      { version: 302, name: "second_v1", checksum: "c".repeat(64) },
    ];
    const database = fakeDatabase({}, (statement, state) => {
      if (statement.startsWith("INSERT INTO omni_schema_version")) {
        state.ledger.push(...rows);
      }
    });
    const text = `INSERT INTO omni_schema_version (version, name, checksum)
VALUES (301, 'first_v1', '${"b".repeat(64)}'), (302, 'second_v1', '${"c".repeat(64)}');`;

    await applySqlMigrationFile(
      database.sql,
      parseSqlMigrationFile(FILE, text),
      [...rows].reverse(),
      [],
    );

    expect(database.calls).toEqual([
      expect.stringMatching(/^INSERT INTO omni_schema_version/),
      "read ledger 302, 301",
    ]);
  });

  it("fails when the rows the file wrote differ from the manifest", async () => {
    const database = fakeDatabase({}, (statement, state) => {
      if (statement.startsWith("INSERT INTO omni_schema_version")) {
        state.ledger.push({ ...ROW, checksum: "c".repeat(64) });
      }
    });

    await expect(
      applySqlMigrationFile(database.sql, parseSqlMigrationFile(FILE, EXAMPLE), [ROW], []),
    ).rejects.toThrow(
      `${FILE} wrote migration ledger rows [300:example_v1:${"c".repeat(64)}], but schema-migrations.json expects [300:example_v1:${"a".repeat(64)}].`,
    );
  });

  it("names the file and statement that failed and keeps the cause", async () => {
    const failure = new Error('relation "example" already exists');
    const database = fakeDatabase({}, (statement) => {
      if (statement.startsWith("CREATE TABLE")) throw failure;
    });

    const error = await applySqlMigrationFile(
      database.sql,
      parseSqlMigrationFile(FILE, EXAMPLE),
      [ROW],
      [],
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `${FILE} statement 4 (CREATE TABLE public.example (id integer)) failed: relation "example" already exists`,
    );
    expect((error as Error).cause).toBe(failure);
    expect(database.calls.at(-1)).toBe("CREATE TABLE public.example (id integer)");
  });
});

describe("schema-migrations.json and supabase/migrations", () => {
  const files = fs
    .readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  it("maps every migration file to the versions it records", () => {
    expect(files.filter((file) => !mappedFiles.includes(file))).toEqual(UNVERSIONED_FILES);
    expect(mappedFiles.filter((file) => !files.includes(file))).toEqual([]);
  });

  it("keeps file-backed versions in file-name order", () => {
    const fileBacked = manifest.flatMap((entry) => (entry.file ? [entry.file] : []));

    expect(fileBacked).toEqual([...fileBacked].sort());
  });

  it("locks every mapped file to the sha256 the manifest records", () => {
    for (const file of mappedFiles) {
      const entries = manifest.filter((entry) => entry.file === file);
      const digest = sqlMigrationFileDigest(
        fs.readFileSync(path.join(migrationsDirectory, file), "utf8"),
        entries.map((entry) => entry.checksum),
      );

      expect({ file, sha256: entries.map((entry) => entry.sha256) }).toEqual({
        file,
        sha256: entries.map(() => digest),
      });
    }
  });

  it("reads every mapped file into exactly the rows the manifest assigns it", async () => {
    for (const file of mappedFiles) {
      const migration = await readSqlMigrationFile(fileEntry(file));

      expect({ file, ledger: [...migration.ledger].sort(byVersion) }).toEqual({
        file,
        ledger: manifest.filter((entry) => entry.file === file).map(ledgerRow),
      });
    }
  });
});

describe("schema migration steps", () => {
  const up = async () => undefined;
  const typescriptSteps = (...versions: number[]) =>
    new Map(versions.map((version) => [version, up]));
  const entry = (version: number, file?: string): ManifestEntry => ({
    version,
    name: `example_${version}_v1`,
    checksum: String(version % 10).repeat(64),
    ...(file ? { file, sha256: sha256(file) } : {}),
  });
  const sealed = (version: number, file: string): ManifestEntry => ({
    ...entry(version, file),
    checksum: sha256(file),
  });

  it("gives every manifest version exactly one step, in order", () => {
    const steps = getSchemaMigrationSteps();
    const sqlSteps = steps.filter((step) => step.kind === "sql");

    expect(steps.flatMap((step) => step.migrations.map((migration) => migration.version)))
      .toEqual(manifest.map((migration) => migration.version));
    expect(sqlSteps.map((step) => step.file)).toEqual(mappedFiles);
    for (const step of sqlSteps) {
      expect(step.migrations).toEqual(
        manifest.filter((migration) => migration.file === step.file).map(ledgerRow),
      );
      expect(step.sha256).toBe(fileEntry(step.file).sha256);
    }
    expect(
      steps
        .filter((step) => step.kind === "typescript")
        .map((step) => step.migrations[0].version),
    ).toEqual(manifest.filter((migration) => !migration.file).map((migration) => migration.version));
    expect(
      sqlSteps
        .filter((step) => step.migrations.length > 1)
        .map((step) => step.migrations.map((migration) => migration.version)),
    ).toEqual([[117, 118]]);
  });

  it("groups adjacent versions that share a file into one step", () => {
    const steps = getSchemaMigrationSteps(
      [entry(1), entry(2, "a.sql"), entry(3, "a.sql"), entry(4, "b.sql")],
      typescriptSteps(1),
    );

    expect(steps.map((step) => [step.kind, step.migrations.map((m) => m.version)])).toEqual([
      ["typescript", [1]],
      ["sql", [2, 3]],
      ["sql", [4]],
    ]);
    expect(steps.flatMap((step) => (step.kind === "sql" ? [step.sha256] : []))).toEqual([
      sha256("a.sql"),
      sha256("b.sql"),
    ]);
  });

  it("keeps the recorded checksums before 208 and uses each file's sha256 from 208 on", () => {
    const steps = getSchemaMigrationSteps(
      [entry(206), entry(207, "a.sql"), sealed(208, "b.sql"), sealed(209, "b.sql")],
      typescriptSteps(206),
    );

    expect(
      steps.map((step) => step.migrations.map((migration) => migration.checksum)),
    ).toEqual([["6".repeat(64)], ["7".repeat(64)], [sha256("b.sql"), sha256("b.sql")]]);
  });

  it.each([
    [
      [entry(1, "a.sql")],
      typescriptSteps(1),
      "Database migration 1 has both a SQL file and a TypeScript step.",
    ],
    [[entry(1), entry(2)], typescriptSteps(1), "Database migration 2 has no SQL file or TypeScript step."],
    [
      [entry(1, "a.sql"), entry(2, "b.sql"), entry(3, "a.sql")],
      typescriptSteps(),
      "a.sql records database migrations that are not adjacent.",
    ],
    [
      [entry(1)],
      typescriptSteps(1, 2, 3),
      "TypeScript migration steps 2, 3 are not in schema-migrations.json.",
    ],
    [
      [{ ...entry(1, "a.sql"), sha256: undefined }],
      typescriptSteps(),
      "Database migration 1 names a.sql without its sha256.",
    ],
    [
      [entry(1, "a.sql"), { ...entry(2, "a.sql"), sha256: sha256("b.sql") }],
      typescriptSteps(),
      "a.sql has more than one sha256 in schema-migrations.json.",
    ],
    [
      [entry(208, "a.sql")],
      typescriptSteps(),
      "Database migration 208 must use the sha256 of a.sql as its checksum.",
    ],
    [
      [sealed(208, "a.sql"), { ...sealed(209, "a.sql"), checksum: "9".repeat(64) }],
      typescriptSteps(),
      "Database migration 209 must use the sha256 of a.sql as its checksum.",
    ],
    [
      [entry(208)],
      typescriptSteps(208),
      "Database migration 208 is a TypeScript step, but every migration from 208 on is a SQL file.",
    ],
  ])("rejects an inconsistent manifest (%#)", (entries, steps, message) => {
    expect(() => getSchemaMigrationSteps(entries, steps)).toThrow(message);
  });
});

function fakeDatabase(
  initialSettings: Record<string, string>,
  execute: (
    statement: string,
    state: { settings: Map<string, string>; ledger: SqlMigrationLedgerRow[] },
  ) => void = (statement, state) => {
    if (statement.startsWith("INSERT INTO omni_schema_version")) {
      state.ledger.push(ROW);
    }
    const local = /^SET LOCAL (\w+) = (.+)$/.exec(statement);
    if (local) state.settings.set(local[1], local[2]);
    const configured = /^SELECT set_config\('([\w.]+)', '([^']*)', true\)$/.exec(statement);
    if (configured) state.settings.set(configured[1], configured[2]);
  },
) {
  const state = {
    settings: new Map(Object.entries(initialSettings)),
    ledger: [] as SqlMigrationLedgerRow[],
  };
  const calls: string[] = [];
  const sql = {
    unsafe: async (text: string, params: unknown[] = []) => {
      if (text.startsWith("SELECT current_setting(")) {
        calls.push(`read settings ${params.join(", ")}`);
        return [
          Object.fromEntries(
            params.map((name, index) => [
              `setting_${index}`,
              state.settings.get(String(name)) ?? null,
            ]),
          ),
        ];
      }
      if (text === "SELECT set_config($1, $2, true)") {
        calls.push(`restore ${String(params[0])}=${String(params[1])}`);
        state.settings.set(String(params[0]), String(params[1]));
        return [];
      }
      const ledgerRead = /^SELECT version, name, checksum FROM omni_schema_version WHERE version IN \(([^)]*)\)$/.exec(text);
      if (ledgerRead) {
        const versions = ledgerRead[1].split(", ").map(Number);
        calls.push(`read ledger ${versions.join(", ")}`);
        return state.ledger.filter((row) => versions.includes(row.version));
      }
      calls.push(text);
      execute(text, state);
      return [];
    },
  };
  return { sql, calls, settings: state.settings };
}
