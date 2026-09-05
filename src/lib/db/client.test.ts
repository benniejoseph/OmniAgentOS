import { describe, expect, it, vi } from "vitest";
import {
  applyDatabaseScope,
  databaseSchemaMigrations,
  enterDatabaseTenantContext,
  getDatabaseAcquireTimeoutMs,
  getDatabaseIdleTransactionTimeoutMs,
  getDatabaseLockTimeoutMs,
  getDatabasePoolIdleTimeoutSeconds,
  getDatabasePoolMax,
  getDatabaseSchemaVerificationTimeoutMs,
  getDatabaseStatementTimeoutMs,
  getDatabaseTenantContext,
  getPendingSchemaMigrationVersions,
  isDatabaseMutation,
  validateSchemaMigrationMarkers,
  verifyDatabaseSchemaWithClient,
  withDatabaseRequestScope,
} from "@/lib/db/client";

describe("database pool sizing", () => {
  it("allows overlapping production requests without unbounded connections", () => {
    try {
      vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "");
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("NODE_ENV", "test");
      expect(getDatabasePoolMax()).toBe(1);

      vi.stubEnv("NODE_ENV", "production");
      expect(getDatabasePoolMax()).toBe(4);

      vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "8");
      expect(getDatabasePoolMax()).toBe(8);

      vi.stubEnv("VERCEL", "1");
      expect(getDatabasePoolMax()).toBe(1);

      vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "20");
      expect(getDatabasePoolMax()).toBe(1);

      vi.stubEnv("VERCEL", "");
      vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "200");
      expect(getDatabasePoolMax()).toBe(20);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("disables the Vercel idle timer without changing durable runtimes", () => {
    try {
      vi.stubEnv("VERCEL", "");
      expect(getDatabasePoolIdleTimeoutSeconds()).toBe(20);

      vi.stubEnv("VERCEL", "1");
      expect(getDatabasePoolIdleTimeoutSeconds()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bounds production schema verification timeouts", () => {
    try {
      vi.stubEnv("OMNIAGENT_SCHEMA_VERIFICATION_TIMEOUT_MS", "");
      expect(getDatabaseSchemaVerificationTimeoutMs()).toBe(10_000);

      vi.stubEnv("OMNIAGENT_SCHEMA_VERIFICATION_TIMEOUT_MS", "250");
      expect(getDatabaseSchemaVerificationTimeoutMs()).toBe(1_000);

      vi.stubEnv("OMNIAGENT_SCHEMA_VERIFICATION_TIMEOUT_MS", "90000");
      expect(getDatabaseSchemaVerificationTimeoutMs()).toBe(60_000);

      vi.stubEnv("OMNIAGENT_SCHEMA_VERIFICATION_TIMEOUT_MS", "invalid");
      expect(getDatabaseSchemaVerificationTimeoutMs()).toBe(10_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bounds database connection acquisition timeouts", () => {
    try {
      vi.stubEnv("OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS", "");
      expect(getDatabaseAcquireTimeoutMs()).toBe(20_000);

      vi.stubEnv("OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS", "100");
      expect(getDatabaseAcquireTimeoutMs()).toBe(500);

      vi.stubEnv("OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS", "90000");
      expect(getDatabaseAcquireTimeoutMs()).toBe(30_000);

      vi.stubEnv("OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS", "invalid");
      expect(getDatabaseAcquireTimeoutMs()).toBe(20_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bounds transaction-local statement, lock, and idle timeouts", () => {
    try {
      vi.stubEnv("OMNIAGENT_DATABASE_STATEMENT_TIMEOUT_MS", "");
      vi.stubEnv("OMNIAGENT_DATABASE_LOCK_TIMEOUT_MS", "");
      vi.stubEnv("OMNIAGENT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS", "");
      expect(getDatabaseStatementTimeoutMs()).toBe(15_000);
      expect(getDatabaseLockTimeoutMs()).toBe(1_000);
      expect(getDatabaseIdleTransactionTimeoutMs()).toBe(15_000);

      vi.stubEnv("OMNIAGENT_DATABASE_STATEMENT_TIMEOUT_MS", "250");
      vi.stubEnv("OMNIAGENT_DATABASE_LOCK_TIMEOUT_MS", "25");
      vi.stubEnv("OMNIAGENT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS", "250");
      expect(getDatabaseStatementTimeoutMs()).toBe(1_000);
      expect(getDatabaseLockTimeoutMs()).toBe(100);
      expect(getDatabaseIdleTransactionTimeoutMs()).toBe(1_000);

      vi.stubEnv("OMNIAGENT_DATABASE_STATEMENT_TIMEOUT_MS", "90000");
      vi.stubEnv("OMNIAGENT_DATABASE_LOCK_TIMEOUT_MS", "20000");
      vi.stubEnv("OMNIAGENT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS", "90000");
      expect(getDatabaseStatementTimeoutMs()).toBe(60_000);
      expect(getDatabaseLockTimeoutMs()).toBe(10_000);
      expect(getDatabaseIdleTransactionTimeoutMs()).toBe(60_000);

      vi.stubEnv("OMNIAGENT_DATABASE_STATEMENT_TIMEOUT_MS", "2000");
      vi.stubEnv("OMNIAGENT_DATABASE_LOCK_TIMEOUT_MS", "5000");
      expect(getDatabaseLockTimeoutMs()).toBe(2_000);

      vi.stubEnv("OMNIAGENT_DATABASE_STATEMENT_TIMEOUT_MS", "invalid");
      vi.stubEnv("OMNIAGENT_DATABASE_LOCK_TIMEOUT_MS", "invalid");
      vi.stubEnv("OMNIAGENT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS", "invalid");
      expect(getDatabaseStatementTimeoutMs()).toBe(15_000);
      expect(getDatabaseLockTimeoutMs()).toBe(1_000);
      expect(getDatabaseIdleTransactionTimeoutMs()).toBe(15_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
describe("database pool acquisition", () => {
  it("reserves and releases the correct pool for tenant queries and system transactions", async () => {
    const runtime = createMockPoolClient([{ source: "runtime" }]);
    const maintenance = createMockPoolClient([{ source: "maintenance" }]);
    const postgresFactory = vi
      .fn()
      .mockReturnValueOnce(runtime.pg)
      .mockReturnValueOnce(maintenance.pg);
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv(
      "OMNIAGENT_MAINTENANCE_DATABASE_URL",
      "postgresql://maintenance.invalid/asael",
    );
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "20");
    vi.resetModules();
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      const isolatedClient = await import("@/lib/db/client");
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 'runtime' AS source`,
        ),
      ).resolves.toEqual([{ source: "runtime" }]);
      await expect(
        isolatedClient.runWithDatabaseSystemScope(
          "unit-test maintenance lookup",
          () =>
            isolatedClient.getSql().transaction(
              (sql: ReturnType<typeof isolatedClient.getSql>) => sql`
                SELECT 'maintenance' AS source
              `,
            ),
        ),
      ).resolves.toEqual([{ source: "maintenance" }]);

      expect(postgresFactory).toHaveBeenCalledTimes(2);
      expect(postgresFactory).toHaveBeenNthCalledWith(
        1,
        "postgresql://runtime.invalid/asael",
        expect.objectContaining({
          max: 1,
          idle_timeout: 0,
          max_lifetime: null,
        }),
      );
      expect(postgresFactory).toHaveBeenNthCalledWith(
        2,
        "postgresql://maintenance.invalid/asael",
        expect.objectContaining({
          max: 1,
          idle_timeout: 0,
          max_lifetime: null,
        }),
      );
      expect(runtime.pg.reserve).toHaveBeenCalledOnce();
      expect(runtime.reserved).not.toHaveProperty("begin");
      expect(runtime.reserved.release).toHaveBeenCalledOnce();
      expect(maintenance.pg.reserve).toHaveBeenCalledOnce();
      expect(maintenance.reserved).not.toHaveProperty("begin");
      expect(maintenance.reserved.release).toHaveBeenCalledOnce();
      expect(statementKinds(runtime.statements)).toEqual([
        "BEGIN",
        "QUERY",
        "SCOPE",
        "QUERY",
        "COMMIT",
      ]);
      expect(statementKinds(maintenance.statements)).toEqual([
        "BEGIN",
        "QUERY",
        "SCOPE",
        "QUERY",
        "COMMIT",
      ]);
      expect(scopeStatement(runtime.statements)?.params.slice(0, 3)).toEqual([
        "tenant-a",
        "false",
        "",
      ]);
      expect(scopeStatement(maintenance.statements)?.params.slice(0, 3)).toEqual([
        "",
        "true",
        "unit-test maintenance lookup",
      ]);
    } finally {
      consoleInfo.mockRestore();
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("leaves the postgres.js max lifetime default intact on durable runtimes", async () => {
    const pool = createMockPoolClient([{ ok: true }]);
    const postgresFactory = vi.fn(
      (databaseUrl: string, options: Record<string, unknown>) => {
        void databaseUrl;
        void options;
        return pool.pg;
      },
    );
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("VERCEL", "");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 1`,
        ),
      ).resolves.toEqual([{ ok: true }]);

      const options = postgresFactory.mock.calls[0]?.[1] as
        | Record<string, unknown>
        | undefined;
      expect(options).toEqual(
        expect.objectContaining({ idle_timeout: 20 }),
      );
      expect(options).not.toHaveProperty("max_lifetime");
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("retires a timed-out Vercel pool and its waiters before replacing it", async () => {
    vi.useFakeTimers();
    const retiredPool = createMockPoolClient([]);
    const replacementPool = createMockPoolClient([{ ok: true }]);
    let rejectRetiredReservation: (error: Error) => void = () => undefined;
    retiredPool.pg.reserve.mockImplementation(
      () =>
        new Promise<typeof retiredPool.reserved>((_resolve, reject) => {
          rejectRetiredReservation = reject;
        }),
    );
    retiredPool.pg.end.mockImplementation(() => {
      rejectRetiredReservation(new Error("retired pool destroyed"));
      return Promise.resolve();
    });
    const postgresFactory = vi
      .fn()
      .mockReturnValueOnce(retiredPool.pg)
      .mockReturnValueOnce(replacementPool.pg);
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS", "500");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const retiredClient = isolatedClient.getSql();
      const timedOutQuery = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => retiredClient`SELECT 1`,
      );
      await vi.advanceTimersByTimeAsync(0);
      const waitingQuery = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => retiredClient`SELECT 2`,
      );
      const timeoutMatch = {
        code: "DATABASE_ACQUIRE_TIMEOUT",
        message: "Database connection acquisition timed out after 500ms.",
      };
      const timedOutRejection = expect(timedOutQuery).rejects.toMatchObject(
        timeoutMatch,
      );
      const waitingRejection = expect(waitingQuery).rejects.toMatchObject(
        timeoutMatch,
      );
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([timedOutRejection, waitingRejection]);

      expect(retiredPool.pg.reserve).toHaveBeenCalledOnce();
      expect(retiredPool.pg.end).toHaveBeenCalledOnce();
      expect(retiredPool.pg.end).toHaveBeenCalledWith({ timeout: 0 });
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          retiredClient`SELECT 3`,
        ),
      ).rejects.toMatchObject(timeoutMatch);
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 4`,
        ),
      ).resolves.toEqual([{ ok: true }]);

      expect(postgresFactory).toHaveBeenCalledTimes(2);
      expect(replacementPool.pg.reserve).toHaveBeenCalledOnce();
      expect(retiredPool.pg.reserve).toHaveBeenCalledOnce();
      expect(replacementPool.reserved.release).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it("bounds ghost reservations and skips a canceled FIFO waiter", async () => {
    vi.useFakeTimers();
    const pool = createMockPoolClient([{ ok: true }]);
    let grantReservation: (reserved: typeof pool.reserved) => void = () =>
      undefined;
    const pendingReservation = new Promise<typeof pool.reserved>((resolve) => {
      grantReservation = resolve;
    });
    pool.pg.reserve
      .mockImplementationOnce(() => pendingReservation)
      .mockImplementationOnce(() => Promise.resolve(pool.reserved));
    vi.doMock("postgres", () => ({ default: vi.fn(() => pool.pg) }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    vi.stubEnv("OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS", "500");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const firstQuery = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => isolatedClient.getSql()`SELECT 1`,
      );
      const firstRejection = expect(firstQuery).rejects.toMatchObject({
        code: "DATABASE_ACQUIRE_TIMEOUT",
        message: "Database connection acquisition timed out after 500ms.",
      });
      await vi.advanceTimersByTimeAsync(0);

      const canceledQuery = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => isolatedClient.getSql()`SELECT 2`,
      );
      const canceledRejection = expect(canceledQuery).rejects.toMatchObject({
        code: "DATABASE_ACQUIRE_TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(250);

      const succeedingQuery = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => isolatedClient.getSql()`SELECT 3`,
      );

      await vi.advanceTimersByTimeAsync(250);
      await Promise.all([firstRejection, canceledRejection]);
      expect(pool.pg.reserve).toHaveBeenCalledOnce();
      expect(pool.statements).toEqual([]);
      expect(pool.reserved.release).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      grantReservation(pool.reserved);
      await expect(succeedingQuery).resolves.toEqual([{ ok: true }]);

      expect(pool.pg.reserve).toHaveBeenCalledTimes(2);
      expect(statementKinds(pool.statements)).toEqual([
        "BEGIN",
        "QUERY",
        "SCOPE",
        "QUERY",
        "COMMIT",
      ]);
      expect(pool.reserved.release).toHaveBeenCalledTimes(2);
      expect(pool.pg.end).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it("releases an acquired slot exactly once when a callback transaction throws", async () => {
    const pool = createMockPoolClient([]);
    vi.doMock("postgres", () => ({ default: vi.fn(() => pool.pg) }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql().transaction(() => {
            throw new Error("transaction callback failed");
          }),
        ),
      ).rejects.toThrow("transaction callback failed");

      expect(pool.pg.reserve).toHaveBeenCalledOnce();
      expect(pool.reserved).not.toHaveProperty("begin");
      expect(transactionCommands(pool.statements)).toEqual(["BEGIN", "ROLLBACK"]);
      expect(pool.reserved.release).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("propagates an early reservation failure without beginning or releasing", async () => {
    const pool = createMockPoolClient([]);
    const reservationError = new Error("pool connection failed");
    pool.pg.reserve.mockRejectedValue(reservationError);
    vi.doMock("postgres", () => ({ default: vi.fn(() => pool.pg) }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS", "5000");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 1`,
        ),
      ).rejects.toBe(reservationError);

      expect(pool.pg.reserve).toHaveBeenCalledOnce();
      expect(pool.statements).toEqual([]);
      expect(pool.reserved.release).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("releases once without rollback when BEGIN fails", async () => {
    const beginError = new Error("begin failed");
    const pool = createMockPoolClient([], { BEGIN: beginError });
    vi.doMock("postgres", () => ({ default: vi.fn(() => pool.pg) }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 1`,
        ),
      ).rejects.toBe(beginError);

      expect(statementKinds(pool.statements)).toEqual(["BEGIN"]);
      expect(pool.reserved).not.toHaveBeenCalled();
      expect(pool.reserved.release).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("rolls back and releases once when COMMIT fails", async () => {
    const commitError = new Error("commit failed");
    const pool = createMockPoolClient([{ ok: true }], { COMMIT: commitError });
    vi.doMock("postgres", () => ({ default: vi.fn(() => pool.pg) }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 1`,
        ),
      ).rejects.toBe(commitError);

      expect(statementKinds(pool.statements)).toEqual([
        "BEGIN",
        "QUERY",
        "SCOPE",
        "QUERY",
        "COMMIT",
        "ROLLBACK",
      ]);
      expect(pool.reserved.release).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

type TransactionCommand = "BEGIN" | "COMMIT" | "ROLLBACK";

function createMockPoolClient(
  resultRows: Record<string, unknown>[],
  controlFailures: Partial<Record<TransactionCommand, Error>> = {},
) {
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const reserved = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...params: unknown[]) => {
      const text = strings.join("?");
      statements.push({ text, params });
      return Promise.resolve(
        isControlStatement(text) || text.includes("set_config") ? [] : resultRows,
      );
    }),
    {
      unsafe: vi.fn((text: string, params: unknown[] = []) => {
        statements.push({ text, params });
        const command = transactionCommand(text);
        if (command && controlFailures[command]) {
          return Promise.reject(controlFailures[command]);
        }
        return Promise.resolve(
          isControlStatement(text) || text.includes("set_config") ? [] : resultRows,
        );
      }),
      release: vi.fn(),
    },
  );
  const pg = Object.assign(vi.fn(), {
    reserve: vi.fn(() => Promise.resolve(reserved)),
    end: vi.fn(() => Promise.resolve()),
  });
  return { pg, reserved, statements };
}

function transactionCommands(
  statements: Array<{ text: string; params: unknown[] }>,
) {
  return statements
    .map(({ text }) => transactionCommand(text))
    .filter((command): command is TransactionCommand => Boolean(command));
}

function statementKinds(
  statements: Array<{ text: string; params: unknown[] }>,
) {
  return statements.map(({ text }) => {
    const command = transactionCommand(text);
    if (command) return command;
    return text.includes("set_config") ? "SCOPE" : "QUERY";
  });
}

function scopeStatement(
  statements: Array<{ text: string; params: unknown[] }>,
) {
  return statements.find(({ text }) => text.includes("set_config"));
}

function isControlStatement(text: string) {
  return Boolean(transactionCommand(text));
}

function transactionCommand(text: string): TransactionCommand | undefined {
  const command = text.trim().toUpperCase();
  return ["BEGIN", "COMMIT", "ROLLBACK"].includes(command)
    ? command as TransactionCommand
    : undefined;
}

describe("database scope application", () => {
  it("sets all transaction-local scope values in one statement", async () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const sql = ((
      strings: TemplateStringsArray,
      ...params: unknown[]
    ) => {
      calls.push({ text: strings.join("?"), params });
      return Promise.resolve([]);
    }) as Parameters<typeof applyDatabaseScope>[0];

    vi.stubEnv("OMNIAGENT_DATABASE_STATEMENT_TIMEOUT_MS", "12345");
    vi.stubEnv("OMNIAGENT_DATABASE_LOCK_TIMEOUT_MS", "750");
    vi.stubEnv("OMNIAGENT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS", "15000");
    try {
      await applyDatabaseScope(sql, {
        kind: "tenant",
        tenantId: "tenant-a",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].text.match(/set_config/g)).toHaveLength(6);
      expect(calls[0].text).toContain("set_config('statement_timeout'");
      expect(calls[0].text).toContain("set_config('lock_timeout'");
      expect(calls[0].text).toContain(
        "set_config('idle_in_transaction_session_timeout'",
      );
      expect(calls[0].params).toEqual([
        "tenant-a",
        "false",
        "",
        "12345",
        "750",
        "15000",
      ]);

      calls.length = 0;
      await applyDatabaseScope(sql, {
        kind: "system",
        reason: "maintenance",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].text.match(/set_config/g)).toHaveLength(6);
      expect(calls[0].params).toEqual([
        "",
        "true",
        "maintenance",
        "12345",
        "750",
        "15000",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("database timing classification", () => {
  it("counts direct and CTE-backed writes as mutations", () => {
    expect(isDatabaseMutation("SELECT 1")).toBe(false);
    expect(isDatabaseMutation("UPDATE omni_jobs SET status = 'done'")).toBe(
      true,
    );
    expect(
      isDatabaseMutation(`
        WITH leased AS (
          SELECT id FROM omni_jobs FOR UPDATE
        )
        UPDATE omni_jobs SET status = 'running'
        FROM leased
        WHERE omni_jobs.id = leased.id
      `),
    ).toBe(true);
    expect(
      isDatabaseMutation(`
        WITH input AS (SELECT * FROM jsonb_to_recordset($1))
        INSERT INTO omni_memories SELECT * FROM input
      `),
    ).toBe(true);
    expect(
      isDatabaseMutation(`
        WITH notes AS (
          SELECT 'UPDATE omni_jobs SET status = ''done''' AS message
        )
        SELECT * FROM notes
      `),
    ).toBe(false);
    expect(
      isDatabaseMutation(`
        WITH notes AS (
          SELECT 1 /* DELETE FROM omni_jobs */
        )
        SELECT * FROM notes -- UPDATE omni_jobs SET status = 'done'
      `),
    ).toBe(false);
  });
});

describe("ordered database schema versions", () => {
  it("pins the informed-notice governance evidence shadow migration", () => {
    expect(databaseSchemaMigrations.at(-1)).toEqual({
      version: 66,
      name: "memory_informed_notice_governance_evidence_shadow",
      checksum: "8e845ac8182b025d6dea8014ec3877c141e55ad2dc551054b1a885e4bb680f6e",
    });
  });

  it("declares unique, strictly increasing versions", () => {
    const versions = databaseSchemaMigrations.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((left, right) => left - right));
    expect(new Set(versions).size).toBe(versions.length);
    expect(databaseSchemaMigrations.every((migration) => migration.name.length > 0)).toBe(true);
    expect(
      databaseSchemaMigrations.every((migration) =>
        /^[a-f0-9]{64}$/.test(migration.checksum),
      ),
    ).toBe(true);
  });

  it("runs every unapplied version for fresh and partially migrated databases", () => {
    const versions = databaseSchemaMigrations.map((migration) => migration.version);
    expect(getPendingSchemaMigrationVersions([])).toEqual(versions);
    expect(getPendingSchemaMigrationVersions([1])).toEqual(versions.slice(1));
    expect(getPendingSchemaMigrationVersions([1, 3])).toEqual(
      versions.filter((version) => version !== 1 && version !== 3),
    );
    expect(getPendingSchemaMigrationVersions(versions)).toEqual([]);
  });

  it("rejects unknown or future migration markers", () => {
    expect(() => getPendingSchemaMigrationVersions([0])).toThrow(
      /unknown migration versions: 0/i,
    );
    expect(() => getPendingSchemaMigrationVersions([99])).toThrow(
      /unknown migration versions: 99/i,
    );
  });

  it("accepts a contiguous integrity-checked future marker for rollback runtime verification", async () => {
    const nextVersion = (databaseSchemaMigrations.at(-1)?.version || 0) + 1;
    const rows = [
      ...databaseSchemaMigrations.map(({ version, name, checksum }) => ({
        version,
        name,
        checksum,
      })),
      {
        version: nextVersion,
        name: "future_additive_migration",
        checksum: "f".repeat(64),
      },
    ];
    const sql = (() => Promise.resolve(rows)) as Parameters<
      typeof verifyDatabaseSchemaWithClient
    >[0];

    await expect(verifyDatabaseSchemaWithClient(sql)).resolves.toBeUndefined();
    expect(() =>
      getPendingSchemaMigrationVersions([nextVersion + 1], {
        allowFutureVersions: true,
      }),
    ).toThrow(/unknown migration versions/i);
    expect(() =>
      validateSchemaMigrationMarkers(
        [
          ...rows.slice(0, -1),
          { ...rows[rows.length - 1], checksum: null },
        ],
        { allowFutureVersions: true },
      ),
    ).toThrow(/future database migration .* missing integrity metadata/i);

    const missingCurrent = rows.filter(
      (row) => row.version !== nextVersion - 1,
    );
    const missingCurrentSql = (() => Promise.resolve(missingCurrent)) as Parameters<
      typeof verifyDatabaseSchemaWithClient
    >[0];
    await expect(verifyDatabaseSchemaWithClient(missingCurrentSql)).rejects.toThrow(
      /pending versions/i,
    );
  });

  it("rejects changed migration names and checksums", () => {
    const first = databaseSchemaMigrations[0];
    expect(() =>
      validateSchemaMigrationMarkers([
        { version: first.version, name: "changed", checksum: first.checksum },
      ]),
    ).toThrow(/name does not match/i);
    expect(() =>
      validateSchemaMigrationMarkers([
        { version: first.version, name: first.name, checksum: "0".repeat(64) },
      ]),
    ).toThrow(/checksum does not match/i);
    expect(() =>
      validateSchemaMigrationMarkers([
        { version: first.version, name: first.name, checksum: null },
      ]),
    ).toThrow(/missing integrity metadata/i);
    expect(
      validateSchemaMigrationMarkers(
        [{ version: first.version, name: null, checksum: null }],
        { allowLegacyMissingValues: true },
      ),
    ).toEqual([first.version]);
  });

  it("verifies every production schema marker in one database query", async () => {
    let calls = 0;
    const sql = (() => {
      calls += 1;
      return Promise.resolve(
        databaseSchemaMigrations.map(({ version, name, checksum }) => ({
          version,
          name,
          checksum,
        })),
      );
    }) as Parameters<typeof verifyDatabaseSchemaWithClient>[0];

    await expect(verifyDatabaseSchemaWithClient(sql)).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it("cancels a pending schema query when verification times out", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OMNIAGENT_SCHEMA_VERIFICATION_TIMEOUT_MS", "1000");
    try {
      const cancel = vi.fn(() => Promise.resolve());
      const pendingQuery = Object.assign(
        new Promise<Record<string, unknown>[]>(() => undefined),
        { cancel },
      );
      const sql = (() => pendingQuery) as Parameters<
        typeof verifyDatabaseSchemaWithClient
      >[0];

      const verification = verifyDatabaseSchemaWithClient(sql);
      const rejection = expect(verification).rejects.toThrow(
        "Database schema verification timed out after 1000ms.",
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await rejection;
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("resets a timed-out production verification so the next request retries", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://example.invalid/omniagent");
    vi.stubEnv("OMNIAGENT_SCHEMA_VERIFICATION_TIMEOUT_MS", "1000");
    const cancel = vi.fn(() => Promise.resolve());
    const hangingQuery = Object.assign(
      new Promise<Record<string, unknown>[]>(() => undefined),
      { cancel },
    );
    const rows = databaseSchemaMigrations.map(({ version, name, checksum }) => ({
      version,
      name,
      checksum,
    }));
    let queries = 0;
    const sql = () => {
      queries += 1;
      return queries === 1 ? hangingQuery : Promise.resolve(rows);
    };
    vi.doMock("postgres", () => ({
      default: vi.fn(() => sql),
    }));
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const firstVerification = isolatedClient.ensureDatabaseSchema();
      const rejection = expect(firstVerification).rejects.toThrow(
        "Database schema verification timed out after 1000ms.",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;

      await expect(isolatedClient.ensureDatabaseSchema()).resolves.toBeUndefined();
      expect(cancel).toHaveBeenCalledOnce();
      expect(queries).toBe(2);
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it("propagates a tenant resolved after an asynchronous lookup to the caller", async () => {
    const resolveTenant = withDatabaseRequestScope(async () => {
      expect(getDatabaseTenantContext()).toBeUndefined();
      enterDatabaseTenantContext();
      await Promise.resolve();
      enterDatabaseTenantContext("tenant-after-await");
      return getDatabaseTenantContext();
    });

    await expect(resolveTenant()).resolves.toBe("tenant-after-await");
    expect(getDatabaseTenantContext()).toBeUndefined();
  });

  it("isolates tenants resolved concurrently in separate request scopes", async () => {
    const resolveTenant = withDatabaseRequestScope(async (tenantId: string) => {
      enterDatabaseTenantContext();
      await new Promise((resolve) => setTimeout(resolve, 0));
      enterDatabaseTenantContext(tenantId);
      await Promise.resolve();
      return getDatabaseTenantContext();
    });

    await expect(
      Promise.all([resolveTenant("tenant-a"), resolveTenant("tenant-b")]),
    ).resolves.toEqual(["tenant-a", "tenant-b"]);
  });

  it("rejects an explicit plaintext database connection in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://example.invalid/omniagent?sslmode=disable",
    );
    vi.resetModules();
    try {
      const client = await import("@/lib/db/client");
      await expect(client.ensureDatabaseSchema()).rejects.toThrow(
        "DATABASE_URL cannot disable TLS in production",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("fails closed when production system scope has no maintenance role", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://example.invalid/omniagent",
    );
    vi.stubEnv("OMNIAGENT_MAINTENANCE_DATABASE_URL", "");
    vi.resetModules();
    try {
      const client = await import("@/lib/db/client");
      await expect(
        client.runWithDatabaseSystemScope(
          "unit-test system lookup",
          async () => client.getSql(),
        ),
      ).rejects.toThrow(/maintenance_database_url is required/i);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
