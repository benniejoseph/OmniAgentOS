import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import type { AuthLedger } from "@/lib/auth/types";

const TENANT_ID = "tenant-current-role";
const EMAIL = "member@example.com";
const account = {
  email: EMAIL,
  tenantId: TENANT_ID,
  tenantName: "Current Role",
  tenantMode: "new",
  label: "Member",
  role: "operator",
};

function allow(accounts: object[]) {
  process.env.OMNIAGENT_PRIVATE_ACCOUNT_ALLOWLIST_JSON = JSON.stringify(accounts);
}

async function editLedger(edit: (ledger: AuthLedger) => AuthLedger) {
  await updateJsonFile<AuthLedger>(
    getDataPath("auth.json"),
    { tenants: [], users: [], memberships: [], sessions: [] },
    edit,
  );
}

function role(actorId = EMAIL, tenantId = TENANT_ID) {
  return import("@/lib/auth/store").then((auth) =>
    auth.currentAccountRoleInTenant({ tenantId, actorId })
  );
}

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-current-role-"),
  );
  delete process.env.DATABASE_URL;
  delete process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
  delete process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
  allow([account]);
  const auth = await import("@/lib/auth/store");
  await auth.createUserWithMembership({
    email: EMAIL,
    password: "correct horse battery staple",
    role: "operator",
    tenantId: TENANT_ID,
    tenantName: "Current Role",
  });
});

beforeEach(async () => {
  allow([account]);
  await editLedger((ledger) => ({
    ...ledger,
    users: ledger.users.map((user) => ({ ...user, status: "active" })),
    memberships: ledger.memberships
      .filter((membership) => membership.tenantId === TENANT_ID)
      .map((membership) => ({ ...membership, status: "active" })),
  }));
});

describe("an account's current role in a tenant (file mode)", () => {
  it("is the role of its active membership", async () => {
    await expect(role()).resolves.toBe("operator");
    await expect(role(" Member@Example.com ")).resolves.toBe("operator");
  });

  it("is unknown for an actor that is not an account", async () => {
    await expect(role("internal-service")).resolves.toBeUndefined();
  });

  it("is none in a tenant it does not belong to", async () => {
    await expect(role(EMAIL, "tenant-elsewhere")).resolves.toBeNull();
  });

  it("is none once its membership or account is disabled", async () => {
    await editLedger((ledger) => ({
      ...ledger,
      memberships: ledger.memberships.map((membership) => ({
        ...membership,
        status: "disabled",
      })),
    }));
    await expect(role()).resolves.toBeNull();

    await editLedger((ledger) => ({
      ...ledger,
      users: ledger.users.map((user) => ({ ...user, status: "disabled" })),
      memberships: ledger.memberships.map((membership) => ({
        ...membership,
        status: "active",
      })),
    }));
    await expect(role()).resolves.toBeNull();
  });

  it("is none once the private-account policy stops granting it", async () => {
    allow([{ ...account, email: "someone-else@example.com" }]);
    await expect(role()).resolves.toBeNull();

    allow([{ ...account, role: "admin" }]);
    await expect(role()).resolves.toBeNull();
  });

  it("is none while the account is also active in another tenant", async () => {
    const addSecondMembership = (status: "active" | "disabled") =>
      editLedger((ledger) => ({
        ...ledger,
        memberships: [
          ...ledger.memberships.filter((membership) =>
            membership.tenantId === TENANT_ID),
          {
            ...ledger.memberships[0],
            id: "membership-second-tenant",
            tenantId: "tenant-second",
            status,
          },
        ],
      }));

    await addSecondMembership("disabled");
    await expect(role()).resolves.toBe("operator");
    await addSecondMembership("active");
    await expect(role()).resolves.toBeNull();
  });
});
