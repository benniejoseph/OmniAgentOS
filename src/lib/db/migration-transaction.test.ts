import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MIGRATION_LOCK_RETRY_DELAYS_MS,
  beginMigrationTransaction,
  getMigrationLockTimeoutMs,
  getMigrationStatementTimeoutMs,
  migrationLockContentionSqlstate,
  runWithMigrationLockRetry,
} from "@/lib/db/migration-transaction";

type Statement = Readonly<{ text: string; values: readonly unknown[] }>;

/** A transaction that records each statement, with $n for its values. */
function recordingTransaction() {
  const statements: Statement[] = [];
  const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings
      .reduce((joined, part, index) => `${joined}$${index}${part}`)
      .replace(/\s+/g, " ")
      .trim();
    statements.push({ text, values });
    return [];
  };
  const tx = Object.assign(tagged, {
    unsafe: async (text: string) => {
      statements.push({ text, values: [] });
      return [];
    },
  });
  return {
    tx: tx as unknown as Parameters<typeof beginMigrationTransaction>[0],
    statements,
  };
}

function lockTimeout(message = "canceling statement due to lock timeout") {
  return Object.assign(new Error(message), { code: "55P03" });
}

/** Retry options that record each wait and log line instead of sleeping. */
function recordingRetry() {
  const sleeps: number[] = [];
  const lines: Record<string, unknown>[] = [];
  return {
    sleeps,
    lines,
    options: {
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      },
      log: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("migration transaction timeouts", () => {
  it("bounds the statement timeout between 30 seconds and an hour", () => {
    for (const [configured, expected] of [
      ["", 600_000],
      ["invalid", 600_000],
      ["0", 600_000],
      ["-45000", 600_000],
      ["1000", 30_000],
      ["30000", 30_000],
      ["45000.4", 45_000],
      ["45000.6", 45_001],
      ["3600000", 3_600_000],
      ["7200000", 3_600_000],
    ] as const) {
      vi.stubEnv("OMNIAGENT_MIGRATION_STATEMENT_TIMEOUT_MS", configured);
      expect([configured, getMigrationStatementTimeoutMs()]).toEqual([configured, expected]);
    }
  });

  it("bounds the lock timeout between 1 and 30 seconds", () => {
    for (const [configured, expected] of [
      ["", 5_000],
      ["invalid", 5_000],
      ["0", 5_000],
      ["-7000", 5_000],
      ["250", 1_000],
      ["1000", 1_000],
      ["7000.4", 7_000],
      ["7000.6", 7_001],
      ["30000", 30_000],
      ["60000", 30_000],
    ] as const) {
      vi.stubEnv("OMNIAGENT_MIGRATION_LOCK_TIMEOUT_MS", configured);
      expect([configured, getMigrationLockTimeoutMs()]).toEqual([configured, expected]);
    }
  });
});

describe("beginMigrationTransaction", () => {
  it("takes the advisory lock with no lock timeout, then sets the lock timeout and system scope", async () => {
    vi.stubEnv("MIGRATION_DATABASE_ROLE", " asael_migrator ");
    vi.stubEnv("OMNIAGENT_MIGRATION_STATEMENT_TIMEOUT_MS", "45000");
    vi.stubEnv("OMNIAGENT_MIGRATION_LOCK_TIMEOUT_MS", "7000");
    const { tx, statements } = recordingTransaction();

    await beginMigrationTransaction(tx, "optional vector schema maintenance");

    expect(statements).toEqual([
      { text: 'SET LOCAL ROLE "asael_migrator"', values: [] },
      {
        text: "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', '0', true)",
        values: ["45000"],
      },
      { text: "SELECT pg_advisory_xact_lock(271828182)", values: [] },
      {
        text: "SELECT set_config('lock_timeout', $1, true), set_config('omni.system_scope', 'true', true), set_config('omni.system_reason', $2, true)",
        values: ["7000", "optional vector schema maintenance"],
      },
    ]);
  });

  it("keeps the connection's role when no migration role is set", async () => {
    vi.stubEnv("MIGRATION_DATABASE_ROLE", "  ");
    vi.stubEnv("OMNIAGENT_MIGRATION_STATEMENT_TIMEOUT_MS", "");
    vi.stubEnv("OMNIAGENT_MIGRATION_LOCK_TIMEOUT_MS", "");
    const { tx, statements } = recordingTransaction();

    await beginMigrationTransaction(tx, "ordered schema migration");

    expect(statements.map((statement) => statement.text)).toEqual([
      "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', '0', true)",
      "SELECT pg_advisory_xact_lock(271828182)",
      "SELECT set_config('lock_timeout', $1, true), set_config('omni.system_scope', 'true', true), set_config('omni.system_reason', $2, true)",
    ]);
    expect(statements.map((statement) => statement.values)).toEqual([
      ["600000"],
      [],
      ["5000", "ordered schema migration"],
    ]);
  });

  it("refuses a migration role that is not a plain PostgreSQL identifier before running anything", async () => {
    vi.stubEnv("MIGRATION_DATABASE_ROLE", `r${"a".repeat(62)}`);
    const accepted = recordingTransaction();
    await beginMigrationTransaction(accepted.tx, "ordered schema migration");
    expect(accepted.statements[0]).toEqual({
      text: `SET LOCAL ROLE "r${"a".repeat(62)}"`,
      values: [],
    });

    for (const role of [`r${"a".repeat(63)}`, "1migrator", 'migrator"; RESET ROLE; --', "migrator-role"]) {
      vi.stubEnv("MIGRATION_DATABASE_ROLE", role);
      const { tx, statements } = recordingTransaction();
      await expect(beginMigrationTransaction(tx, "ordered schema migration")).rejects.toThrow(
        "MIGRATION_DATABASE_ROLE must be a valid PostgreSQL role name.",
      );
      expect([role, statements]).toEqual([role, []]);
    }
  });
});

describe("migrationLockContentionSqlstate", () => {
  it("finds a lock timeout or a deadlock anywhere in the cause chain", () => {
    expect(migrationLockContentionSqlstate(lockTimeout())).toBe("55P03");
    expect(
      migrationLockContentionSqlstate(Object.assign(new Error("deadlock detected"), { code: "40P01" })),
    ).toBe("40P01");
    expect(
      migrationLockContentionSqlstate(
        new Error("Database migration 208 (convergence) failed", {
          cause: new Error("statement 3 failed", { cause: lockTimeout() }),
        }),
      ),
    ).toBe("55P03");
    // A wrapper's own code does not hide the lock error it wraps.
    expect(
      migrationLockContentionSqlstate({ code: "XX000", cause: { code: "40P01" } }),
    ).toBe("40P01");
  });

  it("returns undefined for every other error", () => {
    // A cause chain that loops back on itself. Its getter stops a walk that
    // would go round forever.
    let causeReads = 0;
    const cycle: { code: string; cause?: unknown } = { code: "57014" };
    cycle.cause = {
      code: "42501",
      get cause() {
        causeReads += 1;
        if (causeReads > 10) throw new Error("the cause chain was walked in circles");
        return cycle;
      },
    };
    for (const error of [
      Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
      new Error("relation does not exist"),
      { code: 55 },
      "55P03",
      null,
      undefined,
      cycle,
    ]) {
      expect(migrationLockContentionSqlstate(error)).toBeUndefined();
    }
  });
});

describe("runWithMigrationLockRetry", () => {
  it("runs a transaction that lost a lock race again, logging each retry", async () => {
    const retry = recordingRetry();
    let calls = 0;
    const result = await runWithMigrationLockRetry(
      "Schema migration",
      async () => {
        calls += 1;
        if (calls > 10) throw new Error("runaway retry loop");
        if (calls === 1) throw new Error("Database migration 208 failed", { cause: lockTimeout() });
        if (calls === 2) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        return "migrated";
      },
      retry.options,
    );

    expect(result).toBe("migrated");
    expect(calls).toBe(3);
    expect(retry.sleeps).toEqual([1_000, 2_000]);
    expect(retry.lines).toEqual([
      {
        level: "warn",
        event: "database_migration_lock_retry",
        step: "Schema migration",
        attempt: 1,
        attempts: 5,
        retryInMs: 1_000,
        sqlstate: "55P03",
        error: "Database migration 208 failed",
      },
      {
        level: "warn",
        event: "database_migration_lock_retry",
        step: "Schema migration",
        attempt: 2,
        attempts: 5,
        retryInMs: 2_000,
        sqlstate: "40P01",
        error: "deadlock detected",
      },
    ]);
  });

  it("gives up after five attempts with the last lock error as the cause", async () => {
    const retry = recordingRetry();
    const errors: Error[] = [];
    const run = runWithMigrationLockRetry(
      "Vector backfill of omni_memories",
      async () => {
        if (errors.length >= 10) throw new Error("runaway retry loop");
        const error = lockTimeout(`canceling statement due to lock timeout (${errors.length + 1})`);
        errors.push(error);
        throw error;
      },
      retry.options,
    );

    const failure = await run.then(
      () => {
        throw new Error("expected the retries to give up");
      },
      (error: unknown) => error as Error,
    );
    expect(failure.message).toBe(
      "Vector backfill of omni_memories could not get the locks it needed in 5 attempts: canceling statement due to lock timeout (5)",
    );
    expect(errors).toHaveLength(5);
    expect(failure.cause).toBe(errors[4]);
    expect(MIGRATION_LOCK_RETRY_DELAYS_MS).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(retry.sleeps).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(retry.lines.map((line) => [line.event, line.attempt, line.retryInMs])).toEqual([
      ["database_migration_lock_retry", 1, 1_000],
      ["database_migration_lock_retry", 2, 2_000],
      ["database_migration_lock_retry", 3, 4_000],
      ["database_migration_lock_retry", 4, 8_000],
      ["database_migration_lock_retries_exhausted", undefined, undefined],
    ]);
    expect(retry.lines.at(-1)).toEqual({
      level: "warn",
      event: "database_migration_lock_retries_exhausted",
      step: "Vector backfill of omni_memories",
      attempts: 5,
      sqlstate: "55P03",
      error: "canceling statement due to lock timeout (5)",
    });
  });

  it("rethrows any other error at once", async () => {
    const retry = recordingRetry();
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    let calls = 0;
    await expect(
      runWithMigrationLockRetry(
        "Schema migration",
        async () => {
          calls += 1;
          if (calls > 10) throw new Error("runaway retry loop");
          throw timeout;
        },
        retry.options,
      ),
    ).rejects.toBe(timeout);
    expect(calls).toBe(1);
    expect(retry.sleeps).toEqual([]);
    expect(retry.lines).toEqual([]);
  });

  it("waits on a timer and logs to console.warn by default", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    let settled = false;
    const run = runWithMigrationLockRetry("Schema migration", async () => {
      calls += 1;
      if (calls > 10) throw new Error("runaway retry loop");
      if (calls === 1) throw lockTimeout();
      return "migrated";
    }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect([calls, settled]).toEqual([1, false]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toBe("migrated");
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      level: "warn",
      event: "database_migration_lock_retry",
      step: "Schema migration",
      attempt: 1,
      attempts: 5,
      retryInMs: 1_000,
      sqlstate: "55P03",
      error: "canceling statement due to lock timeout",
    });
  });
});
