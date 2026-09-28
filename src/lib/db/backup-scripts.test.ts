import { spawn } from "node:child_process";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as Array<{ version: number; name: string; checksum: string; file?: string }>;
// What omni_schema_version holds once every migration has been applied.
const ledgerRows = manifest.map(({ version, name, checksum }) => ({
  version,
  name,
  checksum,
}));
const changedLedgerRows = ledgerRows.map((row) =>
  row.version === 26 ? { ...row, checksum: "0".repeat(64) } : row,
);

// Answers the backup script's catalog queries the way a migrated database
// would, and records which queries it was asked.
const FAKE_PSQL = [
  "#!/bin/sh",
  'sql=""',
  'while [ "$#" -gt 0 ]; do',
  '  if [ "$1" = "--command" ]; then sql="$2"; shift; fi',
  "  shift",
  "done",
  'record() { echo "$1" >> "$FAKE_PSQL_LOG"; }',
  'case "$sql" in',
  "  *rolbypassrls*) record role; echo safe ;;",
  '  *"current_database()"*) record database; echo prod ;;',
  "  *omni_database_identity*) record identity-table; echo f ;;",
  '  *"pg_control_system()"*) record system-identifier; echo 7000000000000000001 ;;',
  "  *information_schema.columns*) record ledger-columns; echo '[\"version\", \"name\", \"checksum\", \"applied_at\"]' ;;",
  '  *"FROM omni_schema_version"*) record ledger-rows; cat "$FAKE_PSQL_LEDGER" ;;',
  "  *relforcerowsecurity*) record forced-rls; echo '[\"omni_threads\"]' ;;",
  "  *) record unexpected; exit 3 ;;",
  "esac",
  "",
].join("\n");

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "omni-backup-scripts-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("database backup script", () => {
  it("accepts a database whose ledger rows match schema-migrations.json", async () => {
    const result = await runBackup(ledgerRows);

    expect(result.stderr).not.toContain("not a valid contiguous prefix");
    // The forced-RLS inventory is read only after the ledger check passes.
    expect(result.queries).toContain("forced-rls");
  });

  it("rejects a database whose ledger rows differ from schema-migrations.json", async () => {
    const result = await runBackup(changedLedgerRows);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Database migration markers are not a valid contiguous prefix of schema-migrations.json.",
    );
    expect(result.queries).toContain("ledger-rows");
    expect(result.queries).not.toContain("forced-rls");
  });
});

describe("database restore drill", () => {
  it("accepts a backup manifest that records the database's ledger rows", async () => {
    const result = await runRestoreDrill(ledgerRows);

    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("schema migration metadata is invalid");
    // The size is checked only after the manifest's metadata is accepted.
    expect(result.stderr).toContain("Backup size mismatch: expected 17 bytes, found 16.");
  });

  it("rejects a backup manifest whose ledger rows differ from schema-migrations.json", async () => {
    const result = await runRestoreDrill(changedLedgerRows);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Backup manifest format, digest, or schema migration metadata is invalid.",
    );
    expect(result.stderr).not.toContain("Backup size mismatch");
  });
});

async function runBackup(ledger: unknown) {
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "psql"), FAKE_PSQL);
  await chmod(path.join(bin, "psql"), 0o755);
  const ledgerFile = path.join(directory, "ledger.json");
  const queryLog = path.join(directory, "queries.log");
  await writeFile(ledgerFile, JSON.stringify(ledger));
  await writeFile(queryLog, "");
  const result = await runScript("scripts/db-backup.mjs", {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    NODE_ENV: "test",
    // Nothing listens here; the script fails once it opens its snapshot.
    DATABASE_URL: "postgres://backup:unused@127.0.0.1:1/prod?sslmode=disable",
    OMNIAGENT_BACKUP_OUTPUT: path.join(directory, "out", "backup.dump"),
    FAKE_PSQL_LEDGER: ledgerFile,
    FAKE_PSQL_LOG: queryLog,
  });
  return {
    ...result,
    queries: (await readFile(queryLog, "utf8")).split("\n").filter(Boolean),
  };
}

async function runRestoreDrill(schemaMigrations: unknown) {
  const backup = path.join(directory, "backup.dump");
  await writeFile(backup, "not a real dump\n");
  await writeFile(
    `${backup}.manifest.json`,
    JSON.stringify({
      format: "postgres-custom",
      // One byte more than the file, so the drill stops before pg_restore.
      bytes: 17,
      sha256: "0".repeat(64),
      sourceDatabaseIdentity: {
        database: "prod",
        configuredEndpoint: "127.0.0.1:2/prod",
      },
      schemaMigrations,
      forcedRlsTables: ["omni_threads"],
      tableRowCounts: { omni_threads: "0" },
    }),
  );
  return runScript("scripts/db-restore-drill.mjs", {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    OMNIAGENT_BACKUP_INPUT: backup,
    RESTORE_DATABASE_URL: "postgres://restore:unused@127.0.0.1:1/restore_drill",
    DATABASE_URL: "postgres://app:unused@127.0.0.1:2/prod",
    RESTORE_CONFIRM: "restore-into-isolated-database:restore_drill",
  });
}

function runScript(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      // Only what the script needs, so no real database URL reaches it.
      env: { HOME: directory, TMPDIR: directory, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
