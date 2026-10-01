import { databaseSchemaMigrations, verifyMigratedDatabaseSchema } from "@/lib/db/client";
import {
  describeTenantIsolationProblems,
  readTenantIsolationCatalog,
} from "@/lib/security/isolation-report";

/**
 * Checks a database this release has just migrated: its ledger matches the
 * release exactly, and every tenant table is isolated as the release expects.
 */
export async function verifyMigratedDatabase() {
  const catalog = await verifyMigratedDatabaseSchema(readTenantIsolationCatalog);
  const problems = describeTenantIsolationProblems(catalog);
  if (problems.length > 0) {
    throw new Error(`Tenant isolation does not match this release. ${problems.join("; ")}.`);
  }
  return { migrations: databaseSchemaMigrations.length, tenantTables: catalog.tables.length };
}
