#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  BACKUP_ENCRYPTION_ALGORITHM,
  GRANT_INVENTORY_JSON,
  assertOutsideCheckout,
  backupEncryptionKeyId,
  decryptBackupFile,
  grantDifferences,
  isGrantInventory,
  isRoleNameList,
  parseBackupEncryptionKey,
} from "./db-backup-security.mjs";

const schemaMigrationManifest = JSON.parse(
  await readFile(new URL("../schema-migrations.json", import.meta.url), "utf8"),
);
if (
  !Array.isArray(schemaMigrationManifest) ||
  !Number.isSafeInteger(schemaMigrationManifest.at(-1)?.version) ||
  !schemaMigrationManifest.every(
    (migration, index) =>
      Number.isSafeInteger(migration.version) &&
      migration.version === index + 1 &&
      typeof migration.name === "string" &&
      /^[a-f0-9]{64}$/.test(migration.checksum),
  )
) {
  fail("schema-migrations.json is invalid.");
}
// Backup manifests record the omni_schema_version fields only; a manifest
// entry's `file` and `sha256` only say where the migration's SQL lives and
// what it holds.
const schemaMigrations = schemaMigrationManifest.map(
  ({ version, name, checksum }) => ({ version, name, checksum }),
);

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
let encryptionKey;
try {
  encryptionKey = parseBackupEncryptionKey(
    process.env.OMNIAGENT_BACKUP_ENCRYPTION_KEY,
  );
  await assertOutsideCheckout(backupInput, "OMNIAGENT_BACKUP_INPUT");
} catch (error) {
  fail(error.message);
}
const recoveryTimeObjectiveSeconds = Number(
  process.env.OMNIAGENT_RESTORE_RTO_SECONDS || 3600,
);
if (
  !Number.isSafeInteger(recoveryTimeObjectiveSeconds) ||
  recoveryTimeObjectiveSeconds < 1
) {
  fail("OMNIAGENT_RESTORE_RTO_SECONDS must be a whole number of seconds.");
}
// The role whose privileges the application serves with.
const runtimeRole = "omni_runtime";

// The recovery time runs from here: verifying, decrypting, restoring, and
// checking the backup all count.
const startedAt = new Date();
let backupManifest;
try {
  await access(backupInput);
  backupManifest = await readAndVerifyManifest(
    `${backupInput}.manifest.json`,
    backupInput,
    backupEncryptionKeyId(encryptionKey),
  );
} catch (error) {
  fail(error.message);
}
const backupMigrations = backupManifest.schemaMigrations;
const latestSchemaVersion = backupMigrations.at(-1)?.version || 0;
const expectedMigrationPredicate = backupMigrations
  .map(
    (migration) =>
      `(version = ${migration.version} AND name = ${sqlLiteral(migration.name)} ` +
      `AND checksum = ${sqlLiteral(migration.checksum)})`,
  )
  .join(" OR ") || "FALSE";
const migrationValidationFields = backupMigrations.length
  ? `
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
        )`
  : `
        'migrationCount', 0,
        'latestMigration', 0,
        'validMigrationCount', 0,
        'unknownOrChangedMigrationCount', 0,
        'legacyMigrationColumns', (
          SELECT COALESCE(
            json_agg(column_name ORDER BY ordinal_position),
            '[]'::json
          )
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'omni_schema_version'
        ),
        'legacyMigrationRows', (
          SELECT COUNT(*)::int FROM omni_schema_version
        )`;
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
const restoreEnvironment = postgresEnvironment(restoreUrl);
// The decrypted archive exists only in this owner-only directory, which is
// removed however the drill ends.
const workDirectory = await mkdtemp(
  path.join(path.dirname(backupInput), ".asael-restore-"),
);
const removeWorkDirectory = () =>
  rmSync(workDirectory, { recursive: true, force: true });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    removeWorkDirectory();
    process.exit(1);
  });
}
const restoreInput = path.join(workDirectory, "backup.dump");
const restoreListPath = path.join(workDirectory, "restore.list");

let drillFailure;
try {
  await decryptBackupFile(backupInput, restoreInput, encryptionKey);
  await assertRestoreRoles(backupManifest.grantRoles);
  const archiveList = await runCapture(
    "pg_restore",
    ["--list", restoreInput],
    process.env,
  );
  const restoreList = archiveList
    .split("\n")
    .map((line) =>
      / SCHEMA - public /.test(line) || / COMMENT - SCHEMA public /.test(line)
        ? `; excluded ${line}`
        : line,
    )
    .join("\n");
  await writeFile(restoreListPath, restoreList, {
    encoding: "utf8",
    mode: 0o600,
  });

  const restoreSections = (sections) =>
    run("pg_restore", [
      "--exit-on-error",
      "--clean",
      "--if-exists",
      "--no-owner",
      ...sections.map((section) => `--section=${section}`),
      "--use-list",
      restoreListPath,
      "--dbname",
      restoreEnvironment.PGDATABASE,
      restoreInput,
    ], restoreEnvironment);
  // pg_restore empties search_path. A function whose body names another
  // public function or table without its schema then cannot find it when a
  // CHECK constraint calls it as the data loads, or an index build after. So
  // the definitions load first; then such functions resolve names as the
  // database they were dumped from does until the data and indexes are in,
  // and get the backup's definitions back.
  await restoreSections(["pre-data"]);
  const pinnedFunctions = await pinFunctionSearchPaths();
  await restoreSections(["data", "post-data"]);
  await alterFunctions(pinnedFunctions, "RESET search_path");

  const validationText = await runCapture("psql", [
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    `
      SELECT json_build_object(
        ${migrationValidationFields},
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
        'tableRowCounts', ${restoredTableRowCountsExpression},
        'runtimeRoleSafe', EXISTS (
          SELECT 1
          FROM pg_roles roles
          CROSS JOIN pg_class ledger
          WHERE roles.rolname = ${sqlLiteral(runtimeRole)}
            AND ledger.oid = 'omni_schema_version'::regclass
            AND NOT roles.rolsuper
            AND NOT roles.rolbypassrls
            AND ledger.relowner <> roles.oid
        ),
        'tenantIds', (
          SELECT COALESCE(json_agg(id ORDER BY id), '[]'::json)
          FROM (SELECT id FROM omni_auth_tenants ORDER BY id LIMIT 50) tenants
        ),
        'tenantMembershipCounts', (
          SELECT COALESCE(
            json_object_agg(tenant_id, member_count),
            '{}'::json
          )
          FROM (
            SELECT tenant_id, COUNT(*)::int AS member_count
            FROM omni_auth_memberships
            GROUP BY tenant_id
          ) memberships
        ),
        'grants', ${GRANT_INVENTORY_JSON}
      );
    `,
  ], restoreEnvironment);
  const { grants: restoredGrants, ...validation } = JSON.parse(
    validationText.trim(),
  );
  const migrationMarkersValid = backupMigrations.length
    ? validation.migrationCount === backupMigrations.length &&
      validation.latestMigration === latestSchemaVersion &&
      validation.validMigrationCount === backupMigrations.length &&
      validation.unknownOrChangedMigrationCount === 0
    : JSON.stringify(validation.legacyMigrationColumns) ===
        JSON.stringify(["applied_at"]) &&
      validation.legacyMigrationRows >= 1;
  if (!migrationMarkersValid) {
    throw new Error(
      "Restored database migration markers do not match the backup.",
    );
  }
  if (
    JSON.stringify(validation.omniTableNames) !==
    JSON.stringify(expectedTableNames)
  ) {
    throw new Error(
      "Restored Asael table inventory does not match the backup.",
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
      "Restored Asael database identity does not match the backup source.",
    );
  }
  const grants = grantDifferences(backupManifest.grants, restoredGrants);
  if (grants.missing.length || grants.unexpected.length) {
    throw new Error(
      `Restored grants do not match the backup: ${grants.missing.length} missing` +
        `${grants.missing.length ? ` (first: ${grants.missing[0]})` : ""}, ` +
        `${grants.unexpected.length} unexpected` +
        `${grants.unexpected.length ? ` (first: ${grants.unexpected[0]})` : ""}.`,
    );
  }
  const runtimeSmoke = await readAsRuntimeRole(validation);

  const completedAt = new Date();
  const restoreSeconds = (completedAt.getTime() - startedAt.getTime()) / 1000;
  if (restoreSeconds > recoveryTimeObjectiveSeconds) {
    throw new Error(
      `The restore took ${Math.ceil(restoreSeconds)} seconds, over its ` +
        `${recoveryTimeObjectiveSeconds}-second recovery time objective ` +
        "(OMNIAGENT_RESTORE_RTO_SECONDS).",
    );
  }

  const evidence = {
    completedAt: completedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    backup: backupManifest,
    target: databaseIdentity(restoreUrl),
    validation,
    grants: { checked: restoredGrants.length },
    runtimeSmoke,
    recovery: {
      objectiveSeconds: recoveryTimeObjectiveSeconds,
      restoreSeconds: Math.round(restoreSeconds * 10) / 10,
      backupAgeSeconds: Math.round(
        (completedAt.getTime() - Date.parse(backupManifest.createdAt)) / 1000,
      ),
    },
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
    runtimeSmoke,
    recovery: evidence.recovery,
  }));
} catch (error) {
  drillFailure =
    error instanceof Error ? error.message : "Database restore drill failed.";
} finally {
  removeWorkDirectory();
}
if (drillFailure) {
  fail(drillFailure);
}

// A restore fails partway when a role its grants name is missing, so check
// every one before touching the target.
async function assertRestoreRoles(roles) {
  if (!roles.length) {
    return;
  }
  const missing = JSON.parse(
    (
      await runCapture("psql", [
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        `
          SELECT COALESCE(
            json_agg(required.role_name ORDER BY required.role_name),
            '[]'::json
          )::text
          FROM unnest(ARRAY[${roles.map(sqlLiteral).join(", ")}]::text[])
            AS required(role_name)
          WHERE NOT EXISTS (
            SELECT 1 FROM pg_roles WHERE pg_roles.rolname = required.role_name
          );
        `,
      ], restoreEnvironment)
    ).trim(),
  );
  if (missing.length) {
    throw new Error(
      `The restore server lacks roles the backup grants to: ${missing.join(", ")}. ` +
        `Create each first; NOLOGIN is enough, as in CREATE ROLE ${quoteIdentifier(missing[0])} NOLOGIN;`,
    );
  }
}

// Gives every restored public function that takes its search_path from the
// caller (one an extension owns, or one that sets its own, does not) the
// path the database serves with, and returns their signatures.
async function pinFunctionSearchPaths() {
  const signatures = JSON.parse(
    (
      await runCapture("psql", [
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        `
          SELECT COALESCE(json_agg(signature ORDER BY signature), '[]'::json)::text
          FROM (
            SELECT format(
              '%I.%I(%s)',
              namespace.nspname,
              proc.proname,
              pg_get_function_identity_arguments(proc.oid)
            ) AS signature
            FROM pg_proc proc
            JOIN pg_namespace namespace ON namespace.oid = proc.pronamespace
            WHERE namespace.nspname = 'public'
              AND proc.prokind = 'f'
              AND NOT EXISTS (
                SELECT 1
                FROM pg_depend dependency
                WHERE dependency.classid = 'pg_proc'::regclass
                  AND dependency.objid = proc.oid
                  AND dependency.deptype = 'e'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM unnest(proc.proconfig) AS config(setting)
                WHERE starts_with(config.setting, 'search_path=')
              )
          ) listed;
        `,
      ], restoreEnvironment)
    ).trim(),
  );
  if (
    !Array.isArray(signatures) ||
    !signatures.every((signature) => typeof signature === "string")
  ) {
    throw new Error("The restored function list is not a list of signatures.");
  }
  await alterFunctions(signatures, "SET search_path = public, extensions");
  return signatures;
}

async function alterFunctions(signatures, action) {
  if (!signatures.length) {
    return;
  }
  await run("psql", [
    "--no-psqlrc",
    "--quiet",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    signatures
      .map((signature) => `ALTER FUNCTION ${signature} ${action};`)
      .join("\n"),
  ], restoreEnvironment);
}

// Reads the restored database the way the application does: as the runtime
// role, which row-level security confines to the tenant it is scoped to.
async function readAsRuntimeRole(validation) {
  if (!validation.runtimeRoleSafe) {
    throw new Error(
      `The restored database has no ${runtimeRole} role that row-level security binds: ` +
        "it must exist, not be a superuser, not bypass RLS, and not own the schema.",
    );
  }
  const ledgerRows = Number(expectedTableRowCounts.omni_schema_version);
  const unscoped = await runtimeRead(null);
  if (unscoped.visibleMemberships !== 0 || unscoped.ledgerRows !== ledgerRows) {
    throw new Error(
      `Runtime smoke read failed: ${runtimeRole} without a tenant saw ` +
        `${unscoped.visibleMemberships} memberships and ${unscoped.ledgerRows} of ` +
        `${ledgerRows} migration markers.`,
    );
  }
  for (const tenantId of validation.tenantIds) {
    const scoped = await runtimeRead(tenantId);
    const expected = validation.tenantMembershipCounts[tenantId] ?? 0;
    if (
      scoped.foreignMemberships !== 0 ||
      scoped.visibleMemberships !== expected ||
      scoped.ledgerRows !== ledgerRows
    ) {
      throw new Error(
        `Runtime smoke read failed: ${runtimeRole} scoped to one tenant saw ` +
          `${scoped.visibleMemberships} of its ${expected} memberships, ` +
          `${scoped.foreignMemberships} of other tenants, and ` +
          `${scoped.ledgerRows} of ${ledgerRows} migration markers.`,
      );
    }
  }
  return {
    role: runtimeRole,
    unscopedMembershipsVisible: unscoped.visibleMemberships,
    tenantsChecked: validation.tenantIds.length,
  };
}

async function runtimeRead(tenantId) {
  const tenant = tenantId === null ? "NULL" : sqlLiteral(tenantId);
  let output;
  try {
    // The open read-only transaction ends when psql disconnects.
    output = await runCapture("psql", [
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      `
        BEGIN READ ONLY;
        SET LOCAL ROLE ${quoteIdentifier(runtimeRole)};
        ${tenantId === null ? "" : `SET LOCAL omni.tenant_id = ${tenant};`}
        SELECT json_build_object(
          'visibleMemberships', (SELECT COUNT(*)::int FROM omni_auth_memberships),
          'foreignMemberships', (
            SELECT COUNT(*)::int
            FROM omni_auth_memberships
            WHERE tenant_id IS DISTINCT FROM ${tenant}
          ),
          'ledgerRows', (SELECT COUNT(*)::int FROM omni_schema_version)
        )::text;
      `,
    ], restoreEnvironment);
  } catch (error) {
    throw new Error(
      `Runtime smoke read failed; the restore user must be able to SET ROLE ${runtimeRole}: ${error.message}`,
    );
  }
  return JSON.parse(output.trim().split("\n").at(-1));
}

async function readAndVerifyManifest(manifestPath, backupFile, keyId) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error(`A valid backup manifest is required at ${manifestPath}.`);
  }
  if (
    manifest?.manifestVersion !== 2 ||
    manifest.encryption?.algorithm !== BACKUP_ENCRYPTION_ALGORITHM ||
    !/^[a-f0-9]{16}$/.test(String(manifest.encryption?.keyId || ""))
  ) {
    throw new Error(
      "The backup predates encrypted backups; take a new one with npm run db:backup.",
    );
  }
  if (
    manifest.format !== "postgres-custom" ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes <= 0 ||
    !/^[a-f0-9]{64}$/i.test(String(manifest.sha256 || "")) ||
    !isSchemaMigrationPrefix(manifest.schemaMigrations) ||
    !isTableNameInventory(manifest.forcedRlsTables) ||
    !isTableRowCountInventory(manifest.tableRowCounts) ||
    !isSourceDatabaseIdentity(manifest.sourceDatabaseIdentity) ||
    !isGrantInventory(manifest.grants) ||
    !isRoleNameList(manifest.grantRoles)
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
  if (manifest.encryption.keyId !== keyId) {
    throw new Error(
      "OMNIAGENT_BACKUP_ENCRYPTION_KEY is not the key this backup was encrypted with.",
    );
  }
  return { ...manifest, verifiedAt: new Date().toISOString() };
}

function isSchemaMigrationPrefix(value) {
  return (
    Array.isArray(value) &&
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
        /^[a-f0-9]{64}$/.test(String(value.configuredEndpointSha256 || ""))
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
    // A process can exit before the last of its output has been read.
    child.once("close", (code, signal) => {
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
