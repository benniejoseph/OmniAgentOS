import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantId = "tenant-a";
const workspaceId = "workspace:tenant-a";
const actorId = "actor:11111111-1111-4111-8111-111111111111";
const now = "2026-09-08T12:00:00.000Z";
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
  buildCustomerAccountRevision,
  buildCustomerFactRevision,
  customerAccountId,
  customerFactId,
  customerMutationId,
} from "@/lib/customer-success/contracts";
import { customerHealthEvaluationId } from "@/lib/customer-success/health-contracts";
import {
  evaluateAndSaveCustomerHealth,
  getCurrentCustomerHealthScore,
} from "@/lib/customer-success/health-store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const accountId = customerAccountId({ tenantId, workspaceId, idempotencyKey: "health-account" });

beforeEach(() => {
  mocks.responses = [];
  mocks.queries = [];
  mocks.event.mockReset().mockResolvedValue({ id: "event-1" });
});

describe("customer health score store", () => {
  it("persists policy, immutable score revision, current projection, and typed event", async () => {
    const accountSnapshot = account();
    const factSnapshot = fact();
    mocks.responses.push(
      [],
      [{ account_snapshot: accountSnapshot }],
      [],
      [],
      [{ fact_snapshot: factSnapshot }],
      [{ evaluated_at: now, history_count: 2 }],
      [],
      [],
      [],
    );
    const score = await evaluateAndSaveCustomerHealth({
      authority: mutationAuthority("health-eval-1"),
      accountId,
      expectedAccountRevision: accountSnapshot.revision,
      expectedAccountSha256: accountSnapshot.accountSha256,
      evaluationId: customerHealthEvaluationId({
        accountId,
        idempotencyKey: "health-eval-1",
      }),
    });
    expect(score).toMatchObject({
      revision: 1,
      scoreBasisPoints: 2_000,
      status: "at_risk",
      coverageBasisPoints: 2_500,
      authority: "deterministic_policy",
    });
    expect(mocks.queries.some((query) =>
      query.text.includes("INSERT INTO omni_customer_health_policies")
    )).toBe(true);
    expect(mocks.queries.some((query) =>
      query.text.includes("INSERT INTO omni_customer_health_score_revisions")
    )).toBe(true);
    expect(mocks.queries.some((query) =>
      query.text.includes("INSERT INTO omni_customer_health_scores")
    )).toBe(true);
    expect(mocks.event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "customer.account.health.evaluated",
        payload: expect.objectContaining({
          scoreBasisPoints: 2_000,
          factorCount: 4,
          suggestionCount: 0,
          authority: "deterministic_policy",
        }),
      }),
      expect.objectContaining({ sql: expect.any(Function) }),
    );
  });

  it("returns the immutable result for an idempotent evaluation retry", async () => {
    const accountSnapshot = account();
    const firstScore = await persistedScore(accountSnapshot);
    mocks.responses = [
      [],
      [{ account_snapshot: accountSnapshot }],
      [{ score_snapshot: firstScore }],
    ];
    mocks.queries = [];
    mocks.event.mockClear();
    const retry = await evaluateAndSaveCustomerHealth({
      authority: mutationAuthority("health-eval-1"),
      accountId,
      expectedAccountRevision: accountSnapshot.revision,
      expectedAccountSha256: accountSnapshot.accountSha256,
      evaluationId: firstScore.evaluationId,
    });
    expect(retry.scoreSha256).toBe(firstScore.scoreSha256);
    expect(mocks.queries.some((query) => query.text.includes("INSERT INTO"))).toBe(false);
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it("rejects evaluation against a changed Account 360 revision", async () => {
    const accountSnapshot = account();
    mocks.responses.push([], [{ account_snapshot: accountSnapshot }]);
    await expect(evaluateAndSaveCustomerHealth({
      authority: mutationAuthority("health-stale"),
      accountId,
      expectedAccountRevision: accountSnapshot.revision + 1,
      expectedAccountSha256: accountSnapshot.accountSha256,
      evaluationId: customerHealthEvaluationId({ accountId, idempotencyKey: "health-stale" }),
    })).rejects.toThrow(/evidence changed/);
  });

  it("reads the bounded current score projection", async () => {
    const score = await persistedScore(account());
    mocks.responses = [[{ score_snapshot: score }]];
    mocks.queries = [];
    const current = await getCurrentCustomerHealthScore(readAuthority(), accountId);
    expect(current?.scoreSha256).toBe(score.scoreSha256);
    expect(mocks.queries[0]?.text).toContain("FROM omni_customer_health_scores");
  });
});

async function persistedScore(accountSnapshot: ReturnType<typeof account>) {
  mocks.responses = [
    [],
    [{ account_snapshot: accountSnapshot }],
    [],
    [],
    [{ fact_snapshot: fact() }],
    [{ evaluated_at: now, history_count: 2 }],
    [],
    [],
    [],
  ];
  return evaluateAndSaveCustomerHealth({
    authority: mutationAuthority("health-eval-1"),
    accountId,
    expectedAccountRevision: accountSnapshot.revision,
    expectedAccountSha256: accountSnapshot.accountSha256,
    evaluationId: customerHealthEvaluationId({ accountId, idempotencyKey: "health-eval-1" }),
  });
}

function mutationAuthority(idempotencyKey: string) {
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
      purpose: "customer.health.evaluate",
    }),
  };
}

function readAuthority() {
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
    revision: 1,
    mutationId: customerMutationId({
      accountId,
      idempotencyKey: "health-account",
      operation: "account.create",
    }),
    name: "Acme",
    lifecycle: "active",
    accountOwner: { ownerKind: "actor", ownerId: actorId, displayName: "Owner" },
    crmPermissions: {
      readScope: "workspace_members",
      writeScope: "account_owner",
      externalWriteState: "disabled",
      customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"],
    },
    ownerActorId: actorId,
    revisedByActorId: actorId,
    revisedAt: "2026-09-08T00:00:00.000Z",
  });
}

function fact() {
  const factId = customerFactId({ accountId, idempotencyKey: "support-health" });
  return buildCustomerFactRevision({
    tenantId,
    workspaceId,
    accountId,
    factId,
    revision: 1,
    mutationId: customerMutationId({ accountId, idempotencyKey: "support-health", operation: "fact.record" }),
    factKey: "health.support",
    value: {
      kind: "health",
      dimension: "support",
      status: "at_risk",
      scoreBasisPoints: 2_000,
      summary: "A critical case is open.",
    },
    source: {
      sourceKind: "manual",
      sourceId: "source:support-health",
      sourceRevisionId: "source:support-health:v1",
      sourceRevisionSha256: "a".repeat(64),
      sourceLabel: "Operator assertion",
      providerId: null,
      providerObjectType: null,
      providerObjectIdSha256: null,
      permissionBasis: "operator_assertion",
      allowedPurposeIds: ["customer_success.account.read"],
      observedAt: "2026-09-08T00:00:00.000Z",
      ingestedAt: "2026-09-08T00:01:00.000Z",
    },
    owner: { ownerKind: "actor", ownerId: actorId, displayName: "Owner" },
    confidenceBasisPoints: 8_000,
    validFrom: "2026-09-08T00:00:00.000Z",
    staleAfter: "2026-09-15T00:00:00.000Z",
    recordedByActorId: actorId,
    recordedAt: "2026-09-08T00:01:00.000Z",
  });
}
