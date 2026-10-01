export {};

async function main() {
  const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL?.trim();

  if (!migrationDatabaseUrl) {
    throw new Error(
      "MIGRATION_DATABASE_URL is required. The check reads the schema the release job migrated, over the same connection.",
    );
  }

  process.env.DATABASE_URL = migrationDatabaseUrl;
  Object.assign(process.env, { NODE_ENV: "production" });

  const { closeDatabaseClient } = await import("../src/lib/db/client");
  const { verifyMigratedDatabase } = await import("../src/lib/db/migrated-database");

  try {
    const verified = await verifyMigratedDatabase();
    console.log(
      JSON.stringify({
        level: "info",
        event: "database_verification_completed",
        ...verified,
        completedAt: new Date().toISOString(),
      }),
    );
  } finally {
    await closeDatabaseClient();
  }
}

void main().catch((error) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "database_verification_failed",
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Verification failed.",
    }),
  );
  process.exitCode = 1;
});
