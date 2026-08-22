export {};

async function main() {
  const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL?.trim();

  if (!migrationDatabaseUrl) {
    throw new Error(
      "MIGRATION_DATABASE_URL is required. Do not run schema migrations with the application runtime role.",
    );
  }

  process.env.DATABASE_URL = migrationDatabaseUrl;
  Object.assign(process.env, { NODE_ENV: "production" });

  const startedAt = new Date().toISOString();
  console.log(
    JSON.stringify({
      level: "info",
      event: "database_migration_started",
      startedAt,
    }),
  );

  const { closeDatabaseClient, migrateDatabaseSchema } = await import(
    "../src/lib/db/client"
  );

  try {
    await migrateDatabaseSchema({ verifyRuntimeRole: false });
    console.log(
      JSON.stringify({
        level: "info",
        event: "database_migration_completed",
        startedAt,
        completedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "database_migration_failed",
        startedAt,
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Migration failed.",
      }),
    );
    process.exitCode = 1;
  } finally {
    await closeDatabaseClient();
  }
}

void main().catch((error) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "database_migration_failed",
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Migration failed.",
    }),
  );
  process.exitCode = 1;
});
