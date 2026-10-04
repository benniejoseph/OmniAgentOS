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
import { customerHealthEvaluationId, sealCustomerHealthScore } from "@/lib/customer-success/health-contracts";
import {
  evaluateAndSaveCustomerHealth,
  getCurrentCustomerHealthScore,
  submitCustomerHealthEvaluation,
  readCustomerHealthEvaluationAcceptance,
  CustomerHealthEvaluationRefusedError,
} from "@/lib/customer-success/health-store";
import { CUSTOMER_HEALTH_REVISION_MAX, buildCustomerHealthEvaluationIntent, type CustomerHealthEvaluationRequest } from "@/lib/customer-success/health-mutation-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  CUSTOMER_ACCOUNT_FACT_LIMIT,
  CustomerAccountProjectionLimitError,
} from "@/lib/customer-success/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const accountId = customerAccountId({ tenantId, workspaceId, idempotencyKey: "health-account" });

beforeEach(() => {
  mocks.responses = [];
  mocks.queries = [];
  mocks.event.mockReset().mockResolvedValue({ id: "event-1" });
});

describe("customer health score store", () => {
  it("native replay after a newer Account returns the original acceptance without facts, policy or event effects", async () => {
    const original = account(), score = await persistedScore(original), authority = nativeAuthority("health-eval-1"), request = nativeRequest(original);
    const intent = buildCustomerHealthEvaluationIntent({ ...authority, accountId, request });
    mocks.queries = []; mocks.event.mockClear();
    mocks.responses = [[], [{ account_snapshot: account(2) }],
      [{ score_snapshot: score, owner_actor_id: actorId, request_intent: intent, request_sha256: canonicalJsonSha256(intent) }]];
    const result = await submitCustomerHealthEvaluation({ authority, accountId, request });
    expect(result).toMatchObject({ replayed: true, currentAccount: { revision: 2 }, acceptance: { accountRevision: 1, scoreSha256: score.scoreSha256 } });
    expect(mocks.queries).toHaveLength(3);
    expect(mocks.queries.some((query) => /^\s*(?:INSERT|UPDATE|DELETE)\b|FROM omni_customer_fact_revisions/.test(query.text))).toBe(false);
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it("native stale admission is proven only after exact absence and current owner authority, never for legacy collisions", async () => {
    const snapshot = account(), authority = nativeAuthority("health-eval-1"), request = nativeRequest(snapshot);
    const score = await persistedScore(snapshot);
    mocks.responses = [[], [{ account_snapshot: account(2) }], [{ score_snapshot: null }]];
    await expect(submitCustomerHealthEvaluation({ authority, accountId, request })).rejects.toMatchObject({
      admission: "not_admitted", code: "customer_health_account_changed", evaluationId: score.evaluationId,
      requestSha256: canonicalJsonSha256(buildCustomerHealthEvaluationIntent({ ...authority, accountId, request })),
    });
    expect(mocks.queries.at(-1)?.text).toContain("LEFT JOIN omni_customer_health_score_revisions");
    expect(mocks.queries.at(-1)?.text).toContain("workspace.state = 'active'");
    mocks.responses = [[], [{ account_snapshot: snapshot }],
      [{ score_snapshot: score, owner_actor_id: actorId, request_intent: null, request_sha256: null }]];
    const collision = await submitCustomerHealthEvaluation({ authority, accountId, request }).catch((error: unknown) => error);
    expect(collision).toBeInstanceOf(Error); expect(collision).not.toBeInstanceOf(CustomerHealthEvaluationRefusedError);
    mocks.responses = [[], [{ account_snapshot: snapshot }], []];
    const denied = await submitCustomerHealthEvaluation({ authority, accountId, request }).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(Error); expect(denied).not.toBeInstanceOf(CustomerHealthEvaluationRefusedError);
  });

  it("exact native read joins the current readable owner with its original accepted score in one statement", async () => {
    const snapshot = account(), score = await persistedScore(snapshot), authority = nativeAuthority("health-eval-1");
    const intent = buildCustomerHealthEvaluationIntent({ ...authority, accountId, request: nativeRequest(snapshot) });
    mocks.queries = [];
    mocks.responses = [[{ account_snapshot: account(2), score_snapshot: score, owner_actor_id: actorId,
      request_intent: intent, request_sha256: canonicalJsonSha256(intent) }]];
    const result = await readCustomerHealthEvaluationAcceptance(readAuthority(), { accountId, evaluationId: score.evaluationId });
    expect(result).toMatchObject({ currentAccount: { revision: 2 }, acceptance: { accountRevision: 1 } });
    expect(mocks.queries).toHaveLength(1);
    expect(mocks.queries[0].text).toContain("LEFT JOIN omni_customer_health_score_revisions");
    expect(mocks.queries[0].text).toContain("workspace.state = 'active'");
    expect(mocks.queries[0].text).not.toMatch(/FOR UPDATE|FOR SHARE/);
  });

  it("native evidence overflow is a bound refusal before history, policy or score writes", async () => {
    const snapshot = account(), authority = nativeAuthority("native-overflow"), request = nativeRequest(snapshot);
    mocks.responses = [[], [{ account_snapshot: snapshot }], [{ score_snapshot: null }], [], [{ access_level: "manager" }],
      Array.from({ length: CUSTOMER_ACCOUNT_FACT_LIMIT + 1 }, () => ({ fact_snapshot: null }))];
    await expect(submitCustomerHealthEvaluation({ authority, accountId, request })).rejects.toMatchObject({
      admission: "not_admitted", code: "customer_health_projection_limit",
      requestSha256: canonicalJsonSha256(buildCustomerHealthEvaluationIntent({ ...authority, accountId, request })),
    });
    expect(mocks.queries).toHaveLength(6);
    expect(mocks.queries.some((query) => query.text.includes("clock_timestamp") || /^\s*(?:INSERT|UPDATE|DELETE)\b/.test(query.text))).toBe(false);
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it("native SQL revision exhaustion is refused after current authority without evaluating evidence", async () => {
    const snapshot = account(), authority = nativeAuthority("native-capacity"), request = nativeRequest(snapshot);
    const { scoreSha256: _digest, ...body } = await persistedScore(snapshot);
    const exhausted = sealCustomerHealthScore({ ...body, revision: CUSTOMER_HEALTH_REVISION_MAX,
      scoreRevisionId: `${body.scoreId}:v${CUSTOMER_HEALTH_REVISION_MAX}`,
      previousScoreRevisionId: `${body.scoreId}:v${CUSTOMER_HEALTH_REVISION_MAX - 1}` });
    mocks.queries = []; mocks.event.mockClear();
    mocks.responses = [[], [{ account_snapshot: snapshot }], [{ score_snapshot: null }], [{ score_snapshot: exhausted }], [{ access_level: "manager" }]];
    await expect(submitCustomerHealthEvaluation({ authority, accountId, request })).rejects.toMatchObject({
      admission: "not_admitted", code: "customer_health_revision_exhausted",
    });
    expect(mocks.queries).toHaveLength(5);
    expect(mocks.queries.some((query) => query.text.includes("FROM omni_customer_fact_revisions") || /^\s*(?:INSERT|UPDATE|DELETE)\b/.test(query.text))).toBe(false);
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it("bounds heads with matching DISTINCT collation and preserves unknown health when none remain eligible", async () => {
    const accountSnapshot = account();
    mocks.responses.push(
      [], [{ account_snapshot: accountSnapshot }], [], [], [],
      [{ evaluated_at: now, history_count: 10_003 }], [], [], [],
    );
    const score = await evaluateAndSaveCustomerHealth({
      authority: mutationAuthority("health-no-eligible-heads"),
      accountId,
      expectedAccountRevision: accountSnapshot.revision,
      expectedAccountSha256: accountSnapshot.accountSha256,
      evaluationId: customerHealthEvaluationId({ accountId, idempotencyKey: "health-no-eligible-heads" }),
    });
    expect(score).toMatchObject({ status: "unknown", scoreBasisPoints: null, confidenceBasisPoints: 0, coverageBasisPoints: 0 });
    expect(score.factors).toHaveLength(4);
    for (const factor of score.factors) {
      expect(factor).toMatchObject({ evidence: [], evidenceState: "missing", scoreBasisPoints: null });
    }
    const query = mocks.queries[4];
    expect(query.text).toMatch(/SELECT DISTINCT ON \(fact_id COLLATE "C"\)[\s\S]+ORDER BY fact_id COLLATE "C", revision DESC[\s\S]+\) AS latest_readable_facts[\s\S]+WHERE fact_snapshot->>'state' = 'active'[\s\S]+ORDER BY fact_id COLLATE "C"[\s\S]+LIMIT \?/);
    expect(query.text).toContain("allowed_purpose_ids @> ARRAY['customer_success.account.read']::TEXT[]");
    expect(query.text).toContain("fact_snapshot->'source'->'allowedPurposeIds' @> to_jsonb(ARRAY['customer_success.account.read']::TEXT[])");
    expect(query.values).toEqual([tenantId, workspaceId, accountId, CUSTOMER_ACCOUNT_FACT_LIMIT + 1]);
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ status: "unknown", scoreBasisPoints: null }),
    }), expect.anything());
  });

  it("rejects the overflow sentinel before decoding evidence, reading history, or writing any score", async () => {
    const accountSnapshot = account();
    mocks.responses.push(
      [], [{ account_snapshot: accountSnapshot }], [], [],
      Array.from({ length: CUSTOMER_ACCOUNT_FACT_LIMIT + 1 }, () => ({ fact_snapshot: null })),
    );
    await expect(evaluateAndSaveCustomerHealth({
      authority: mutationAuthority("health-overflow"),
      accountId,
      expectedAccountRevision: accountSnapshot.revision,
      expectedAccountSha256: accountSnapshot.accountSha256,
      evaluationId: customerHealthEvaluationId({ accountId, idempotencyKey: "health-overflow" }),
    })).rejects.toBeInstanceOf(CustomerAccountProjectionLimitError);
    expect(mocks.queries).toHaveLength(5);
    expect(mocks.queries.some((query) => query.text.includes("clock_timestamp") || query.text.includes("history_count"))).toBe(false);
    expect(mocks.queries.some((query) => /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM|omni_)/.test(query.text))).toBe(false);
    expect(mocks.event).not.toHaveBeenCalled();
  });

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

function account(revision = 1) {
  return buildCustomerAccountRevision({
    tenantId,
    workspaceId,
    accountId,
    revision,
    mutationId: customerMutationId({
      accountId,
      idempotencyKey: "health-account",
      operation: revision === 1 ? "account.create" : "account.revise",
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

function nativeAuthority(key: string) {
  const value = mutationAuthority(key);
  return { ...value, executionScope: { ...value.executionScope, causationId: accountId } };
}
function nativeRequest(snapshot = account()): CustomerHealthEvaluationRequest {
  return { contract: "customer-health-evaluation-request:1", workspaceId, expectedAccountRevision: snapshot.revision,
    expectedAccountSha256: snapshot.accountSha256, modelSuggestions: [] };
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
