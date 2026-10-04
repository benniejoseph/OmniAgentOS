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
  buildCustomerFactRevision,
  buildCustomerAccountRevision,
  customerAccountId,
  customerFactId,
  customerMutationId,
  type CustomerCrmPermissions,
} from "@/lib/customer-success/contracts";
import {
  CUSTOMER_ACCOUNT_FACT_LIMIT,
  CustomerAccountProjectionLimitError,
  getCustomerAccount360,
  recordCustomerFact,
  saveCustomerAccount,
  submitCustomerAccountMutation,
  CustomerAccountConflictError,
  CustomerAccountNotFoundError,
} from "@/lib/customer-success/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildCustomerAccountMutationIntent, type CustomerAccountMutationRequest } from "@/lib/customer-success/account-mutation-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

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

describe("exact create/revise admission", () => {
  const request = { operation: "account.create" as const, name: "Acme", lifecycle: "active" as const, organizationEntityId: "organization:acme", accountOwner: accountInput().accountOwner, customerDataPurposeIds: accountInput().crmPermissions.customerDataPurposeIds };
  function intent(key: string, value: CustomerAccountMutationRequest, id?: string) {
    return buildCustomerAccountMutationIntent({ tenantId, workspaceId, canonicalActorId: actorId, idempotencyKey: key, accountId: id, request: value });
  }
  function admitted(current?: unknown, accepted?: Record<string, unknown>) {
    mocks.responses.push([], [{ access_level: "manager" }], current ? [{ account_snapshot: current }] : []);
    if (current) mocks.responses.push(accepted ? [accepted] : []);
  }
  function expectNoWrite() {
    expect(mocks.queries.some((query) => /INSERT|UPDATE omni_customer_accounts/.test(query.text))).toBe(false);
    expect(mocks.event).not.toHaveBeenCalled();
  }
  it("persists full intent beside revision and passes the same transaction to its event", async () => {
    admitted();
    mocks.responses.push([], [{ revised_at: now }], [], []);
    const result = await submitCustomerAccountMutation({ authority: authority("account-1"), request });
    expect(result.account).toMatchObject({ accountId, revision: 1 });
    expect(result.acceptance).toMatchObject({ requestSha256: canonicalJsonSha256(intent("account-1", request)), acceptedAt: now });
    const revision = mocks.queries.find((query) => query.text.includes("INSERT INTO omni_customer_account_revisions"))!;
    expect(revision.text).toContain("request_intent, request_sha256");
    expect(revision.values).toContainEqual(intent("account-1", request));
    expect(mocks.event).toHaveBeenCalledOnce();
  });
  it("returns the original accepted create after subsequent revisions without clock, fact read or write", async () => {
    const accepted = await createdAccountSnapshot();
    const claim = intent("account-1", request);
    const current = buildCustomerAccountRevision({ ...accepted, revision: 3, mutationId: customerMutationId({ accountId, operation: "account.revise", idempotencyKey: "third" }), name: "Later", revisedAt: "2026-10-04T12:00:00.000Z" });
    admitted(current, { account_snapshot: accepted, request_intent: claim, request_sha256: canonicalJsonSha256(claim) });
    const result = await submitCustomerAccountMutation({ authority: authority("account-1"), request });
    expect(result.account).toEqual(accepted);
    expect(result.acceptance.revision).toBe(1);
    expect(mocks.queries).toHaveLength(4);
    expectNoWrite();
  });
  it("reconciles an old CAS before checking the advanced head and retains sparse input", async () => {
    const initial = await createdAccountSnapshot();
    const patch = { operation: "account.revise" as const, expectedRevision: 1, lifecycle: "at_risk" as const };
    const claim = intent("revise", patch, accountId);
    const accepted = buildCustomerAccountRevision({ ...initial, revision: 2, mutationId: claim.mutationId, lifecycle: "at_risk", revisedAt: "2026-10-04T12:00:00.000Z" });
    const current = buildCustomerAccountRevision({ ...accepted, revision: 3, mutationId: customerMutationId({ accountId, operation: "account.revise", idempotencyKey: "third" }), lifecycle: "active", revisedAt: "2026-10-04T12:01:00.000Z" });
    admitted(current, { account_snapshot: accepted, request_intent: claim, request_sha256: canonicalJsonSha256(claim) });
    expect((await submitCustomerAccountMutation({ authority: authority("revise"), accountId, request: patch })).account).toEqual(accepted);
    expectNoWrite();
  });
  it("applies a fresh sparse patch to the locked exact head without altering external CRM permissions or canonical ownership", async () => {
    const initial = await createdAccountSnapshot();
    const current = buildCustomerAccountRevision({ ...initial, crmPermissions: { ...initial.crmPermissions, externalWriteState: "approval_required" } });
    admitted(current);
    mocks.responses.push([{ revised_at: "2026-10-04T12:00:00.000Z" }], [], [{ account_id: accountId }]);
    const request = { operation: "account.revise" as const, expectedRevision: 1, accountOwner: { ownerKind: "team" as const, ownerId: "team:success", displayName: "Success team" } };
    const accepted = await submitCustomerAccountMutation({ authority: authority("owner-metadata"), accountId, request });
    expect(accepted.account).toMatchObject({ revision: 2, ownerActorId: actorId, accountOwner: request.accountOwner, name: current.name, lifecycle: current.lifecycle, crmPermissions: current.crmPermissions });
    const stored = mocks.queries.find((query) => query.text.includes("INSERT INTO omni_customer_account_revisions"))!;
    expect(stored.values).toContainEqual(intent("owner-metadata", request, accountId));
    expect(mocks.queries.some((query) => query.text.includes("omni_customer_fact"))).toBe(false);
    expect(mocks.event).toHaveBeenCalledOnce();
  });
  it.each(["changed", "legacy", "corrupt", "actor"])("refuses %s evidence under the same accepted key", async (variant) => {
    const account = await createdAccountSnapshot();
    const claim = intent("account-1", request);
    const stored = variant === "legacy" ? null : variant === "actor" ? { ...claim, canonicalActorId: "actor:22222222-2222-4222-8222-222222222222" } : claim;
    admitted(account, { account_snapshot: account, request_intent: stored, request_sha256: variant === "corrupt" ? "a".repeat(64) : stored ? canonicalJsonSha256(stored) : null });
    await expect(submitCustomerAccountMutation({ authority: authority("account-1"), request: variant === "changed" ? { ...request, name: "Changed" } : request })).rejects.toBeInstanceOf(CustomerAccountConflictError);
    expectNoWrite();
  });
  it("checks current membership before any accepted read", async () => {
    mocks.responses.push([], []);
    await expect(submitCustomerAccountMutation({ authority: authority("account-1"), request })).rejects.toThrow(/Current workspace write access/);
    expect(mocks.queries).toHaveLength(2);
    expectNoWrite();
  });
  it("requires a current exact owned account before revise replay", async () => {
    admitted();
    await expect(submitCustomerAccountMutation({ authority: authority("revise"), accountId, request: { operation: "account.revise", expectedRevision: 1, name: "Changed" } })).rejects.toBeInstanceOf(CustomerAccountNotFoundError);
    expect(mocks.queries).toHaveLength(3);
    expect(mocks.queries[2].text).toContain("owner_actor_id = ?");
    expectNoWrite();
  });
  it("rejects a shared key from another canonical account owner without reading accepted revisions", async () => {
    admitted();
    mocks.responses.push([{ account_id: accountId }]);
    await expect(submitCustomerAccountMutation({ authority: authority("account-1"), request })).rejects.toThrow(/already assigned/);
    expect(mocks.queries.some((query) => query.text.includes("FROM omni_customer_account_revisions"))).toBe(false);
    expectNoWrite();
  });
  it("rejects a fresh stale CAS after finding no accepted mutation", async () => {
    const initial = await createdAccountSnapshot();
    admitted(initial);
    await expect(submitCustomerAccountMutation({ authority: authority("new"), accountId, request: { operation: "account.revise", expectedRevision: 2, name: "Changed" } })).rejects.toThrow(/changed/);
    expectNoWrite();
  });
});

describe("customer Account 360 store", () => {
  it("bounds latest eligible heads without moving the active filter into revision selection", async () => {
    const account = await createdAccountSnapshot();
    mocks.responses.push([{ account_snapshot: account }], [], [{ history_count: 5_002, evaluated_at: now }]);
    const result = await getCustomerAccount360(readAuthority(), accountId);
    expect(result).toMatchObject({ facts: [], historyCount: 5_002 });
    const query = mocks.queries[1];
    expect(query.text).toMatch(/SELECT DISTINCT ON \(fact_id COLLATE "C"\)[\s\S]+ORDER BY fact_id COLLATE "C", revision DESC[\s\S]+\) AS latest_readable_facts[\s\S]+WHERE fact_snapshot->>'state' = 'active'[\s\S]+LIMIT \?/);
    expect(query.text).toContain("fact_snapshot->'source'->'allowedPurposeIds' @> to_jsonb(ARRAY[?]::TEXT[])");
    expect(query.values).toEqual([tenantId, workspaceId, accountId, "customer_success.account.read", "customer_success.account.read", 5_001]);
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it("returns all 5,000 eligible facts at the projection boundary", async () => {
    const account = await createdAccountSnapshot();
    const facts = Array.from({ length: CUSTOMER_ACCOUNT_FACT_LIMIT }, (_, index) => readableFact(index));
    mocks.responses.push([{ account_snapshot: account }], facts.map((fact) => ({ fact_snapshot: fact })), [{ history_count: 5_001, evaluated_at: now }]);
    const result = await getCustomerAccount360(readAuthority(), accountId);
    expect(result?.facts).toHaveLength(5_000);
    expect(result?.factsByKind.health).toHaveLength(5_000);
    expect(new Set(result?.facts.map((view) => view.fact.factId)).size).toBe(5_000);
    expect(result?.historyCount).toBe(5_001);
  });

  it("rejects the overflow sentinel before parsing or reading history, never returning truncated facts", async () => {
    const account = await createdAccountSnapshot();
    mocks.responses.push([{ account_snapshot: account }], Array.from({ length: 5_001 }, () => ({ fact_snapshot: null })));
    await expect(getCustomerAccount360(readAuthority(), accountId)).rejects.toBeInstanceOf(CustomerAccountProjectionLimitError);
    expect(mocks.queries).toHaveLength(2);
    expect(mocks.queries.some((query) => query.text.includes("history_count"))).toBe(false);
    expect(mocks.event).not.toHaveBeenCalled();
  });

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

function readAuthority() {
  return { tenantId, workspaceId, canonicalActorId: actorId, readableActorIds: [actorId], purposeId: "customer_success.account.read" as const };
}

function readableFact(index: number) {
  const idempotencyKey = `bounded-fact-${index}`;
  return buildCustomerFactRevision({
    tenantId, workspaceId, accountId,
    factId: customerFactId({ accountId, idempotencyKey }), revision: 1,
    mutationId: customerMutationId({ accountId, idempotencyKey, operation: "fact.record" }),
    factKey: `health.dimension_${index}`,
    value: { kind: "health", dimension: "overall", status: "watch", scoreBasisPoints: null, summary: "Exact source evidence." },
    source: {
      sourceKind: "manual", sourceId: `operator:${index}`, sourceRevisionId: `operator:${index}:v1`,
      sourceRevisionSha256: "a".repeat(64), sourceLabel: "Operator assertion",
      providerId: null, providerObjectType: null, providerObjectIdSha256: null,
      permissionBasis: "operator_assertion", allowedPurposeIds: ["customer_success.account.read"], observedAt: now, ingestedAt: now,
    },
    owner: { ownerKind: "actor", ownerId: actorId, displayName: "Owner" },
    confidenceBasisPoints: 8_000, validFrom: now, recordedByActorId: actorId, recordedAt: now,
  });
}

async function createdAccountSnapshot() {
  mocks.responses.push([], [], [], [{ revised_at: now }], [], []);
  const account = await saveCustomerAccount(accountInput());
  mocks.responses = [];
  mocks.queries = [];
  mocks.event.mockClear();
  return account;
}
