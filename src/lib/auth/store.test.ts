import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-auth-"));
  delete process.env.DATABASE_URL;
  delete process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
  delete process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
});

describe("auth identity creation (file mode)", () => {
  it("rejects an existing global email without attaching it to another tenant", async () => {
    const auth = await import("@/lib/auth/store");
    const created = await auth.createUserWithMembership({
      email: "existing@example.com",
      password: "correct horse battery staple",
      role: "admin",
      tenantId: "tenant-a",
      tenantName: "Tenant A",
    });

    expect(created.email).toBe("existing@example.com");
    expect(created).not.toHaveProperty("passwordHash");

    await expect(
      auth.createUserWithMembership({
        email: "EXISTING@example.com",
        password: "a different secure password",
        role: "viewer",
        tenantId: "tenant-b",
        tenantName: "Tenant B",
      }),
    ).rejects.toMatchObject({
      name: "IdentityConflictError",
      code: "identity_conflict",
      status: 409,
    });

    const tenantA = await auth.getAuthControlPlane({ tenantId: "tenant-a" });
    const tenantB = await auth.getAuthControlPlane({ tenantId: "tenant-b" });
    expect(tenantA.users).toHaveLength(1);
    expect(tenantA.users[0]).not.toHaveProperty("passwordHash");
    expect(tenantB.users).toHaveLength(0);
    expect(tenantB.memberships).toHaveLength(0);
  });

  it("rotates a workspace password and revokes active sessions", async () => {
    const auth = await import("@/lib/auth/store");
    const email = "rotate@example.com";
    const tenantId = "tenant-rotate";
    await auth.createUserWithMembership({
      email,
      password: "original secure password",
      role: "operator",
      tenantId,
    });
    const originalSession = await auth.authenticatePassword({
      email,
      password: "original secure password",
    });
    expect(originalSession).not.toBeNull();

    await expect(
      auth.rotateUserPassword({
        email,
        password: "replacement secure password",
        tenantId,
      }),
    ).resolves.toMatchObject({ email });
    await expect(
      auth.getSessionIdentity(originalSession?.token),
    ).resolves.toBeNull();
    await expect(
      auth.authenticatePassword({
        email,
        password: "original secure password",
      }),
    ).resolves.toBeNull();
    await expect(
      auth.authenticatePassword({
        email,
        password: "replacement secure password",
      }),
    ).resolves.toMatchObject({
      identity: {
        tenant: { id: tenantId },
      },
    });
  });
});
