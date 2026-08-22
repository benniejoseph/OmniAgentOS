#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const schemaMigrations = JSON.parse(
  await readFile(new URL("../schema-migrations.json", import.meta.url), "utf8"),
);
if (
  !Array.isArray(schemaMigrations) ||
  !Number.isSafeInteger(schemaMigrations.at(-1)?.version) ||
  !schemaMigrations.every(
    (migration, index) =>
      Number.isSafeInteger(migration.version) &&
      migration.version === index + 1 &&
      typeof migration.name === "string" &&
      /^[a-f0-9]{64}$/.test(migration.checksum),
  )
) {
  fail("schema-migrations.json is invalid.");
}

const backupInput = path.resolve(process.env.OMNIAGENT_BACKUP_INPUT || "");
const restoreUrl = process.env.RESTORE_DATABASE_URL?.trim();
const productionUrl = process.env.DATABASE_URL?.trim();
const confirmation = process.env.RESTORE_CONFIRM;

if (!process.env.OMNIAGENT_BACKUP_INPUT) {
  fail("OMNIAGENT_BACKUP_INPUT is required.");
}
if (!restoreUrl) {
  fail("RESTORE_DATABASE_URL is required.");
}
if (!productionUrl) {
  fail("DATABASE_URL is required so the restore target can be compared with production.");
}
const restoreDatabaseName = databaseName(restoreUrl);
if (confirmation !== `restore-into-isolated-database:${restoreDatabaseName}`) {
  fail(
    `Set RESTORE_CONFIRM="restore-into-isolated-database:${restoreDatabaseName}" ` +
      "to acknowledge the exact destructive target.",
  );
}
if (
  databaseIdentity(productionUrl) === databaseIdentity(restoreUrl) ||
  databaseName(productionUrl) === restoreDatabaseName
) {
  fail("RESTORE_DATABASE_URL must not identify the configured production database.");
}

await access(backupInput);
const manifestPath = `${backupInput}.manifest.json`;
const backupManifest = await readAndVerifyManifest(manifestPath, backupInput);
const backupMigrations = backupManifest.schemaMigrations;
const latestSchemaVersion = backupMigrations.at(-1).version;
const expectedMigrationPredicate = backupMigrations
  .map(
    (migration) =>
      `(version = ${migration.version} AND name = ${sqlLiteral(migration.name)} ` +
      `AND checksum = ${sqlLiteral(migration.checksum)})`,
  )
  .join(" OR ");
const expectedTableRowCounts = backupManifest.tableRowCounts;
const expectedTableNames = Object.keys(expectedTableRowCounts).sort();
const expectedForcedRlsTables = backupManifest.forcedRlsTables;
const restoredTableRowCountsExpression = tableRowCountsSql(
  expectedTableRowCounts,
);
const restoredDatabaseIdentityExpression = backupManifest.sourceDatabaseIdentity
  .omniDatabaseId
  ? "(SELECT id FROM omni_database_identity WHERE singleton = TRUE)"
  : "NULL";
const startedAt = new Date();
const restoreEnvironment = postgresEnvironment(restoreUrl);

try {
  await run("pg_restore", [
    "--exit-on-error",
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-acl",
    "--dbname",
    restoreEnvironment.PGDATABASE,
    backupInput,
  ], restoreEnvironment);

  const validationText = await runCapture("psql", [
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    `
      SELECT json_build_object(
        'migrationCount', (
          SELECT COUNT(*)::int
          FROM omni_schema_version
          WHERE version IS NOT NULL
        ),
        'latestMigration', (
          SELECT COALESCE(MAX(version), 0)::int
          FROM omni_schema_version
        ),
        'validMigrationCount', (
          SELECT COUNT(*)::int
          FROM omni_schema_version
          WHERE version IS NOT NULL
            AND (${expectedMigrationPredicate})
        ),
        'unknownOrChangedMigrationCount', (
          SELECT COUNT(*)::int
          FROM omni_schema_version
          WHERE version IS NOT NULL
            AND NOT (${expectedMigrationPredicate})
        ),
        'forcedRlsTableCount', (
          SELECT COUNT(*)::int
          FROM pg_class
          WHERE relnamespace = 'public'::regnamespace
            AND relname LIKE 'omni_%'
            AND relrowsecurity
            AND relforcerowsecurity
        ),
        'forcedRlsTables', (
          SELECT COALESCE(
            json_agg(relname ORDER BY relname),
            '[]'::json
          )
          FROM pg_class
          WHERE relnamespace = 'public'::regnamespace
            AND relkind = 'r'
            AND relname LIKE 'omni_%'
            AND relrowsecurity
            AND relforcerowsecurity
        ),
        'omniTableNames', (
          SELECT COALESCE(
            json_agg(tablename ORDER BY tablename),
            '[]'::json
          )
          FROM pg_tables
          WHERE schemaname = 'public'
            AND tablename LIKE 'omni_%'
        ),
        'tenantCount', (SELECT COUNT(*)::int FROM omni_auth_tenants),
        'userCount', (SELECT COUNT(*)::int FROM omni_auth_users),
        'databaseIdentity', ${restoredDatabaseIdentityExpression},
        'tableRowCounts', ${restoredTableRowCountsExpression}
      );
    `,
  ], restoreEnvironment);
  const validation = JSON.parse(validationText.trim());
  if (
    validation.migrationCount !== backupMigrations.length ||
    validation.latestMigration !== latestSchemaVersion ||
    validation.validMigrationCount !== backupMigrations.length ||
    validation.unknownOrChangedMigrationCount !== 0
  ) {
    throw new Error(
      "Restored database migration markers do not match this release.",
    );
  }
  if (
    JSON.stringify(validation.omniTableNames) !==
    JSON.stringify(expectedTableNames)
  ) {
    throw new Error(
      "Restored OmniAgent table inventory does not match the backup.",
    );
  }
  if (
    validation.forcedRlsTableCount !== expectedForcedRlsTables.length ||
    JSON.stringify(validation.forcedRlsTables) !==
      JSON.stringify(expectedForcedRlsTables)
  ) {
    throw new Error(
      "Restored forced-RLS inventory does not match the backup.",
    );
  }
  if (
    JSON.stringify(validation.tableRowCounts) !==
    JSON.stringify(expectedTableRowCounts)
  ) {
    throw new Error(
      "Restored table row counts do not match the source backup inventory.",
    );
  }
  if (
    backupManifest.sourceDatabaseIdentity.omniDatabaseId &&
    validation.databaseIdentity !==
      backupManifest.sourceDatabaseIdentity.omniDatabaseId
  ) {
    throw new Error(
      "Restored OmniAgent database identity does not match the backup source.",
    );
  }

  const evidence = {
    completedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    backup: backupManifest,
    target: databaseIdentity(restoreUrl),
    validation,
  };
  const evidenceOutput = path.resolve(
    process.env.OMNIAGENT_RESTORE_EVIDENCE_OUTPUT ||
      `${backupInput}.restore-evidence.json`,
  );
  await writeFile(evidenceOutput, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({
    level: "info",
    message: "Database restore drill passed.",
    evidenceOutput,
    validation,
  }));
} catch (error) {
  fail(error instanceof Error ? error.message : "Database restore drill failed.");
}

async function readAndVerifyManifest(manifestPath, backupFile) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error(`A valid backup manifest is required at ${manifestPath}.`);
  }
  if (
    manifest?.format !== "postgres-custom" ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes <= 0 ||
    !/^[a-f0-9]{64}$/i.test(String(manifest.sha256 || "")) ||
    !isSchemaMigrationPrefix(manifest.schemaMigrations) ||
    !isTableNameInventory(manifest.forcedRlsTables) ||
    !isTableRowCountInventory(manifest.tableRowCounts) ||
    !isSourceDatabaseIdentity(manifest.sourceDatabaseIdentity)
  ) {
    throw new Error(
      "Backup manifest format, digest, or schema migration metadata is invalid.",
    );
  }
  const file = await stat(backupFile);
  if (file.size !== manifest.bytes) {
    throw new Error(`Backup size mismatch: expected ${manifest.bytes} bytes, found ${file.size}.`);
  }
  const actualSha256 = await hashFile(backupFile);
  if (actualSha256.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
    throw new Error("Backup SHA-256 digest does not match its manifest.");
  }
  return { ...manifest, verifiedAt: new Date().toISOString() };
}

function isSchemaMigrationPrefix(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= schemaMigrations.length &&
    JSON.stringify(value) ===
      JSON.stringify(schemaMigrations.slice(0, value.length))
  );
}

function isTableRowCountInventory(value) {
  const entries =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
      : [];
  return (
    entries.length > 0 &&
    entries.every(
      ([tableName, count]) =>
        /^omni_[a-z0-9_]+$/.test(tableName) &&
        /^(0|[1-9][0-9]*)$/.test(String(count)),
    )
  );
}

function isTableNameInventory(value) {
  return (
    Array.isArray(value) &&
    value.every((tableName) => /^omni_[a-z0-9_]+$/.test(String(tableName))) &&
    JSON.stringify(value) === JSON.stringify([...value].sort())
  );
}

function isSourceDatabaseIdentity(value) {
  return Boolean(
    value &&
      typeof value.database === "string" &&
      value.database.trim() &&
      (
        /^[a-f0-9]{32}$/i.test(String(value.omniDatabaseId || "")) ||
        /^[0-9]+$/.test(String(value.systemIdentifier || "")) ||
        (
          typeof value.configuredEndpoint === "string" &&
          /^[^/\s]+:[0-9]+\/[^/\s]+$/.test(value.configuredEndpoint)
        )
      ),
  );
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function databaseIdentity(value) {
  const url = new URL(value);
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${decodeURIComponent(url.pathname.replace(/^\//, ""))}`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function tableRowCountsSql(expectedCounts) {
  const fields = Object.keys(expectedCounts)
    .sort()
    .flatMap((tableName) => [
      sqlLiteral(tableName),
      `(SELECT COUNT(*)::text FROM ${quoteIdentifier(tableName)})`,
    ]);
  return `json_build_object(${fields.join(", ")})`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function databaseName(value) {
  const url = new URL(value);
  const name = decodeURIComponent(url.pathname.replace(/^\//, "")).trim().toLowerCase();
  if (!name) {
    throw new Error("Database URLs must include a database name.");
  }
  return name;
}

function postgresEnvironment(value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Database URLs must use postgres:// or postgresql://.");
  }
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    PGSSLMODE: url.searchParams.get("sslmode") || "require",
  };
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} failed (${signal || `exit ${code}`}).`));
      }
    });
  });
}

function runCapture(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 1_000_000) {
        child.kill("SIGTERM");
        reject(new Error(`${command} output exceeded 1 MB.`));
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${command} failed (${signal || `exit ${code}`}).`));
      }
    });
  });
}

function fail(message) {
  console.error(JSON.stringify({ level: "error", message }));
  process.exit(1);
}
