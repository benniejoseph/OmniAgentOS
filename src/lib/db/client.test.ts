import { describe, expect, it, vi } from "vitest";
import {
  applyDatabaseScope,
  databaseSchemaMigrations,
  enterDatabaseActorContext,
  enterDatabaseTenantContext,
  getDatabaseActorContext,
  getDatabaseAcquireTimeoutMs,
  getDatabaseIdleTransactionTimeoutMs,
  getDatabaseLockTimeoutMs,
  getDatabasePoolIdleTimeoutSeconds,
  getDatabasePoolMax,
  getDatabaseReservationTimeoutMs,
  getDatabaseSchemaVerificationTimeoutMs,
  getDatabaseStatementTimeoutMs,
  getDatabaseTenantContext,
  getPendingSchemaMigrationVersions,
  isDatabaseMutation,
  runWithDatabaseTenantScope,
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

  it("disables local idle rotation wherever close fencing owns generations", () => {
    try {
      vi.stubEnv("VERCEL", "");
      expect(getDatabasePoolIdleTimeoutSeconds()).toBe(0);

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

  it("bounds reserved-operation watchdog timeouts", () => {
    try {
      vi.stubEnv("OMNIAGENT_DATABASE_RESERVATION_TIMEOUT_MS", "");
      expect(getDatabaseReservationTimeoutMs()).toBe(30_000);

      vi.stubEnv("OMNIAGENT_DATABASE_RESERVATION_TIMEOUT_MS", "100");
      expect(getDatabaseReservationTimeoutMs()).toBe(1_000);

      vi.stubEnv("OMNIAGENT_DATABASE_RESERVATION_TIMEOUT_MS", "900000");
      expect(getDatabaseReservationTimeoutMs()).toBe(120_000);

      vi.stubEnv("OMNIAGENT_DATABASE_RESERVATION_TIMEOUT_MS", "invalid");
      expect(getDatabaseReservationTimeoutMs()).toBe(30_000);
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
      expect(scopeStatement(runtime.statements)?.params.slice(0, 4)).toEqual([
        "tenant-a",
        '{"version":1,"tenantId":"tenant-a","actorIds":[]}',
        "false",
        "",
      ]);
      expect(scopeStatement(maintenance.statements)?.params.slice(0, 4)).toEqual([
        "",
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

  it("disables routine postgres.js rotation on durable runtimes", async () => {
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
        expect.objectContaining({
          idle_timeout: 0,
          max_lifetime: null,
        }),
      );
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
      expect(postgresFactory).toHaveBeenCalledOnce();
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          retiredClient`SELECT 3`,
        ),
      ).resolves.toEqual([{ ok: true }]);
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 4`,
        ),
      ).resolves.toEqual([{ ok: true }]);

      expect(postgresFactory).toHaveBeenCalledTimes(2);
      expect(replacementPool.pg.reserve).toHaveBeenCalledTimes(2);
      expect(retiredPool.pg.reserve).toHaveBeenCalledOnce();
      expect(replacementPool.reserved.release).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it("retires a durable generation when its driver reservation never settles", async () => {
    vi.useFakeTimers();
    const retiredPool = createMockPoolClient([]);
    const replacementPool = createMockPoolClient([{ ok: true }]);
    retiredPool.pg.reserve.mockImplementation(
      () => new Promise<typeof retiredPool.reserved>(() => undefined),
    );
    const postgresFactory = vi
      .fn()
      .mockReturnValueOnce(retiredPool.pg)
      .mockReturnValueOnce(replacementPool.pg);
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "4");
    vi.stubEnv("OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS", "500");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const timedOut = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => isolatedClient.getSql()`SELECT 1`,
      );
      const rejection = expect(timedOut).rejects.toMatchObject({
        code: "DATABASE_ACQUIRE_TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(500);
      await rejection;

      expect(retiredPool.pg.end).toHaveBeenCalledWith({ timeout: 0 });
      expect(postgresFactory).toHaveBeenCalledOnce();
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 2`,
        ),
      ).resolves.toEqual([{ ok: true }]);
      expect(postgresFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it("retries one runtime statement on a replacement without crossing tenant scope", async () => {
    const poisonedPool = createMockPoolClient([]);
    const replacementPool = createMockPoolClient([{ ok: true }]);
    const neverSettles = new Promise<Record<string, unknown>[]>(() => undefined);
    poisonedPool.reserved.mockImplementation(
      (strings: TemplateStringsArray, ...params: unknown[]) => {
        const text = strings.join("?");
        poisonedPool.statements.push({ text, params });
        return text.includes("set_config") ? Promise.resolve([]) : neverSettles;
      },
    );
    const closeHandlers: Array<(connectionId: number) => void> = [];
    const postgresFactory = vi.fn(
      (_databaseUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        if (options.onclose) closeHandlers.push(options.onclose);
        return closeHandlers.length === 1 ? poisonedPool.pg : replacementPool.pg;
      },
    );
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS", "5000");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const poisonedClient = isolatedClient.getSql();
      const pendingQuery = isolatedClient.runWithDatabaseActorScope(
        "tenant-a",
        ["actor-a"],
        () => poisonedClient`SELECT 1`,
      );
      await vi.waitFor(() => {
        expect(poisonedPool.reserved).toHaveBeenCalledTimes(2);
      });

      closeHandlers[0]?.(1);
      await expect(pendingQuery).resolves.toEqual([{ ok: true }]);
      expect(poisonedPool.pg.end).toHaveBeenCalledOnce();
      expect(poisonedPool.pg.end).toHaveBeenCalledWith({ timeout: 0 });
      expect(poisonedPool.reserved.release).not.toHaveBeenCalled();

      await expect(
        isolatedClient.runWithDatabaseActorScope(
          "tenant-b",
          ["actor-b"],
          () => poisonedClient`SELECT 2`,
        ),
      ).resolves.toEqual([{ ok: true }]);
      expect(postgresFactory).toHaveBeenCalledTimes(2);
      expect(poisonedPool.pg.reserve).toHaveBeenCalledOnce();
      expect(replacementPool.reserved.release).toHaveBeenCalledTimes(2);
      expect(
        replacementPool.statements
          .filter(({ text }) => text.includes("set_config"))
          .map(({ params }) => params.slice(0, 2)),
      ).toEqual([
        [
          "tenant-a",
          '{"version":1,"tenantId":"tenant-a","actorIds":["actor-a"]}',
        ],
        [
          "tenant-b",
          '{"version":1,"tenantId":"tenant-b","actorIds":["actor-b"]}',
        ],
      ]);

      // A late close callback from the detached generation cannot retire the
      // replacement singleton.
      closeHandlers[0]?.(1);
      expect(replacementPool.pg.end).not.toHaveBeenCalled();
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-c", () =>
          isolatedClient.getSql()`SELECT 3`,
        ),
      ).resolves.toEqual([{ ok: true }]);
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("verifies schema before reserving both an initial and replacement generation", async () => {
    const events: string[] = [];
    const retiredPool = createMockPoolClient([]);
    const replacementPool = createMockPoolClient([{ ok: true }]);
    const schemaRows = databaseSchemaMigrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
    }));
    const neverSettles = new Promise<Record<string, unknown>[]>(() => undefined);
    retiredPool.pg.mockImplementation(() => {
      events.push("verify:retired");
      return Promise.resolve(schemaRows);
    });
    replacementPool.pg.mockImplementation(() => {
      events.push("verify:replacement");
      return Promise.resolve(schemaRows);
    });
    retiredPool.pg.reserve.mockImplementation(() => {
      events.push("reserve:retired");
      return Promise.resolve(retiredPool.reserved);
    });
    replacementPool.pg.reserve.mockImplementation(() => {
      events.push("reserve:replacement");
      return Promise.resolve(replacementPool.reserved);
    });
    retiredPool.reserved.mockImplementation(
      (strings: TemplateStringsArray, ...params: unknown[]) => {
        const text = strings.join("?");
        retiredPool.statements.push({ text, params });
        return text.includes("set_config") ? Promise.resolve([]) : neverSettles;
      },
    );
    const closeHandlers: Array<(connectionId: number) => void> = [];
    const postgresFactory = vi.fn(
      (_databaseUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        if (options.onclose) closeHandlers.push(options.onclose);
        return closeHandlers.length === 1 ? retiredPool.pg : replacementPool.pg;
      },
    );
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const pendingQuery = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => isolatedClient.getSql()`SELECT 'schema-ordered-retry'`,
      );
      await vi.waitFor(() => {
        expect(retiredPool.reserved).toHaveBeenCalledTimes(2);
      });
      expect(events).toEqual(["verify:retired", "reserve:retired"]);

      closeHandlers[0]?.(1);
      await expect(pendingQuery).resolves.toEqual([{ ok: true }]);
      expect(events).toEqual([
        "verify:retired",
        "reserve:retired",
        "verify:replacement",
        "reserve:replacement",
      ]);
      expect(postgresFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("does not let stale readiness waiters reserve a replacement generation", async () => {
    const retiredPool = createMockPoolClient([{ source: "retired" }]);
    const replacementPool = createMockPoolClient([{ source: "replacement" }]);
    const schemaRows = databaseSchemaMigrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
    }));
    const neverSettles = new Promise<Record<string, unknown>[]>(() => undefined);
    retiredPool.reserved.mockImplementation(
      (strings: TemplateStringsArray, ...params: unknown[]) => {
        const text = strings.join("?");
        retiredPool.statements.push({ text, params });
        if (text.includes("owner-holds-generation")) return neverSettles;
        return Promise.resolve(
          text.includes("set_config") ? [] : [{ source: "retired" }],
        );
      },
    );
    let resolveReplacementSchema!: (
      rows: Record<string, unknown>[],
    ) => void;
    const replacementSchema = new Promise<Record<string, unknown>[]>((resolve) => {
      resolveReplacementSchema = resolve;
    });
    replacementPool.pg.mockImplementation(() => replacementSchema);
    const closeHandlers: Array<(connectionId: number) => void> = [];
    let generation = 0;
    const postgresFactory = vi.fn(
      (_databaseUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        if (options.onclose) closeHandlers.push(options.onclose);
        generation += 1;
        return generation === 1 ? retiredPool.pg : replacementPool.pg;
      },
    );
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const staleWrapper = isolatedClient.getSql();
      await expect(
        isolatedClient.runWithDatabaseTenantScope(
          "tenant-a",
          () => staleWrapper`SELECT 'bootstrap-readiness'`,
        ),
      ).resolves.toEqual([{ source: "retired" }]);

      const owner = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => staleWrapper`SELECT 'owner-holds-generation'`,
      );
      await vi.waitFor(() => {
        expect(retiredPool.statements.some(({ text }) =>
          text.includes("owner-holds-generation"))).toBe(true);
      });

      // This waiter captures the already-resolved old readiness generation,
      // then yields before pool admission. Retire the owner generation and let
      // another waiter create the pending replacement readiness promise.
      const staleWaiter = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => staleWrapper`SELECT 'stale-readiness-waiter'`,
      );
      closeHandlers[0]?.(1);
      const replacementWaiter = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => staleWrapper`SELECT 'replacement-readiness-owner'`,
      );

      await vi.waitFor(() => expect(replacementPool.pg).toHaveBeenCalledOnce());
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
      expect(replacementPool.pg.reserve).not.toHaveBeenCalled();

      resolveReplacementSchema(schemaRows);
      await expect(Promise.all([
        owner,
        staleWaiter,
        replacementWaiter,
      ])).resolves.toEqual([
        [{ source: "replacement" }],
        [{ source: "replacement" }],
        [{ source: "replacement" }],
      ]);
      expect(replacementPool.pg.reserve).toHaveBeenCalledTimes(3);
      expect(retiredPool.pg.end).toHaveBeenCalledWith({ timeout: 0 });
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("retries one system statement on the replacement maintenance generation", async () => {
    const events: string[] = [];
    const retiredMaintenance = createMockPoolClient([]);
    const runtimeVerifier = createMockPoolClient([]);
    const replacementMaintenance = createMockPoolClient([
      { source: "replacement-maintenance" },
    ]);
    const schemaRows = databaseSchemaMigrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
    }));
    runtimeVerifier.pg.mockImplementation(() => {
      events.push("verify:runtime");
      return Promise.resolve(schemaRows);
    });
    retiredMaintenance.pg.reserve.mockImplementation(() => {
      events.push("reserve:retired-maintenance");
      return Promise.resolve(retiredMaintenance.reserved);
    });
    replacementMaintenance.pg.reserve.mockImplementation(() => {
      events.push("reserve:replacement-maintenance");
      return Promise.resolve(replacementMaintenance.reserved);
    });
    const neverSettles = new Promise<Record<string, unknown>[]>(() => undefined);
    retiredMaintenance.reserved.mockImplementation(
      (strings: TemplateStringsArray, ...params: unknown[]) => {
        const text = strings.join("?");
        retiredMaintenance.statements.push({ text, params });
        return text.includes("set_config") ? Promise.resolve([]) : neverSettles;
      },
    );
    const closeHandlers: Array<(connectionId: number) => void> = [];
    let maintenanceGenerations = 0;
    const postgresFactory = vi.fn(
      (databaseUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        if (options.onclose) closeHandlers.push(options.onclose);
        if (databaseUrl.includes("maintenance.invalid")) {
          maintenanceGenerations += 1;
          return maintenanceGenerations === 1
            ? retiredMaintenance.pg
            : replacementMaintenance.pg;
        }
        return runtimeVerifier.pg;
      },
    );
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv(
      "OMNIAGENT_MAINTENANCE_DATABASE_URL",
      "postgresql://maintenance.invalid/asael",
    );
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      const isolatedClient = await import("@/lib/db/client");
      const maintenanceClient = await isolatedClient.runWithDatabaseSystemScope(
        "capture maintenance wrapper",
        () => isolatedClient.getSql(),
      );
      const pendingQuery = isolatedClient.runWithDatabaseSystemScope(
        "retry maintenance query",
        () => maintenanceClient`SELECT 'maintenance-retry'`,
      );
      await vi.waitFor(() => {
        expect(retiredMaintenance.reserved).toHaveBeenCalledTimes(2);
      });
      expect(events).toEqual([
        "verify:runtime",
        "reserve:retired-maintenance",
      ]);

      closeHandlers[0]?.(1);
      await expect(pendingQuery).resolves.toEqual([
        { source: "replacement-maintenance" },
      ]);
      expect(retiredMaintenance.pg.end).toHaveBeenCalledWith({ timeout: 0 });
      expect(retiredMaintenance.reserved.release).not.toHaveBeenCalled();
      expect(events).toEqual([
        "verify:runtime",
        "reserve:retired-maintenance",
        "reserve:replacement-maintenance",
      ]);

      await expect(
        isolatedClient.runWithDatabaseSystemScope(
          "stale maintenance wrapper",
          () => maintenanceClient`SELECT 'maintenance-again'`,
        ),
      ).resolves.toEqual([{ source: "replacement-maintenance" }]);

      expect(postgresFactory).toHaveBeenCalledTimes(3);
      expect(postgresFactory.mock.calls.map(([databaseUrl]) => databaseUrl)).toEqual([
        "postgresql://maintenance.invalid/asael",
        "postgresql://runtime.invalid/asael",
        "postgresql://maintenance.invalid/asael",
      ]);
      expect(retiredMaintenance.pg.reserve).toHaveBeenCalledOnce();
      expect(replacementMaintenance.pg.reserve).toHaveBeenCalledTimes(2);
      expect(
        replacementMaintenance.statements
          .filter(({ text }) => text.includes("set_config"))
          .map(({ params }) => params.slice(0, 4)),
      ).toEqual([
        ["", "", "true", "retry maintenance query"],
        ["", "", "true", "stale maintenance wrapper"],
      ]);
    } finally {
      consoleInfo.mockRestore();
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("attempts a closed single statement only once on a replacement generation", async () => {
    const firstPool = createMockPoolClient([]);
    const secondPool = createMockPoolClient([]);
    const neverSettles = new Promise<Record<string, unknown>[]>(() => undefined);
    for (const pool of [firstPool, secondPool]) {
      pool.reserved.mockImplementation(
        (strings: TemplateStringsArray, ...params: unknown[]) => {
          const text = strings.join("?");
          pool.statements.push({ text, params });
          return text.includes("set_config") ? Promise.resolve([]) : neverSettles;
        },
      );
    }
    const closeHandlers: Array<(connectionId: number) => void> = [];
    const postgresFactory = vi.fn(
      (_databaseUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        if (options.onclose) closeHandlers.push(options.onclose);
        return closeHandlers.length === 1 ? firstPool.pg : secondPool.pg;
      },
    );
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("VERCEL", "1");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const pendingQuery = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => isolatedClient.getSql()`SELECT 'retry-once'`,
      );
      const rejection = expect(pendingQuery).rejects.toMatchObject({
        code: "DATABASE_CONNECTION_CLOSED",
        message: "DATABASE_URL database connection closed; its pool was retired.",
      });
      await vi.waitFor(() => {
        expect(firstPool.reserved).toHaveBeenCalledTimes(2);
      });

      closeHandlers[0]?.(1);
      await vi.waitFor(() => {
        expect(secondPool.reserved).toHaveBeenCalledTimes(2);
      });
      closeHandlers[1]?.(2);
      await rejection;

      expect(postgresFactory).toHaveBeenCalledTimes(2);
      expect(firstPool.pg.reserve).toHaveBeenCalledOnce();
      expect(secondPool.pg.reserve).toHaveBeenCalledOnce();
      expect(firstPool.pg.end).toHaveBeenCalledWith({ timeout: 0 });
      expect(secondPool.pg.end).toHaveBeenCalledWith({ timeout: 0 });
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("fences a durable runtime close without retiring the maintenance generation", async () => {
    const retiredRuntime = createMockPoolClient([]);
    const maintenance = createMockPoolClient([{ source: "maintenance" }]);
    const replacementRuntime = createMockPoolClient([{ source: "replacement" }]);
    const neverSettles = new Promise<Record<string, unknown>[]>(() => undefined);
    retiredRuntime.reserved.mockImplementation(
      (strings: TemplateStringsArray, ...params: unknown[]) => {
        const text = strings.join("?");
        retiredRuntime.statements.push({ text, params });
        return text.includes("set_config") ? Promise.resolve([]) : neverSettles;
      },
    );
    const closeHandlers: Array<(connectionId: number) => void> = [];
    const postgresFactory = vi.fn(
      (_databaseUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        if (options.onclose) closeHandlers.push(options.onclose);
        const call = closeHandlers.length;
        if (call === 1) return retiredRuntime.pg;
        if (call === 2) return maintenance.pg;
        return replacementRuntime.pg;
      },
    );
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv(
      "OMNIAGENT_MAINTENANCE_DATABASE_URL",
      "postgresql://maintenance.invalid/asael",
    );
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.resetModules();
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      const isolatedClient = await import("@/lib/db/client");
      const retiredClient = isolatedClient.getSql();
      await expect(
        isolatedClient.runWithDatabaseSystemScope(
          "warm independent maintenance pool",
          () => isolatedClient.getSql()`SELECT 'maintenance'`,
        ),
      ).resolves.toEqual([{ source: "maintenance" }]);

      const pendingRuntime = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => retiredClient`SELECT 'stuck-runtime'`,
      );
      await vi.waitFor(() => {
        expect(retiredRuntime.reserved).toHaveBeenCalledTimes(2);
      });
      closeHandlers[0]?.(1);

      await expect(pendingRuntime).resolves.toEqual([
        { source: "replacement" },
      ]);
      expect(retiredRuntime.pg.end).toHaveBeenCalledWith({ timeout: 0 });
      expect(retiredRuntime.reserved.release).not.toHaveBeenCalled();
      expect(maintenance.pg.end).not.toHaveBeenCalled();

      await expect(
        isolatedClient.runWithDatabaseSystemScope(
          "verify maintenance pool remains active",
          () => isolatedClient.getSql()`SELECT 'maintenance-again'`,
        ),
      ).resolves.toEqual([{ source: "maintenance" }]);
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 'replacement-runtime'`,
        ),
      ).resolves.toEqual([{ source: "replacement" }]);
      expect(postgresFactory).toHaveBeenCalledTimes(3);
      expect(maintenance.reserved.release).toHaveBeenCalledTimes(2);
      expect(replacementRuntime.reserved.release).toHaveBeenCalledTimes(2);
    } finally {
      consoleInfo.mockRestore();
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("fences a late transaction callback from querying or controlling a replacement generation", async () => {
    const retiredPool = createMockPoolClient([{ ok: true }]);
    const replacementPool = createMockPoolClient([{ ok: true }]);
    const closeHandlers: Array<(connectionId: number) => void> = [];
    const postgresFactory = vi.fn(
      (_databaseUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        if (options.onclose) closeHandlers.push(options.onclose);
        return closeHandlers.length === 1 ? retiredPool.pg : replacementPool.pg;
      },
    );
    let resumeCallback: () => void = () => undefined;
    const callbackGate = new Promise<void>((resolve) => {
      resumeCallback = resolve;
    });
    let markLateAttemptFinished: () => void = () => undefined;
    const lateAttemptFinished = new Promise<void>((resolve) => {
      markLateAttemptFinished = resolve;
    });
    let lateError: unknown;
    let callbackRuns = 0;
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OMNIAGENT_DATABASE_RESERVATION_TIMEOUT_MS", "5000");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const retiredClient = isolatedClient.getSql();
      const originalTransaction = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => retiredClient.transaction(async (
          sql: ReturnType<typeof isolatedClient.getSql>,
        ) => {
          callbackRuns += 1;
          await sql`SELECT 'before-close'`;
          await callbackGate;
          try {
            await sql`SELECT 'must-not-run'`;
          } catch (error) {
            lateError = error;
          } finally {
            markLateAttemptFinished();
          }
        }),
      );
      await vi.waitFor(() => {
        expect(retiredPool.statements.some(({ text }) =>
          text.includes("before-close"))).toBe(true);
      });
      const statementsAtClose = retiredPool.statements.map(({ text }) => text);

      closeHandlers[0]?.(1);
      await expect(originalTransaction).rejects.toMatchObject({
        code: "DATABASE_CONNECTION_CLOSED",
      });
      expect(postgresFactory).toHaveBeenCalledOnce();
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 'replacement'`,
        ),
      ).resolves.toEqual([{ ok: true }]);
      const replacementStatements = replacementPool.statements.map(
        ({ text }) => text,
      );

      resumeCallback();
      await lateAttemptFinished;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(lateError).toMatchObject({ code: "DATABASE_CONNECTION_CLOSED" });
      expect(retiredPool.statements.map(({ text }) => text)).toEqual(
        statementsAtClose,
      );
      expect(replacementPool.statements.map(({ text }) => text)).toEqual(
        replacementStatements,
      );
      expect(callbackRuns).toBe(1);
      expect(retiredPool.reserved.release).not.toHaveBeenCalled();
      expect(replacementPool.reserved.release).toHaveBeenCalledOnce();
    } finally {
      resumeCallback();
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("lets a waiter time out without retiring valid work, then retires a stuck owner", async () => {
    vi.useFakeTimers();
    const poisonedPool = createMockPoolClient([]);
    const replacementPool = createMockPoolClient([{ ok: true }]);
    const neverSettles = new Promise<Record<string, unknown>[]>(() => undefined);
    poisonedPool.reserved.mockImplementation(
      (strings: TemplateStringsArray, ...params: unknown[]) => {
        const text = strings.join("?");
        poisonedPool.statements.push({ text, params });
        return text.includes("set_config") ? Promise.resolve([]) : neverSettles;
      },
    );
    const postgresFactory = vi
      .fn()
      .mockReturnValueOnce(poisonedPool.pg)
      .mockReturnValueOnce(replacementPool.pg);
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS", "500");
    vi.stubEnv("OMNIAGENT_DATABASE_RESERVATION_TIMEOUT_MS", "1000");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const poisonedClient = isolatedClient.getSql();
      const stuckQuery = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => poisonedClient`SELECT 1`,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(poisonedPool.reserved).toHaveBeenCalledTimes(2);

      const starvedQuery = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => poisonedClient`SELECT 2`,
      );
      const acquireTimeoutMatch = {
        code: "DATABASE_ACQUIRE_TIMEOUT",
        message: "Database connection acquisition timed out after 500ms.",
      };
      const reservationTimeoutMatch = {
        code: "DATABASE_RESERVATION_TIMEOUT",
        message:
          "Database reserved operation made no progress for 1000ms. Its transaction outcome is unknown; automatic retry is forbidden.",
        retryable: false,
      };
      const stuckRejection = expect(stuckQuery).rejects.toMatchObject(
        reservationTimeoutMatch,
      );
      const starvedRejection = expect(starvedQuery).rejects.toMatchObject(
        acquireTimeoutMatch,
      );
      await vi.advanceTimersByTimeAsync(500);
      await starvedRejection;
      expect(poisonedPool.pg.end).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      await stuckRejection;

      expect(poisonedPool.pg.end).toHaveBeenCalledOnce();
      expect(poisonedPool.pg.end).toHaveBeenCalledWith({ timeout: 0 });
      expect(poisonedPool.reserved.release).not.toHaveBeenCalled();
      expect(postgresFactory).toHaveBeenCalledOnce();
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 3`,
        ),
      ).resolves.toEqual([{ ok: true }]);
      expect(postgresFactory).toHaveBeenCalledTimes(2);
      expect(replacementPool.reserved.release).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it("retires a durable generation when its owning query makes no progress", async () => {
    vi.useFakeTimers();
    const retiredPool = createMockPoolClient([]);
    const replacementPool = createMockPoolClient([{ ok: true }]);
    const neverSettles = new Promise<Record<string, unknown>[]>(() => undefined);
    retiredPool.reserved.mockImplementation(
      (strings: TemplateStringsArray, ...params: unknown[]) => {
        const text = strings.join("?");
        retiredPool.statements.push({ text, params });
        return text.includes("set_config") ? Promise.resolve([]) : neverSettles;
      },
    );
    const postgresFactory = vi
      .fn()
      .mockReturnValueOnce(retiredPool.pg)
      .mockReturnValueOnce(replacementPool.pg);
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "4");
    vi.stubEnv("OMNIAGENT_DATABASE_RESERVATION_TIMEOUT_MS", "1000");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const stuck = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => isolatedClient.getSql()`SELECT 1`,
      );
      const rejection = expect(stuck).rejects.toMatchObject({
        code: "DATABASE_RESERVATION_TIMEOUT",
        retryable: false,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;

      expect(retiredPool.pg.end).toHaveBeenCalledWith({ timeout: 0 });
      expect(retiredPool.reserved.release).not.toHaveBeenCalled();
      expect(postgresFactory).toHaveBeenCalledOnce();
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 2`,
        ),
      ).resolves.toEqual([{ ok: true }]);
      expect(postgresFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it("retires ghost reservations and rejects every waiter on that generation", async () => {
    vi.useFakeTimers();
    const retiredPool = createMockPoolClient([]);
    const replacementPool = createMockPoolClient([{ ok: true }]);
    let grantReservation: (reserved: typeof retiredPool.reserved) => void = () =>
      undefined;
    const pendingReservation = new Promise<typeof retiredPool.reserved>((resolve) => {
      grantReservation = resolve;
    });
    retiredPool.pg.reserve.mockImplementationOnce(() => pendingReservation);
    const postgresFactory = vi
      .fn()
      .mockReturnValueOnce(retiredPool.pg)
      .mockReturnValueOnce(replacementPool.pg);
    vi.doMock("postgres", () => ({ default: postgresFactory }));
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

      const generationWaiter = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => isolatedClient.getSql()`SELECT 3`,
      );
      const generationRejection = expect(generationWaiter).rejects.toMatchObject({
        code: "DATABASE_ACQUIRE_TIMEOUT",
      });

      await vi.advanceTimersByTimeAsync(250);
      await Promise.all([
        firstRejection,
        canceledRejection,
        generationRejection,
      ]);
      expect(retiredPool.pg.reserve).toHaveBeenCalledOnce();
      expect(retiredPool.statements).toEqual([]);
      expect(retiredPool.reserved.release).not.toHaveBeenCalled();
      expect(retiredPool.pg.end).toHaveBeenCalledWith({ timeout: 0 });

      grantReservation(retiredPool.reserved);
      await vi.advanceTimersByTimeAsync(0);
      expect(retiredPool.reserved.release).not.toHaveBeenCalled();

      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 4`,
        ),
      ).resolves.toEqual([{ ok: true }]);
      expect(postgresFactory).toHaveBeenCalledTimes(2);
      expect(statementKinds(replacementPool.statements)).toEqual([
        "BEGIN",
        "QUERY",
        "SCOPE",
        "QUERY",
        "COMMIT",
      ]);
      expect(replacementPool.reserved.release).toHaveBeenCalledOnce();
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

  it("keeps transaction control private to the reservation manager", async () => {
    const pool = createMockPoolClient([]);
    vi.doMock("postgres", () => ({ default: vi.fn(() => pool.pg) }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql().transaction((
            sql: ReturnType<typeof isolatedClient.getSql>,
          ) => sql.unsafe("COMMIT")),
        ),
      ).rejects.toThrow(
        "Transaction control is reserved for the database reservation manager.",
      );
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql().unsafe(
            "/* outer /* nested */ comment */ RELEASE tenant_savepoint",
          ),
        ),
      ).rejects.toThrow(
        "Transaction control is reserved for the database reservation manager.",
      );

      expect(transactionCommands(pool.statements)).toEqual([
        "BEGIN",
        "ROLLBACK",
        "BEGIN",
        "ROLLBACK",
      ]);
      expect(pool.reserved.release).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("uses PostgreSQL's single-statement protocol for the continued E-string exploit", async () => {
    const exploit = String.raw`UPDATE omni_memories SET importance = 1; SELECT E'a'
'b\\''; COMMIT; SELECT pg_sleep(30)`;
    const singleStatementError = Object.assign(
      new Error("cannot insert multiple commands into a prepared statement"),
      { code: "42601" },
    );
    const pool = createMockPoolClient([]);
    pool.reserved.mockImplementation(
      (strings: TemplateStringsArray, ...params: unknown[]) => {
        const text = strings.join("?");
        pool.statements.push({ text, params });
        return text.includes("COMMIT")
          ? Promise.reject(singleStatementError)
          : Promise.resolve([]);
      },
    );
    pool.reserved.unsafe.mockImplementation((
      text: string,
      params: unknown[] = [],
      options?: Record<string, unknown>,
    ) => {
      pool.statements.push({ text, params });
      const command = transactionCommand(text);
      if (command) return Promise.resolve([]);
      if (text === exploit) {
        return options?.simple === false
          ? Promise.reject(singleStatementError)
          : Promise.reject(new Error("raw batch used the simple protocol"));
      }
      return Promise.resolve([]);
    });
    const postgresFactory = vi.fn(() => pool.pg);
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql().unsafe(exploit),
        ),
      ).rejects.toBe(singleStatementError);
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql().query(exploit),
        ),
      ).rejects.toBe(singleStatementError);
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`UPDATE omni_memories SET importance = 1; COMMIT`,
        ),
      ).rejects.toBe(singleStatementError);

      expect(
        pool.reserved.unsafe.mock.calls
          .filter(([text]) => text === exploit)
          .map((call) => call[2]),
      ).toEqual([
        { prepare: false, simple: false },
        { prepare: false, simple: false },
      ]);
      expect(postgresFactory).toHaveBeenCalledOnce();
      expect(pool.pg.end).not.toHaveBeenCalled();
      expect(transactionCommands(pool.statements)).toEqual([
        "BEGIN",
        "ROLLBACK",
        "BEGIN",
        "ROLLBACK",
        "BEGIN",
        "ROLLBACK",
      ]);
      expect(pool.reserved.release).toHaveBeenCalledTimes(3);
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("ignores control words inside PostgreSQL comments and quoted regions", async () => {
    const rows = [{ ok: true }];
    const pool = createMockPoolClient(rows);
    vi.doMock("postgres", () => ({ default: vi.fn(() => pool.pg) }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const safeRawStatements = [
        "SELECT 'COMMIT; ROLLBACK', 'it''s END'",
        'SELECT "COMMIT; ROLLBACK", "quoted""END"',
        "SELECT 1 /* outer ; COMMIT /* nested ; ROLLBACK */ ignored */ -- ; END\n",
        "DO $body$ BEGIN; COMMIT; ROLLBACK; END $body$",
      ];
      for (const statement of safeRawStatements) {
        await expect(
          isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
            isolatedClient.getSql().unsafe(statement),
          ),
        ).resolves.toEqual(rows);
      }

      const parameterValue = "untrusted'; COMMIT";
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT ${parameterValue} AS payload`,
        ),
      ).resolves.toEqual(rows);

      expect(
        pool.reserved.unsafe.mock.calls
          .filter(([text]) => safeRawStatements.includes(String(text)))
          .map((call) => call[2]),
      ).toEqual(safeRawStatements.map(() => ({
        prepare: false,
        simple: false,
      })));
      const taggedParameterCall = pool.reserved.mock.calls.find(([strings]) =>
        (strings as TemplateStringsArray).join("?").includes("AS payload"));
      expect(taggedParameterCall?.slice(1)).toEqual([parameterValue]);
      expect(pool.pg.reserve).toHaveBeenCalledTimes(5);
      expect(pool.reserved.release).toHaveBeenCalledTimes(5);
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("rolls back instead of committing when a callback leaves a query running", async () => {
    const pool = createMockPoolClient([]);
    let finishQuery: () => void = () => undefined;
    const pendingQuery = new Promise<Record<string, unknown>[]>((resolve) => {
      finishQuery = () => resolve([]);
    });
    pool.reserved.mockImplementation(
      (strings: TemplateStringsArray, ...params: unknown[]) => {
        const text = strings.join("?");
        pool.statements.push({ text, params });
        return text.includes("fire-and-forget")
          ? pendingQuery
          : Promise.resolve([]);
      },
    );
    vi.doMock("postgres", () => ({ default: vi.fn(() => pool.pg) }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql().transaction((
            sql: ReturnType<typeof isolatedClient.getSql>,
          ) => {
            void sql`SELECT 'fire-and-forget'`;
          }),
        ),
      ).rejects.toMatchObject({ code: "DATABASE_RESERVATION_INFLIGHT" });

      expect(transactionCommands(pool.statements)).toEqual([
        "BEGIN",
        "ROLLBACK",
      ]);
      expect(pool.statements.some(({ text }) => text.includes("fire-and-forget")))
        .toBe(true);
      expect(pool.reserved.release).toHaveBeenCalledOnce();
    } finally {
      finishQuery();
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("does not retry an arbitrary connection-class statement error", async () => {
    const queryError = Object.assign(new Error("socket reset during query"), {
      code: "ECONNRESET",
    });
    const pool = createMockPoolClient([]);
    pool.reserved.mockImplementation(
      (strings: TemplateStringsArray, ...params: unknown[]) => {
        const text = strings.join("?");
        pool.statements.push({ text, params });
        return text.includes("set_config")
          ? Promise.resolve([])
          : Promise.reject(queryError);
      },
    );
    const postgresFactory = vi.fn(() => pool.pg);
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 1`,
        ),
      ).rejects.toBe(queryError);

      expect(postgresFactory).toHaveBeenCalledOnce();
      expect(pool.pg.reserve).toHaveBeenCalledOnce();
      expect(transactionCommands(pool.statements)).toEqual([
        "BEGIN",
        "ROLLBACK",
      ]);
      expect(pool.pg.end).not.toHaveBeenCalled();
      expect(pool.reserved.release).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("reports an unknown commit outcome and retires that exact generation", async () => {
    vi.useFakeTimers();
    const committingPool = createMockPoolClient([{ ok: true }]);
    const replacementPool = createMockPoolClient([{ ok: true }]);
    const pendingCommit = new Promise<Record<string, unknown>[]>(() => undefined);
    committingPool.reserved.unsafe.mockImplementation(
      (text: string, params: unknown[] = []) => {
        committingPool.statements.push({ text, params });
        return transactionCommand(text) === "COMMIT"
          ? pendingCommit
          : Promise.resolve([]);
      },
    );
    const postgresFactory = vi
      .fn()
      .mockReturnValueOnce(committingPool.pg)
      .mockReturnValueOnce(replacementPool.pg);
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OMNIAGENT_DATABASE_RESERVATION_TIMEOUT_MS", "1000");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const committing = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => isolatedClient.getSql()`SELECT 1`,
      );
      const rejectedCommit = expect(committing).rejects.toMatchObject({
        code: "DATABASE_COMMIT_OUTCOME_UNKNOWN",
        message:
          "Database commit timed out after 1000ms. Its outcome is unknown; automatic retry is forbidden.",
        retryable: false,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(transactionCommands(committingPool.statements)).toContain("COMMIT");

      await vi.advanceTimersByTimeAsync(1000);
      await rejectedCommit;
      expect(transactionCommands(committingPool.statements)).toEqual([
        "BEGIN",
        "COMMIT",
      ]);
      expect(committingPool.pg.end).toHaveBeenCalledWith({ timeout: 0 });
      expect(committingPool.reserved.release).not.toHaveBeenCalled();
      expect(postgresFactory).toHaveBeenCalledOnce();

      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 2`,
        ),
      ).resolves.toEqual([{ ok: true }]);
      expect(postgresFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it("keeps close-during-COMMIT unknown only on the committing lease", async () => {
    const pool = createMockPoolClient([{ ok: true }]);
    const replacementPool = createMockPoolClient([{ ok: true }]);
    const pendingCommit = new Promise<Record<string, unknown>[]>(() => undefined);
    pool.reserved.unsafe.mockImplementation(
      (text: string, params: unknown[] = []) => {
        pool.statements.push({ text, params });
        return transactionCommand(text) === "COMMIT"
          ? pendingCommit
          : Promise.resolve([]);
      },
    );
    const closeHandlers: Array<(connectionId: number) => void> = [];
    const postgresFactory = vi.fn(
      (_databaseUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        if (options.onclose) closeHandlers.push(options.onclose);
        return closeHandlers.length === 1 ? pool.pg : replacementPool.pg;
      },
    );
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS", "5000");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const client = isolatedClient.getSql();
      const committing = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => client`SELECT 1`,
      );
      await vi.waitFor(() => {
        expect(transactionCommands(pool.statements)).toContain("COMMIT");
      });
      const waiting = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => client`SELECT 2`,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const committingRejection = expect(committing).rejects.toMatchObject({
        code: "DATABASE_COMMIT_OUTCOME_UNKNOWN",
        retryable: false,
      });
      const waitingResult = expect(waiting).resolves.toEqual([{ ok: true }]);

      closeHandlers[0]?.(1);
      await Promise.all([committingRejection, waitingResult]);
      expect(transactionCommands(pool.statements)).toEqual([
        "BEGIN",
        "COMMIT",
      ]);
      expect(pool.pg.end).toHaveBeenCalledWith({ timeout: 0 });
      expect(pool.reserved.release).not.toHaveBeenCalled();
      expect(replacementPool.reserved.release).toHaveBeenCalledOnce();
      expect(postgresFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("retires an ECONNRESET COMMIT before rollback or a delayed close can escape", async () => {
    const retiredPool = createMockPoolClient([{ ok: true }]);
    const replacementPool = createMockPoolClient([{ ok: true }]);
    let rejectCommit: (error: Error) => void = () => undefined;
    const pendingCommit = new Promise<Record<string, unknown>[]>((_, reject) => {
      rejectCommit = reject;
    });
    retiredPool.reserved.unsafe.mockImplementation(
      (text: string, params: unknown[] = []) => {
        retiredPool.statements.push({ text, params });
        return transactionCommand(text) === "COMMIT"
          ? pendingCommit
          : Promise.resolve([]);
      },
    );
    const closeHandlers: Array<(connectionId: number) => void> = [];
    const postgresFactory = vi.fn(
      (_databaseUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        if (options.onclose) closeHandlers.push(options.onclose);
        return closeHandlers.length === 1 ? retiredPool.pg : replacementPool.pg;
      },
    );
    vi.doMock("postgres", () => ({ default: postgresFactory }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS", "5000");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const retiredClient = isolatedClient.getSql();
      let callbackRuns = 0;
      const committing = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => retiredClient.transaction(async (
          sql: ReturnType<typeof isolatedClient.getSql>,
        ) => {
          callbackRuns += 1;
          return sql`SELECT 1`;
        }),
      );
      await vi.waitFor(() => {
        expect(transactionCommands(retiredPool.statements)).toContain("COMMIT");
      });
      const waiting = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => retiredClient`SELECT 2`,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const committingRejection = expect(committing).rejects.toMatchObject({
        code: "DATABASE_COMMIT_OUTCOME_UNKNOWN",
        retryable: false,
      });
      const waitingResult = expect(waiting).resolves.toEqual([{ ok: true }]);

      rejectCommit(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }));
      await Promise.all([committingRejection, waitingResult]);
      expect(callbackRuns).toBe(1);
      expect(transactionCommands(retiredPool.statements)).toEqual([
        "BEGIN",
        "COMMIT",
      ]);
      expect(retiredPool.pg.end).toHaveBeenCalledWith({ timeout: 0 });
      expect(retiredPool.reserved.release).not.toHaveBeenCalled();

      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 3`,
        ),
      ).resolves.toEqual([{ ok: true }]);
      const replacementStatements = replacementPool.statements.map(
        ({ text }) => text,
      );
      closeHandlers[0]?.(1);
      expect(replacementPool.pg.end).not.toHaveBeenCalled();
      await expect(
        isolatedClient.runWithDatabaseTenantScope("tenant-a", () =>
          isolatedClient.getSql()`SELECT 4`,
        ),
      ).resolves.toEqual([{ ok: true }]);
      expect(replacementPool.statements.map(({ text }) => text)).not.toEqual(
        replacementStatements,
      );
      expect(postgresFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("refreshes the no-progress watchdog after each successful operation", async () => {
    vi.useFakeTimers();
    const pool = createMockPoolClient([{ ok: true }]);
    pool.reserved.mockImplementation(
      (strings: TemplateStringsArray, ...params: unknown[]) => {
        const text = strings.join("?");
        pool.statements.push({ text, params });
        if (text.includes("slow-step")) {
          return new Promise<Record<string, unknown>[]>((resolve) => {
            setTimeout(() => resolve([{ ok: true }]), 700);
          });
        }
        return Promise.resolve(text.includes("set_config") ? [] : [{ ok: true }]);
      },
    );
    vi.doMock("postgres", () => ({ default: vi.fn(() => pool.pg) }));
    vi.stubEnv("DATABASE_URL", "postgresql://runtime.invalid/asael");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("OMNIAGENT_DATABASE_RESERVATION_TIMEOUT_MS", "1000");
    vi.resetModules();

    try {
      const isolatedClient = await import("@/lib/db/client");
      const transaction = isolatedClient.runWithDatabaseTenantScope(
        "tenant-a",
        () => isolatedClient.getSql().transaction(async (
          sql: ReturnType<typeof isolatedClient.getSql>,
        ) => {
          await sql`SELECT 'slow-step-1'`;
          await sql`SELECT 'slow-step-2'`;
          return "done";
        }),
      );
      await vi.advanceTimersByTimeAsync(700);
      await vi.advanceTimersByTimeAsync(700);

      await expect(transaction).resolves.toBe("done");
      expect(transactionCommands(pool.statements)).toEqual([
        "BEGIN",
        "COMMIT",
      ]);
      expect(pool.pg.end).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("postgres");
      vi.unstubAllEnvs();
      vi.useRealTimers();
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
      unsafe: vi.fn((
        text: string,
        params: unknown[] = [],
        _options?: Record<string, unknown>,
      ) => {
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
  const pg = Object.assign(vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("FROM omni_schema_version")) {
      return Promise.resolve(databaseSchemaMigrations.map((migration) => ({
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
      })));
    }
    return Promise.resolve(resultRows);
  }), {
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
        actorIds: ["actor-a"],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].text.match(/set_config/g)).toHaveLength(8);
      expect(calls[0].text).toContain("set_config('omni.actor_scope_v1'");
      expect(calls[0].text).toContain(
        "set_config('standard_conforming_strings', 'on', true)",
      );
      expect(calls[0].text).toContain("set_config('statement_timeout'");
      expect(calls[0].text).toContain("set_config('lock_timeout'");
      expect(calls[0].text).toContain(
        "set_config('idle_in_transaction_session_timeout'",
      );
      expect(calls[0].params).toEqual([
        "tenant-a",
        '{"version":1,"tenantId":"tenant-a","actorIds":["actor-a"]}',
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
      expect(calls[0].text.match(/set_config/g)).toHaveLength(8);
      expect(calls[0].params).toEqual([
        "",
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
  it("pins the split agent identity and private-memory migrations", () => {
    expect(databaseSchemaMigrations.find((migration) => migration.version === 108)).toEqual({
      version: 108,
      name: "agent_identity_versions_v1",
      checksum: "0061d42b7a5638ffb41b2c51038df6d082c183b08f94aec5d3196920430be476",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 109)).toEqual({
      version: 109,
      name: "agent_definition_persona_v1",
      checksum: "4c853b38ba5b8a2643c10c9a17789f0c2762feeb4dcc50e7eae1e2b0a086dc89",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 110)).toEqual({
      version: 110,
      name: "agent_private_memory_v1",
      checksum: "7472b7f5f3ce4099e0b74f6a71bd661cc5de465b014b0df06d9e85571d4ce54b",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 111)).toEqual({
      version: 111,
      name: "agent_memory_grants_v1",
      checksum: "7e438818cab0afcf73dfe6aeda9d36edbf6bd7d81c83a26c92b1370f4a0b1dc6",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 112)).toEqual({
      version: 112,
      name: "agent_memory_grant_lifecycle_v1",
      checksum: "1f4938099e3912d33c92a483db1563bdb6ad76e90c090d2a85b8b456da61c715",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 113)).toEqual({
      version: 113,
      name: "agent_release_lifecycle_v1",
      checksum: "9cbb9af27c5978f1fdd9af6ef12da8c9f9282251d162d879d5b323d657b1b6ff",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 151)).toEqual({
      version: 151,
      name: "maintenance_system_scope_v1",
      checksum: "6eeab2482987d833ab99862640348951d6d798d732cb91df91791ac29b098679",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 169)).toEqual({
      version: 169,
      name: "app_builder_verification_v1",
      checksum: "42d9291da42daf9b4513f4fe9f3221bae4336d2d20074773a96db70135d9d176",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 170)).toEqual({
      version: 170,
      name: "app_builder_github_delivery_v1",
      checksum: "7d1f8e773faa0de1e8a5ac7a58ffb79a236a79504932fc757ee4cfbfbf796e7f",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 171)).toEqual({
      version: 171,
      name: "app_builder_preview_deployments_v1",
      checksum: "22a1cc4db58ef6e999d0276af281a12d4876dc46964009ebd124d645327294ad",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 172)).toEqual({
      version: 172,
      name: "app_builder_production_releases_v1",
      checksum: "7d4c51d2d01df3f14c2ccf263b8c2b029acaf1537db427d8b2353b4b3ea8fed0",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 174)).toEqual({
      version: 174,
      name: "app_builder_repository_workspaces_v1",
      checksum: "30f4769a6fcccd41aa457882b6be2752583d7d5920be75597e3b2121e91604d0",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 187)).toEqual({
      version: 187,
      name: "builtin_skill_catalog_v2",
      checksum: "fe690251c625bd3a55932b5a58c26509df6bc283cb24a1dd7c6373a1ce0a3a9c",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 188)).toEqual({
      version: 188,
      name: "builtin_skill_catalog_v3",
      checksum: "4c206314533b7812aff807d551f1b1514987582b64c21e1c17378ac0c592deb1",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 189)).toEqual({
      version: 189,
      name: "generated_artifact_persistence_v1",
      checksum: "4065c615c77bf4baf5921d5dcd468359ed8113bc49ba5291908bdfc3b9f36ebf",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 190)).toEqual({
      version: 190,
      name: "moltbook_agent_connections_v1",
      checksum: "e0b8c00ca8f4fce6139735623366cacfa97675419a57c1666b4bf0fe4bbe8e46",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 191)).toEqual({
      version: 191,
      name: "agent_identity_validator_privilege_repair_v1",
      checksum: "225d62212d28a5c6186d0e62d402a61e0283bfd34695f1f8aa25b2e1132593f2",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 192)).toEqual({
      version: 192,
      name: "agent_private_trigger_privilege_repair_v1",
      checksum: "a8beaa32d24c97ad6763801982c474414ab93a046f98d91fc3df30bb9e172fab",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 193)).toEqual({
      version: 193,
      name: "execution_principal_row_validator_grant_v1",
      checksum: "9b787d1cfa1d6ae007cf8594f43c00045bab640b1f596e91d330923acc3bf2f7",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 194)).toEqual({
      version: 194,
      name: "moltbook_autonomy_v1",
      checksum: "66a868eed1a0fef0eb61d8f69d0d2351605edf39711c007d5c58f1febb5cafef",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 195)).toEqual({
      version: 195,
      name: "moltbook_autonomy_privilege_repair_v1",
      checksum: "c02b2ca195cbb00c206320eb2074fed7981c282c356f1d4320c6c1ac866adf94",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 196)).toEqual({
      version: 196,
      name: "delegation_execution_runtime_v1",
      checksum: "0113edbdab2a99f32d4e318c8407a5b66fb8fd7bcbbf839d4d199ded0d2ad6ac",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 199)).toEqual({
      version: 199,
      name: "scheduled_workflow_policy_lease_v1",
      checksum: "56d69404165e70123c590cf1637985db06de55889e4de64e28523b92885ca093",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 200)).toEqual({
      version: 200,
      name: "notification_disposition_runtime_v1",
      checksum: "99af5ab52a824c435e19e46f918755bfa549a1fecda22f9061940f9030c97c2b",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 202)).toEqual({
      version: 202,
      name: "delegation_execution_rls_composition_repair_v1",
      checksum: "3d6b28bd2fdb00cc57360506baea3ef120a4ae13e0050be57ba6d266310a3d63",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 203)).toEqual({
      version: 203,
      name: "agent_daily_learning_v1",
      checksum: "88fa0dd240ba1920d2bb66395bb2b268dc98bd682282fbe3633d1df4b1d01f96",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 204)).toEqual({
      version: 204,
      name: "google_multi_account_connections_v1",
      checksum: "8c7ae456bdbcc92f00adb2f24728cf03dc2b082cae7880e0f87ce71d15314cd8",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 205)).toEqual({
      version: 205,
      name: "governed_local_command_runner_v1",
      checksum: "a9c301b4ef3030962b2ae9f69b8df9c2cb2914e90b0d9c8a3c6032f91691015a",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 206)).toEqual({
      version: 206,
      name: "prompt_queue_context_pins_v1",
      checksum: "5de8d38921e0d4d0f7e79bcfe4745f780ce973b009c874a519d09bfd8f3ff777",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 139)).toEqual({
      version: 139,
      name: "salesforce_guarded_writes_v1",
      checksum: "1abb9529ce56ff31484da98bc52de725d7c6402792dbff1b0b1706abc7c9f1e1",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 137)).toEqual({
      version: 137,
      name: "customer_account_360_v1",
      checksum: "b9612ed4eb81a1a34496d22cead72ba782facc9594085eef551584ebb97a0c07",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 136)).toEqual({
      version: 136,
      name: "meeting_commitment_conversion_v1",
      checksum: "ab838fcbc59a03d497e77b256e2d7f0e85bd5576ac4fa9980434b764fb9765be",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 129)).toEqual({
      version: 129,
      name: "canonical_work_projection_repair_v1",
      checksum: "2caff999167ba65438fbef957b194e64b9556c203028995fbb316ed7ba310bfc",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 128)).toEqual({
      version: 128,
      name: "canonical_work_model_v1",
      checksum: "04e10243d48983a00192987e1a2cb0f4b7dc00a1609a13d172495e911c85c59c",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 126)).toEqual({
      version: 126,
      name: "ap2_credential_authorization_v1",
      checksum: "58e206e5cf85d52958965d7ae06d89a1f61059ee41532970c3645b1dfff60708",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 125)).toEqual({
      version: 125,
      name: "ap2_human_present_mandates_v1",
      checksum: "f8b75e5d61a3a347649d82909e8e18e6f174079d37a5609643df768c0c9031a5",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 124)).toEqual({
      version: 124,
      name: "governed_communications_v1",
      checksum: "b0199382bc9ed5a5fe99357b3deec7b0b3ed9de8921e89ed6705062b8e2b862f",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 123)).toEqual({
      version: 123,
      name: "actor_rls_policy_repair_v1",
      checksum: "d5dfb0fb60b28c8d8c317ae8c13d9e9000cfa408ae2124dd7d62e7af538bebcd",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 122)).toEqual({
      version: 122,
      name: "browser_takeover_profiles_v1",
      checksum: "ee32a9191756e79b13799f8e5bbf0768a962f7501194c222bb481ef9fa2e47d4",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 120)).toEqual({
      version: 120,
      name: "trash_lifecycle_v1",
      checksum: "49c6af6f71d05afa4f10aa2d966381f2614fe8e9037347cd247d7b56a332049c",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 119)).toEqual({
      version: 119,
      name: "a2a_delegation_safety_v1",
      checksum: "fd3a418e621c8763c1d1850e287c098e69fa805f79a0ab00e399d67f4b3d76bc",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 118)).toEqual({
      version: 118,
      name: "a2a_task_mappings_v1",
      checksum: "79e1d6eab1184b8737e08f128ae49d6c966b53d7386d36c1e94efd5974085f8c",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 117)).toEqual({
      version: 117,
      name: "a2a_peer_rollouts_v1",
      checksum: "a11e97b868005023fe398d66bb795bd9939ca3b19963515452a54fe849aecb67",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 116)).toEqual({
      version: 116,
      name: "delegation_task_lifecycle_v1",
      checksum: "8b60665b57c9d7d1e4c31c3d17a6b57fbd50d4c9f0fecbe3d2ffaa2a7eee4ccc",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 115)).toEqual({
      version: 115,
      name: "agent_adaptation_lifecycle_v1",
      checksum: "adb861cb8c067108beaa6e0f92eb206086541f766e5665421fe887e2a11d90e5",
    });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 114)).toEqual({
      version: 114,
      name: "agent_release_enrollment_v1",
      checksum: "368ef844bec7d397e8bf8fe50c743aecd9e383b22f5451132e2feff528516f43",
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
    const futureVersion = (databaseSchemaMigrations.at(-1)?.version || 0) + 1;
    expect(() => getPendingSchemaMigrationVersions([0])).toThrow(
      /unknown migration versions: 0/i,
    );
    expect(() => getPendingSchemaMigrationVersions([futureVersion])).toThrow(
      new RegExp(`unknown migration versions: ${futureVersion}`, "i"),
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

  it("keeps every database-scoped API response out of browser and shared caches", async () => {
    const handle = withDatabaseRequestScope(async (request: Request) => {
      expect(request.url).toBe("https://asael.example/api/private");
      return Response.json(
        { tenantId: "tenant-a", actorId: "actor-a" },
        { headers: { "cache-control": "public, s-maxage=300" } },
      );
    });

    const response = await handle(
      new Request("https://asael.example/api/private"),
    );

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("server-timing")).toContain("total;dur=");
    await expect(response.json()).resolves.toEqual({
      tenantId: "tenant-a",
      actorId: "actor-a",
    });
  });

  it("preserves only the explicit public health-summary cache contract", async () => {
    const handle = withDatabaseRequestScope(async (_request: Request) =>
      Response.json(
        { status: "healthy" },
        {
          headers: {
            "cache-control": "public, s-maxage=30, stale-while-revalidate=300",
          },
        },
      )
    );

    const publicSummary = await handle(
      new Request("https://asael.example/api/health?public=1"),
    );
    expect(publicSummary.headers.get("cache-control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=300",
    );

    const privateHealth = await handle(
      new Request("https://asael.example/api/health"),
    );
    expect(privateHealth.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("propagates actor aliases only inside the resolved request scope", async () => {
    const resolveActor = withDatabaseRequestScope(async () => {
      enterDatabaseActorContext("tenant-a", ["actor:canonical", "legacy@example.test"]);
      await Promise.resolve();
      return {
        tenantId: getDatabaseTenantContext(),
        actorIds: getDatabaseActorContext(),
      };
    });

    await expect(resolveActor()).resolves.toEqual({
      tenantId: "tenant-a",
      actorIds: ["actor:canonical", "legacy@example.test"],
    });
    expect(getDatabaseActorContext()).toEqual([]);
  });

  it("preserves an actor scope through a same-tenant nested boundary", async () => {
    const nestedActor = withDatabaseRequestScope(async () => {
      enterDatabaseActorContext("tenant-a", ["actor-a"]);
      return runWithDatabaseTenantScope(
        "tenant-a",
        () => getDatabaseActorContext(),
      );
    });

    await expect(nestedActor()).resolves.toEqual(["actor-a"]);
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
