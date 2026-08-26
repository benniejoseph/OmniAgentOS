import { describe, expect, it, vi } from "vitest";
import {
  applyDatabaseScope,
  databaseSchemaMigrations,
  enterDatabaseTenantContext,
  getDatabasePoolMax,
  getDatabaseSchemaVerificationTimeoutMs,
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
      vi.stubEnv("NODE_ENV", "test");
      expect(getDatabasePoolMax()).toBe(1);

      vi.stubEnv("NODE_ENV", "production");
      expect(getDatabasePoolMax()).toBe(4);

      vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "8");
      expect(getDatabasePoolMax()).toBe(8);

      vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "200");
      expect(getDatabasePoolMax()).toBe(20);
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
});

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

    await applyDatabaseScope(sql, {
      kind: "tenant",
      tenantId: "tenant-a",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].text.match(/set_config/g)).toHaveLength(3);
    expect(calls[0].params).toEqual(["tenant-a", "false", ""]);

    calls.length = 0;
    await applyDatabaseScope(sql, {
      kind: "system",
      reason: "maintenance",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(["", "true", "maintenance"]);
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
