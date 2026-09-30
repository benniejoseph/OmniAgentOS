import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  backupEncryptionKeyId,
  createBackupEncryptionStream,
  parseBackupEncryptionKey,
} from "../../../scripts/db-backup-security.mjs";

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
const encryptionKey = randomBytes(32).toString("base64");
// Variables a test sets or, as undefined, removes.
type EnvironmentChanges = Record<string, string | undefined>;

// Answers the scripts' catalog queries the way a migrated database would,
// and records which queries it was asked.
const FAKE_PSQL = [
  "#!/bin/sh",
  'sql=""',
  'while [ "$#" -gt 0 ]; do',
  '  if [ "$1" = "--command" ]; then sql="$2"; shift; fi',
  "  shift",
  "done",
  'record() { echo "$1" >> "$FAKE_PSQL_LOG"; }',
  'case "$sql" in',
  '  *"unnest(ARRAY"*) record missing-roles; echo "${FAKE_PSQL_MISSING_ROLES:-[]}" ;;',
  '  *"SET LOCAL omni.tenant_id"*) record tenant-read; echo "$FAKE_PSQL_TENANT_READ" ;;',
  '  *"SET LOCAL ROLE"*) record unscoped-read; echo "$FAKE_PSQL_UNSCOPED_READ" ;;',
  `  *"'tableRowCounts'"*) record validation; cat "$FAKE_PSQL_VALIDATION" ;;`,
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

// Lists an archive's entries, or records what it was asked to restore.
const FAKE_PG_RESTORE = [
  "#!/bin/sh",
  'echo "$*" >> "$FAKE_PG_RESTORE_LOG"',
  'list=""; previous=""; last=""',
  'for argument in "$@"; do',
  '  if [ "$previous" = "--use-list" ]; then list="$argument"; fi',
  '  previous="$argument"; last="$argument"',
  "done",
  'if [ "$1" = "--list" ]; then',
  "  echo '3; 2615 2200 SCHEMA - public pg_database_owner'",
  "  echo '4; 0 0 COMMENT - SCHEMA public pg_database_owner'",
  "  echo '215; 1259 16390 TABLE public omni_threads postgres'",
  "  exit 0",
  "fi",
  'if [ -n "$FAKE_PG_RESTORE_SLEEP" ]; then sleep "$FAKE_PG_RESTORE_SLEEP"; fi',
  'cp "$last" "$FAKE_PG_RESTORE_COPY"',
  'cp "$list" "$FAKE_PG_RESTORE_LIST_COPY"',
  "",
].join("\n");

// A drill backup: an encrypted stand-in for a pg_dump archive of two tenants
// with one member each.
const archive = Buffer.concat([Buffer.from("PGDMP"), randomBytes(4096)]);
const grants = [
  { object: "table omni_schema_version", grantee: "omni_runtime", privileges: "SELECT" },
  {
    object: "table omni_threads",
    grantee: "omni_runtime",
    privileges: "DELETE, INSERT, SELECT, UPDATE",
  },
];
const tableRowCounts = {
  omni_auth_memberships: "2",
  omni_schema_version: String(ledgerRows.length),
  omni_threads: "0",
};
const restoredValidation = {
  migrationCount: ledgerRows.length,
  latestMigration: ledgerRows.at(-1)?.version,
  validMigrationCount: ledgerRows.length,
  unknownOrChangedMigrationCount: 0,
  forcedRlsTableCount: 1,
  forcedRlsTables: ["omni_threads"],
  omniTableNames: Object.keys(tableRowCounts),
  tenantCount: 2,
  userCount: 2,
  databaseIdentity: null,
  tableRowCounts,
  runtimeRoleSafe: true,
  tenantIds: ["tenant-a", "tenant-b"],
  tenantMembershipCounts: { "tenant-a": 1, "tenant-b": 1 },
  grants,
};
const unscopedRead = {
  visibleMemberships: 0,
  foreignMemberships: 0,
  ledgerRows: ledgerRows.length,
};
const tenantRead = {
  visibleMemberships: 1,
  foreignMemberships: 0,
  ledgerRows: ledgerRows.length,
};

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

  it("refuses to back up without an encryption key, before it reads the database", async () => {
    const result = await runBackup(ledgerRows, {
      OMNIAGENT_BACKUP_ENCRYPTION_KEY: undefined,
    });

    expect(result.code).toBe(1);
    expect(failureMessage(result.stderr)).toBe(
      "OMNIAGENT_BACKUP_ENCRYPTION_KEY must be 32 random bytes in base64. " +
        "Create one with `openssl rand -base64 32` and keep it apart from the backups.",
    );
    expect(result.queries).toEqual([]);
    expect(fs.existsSync(path.join(directory, "out"))).toBe(false);
  });

  it("refuses to write a backup inside a git checkout", async () => {
    const checkout = path.join(directory, "checkout");
    await mkdir(path.join(checkout, ".git"), { recursive: true });

    const result = await runBackup(ledgerRows, {
      OMNIAGENT_BACKUP_OUTPUT: path.join(checkout, "backups", "backup.dump.enc"),
    });

    expect(result.code).toBe(1);
    expect(failureMessage(result.stderr)).toContain(
      "OMNIAGENT_BACKUP_OUTPUT must be outside a git checkout",
    );
    expect(result.queries).toEqual([]);
    expect(fs.existsSync(path.join(checkout, "backups"))).toBe(false);
  });

  it("keeps backups in a private directory in the home directory by default", async () => {
    const result = await runBackup(ledgerRows, { OMNIAGENT_BACKUP_OUTPUT: undefined });
    const backups = path.join(directory, ".asael", "backups");

    // It fails once it opens its snapshot, with the directory prepared.
    expect(result.code).toBe(1);
    expect(result.queries).toContain("forced-rls");
    expect((await stat(backups)).mode & 0o777).toBe(0o700);
    expect(await readdir(backups)).toEqual([]);
  });
});

describe("database restore drill", () => {
  it("restores an encrypted backup with its grants and reads it as the runtime role", async () => {
    const result = await runRestoreDrill();

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    // pg_restore saw the decrypted archive, grants included.
    expect(result.restores).toHaveLength(2);
    expect(result.restores[0]).toMatch(/^--list \S+\/\.asael-restore-[^/]+\/backup\.dump$/);
    expect(result.restores[1]).toContain("--no-owner");
    expect(result.restores[1]).not.toContain("--no-acl");
    expect((await readFile(path.join(result.root, "restored.dump"))).equals(archive)).toBe(
      true,
    );
    const list = await readFile(path.join(result.root, "restore.list"), "utf8");
    expect(list).toContain("; excluded 3; 2615 2200 SCHEMA - public pg_database_owner");
    expect(list).toContain("\n215; 1259 16390 TABLE public omni_threads postgres");
    expect(result.queries).toEqual([
      "missing-roles",
      "validation",
      "unscoped-read",
      "tenant-read",
      "tenant-read",
    ]);
    expect(result.workDirectories).toEqual([]);

    const evidenceFile = `${result.backup}.restore-evidence.json`;
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    expect((await stat(evidenceFile)).mode & 0o777).toBe(0o600);
    expect(evidence).toMatchObject({
      grants: { checked: 2 },
      runtimeSmoke: {
        role: "omni_runtime",
        unscopedMembershipsVisible: 0,
        tenantsChecked: 2,
      },
      recovery: { objectiveSeconds: 3600 },
    });
    expect(evidence.validation).not.toHaveProperty("grants");
    expect(evidence.recovery.restoreSeconds).toBeLessThan(60);
    expect(evidence.recovery.backupAgeSeconds).toBeGreaterThanOrEqual(60);
  });

  it("rejects a backup manifest whose ledger rows differ from schema-migrations.json", async () => {
    const result = await runRestoreDrill({
      manifest: { schemaMigrations: changedLedgerRows },
    });

    expect(result.code).toBe(1);
    expect(failureMessage(result.stderr)).toBe(
      "Backup manifest format, digest, or schema migration metadata is invalid.",
    );
    expect(result.restores).toEqual([]);
  });

  it("refuses a backup its manifest, key, or tag does not vouch for", async () => {
    const otherKey = randomBytes(32).toString("base64");
    const flipCiphertextByte = (bytes: Buffer) => {
      const changed = Buffer.from(bytes);
      changed[100] ^= 0x01;
      return changed;
    };

    for (const [options, expected] of [
      [
        { manifest: { manifestVersion: undefined, encryption: undefined } },
        "The backup predates encrypted backups; take a new one with npm run db:backup.",
      ],
      [
        { manifest: { manifestVersion: 1 } },
        "The backup predates encrypted backups; take a new one with npm run db:backup.",
      ],
      [
        { manifest: { grants: undefined } },
        "Backup manifest format, digest, or schema migration metadata is invalid.",
      ],
      [
        { manifest: { grantRoles: [""] } },
        "Backup manifest format, digest, or schema migration metadata is invalid.",
      ],
      [{ manifest: { bytes: 1 } }, "Backup size mismatch: expected 1 bytes, found "],
      [
        { manifest: { sha256: "0".repeat(64) } },
        "Backup SHA-256 digest does not match its manifest.",
      ],
      [
        { env: { OMNIAGENT_BACKUP_ENCRYPTION_KEY: otherKey } },
        "OMNIAGENT_BACKUP_ENCRYPTION_KEY is not the key this backup was encrypted with.",
      ],
      [{ change: flipCiphertextByte }, "The backup failed authentication"],
    ] as const) {
      const result = await runRestoreDrill(options);

      expect(result.code, expected).toBe(1);
      expect(failureMessage(result.stderr)).toContain(expected);
      expect(result.queries, expected).toEqual([]);
      expect(result.restores, expected).toEqual([]);
      expect(result.workDirectories, expected).toEqual([]);
    }
  });

  it("refuses to start without a key, a whole-second objective, or a backup outside a checkout", async () => {
    for (const [options, expected] of [
      [
        { env: { OMNIAGENT_BACKUP_ENCRYPTION_KEY: undefined } },
        "OMNIAGENT_BACKUP_ENCRYPTION_KEY must be 32 random bytes in base64.",
      ],
      [
        { env: { OMNIAGENT_RESTORE_RTO_SECONDS: "0" } },
        "OMNIAGENT_RESTORE_RTO_SECONDS must be a whole number of seconds.",
      ],
      [
        { env: { OMNIAGENT_RESTORE_RTO_SECONDS: "1.5" } },
        "OMNIAGENT_RESTORE_RTO_SECONDS must be a whole number of seconds.",
      ],
      [
        { env: { OMNIAGENT_RESTORE_RTO_SECONDS: "soon" } },
        "OMNIAGENT_RESTORE_RTO_SECONDS must be a whole number of seconds.",
      ],
      [{ inCheckout: true }, "OMNIAGENT_BACKUP_INPUT must be outside a git checkout"],
    ] as const) {
      const result = await runRestoreDrill(options);

      expect(result.code, expected).toBe(1);
      expect(failureMessage(result.stderr)).toContain(expected);
      expect(result.queries, expected).toEqual([]);
      expect(result.restores, expected).toEqual([]);
      expect(result.workDirectories, expected).toEqual([]);
    }
  });

  it("names every role the restore needs before it touches the target", async () => {
    const result = await runRestoreDrill({
      env: { FAKE_PSQL_MISSING_ROLES: '["anon","omni_runtime"]' },
    });

    expect(result.code).toBe(1);
    expect(failureMessage(result.stderr)).toBe(
      "The restore server lacks roles the backup grants to: anon, omni_runtime. " +
        'Create each first; NOLOGIN is enough, as in CREATE ROLE "anon" NOLOGIN;',
    );
    expect(result.queries).toEqual(["missing-roles"]);
    expect(result.restores).toEqual([]);
    expect(result.workDirectories).toEqual([]);
  });

  it("fails when the restored grants differ from the backup's", async () => {
    const anon = { object: "table omni_threads", grantee: "anon", privileges: "SELECT" };

    for (const [restoredGrants, expected] of [
      [
        [grants[1], anon],
        "Restored grants do not match the backup: 1 missing " +
          "(first: table omni_schema_version to omni_runtime: SELECT), 1 unexpected " +
          "(first: table omni_threads to anon: SELECT).",
      ],
      [
        [...grants, anon],
        "Restored grants do not match the backup: 0 missing, 1 unexpected " +
          "(first: table omni_threads to anon: SELECT).",
      ],
    ] as const) {
      const result = await runRestoreDrill({ validation: { grants: restoredGrants } });

      expect(result.code, expected).toBe(1);
      expect(failureMessage(result.stderr)).toBe(expected);
      expect(result.queries, expected).not.toContain("unscoped-read");
      expect(fs.existsSync(`${result.backup}.restore-evidence.json`), expected).toBe(false);
      expect(result.workDirectories, expected).toEqual([]);
    }
  });

  it("fails unless the runtime role reads exactly its own tenant's rows", async () => {
    for (const [options, expected] of [
      [
        { validation: { runtimeRoleSafe: false } },
        "The restored database has no omni_runtime role that row-level security binds",
      ],
      [
        { env: { FAKE_PSQL_UNSCOPED_READ: JSON.stringify({ ...unscopedRead, visibleMemberships: 2 }) } },
        "omni_runtime without a tenant saw 2 memberships",
      ],
      [
        { env: { FAKE_PSQL_UNSCOPED_READ: JSON.stringify({ ...unscopedRead, ledgerRows: 0 }) } },
        `and 0 of ${ledgerRows.length} migration markers`,
      ],
      [
        { env: { FAKE_PSQL_TENANT_READ: JSON.stringify({ ...tenantRead, foreignMemberships: 1 }) } },
        "1 of other tenants",
      ],
      [
        { env: { FAKE_PSQL_TENANT_READ: JSON.stringify({ ...tenantRead, visibleMemberships: 0 }) } },
        "saw 0 of its 1 memberships",
      ],
      [
        { env: { FAKE_PSQL_TENANT_READ: JSON.stringify({ ...tenantRead, ledgerRows: 1 }) } },
        `and 1 of ${ledgerRows.length} migration markers`,
      ],
    ] as const) {
      const result = await runRestoreDrill(options);

      expect(result.code, expected).toBe(1);
      expect(failureMessage(result.stderr)).toContain(expected);
      expect(fs.existsSync(`${result.backup}.restore-evidence.json`), expected).toBe(false);
      expect(result.workDirectories, expected).toEqual([]);
    }
  });

  it("fails a restore slower than its recovery time objective", async () => {
    const result = await runRestoreDrill({
      env: { OMNIAGENT_RESTORE_RTO_SECONDS: "1", FAKE_PG_RESTORE_SLEEP: "2" },
    });

    expect(result.code).toBe(1);
    expect(failureMessage(result.stderr)).toMatch(
      /^The restore took [2-9] seconds, over its 1-second recovery time objective \(OMNIAGENT_RESTORE_RTO_SECONDS\)\.$/,
    );
    // Every check ran; only the time failed.
    expect(result.queries.at(-1)).toBe("tenant-read");
    expect(fs.existsSync(`${result.backup}.restore-evidence.json`)).toBe(false);
    expect(result.workDirectories).toEqual([]);
  });

  it("removes the decrypted archive when it is stopped mid-restore", async () => {
    let stopped: Promise<void> = Promise.resolve();
    const result = await runRestoreDrill({
      env: { FAKE_PG_RESTORE_SLEEP: "5" },
      onSpawn: (child, { restoreLog }) => {
        stopped = (async () => {
          // pg_restore is running on the decrypted archive once it logs twice.
          await waitFor(() => lines(restoreLog).length === 2);
          if (child.pid !== undefined && child.pid > 1) {
            child.kill("SIGTERM");
          }
        })();
      },
    });
    await stopped;

    expect(result.code).toBe(1);
    expect(result.restores).toHaveLength(2);
    expect(result.workDirectories).toEqual([]);
    expect(fs.existsSync(`${result.backup}.restore-evidence.json`)).toBe(false);
  });
});

async function writeFakeBin(root: string) {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const [name, script] of [
    ["psql", FAKE_PSQL],
    ["pg_restore", FAKE_PG_RESTORE],
  ]) {
    await writeFile(path.join(bin, name), script);
    await chmod(path.join(bin, name), 0o755);
  }
  return bin;
}

async function runBackup(ledger: unknown, overrides: EnvironmentChanges = {}) {
  const bin = await writeFakeBin(directory);
  const ledgerFile = path.join(directory, "ledger.json");
  const queryLog = path.join(directory, "queries.log");
  await writeFile(ledgerFile, JSON.stringify(ledger));
  await writeFile(queryLog, "");
  const result = await runScript("scripts/db-backup.mjs", {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    NODE_ENV: "test",
    // Nothing listens here; the script fails once it opens its snapshot.
    DATABASE_URL: "postgres://backup:unused@127.0.0.1:1/prod?sslmode=disable",
    OMNIAGENT_BACKUP_ENCRYPTION_KEY: encryptionKey,
    OMNIAGENT_BACKUP_OUTPUT: path.join(directory, "out", "backup.dump.enc"),
    FAKE_PSQL_LEDGER: ledgerFile,
    FAKE_PSQL_LOG: queryLog,
    ...overrides,
  });
  return { ...result, queries: lines(queryLog) };
}

async function runRestoreDrill(
  options: {
    manifest?: Record<string, unknown>;
    validation?: Record<string, unknown>;
    env?: EnvironmentChanges;
    change?: (encrypted: Buffer) => Buffer;
    inCheckout?: boolean;
    onSpawn?: (child: ChildProcess, paths: { restoreLog: string }) => void;
  } = {},
) {
  const root = await mkdtemp(path.join(directory, "drill-"));
  const backups = options.inCheckout
    ? path.join(root, "checkout", "backups")
    : path.join(root, "backups");
  await mkdir(backups, { recursive: true });
  if (options.inCheckout) {
    await mkdir(path.join(root, "checkout", ".git"));
  }
  const backup = path.join(backups, "backup.dump.enc");
  await pipeline(
    Readable.from([archive]),
    createBackupEncryptionStream(parseBackupEncryptionKey(encryptionKey)),
    fs.createWriteStream(backup),
  );
  const encrypted = await readFile(backup);
  const written = options.change ? options.change(encrypted) : encrypted;
  await writeFile(backup, written);
  await writeFile(
    `${backup}.manifest.json`,
    JSON.stringify({
      manifestVersion: 2,
      format: "postgres-custom",
      encryption: {
        algorithm: "aes-256-gcm",
        keyId: backupEncryptionKeyId(parseBackupEncryptionKey(encryptionKey)),
      },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      file: path.basename(backup),
      bytes: written.length,
      sha256: createHash("sha256").update(written).digest("hex"),
      sourceRevision: null,
      sourceDatabaseIdentity: {
        database: "prod",
        configuredEndpointSha256: "a".repeat(64),
      },
      schemaMigrations: ledgerRows,
      forcedRlsTables: ["omni_threads"],
      excludedTableData: [],
      tableRowCounts,
      grants,
      grantRoles: ["omni_runtime"],
      ...options.manifest,
    }),
  );

  const bin = await writeFakeBin(root);
  const queryLog = path.join(root, "queries.log");
  const restoreLog = path.join(root, "restores.log");
  const validationFile = path.join(root, "validation.json");
  await writeFile(queryLog, "");
  await writeFile(restoreLog, "");
  await writeFile(
    validationFile,
    JSON.stringify({ ...restoredValidation, ...options.validation }),
  );
  const result = await runScript(
    "scripts/db-restore-drill.mjs",
    {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      NODE_ENV: "test",
      OMNIAGENT_BACKUP_INPUT: backup,
      OMNIAGENT_BACKUP_ENCRYPTION_KEY: encryptionKey,
      RESTORE_DATABASE_URL: "postgres://restore:unused@127.0.0.1:1/restore_drill",
      DATABASE_URL: "postgres://app:unused@127.0.0.1:2/prod",
      RESTORE_CONFIRM: "restore-into-isolated-database:restore_drill",
      FAKE_PSQL_LOG: queryLog,
      FAKE_PSQL_VALIDATION: validationFile,
      FAKE_PSQL_UNSCOPED_READ: JSON.stringify(unscopedRead),
      FAKE_PSQL_TENANT_READ: JSON.stringify(tenantRead),
      FAKE_PG_RESTORE_LOG: restoreLog,
      FAKE_PG_RESTORE_COPY: path.join(root, "restored.dump"),
      FAKE_PG_RESTORE_LIST_COPY: path.join(root, "restore.list"),
      ...options.env,
    },
    (child) => options.onSpawn?.(child, { restoreLog }),
  );
  return {
    ...result,
    root,
    backup,
    queries: lines(queryLog),
    restores: lines(restoreLog),
    workDirectories: (await readdir(backups)).filter((name) =>
      name.startsWith(".asael-restore-"),
    ),
  };
}

function lines(file: string) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

// The message a script reported with its last line of standard error.
function failureMessage(stderr: string) {
  const line = stderr.trim().split("\n").at(-1) ?? "";
  try {
    return String(JSON.parse(line).message);
  } catch {
    return line;
  }
}

async function waitFor(ready: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the drill.");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function runScript(
  script: string,
  env: NodeJS.ProcessEnv,
  onSpawn?: (child: ChildProcess) => void,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      // Only what the script needs, so no real database URL reaches it.
      env: { HOME: directory, TMPDIR: directory, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    onSpawn?.(child);
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
