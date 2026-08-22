import { describe, expect, it, vi } from "vitest";
import {
  databaseSchemaMigrations,
  enterDatabaseTenantContext,
  getDatabaseTenantContext,
  getPendingSchemaMigrationVersions,
  validateSchemaMigrationMarkers,
  withDatabaseRequestScope,
} from "@/lib/db/client";

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
