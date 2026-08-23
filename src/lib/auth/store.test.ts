import { mkdtemp, readFile } from "node:fs/promises";
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

  it("resolves a fresh session without provisioning changed bootstrap credentials", async () => {
    const auth = await import("@/lib/auth/store");
    process.env.OMNIAGENT_BOOTSTRAP_EMAIL = "bootstrap-session@example.com";
    process.env.OMNIAGENT_BOOTSTRAP_PASSWORD = "bootstrap session password";
    process.env.OMNIAGENT_DEFAULT_TENANT = "tenant-session-bootstrap";
    const authenticated = await auth.authenticatePassword({
      email: process.env.OMNIAGENT_BOOTSTRAP_EMAIL,
      password: process.env.OMNIAGENT_BOOTSTRAP_PASSWORD,
    });
    expect(authenticated).not.toBeNull();

    const authFile = path.join(process.env.OMNIAGENT_DATA_DIR!, "auth.json");
    const before = await readFile(authFile, "utf8");
    process.env.OMNIAGENT_BOOTSTRAP_EMAIL = "should-not-be-provisioned@example.com";
    process.env.OMNIAGENT_BOOTSTRAP_PASSWORD = "unused bootstrap password";
    process.env.OMNIAGENT_DEFAULT_TENANT = "tenant-not-provisioned";

    await expect(
      auth.getSessionIdentity(authenticated?.token),
    ).resolves.toMatchObject({
      user: { email: "bootstrap-session@example.com" },
      tenant: { id: "tenant-session-bootstrap" },
    });
    await expect(readFile(authFile, "utf8")).resolves.toBe(before);
  });
});
