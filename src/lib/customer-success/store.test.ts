import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantId = "tenant-a";
const workspaceId = "workspace:tenant-a";
const actorId = "actor:11111111-1111-4111-8111-111111111111";
const now = "2026-09-08T02:00:00.000Z";
const mocks = vi.hoisted(() => ({
  responses: [] as Record<string, unknown>[][],
  queries: [] as Array<{ text: string; values: unknown[] }>,
  event: vi.fn(),
}));

vi.mock("@/lib/db/client", () => {
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      mocks.queries.push({ text: strings.join("?"), values });
      return mocks.responses.shift() || [];
    },
    { transaction: async (operation: (client: unknown) => Promise<unknown>) => operation(sql) },
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: () => sql,
    hasDatabaseUrl: () => true,
    runWithDatabaseActorScope: async (
      _tenantId: string,
      _actorIds: readonly string[],
      operation: () => Promise<unknown>,
    ) => operation(),
  };
});

vi.mock("@/lib/events/store", () => ({ appendScopedDomainEvent: mocks.event }));

import {
  customerAccountId,
  customerFactId,
  customerMutationId,
  type CustomerCrmPermissions,
} from "@/lib/customer-success/contracts";
import {
  recordCustomerFact,
  saveCustomerAccount,
} from "@/lib/customer-success/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const accountId = customerAccountId({ tenantId, workspaceId, idempotencyKey: "account-1" });

function authority(idempotencyKey: string) {
  return {
    tenantId,
    workspaceId,
    canonicalActorId: actorId,
    readableActorIds: [actorId],
    purposeId: "customer_success.account.manage" as const,
    idempotencyKey,
    executionScope: createExecutionScope({
      tenantId,
      workspaceId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: idempotencyKey,
      purpose: "customer.account.manage",
    }),
  };
}

function accountInput() {
  return {
    authority: authority("account-1"),
    accountId,
    mutationId: customerMutationId({ accountId, idempotencyKey: "account-1", operation: "account.create" as const }),
    name: "Acme",
    lifecycle: "active" as const,
    accountOwner: { ownerKind: "actor" as const, ownerId: actorId, displayName: "Owner" },
    crmPermissions: {
      readScope: "workspace_members" as const,
      writeScope: "account_owner" as const,
      externalWriteState: "disabled" as const,
      customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"],
    } satisfies CustomerCrmPermissions,
    organizationEntityId: "organization:acme",
  };
}

beforeEach(() => {
  mocks.responses = [];
  mocks.queries = [];
  mocks.event.mockReset().mockResolvedValue({ id: "event-1" });
});

describe("customer Account 360 store", () => {
  it("persists an immutable account revision and monotonic current projection", async () => {
    mocks.responses.push([], [], [], [{ revised_at: now }], [], []);
    const account = await saveCustomerAccount(accountInput());
    expect(account).toMatchObject({ revision: 1, name: "Acme", lifecycle: "active" });
    expect(mocks.queries.some((query) =>
      query.text.includes("INSERT INTO omni_customer_account_revisions")
    )).toBe(true);
    expect(mocks.queries.some((query) =>
      query.text.includes("INSERT INTO omni_customer_accounts")
    )).toBe(true);
    expect(mocks.event).toHaveBeenCalledWith(
      expect.objectContaining({ type: "customer.account.created" }),
      expect.objectContaining({ sql: expect.any(Function) }),
    );
  });

  it("records a sourced fact whose purposes stay inside the account boundary", async () => {
    const accountSnapshot = await createdAccountSnapshot();
    mocks.responses.push(
      [],
      [{ account_snapshot: accountSnapshot }],
      [],
      [],
      [{ recorded_at: now }],
      [],
    );
    const factId = customerFactId({ accountId, idempotencyKey: "fact-1" });
    const fact = await recordCustomerFact({
      authority: authority("fact-1"),
      accountId,
      factId,
      mutationId: customerMutationId({ accountId, idempotencyKey: "fact-1", operation: "fact.record" }),
      factKey: "health.overall",
      value: { kind: "health", dimension: "overall", status: "watch", scoreBasisPoints: null, summary: "Adoption is below target." },
      source: {
        sourceKind: "manual",
        sourceId: "operator:fact-1",
        sourceRevisionId: "operator:fact-1:v1",
        sourceRevisionSha256: "a".repeat(64),
        sourceLabel: "Operator assertion",
        providerId: null,
        providerObjectType: null,
        providerObjectIdSha256: null,
        permissionBasis: "operator_assertion",
        allowedPurposeIds: ["customer_success.account.read"],
        observedAt: now,
        ingestedAt: now,
      },
      owner: { ownerKind: "actor", ownerId: actorId, displayName: "Owner" },
      confidenceBasisPoints: 8_000,
      validFrom: now,
      staleAfter: "2026-10-08T02:00:00.000Z",
    });
    expect(fact).toMatchObject({ factKey: "health.overall", kind: "health", revision: 1 });
    expect(mocks.queries.some((query) =>
      query.text.includes("INSERT INTO omni_customer_fact_revisions")
    )).toBe(true);
    expect(mocks.event).toHaveBeenCalledWith(
      expect.objectContaining({ type: "customer.account.fact.recorded" }),
      expect.objectContaining({ sql: expect.any(Function) }),
    );
  });

  it("rejects a fact that widens the account customer-data purposes", async () => {
    const accountSnapshot = await createdAccountSnapshot();
    mocks.responses.push([], [{ account_snapshot: accountSnapshot }]);
    const factId = customerFactId({ accountId, idempotencyKey: "fact-wide" });
    await expect(recordCustomerFact({
      authority: authority("fact-wide"),
      accountId,
      factId,
      mutationId: customerMutationId({ accountId, idempotencyKey: "fact-wide", operation: "fact.record" }),
      factKey: "health.overall",
      value: { kind: "health", dimension: "overall", status: "watch", scoreBasisPoints: null, summary: "Review." },
      source: {
        sourceKind: "manual",
        sourceId: "operator:fact-wide",
        sourceRevisionId: "operator:fact-wide:v1",
        sourceRevisionSha256: "b".repeat(64),
        sourceLabel: "Operator assertion",
        providerId: null,
        providerObjectType: null,
        providerObjectIdSha256: null,
        permissionBasis: "operator_assertion",
        allowedPurposeIds: ["customer_success.account.read", "customer_success.analytics"],
        observedAt: now,
        ingestedAt: now,
      },
      owner: { ownerKind: "actor", ownerId: actorId, displayName: "Owner" },
      confidenceBasisPoints: 8_000,
      validFrom: now,
    })).rejects.toThrow(/exceed the account permission boundary/);
    expect(mocks.queries.some((query) =>
      query.text.includes("INSERT INTO omni_customer_fact_revisions")
    )).toBe(false);
  });
});

async function createdAccountSnapshot() {
  mocks.responses.push([], [], [], [{ revised_at: now }], [], []);
  const account = await saveCustomerAccount(accountInput());
  mocks.responses = [];
  mocks.queries = [];
  mocks.event.mockClear();
  return account;
}
