import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  responses: [] as Record<string, unknown>[][],
  queries: [] as Array<{ text: string; values: unknown[] }>,
  scopes: [] as Array<{ tenantId: string; actorIds: readonly string[] }>,
}));

vi.mock("@/lib/db/client", () => {
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    mocks.queries.push({ text: strings.join("?"), values });
    return mocks.responses.shift() || [];
  };
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: () => sql,
    hasDatabaseUrl: () => true,
    runWithDatabaseActorScope: async (
      tenantId: string,
      actorIds: readonly string[],
      operation: () => Promise<unknown>,
    ) => {
      mocks.scopes.push({ tenantId, actorIds });
      return operation();
    },
  };
});

import {
  buildCustomerAccountRevision,
  customerAccountId,
  customerMutationId,
} from "@/lib/customer-success/contracts";
import {
  loadCustomerSuccessAccountSourceSet,
  loadCustomerSuccessPortfolioSourceSets,
} from "@/lib/customer-success/intelligence-store";

const tenantId = "tenant-a";
const workspaceId = "workspace:tenant-a";
const actorId = "actor:11111111-1111-4111-8111-111111111111";
const accountId = customerAccountId({ tenantId, workspaceId, idempotencyKey: "account" });

beforeEach(() => {
  mocks.responses = [];
  mocks.queries = [];
  mocks.scopes = [];
});

describe("customer-success intelligence store", () => {
  it("loads bounded immutable history and linked surfaces under exact actor scope", async () => {
    const snapshot = account();
    mocks.responses = [
      [{ account_snapshot: snapshot }],
      [],
      [{ account_snapshot: snapshot }],
      [],
      [],
      [],
      [],
      [],
    ];

    const result = await loadCustomerSuccessAccountSourceSet(authority(), accountId, {
      historyLimit: 40,
    });

    expect(result?.account360.account.accountId).toBe(accountId);
    expect(result?.accountHistory).toEqual([snapshot]);
    expect(result?.health).toBeNull();
    expect(mocks.scopes).toEqual([{ tenantId, actorIds: [actorId] }]);
    expect(mocks.queries).toHaveLength(8);
    expect(mocks.queries.every((query) => query.values.includes(tenantId))).toBe(true);
    expect(mocks.queries.some((query) => query.text.includes("jsonb_array_elements"))).toBe(true);
    expect(mocks.queries.some((query) =>
      query.text.includes("omni_customer_success_workflow_run_revisions")
    )).toBe(true);
  });

  it("returns an empty portfolio without reading unrelated workspace surfaces", async () => {
    mocks.responses = [[]];

    const result = await loadCustomerSuccessPortfolioSourceSets(authority(), { limit: 20 });

    expect(result).toEqual([]);
    expect(mocks.queries).toHaveLength(1);
    expect(mocks.queries[0]?.text).toContain("FROM omni_customer_accounts");
  });
});

function authority() {
  return {
    tenantId,
    workspaceId,
    canonicalActorId: actorId,
    readableActorIds: [actorId],
    purposeId: "customer_success.account.read" as const,
  };
}

function account() {
  return buildCustomerAccountRevision({
    tenantId,
    workspaceId,
    accountId,
    organizationEntityId: "organization:acme",
    revision: 1,
    mutationId: customerMutationId({ accountId, idempotencyKey: "account", operation: "account.create" }),
    name: "Acme",
    lifecycle: "active",
    accountOwner: { ownerKind: "actor", ownerId: actorId, displayName: "CSM" },
    crmPermissions: {
      readScope: "workspace_members",
      writeScope: "account_owner",
      externalWriteState: "disabled",
      customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"],
    },
    ownerActorId: actorId,
    revisedByActorId: actorId,
    revisedAt: "2026-09-08T08:00:00.000Z",
  });
}
