#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import postgres from "postgres";

const schemaMigrations = JSON.parse(
  await readFile(new URL("../schema-migrations.json", import.meta.url), "utf8"),
);
assertSchemaMigrationManifest(schemaMigrations);

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  fail("DATABASE_URL is required.");
}
const backupDatabaseUrl =
  process.env.OMNIAGENT_BACKUP_DATABASE_URL?.trim() || databaseUrl;
if (
  process.env.NODE_ENV === "production" &&
  !process.env.OMNIAGENT_BACKUP_DATABASE_URL?.trim()
) {
  fail(
    "OMNIAGENT_BACKUP_DATABASE_URL is required in production; use a dedicated backup role with BYPASSRLS.",
  );
}

const createdAt = new Date();
const output = path.resolve(
  process.env.OMNIAGENT_BACKUP_OUTPUT ||
    path.join("backups", `omniagent-${createdAt.toISOString().replace(/[:.]/g, "-")}.dump`),
);
const temporaryOutput = `${output}.partial-${process.pid}`;
const manifestOutput = `${output}.manifest.json`;

await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await rm(temporaryOutput, { force: true });

try {
  await assertBackupRole(backupDatabaseUrl);
  const sourceDatabaseIdentity = await assertSameDatabase(
    databaseUrl,
    backupDatabaseUrl,
  );
  const sourceSchemaMigrations = await readDatabaseSchemaState(backupDatabaseUrl);
  const sourceForcedRlsTables = await readDatabaseForcedRlsTables(
    backupDatabaseUrl,
  );
  const snapshotClient = postgres(backupDatabaseUrl, {
    max: 1,
    connect_timeout: 30,
    idle_timeout: 0,
    ssl: "require",
  });
  let sourceTableRowCounts;
  try {
    await snapshotClient.begin(
      "ISOLATION LEVEL REPEATABLE READ READ ONLY",
      async (sql) => {
        const [snapshot] =
          await sql`SELECT pg_export_snapshot() AS snapshot_id`;
        sourceTableRowCounts = await readDatabaseTableRowCountsFromSql(sql);
        await run("pg_dump", [
          "--format=custom",
          "--compress=9",
          "--schema=public",
          "--no-owner",
          "--no-acl",
          "--snapshot",
          snapshot.snapshot_id,
          "--file",
          temporaryOutput,
        ], postgresEnvironment(backupDatabaseUrl));
      },
    );
  } finally {
    await snapshotClient.end({ timeout: 5 });
  }
  if (!sourceTableRowCounts) {
    throw new Error("Database snapshot row counts were not captured.");
  }
  await chmod(temporaryOutput, 0o600);
  await rename(temporaryOutput, output);

  const file = await stat(output);
  const manifest = {
    format: "postgres-custom",
    createdAt: createdAt.toISOString(),
    file: output,
    bytes: file.size,
    sha256: await hashFile(output),
    sourceRevision:
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.GITHUB_SHA ||
      process.env.OMNIAGENT_RELEASE_SHA ||
      null,
    sourceDatabase: databaseIdentity(backupDatabaseUrl),
    sourceDatabaseIdentity,
    schemaMigrations: sourceSchemaMigrations,
    forcedRlsTables: sourceForcedRlsTables,
    tableRowCounts: sourceTableRowCounts,
  };
  await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ level: "info", message: "Database backup completed.", ...manifest }));
} catch (error) {
  await rm(temporaryOutput, { force: true });
  fail(error instanceof Error ? error.message : "Database backup failed.");
}

function postgresEnvironment(value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  }
  if (
    process.env.NODE_ENV === "production" &&
    url.searchParams.get("sslmode")?.toLowerCase() === "disable"
  ) {
    throw new Error("Backup database connections cannot disable TLS in production.");
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

async function assertBackupRole(value) {
  const output = await runCapture(
    "psql",
    [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--command",
      "SELECT CASE WHEN rolbypassrls AND NOT rolsuper THEN 'safe' ELSE 'unsafe' END FROM pg_roles WHERE rolname = current_user",
    ],
    postgresEnvironment(value),
  );
  if (output.trim() !== "safe") {
    throw new Error(
      "Backup role must be a non-superuser dedicated role with BYPASSRLS. Configure OMNIAGENT_BACKUP_DATABASE_URL accordingly.",
    );
  }
}

async function readDatabaseSchemaState(value) {
  const environment = postgresEnvironment(value);
  const columnsOutput = await runCapture(
    "psql",
    [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      `
        SELECT COALESCE(
          json_agg(column_name ORDER BY ordinal_position),
          '[]'::json
        )::text
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'omni_schema_version';
      `,
    ],
    environment,
  );
  const columns = JSON.parse(columnsOutput.trim());
  if (
    JSON.stringify(columns) === JSON.stringify(["applied_at"])
  ) {
    const markerCount = Number(
      (
        await runCapture(
          "psql",
          [
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "--set",
            "ON_ERROR_STOP=1",
            "--command",
            "SELECT COUNT(*)::int FROM omni_schema_version",
          ],
          environment,
        )
      ).trim(),
    );
    if (markerCount < 1) {
      throw new Error("The legacy database migration marker is empty.");
    }
    return [];
  }
  if (
    !Array.isArray(columns) ||
    !["version", "name", "checksum", "applied_at"].every((column) =>
      columns.includes(column),
    )
  ) {
    throw new Error("Database migration marker columns are not recognized.");
  }
  const output = await runCapture(
    "psql",
    [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      `
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'version', version,
              'name', name,
              'checksum', checksum
            )
            ORDER BY version
          ) FILTER (WHERE version IS NOT NULL),
          '[]'::json
        )::text
        FROM omni_schema_version;
      `,
    ],
    environment,
  );
  const state = JSON.parse(output.trim());
  const expectedPrefix = schemaMigrations.slice(0, state.length);
  if (
    !Array.isArray(state) ||
    state.length > schemaMigrations.length ||
    JSON.stringify(state) !== JSON.stringify(expectedPrefix)
  ) {
    throw new Error(
      "Database migration markers are not a valid contiguous prefix of schema-migrations.json.",
    );
  }
  return state;
}

async function assertSameDatabase(runtimeUrl, backupUrl) {
  const [runtimeIdentity, backupIdentity] = await Promise.all([
    readLiveDatabaseIdentity(runtimeUrl),
    readLiveDatabaseIdentity(backupUrl),
  ]);
  const sameOmniDatabase = Boolean(
    runtimeIdentity.omniDatabaseId &&
      backupIdentity.omniDatabaseId &&
      runtimeIdentity.omniDatabaseId === backupIdentity.omniDatabaseId,
  );
  const sameServerDatabase = Boolean(
    runtimeIdentity.systemIdentifier &&
      backupIdentity.systemIdentifier &&
      runtimeIdentity.systemIdentifier === backupIdentity.systemIdentifier &&
      runtimeIdentity.database === backupIdentity.database,
  );
  const physicalIdentityAvailable = Boolean(
    runtimeIdentity.systemIdentifier && backupIdentity.systemIdentifier,
  );
  const logicalIdentityAvailable = Boolean(
    runtimeIdentity.omniDatabaseId && backupIdentity.omniDatabaseId,
  );
  const sameConfiguredEndpoint =
    runtimeIdentity.configuredEndpoint === backupIdentity.configuredEndpoint &&
    runtimeIdentity.database === backupIdentity.database;
  const sameDatabase = physicalIdentityAvailable
    ? sameServerDatabase &&
      (!logicalIdentityAvailable || sameOmniDatabase)
    : logicalIdentityAvailable
      ? sameOmniDatabase
      : sameConfiguredEndpoint;
  if (!sameDatabase) {
    throw new Error(
      "OMNIAGENT_BACKUP_DATABASE_URL does not identify the DATABASE_URL database.",
    );
  }
  return backupIdentity;
}

async function readLiveDatabaseIdentity(value) {
  const environment = postgresEnvironment(value);
  const database = (
    await runCapture(
      "psql",
      [
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        "SELECT current_database()",
      ],
      environment,
    )
  ).trim();
  const hasOmniIdentity =
    (
      await runCapture(
        "psql",
        [
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--set",
          "ON_ERROR_STOP=1",
          "--command",
          "SELECT to_regclass('public.omni_database_identity') IS NOT NULL",
        ],
        environment,
      )
    ).trim() === "t";
  const omniDatabaseId = hasOmniIdentity
    ? (
        await runCapture(
          "psql",
          [
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "--set",
            "ON_ERROR_STOP=1",
            "--command",
            "SELECT id FROM omni_database_identity WHERE singleton = TRUE",
          ],
          environment,
        )
      ).trim() || undefined
    : undefined;
  let systemIdentifier;
  try {
    systemIdentifier = (
      await runCapture(
        "psql",
        [
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--set",
          "ON_ERROR_STOP=1",
          "--command",
          "SELECT system_identifier::text FROM pg_control_system()",
        ],
        environment,
      )
    ).trim();
  } catch (error) {
    if (!omniDatabaseId) {
      throw error;
    }
  }
  return {
    database,
    configuredEndpoint: databaseIdentity(value),
    omniDatabaseId,
    systemIdentifier: systemIdentifier || undefined,
  };
}

async function readDatabaseTableRowCountsFromSql(sql) {
  const tableRows = await sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE 'omni_%'
    ORDER BY tablename
  `;
  const tableNames = tableRows.map((row) => row.tablename);
  if (
    !Array.isArray(tableNames) ||
    !tableNames.length ||
    tableNames.some((name) => !/^omni_[a-z0-9_]+$/.test(String(name)))
  ) {
    throw new Error("Unable to build a safe Asael table inventory.");
  }
  const counts = {};
  for (const tableName of tableNames) {
    const [row] = await sql.unsafe(
      `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(tableName)}`,
    );
    counts[tableName] = row.count;
  }
  return counts;
}

async function readDatabaseForcedRlsTables(value) {
  const output = await runCapture(
    "psql",
    [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      `
        SELECT COALESCE(
          json_agg(class.relname ORDER BY class.relname),
          '[]'::json
        )::text
        FROM pg_class class
        WHERE class.relnamespace = 'public'::regnamespace
          AND class.relkind = 'r'
          AND class.relname LIKE 'omni_%'
          AND class.relrowsecurity
          AND class.relforcerowsecurity;
      `,
    ],
    postgresEnvironment(value),
  );
  const tables = JSON.parse(output.trim());
  if (
    !Array.isArray(tables) ||
    tables.some((name) => !/^omni_[a-z0-9_]+$/.test(String(name)))
  ) {
    throw new Error("Unable to inventory forced-RLS tables.");
  }
  return tables;
}

function assertSchemaMigrationManifest(value) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every(
      (migration, index) =>
        Number.isSafeInteger(migration.version) &&
        migration.version === index + 1 &&
        typeof migration.name === "string" &&
        /^[a-f0-9]{64}$/.test(migration.checksum),
    )
  ) {
    fail("schema-migrations.json is invalid.");
  }
}

function databaseIdentity(value) {
  const url = new URL(value);
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${decodeURIComponent(
    url.pathname.replace(/^\//, ""),
  ).toLowerCase()}`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
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
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} failed (${signal || `exit ${code}`}).`));
      }
    });
  });
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

function fail(message) {
  console.error(JSON.stringify({ level: "error", message }));
  process.exit(1);
}
