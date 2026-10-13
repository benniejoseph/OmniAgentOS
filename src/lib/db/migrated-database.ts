import { databaseSchemaMigrations, verifyMigratedDatabaseSchema } from "@/lib/db/client";
import { verifyResponsibilityWorkspaceFence } from "@/lib/db/responsibility-workspace-fence";
import {
  describeTenantIsolationProblems,
  readTenantIsolationCatalog,
} from "@/lib/security/isolation-report";

/**
 * Checks a database this release has just migrated: its ledger matches the
 * release exactly, and every tenant table is isolated as the release expects.
 */
export async function verifyMigratedDatabase() {
  const catalog = await verifyMigratedDatabaseSchema(async (query) => {
    const catalog = await readTenantIsolationCatalog(query);
    await verifyResponsibilityWorkspaceFence(query);
    return catalog;
  });
  const problems = describeTenantIsolationProblems(catalog);
  if (problems.length > 0) {
    throw new Error(`Tenant isolation does not match this release. ${problems.join("; ")}.`);
  }
  return { migrations: databaseSchemaMigrations.length, tenantTables: catalog.tables.length };
}
