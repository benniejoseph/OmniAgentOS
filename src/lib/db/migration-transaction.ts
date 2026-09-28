import "server-only";

import type postgres from "postgres";

const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 600_000;
const MIN_MIGRATION_STATEMENT_TIMEOUT_MS = 30_000;
const MAX_MIGRATION_STATEMENT_TIMEOUT_MS = 3_600_000;
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 5_000;
const MIN_MIGRATION_LOCK_TIMEOUT_MS = 1_000;
const MAX_MIGRATION_LOCK_TIMEOUT_MS = 30_000;

/**
 * The waits between the attempts of a migration transaction that could not
 * get a lock. There is one more attempt than there are waits.
 */
export const MIGRATION_LOCK_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  1_000, 2_000, 4_000, 8_000,
]);

/** lock_not_available (a lock timeout expired) and deadlock_detected. */
const LOCK_CONTENTION_SQLSTATES: ReadonlySet<string> = new Set(["55P03", "40P01"]);

type MigrationTransaction = postgres.TransactionSql<Record<string, never>>;

/** OMNIAGENT_MIGRATION_STATEMENT_TIMEOUT_MS: 10 minutes by default, 30 s to 1 hour. */
export function getMigrationStatementTimeoutMs() {
  const configured = Number(process.env.OMNIAGENT_MIGRATION_STATEMENT_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(Math.round(configured), MIN_MIGRATION_STATEMENT_TIMEOUT_MS),
    MAX_MIGRATION_STATEMENT_TIMEOUT_MS,
  );
}

/** OMNIAGENT_MIGRATION_LOCK_TIMEOUT_MS: 5 s by default, 1 s to 30 s. */
export function getMigrationLockTimeoutMs() {
  const configured = Number(process.env.OMNIAGENT_MIGRATION_LOCK_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(Math.round(configured), MIN_MIGRATION_LOCK_TIMEOUT_MS),
    MAX_MIGRATION_LOCK_TIMEOUT_MS,
  );
}

/**
 * Starts a migration transaction. It waits for the migration advisory lock,
 * which the migration files take too, with no lock timeout, so a second
 * runner waits, up to the statement timeout, for the first to finish. Only
 * then does it set the lock timeout: while a statement waits for a table lock,
 * every later query on that table queues behind it, so no statement may wait
 * long for one.
 */
export async function beginMigrationTransaction(tx: MigrationTransaction, reason: string) {
  const role = process.env.MIGRATION_DATABASE_ROLE?.trim();
  if (role) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(role)) {
      throw new Error("MIGRATION_DATABASE_ROLE must be a valid PostgreSQL role name.");
    }
    await tx.unsafe(`SET LOCAL ROLE "${role}"`);
  }
  await tx`
    SELECT set_config('statement_timeout', ${String(getMigrationStatementTimeoutMs())}, true),
           set_config('lock_timeout', '0', true)
  `;
  await tx`SELECT pg_advisory_xact_lock(271828182)`;
  await tx`
    SELECT set_config('lock_timeout', ${String(getMigrationLockTimeoutMs())}, true),
           set_config('omni.system_scope', 'true', true),
           set_config('omni.system_reason', ${reason}, true)
  `;
}

/**
 * The SQLSTATE when an error, or an error in its cause chain, says another
 * session held a lock the migration needed: a lock timeout expired, or the
 * migration was chosen to break a deadlock. Undefined for any other error.
 */
export function migrationLockContentionSqlstate(error: unknown) {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && LOCK_CONTENTION_SQLSTATES.has(code)) {
      return code;
    }
    current = cause;
  }
  return undefined;
}

type MigrationLockRetryOptions = Readonly<{
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
}>;

/**
 * Runs a migration transaction, and runs it again from the start while it
 * fails only because another session held a lock it needed. A failed attempt
 * rolls back, so each attempt starts from the same schema. Every retry, and
 * giving up, is logged as a JSON line.
 */
export async function runWithMigrationLockRetry<T>(
  step: string,
  transaction: () => Promise<T>,
  {
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log = (line) => console.warn(line),
  }: MigrationLockRetryOptions = {},
): Promise<T> {
  const attempts = MIGRATION_LOCK_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await transaction();
    } catch (error) {
      const sqlstate = migrationLockContentionSqlstate(error);
      if (!sqlstate) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts) {
        log(JSON.stringify({
          level: "warn",
          event: "database_migration_lock_retries_exhausted",
          step,
          attempts,
          sqlstate,
          error: message,
        }));
        throw new Error(
          `${step} could not get the locks it needed in ${attempts} attempts: ${message}`,
          { cause: error },
        );
      }
      const retryInMs = MIGRATION_LOCK_RETRY_DELAYS_MS[attempt - 1];
      log(JSON.stringify({
        level: "warn",
        event: "database_migration_lock_retry",
        step,
        attempt,
        attempts,
        retryInMs,
        sqlstate,
        error: message,
      }));
      await sleep(retryInMs);
    }
  }
}
