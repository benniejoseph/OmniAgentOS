import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestAccess: vi.fn(),
  current: vi.fn(),
  history: vi.fn(),
  evaluate: vi.fn(),
  submit: vi.fn(),
  evaluation: vi.fn(),
}));

vi.mock("@/lib/memory/shared-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/shared-context")>()),
  requestSharedMemoryAccessFromSecurityContext: mocks.requestAccess,
}));
vi.mock("@/lib/customer-success/health-store", async () => ({
  getCurrentCustomerHealthScore: mocks.current,
  listCustomerHealthScoreHistory: mocks.history,
  evaluateAndSaveCustomerHealth: mocks.evaluate,
  submitCustomerHealthEvaluation: mocks.submit,
  readCustomerHealthEvaluationAcceptance: mocks.evaluation,
  CustomerHealthEvaluationRefusedError: (await import("@/lib/customer-success/health-mutation-contracts")).CustomerHealthEvaluationRefusedError,
}));

import {
  evaluateCustomerHealthService,
  showCustomerHealthService,
  evaluateCustomerHealthNativeService,
  readCustomerHealthEvaluationService,
} from "@/lib/app-services/customer-health";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { buildDefaultCustomerHealthPolicy, customerHealthScoreId } from "@/lib/customer-success/health-contracts";
import { buildCustomerHealthEvaluationIntent, customerHealthEvaluationAcceptanceSchema, customerHealthEvaluationRequestSchema, CustomerHealthEvaluationRefusedError } from "@/lib/customer-success/health-mutation-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const authUserId = "11111111-1111-4111-8111-111111111111";
const canonicalActorId = `actor:${authUserId}`;
const workspaceId = `workspace:personal:${authUserId}`;
const accountId = `customer-account:${"a".repeat(64)}`;
const context = {
  tenantId: "tenant-health",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: authUserId,
    email: "owner@example.test",
    sessionId: "session-health",
    tenantName: "Health tenant",
  },
} satisfies SecurityContext;

function access(canWrite = true) {
  return {
    actorBinding: {
      canonicalActorId,
      readableOwnerActorIds: [canonicalActorId, context.actorId],
    },
    authority: {
      initiatingActorId: canonicalActorId,
      workspaceId,
      accessLevel: canWrite ? "manager" : "reader",
      canWrite,
      authoritySha256: "b".repeat(64),
    },
  };
}

function caller(idempotencyKey: string) {
  return createAppServiceCaller({
    context,
    idempotencyKey,
    executionScope: createExecutionScope({
      tenantId: context.tenantId,
      initiatingActorId: context.actorId,
      executingPrincipalType: "user",
      executingPrincipalId: context.actorId,
      correlationId: idempotencyKey,
      purpose: "api.customer-health.evaluate",
    }),
  });
}

function nativeCaller(idempotencyKey = "native-health") {
  return createAppServiceCaller({ context, idempotencyKey, executionScope: createExecutionScope({
    tenantId: context.tenantId, initiatingActorId: context.actorId, executingPrincipalType: "user", executingPrincipalId: context.actorId,
    correlationId: idempotencyKey, causationId: accountId, workspaceId, purpose: "api.customer-health.evaluate",
  }) });
}
function nativeFixture(key = "native-health") {
  const request = customerHealthEvaluationRequestSchema.parse({ contract: "customer-health-evaluation-request:1", workspaceId,
    expectedAccountRevision: 4, expectedAccountSha256: "d".repeat(64), modelSuggestions: [] });
  const intent = buildCustomerHealthEvaluationIntent({ tenantId: context.tenantId, workspaceId, canonicalActorId, accountId, idempotencyKey: key, request });
  const policy = buildDefaultCustomerHealthPolicy(), scoreId = customerHealthScoreId({ tenantId: context.tenantId, workspaceId, accountId });
  const body = { schemaVersion: 1, contract: "customer-health-evaluation-acceptance:1", operation: "health.evaluate",
    tenantId: context.tenantId, workspaceId, accountId, canonicalActorId, evaluationId: intent.evaluationId,
    idempotencyKeySha256: intent.idempotencyKeySha256, requestSha256: canonicalJsonSha256(intent),
    accountRevisionId: `${accountId}:v4`, accountRevision: 4, accountSha256: request.expectedAccountSha256,
    scoreId, scoreRevisionId: `${scoreId}:v1`, scoreRevision: 1, scoreSha256: "c".repeat(64),
    policyId: policy.policyId, policySha256: policy.policySha256, inputSha256: "e".repeat(64),
    scoreBasisPoints: null, status: "unknown", confidenceBasisPoints: 0, coverageBasisPoints: 0,
    authority: "deterministic_policy", acceptedAt: "2026-10-04T12:00:00.123Z" };
  const acceptance = customerHealthEvaluationAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
  const currentAccount = { accountId, revisionId: `${accountId}:v4`, revision: 4, accountSha256: request.expectedAccountSha256 };
  return { request, intent, result: { currentAccount, acceptance, replayed: false } };
}

beforeEach(() => {
  mocks.requestAccess.mockReset().mockResolvedValue(access());
  mocks.current.mockReset().mockResolvedValue(null);
  mocks.history.mockReset().mockResolvedValue([]);
  mocks.evaluate.mockReset().mockImplementation(async (input) => ({
    accountId: input.accountId,
    evaluationId: input.evaluationId,
    scoreSha256: "c".repeat(64),
    suggestions: input.suggestions || [],
  }));
  mocks.submit.mockReset().mockImplementation(async (input) => nativeFixture(input.authority.idempotencyKey).result);
  mocks.evaluation.mockReset().mockImplementation(async () => {
    const { replayed: _replayed, ...result } = nativeFixture().result;
    return result;
  });
});

describe("native compact health evaluation service", () => {
  it("uses exact canonical user authority and returns only the compact atomic acceptance", async () => {
    const f = nativeFixture(), result = await evaluateCustomerHealthNativeService(nativeCaller(), { ...f.request, accountId });
    expect(result.data).toEqual({ contract: "customer-health-evaluation-read:1", context: {
      scope: "workspace", workspaceId, accessLevel: "manager", canWrite: true, authoritySha256: "b".repeat(64),
    }, ...f.result });
    expect(result.receipt.operation).toBe("app.customer_accounts.health.evaluate");
    expect(result.receipt.idempotencyKeySha256).toBe(f.result.acceptance.idempotencyKeySha256);
    expect(mocks.submit).toHaveBeenCalledWith({ accountId, request: f.request, authority: expect.objectContaining({
      tenantId: context.tenantId, workspaceId, canonicalActorId, readableActorIds: [canonicalActorId],
      purposeId: "customer_success.account.manage", idempotencyKey: "native-health",
      executionScope: expect.objectContaining({ initiatingActorId: canonicalActorId, executingPrincipalId: canonicalActorId,
        executingPrincipalType: "user", workspaceId, causationId: accountId, purpose: "customer.health.evaluate" }),
    }) });
    expect(mocks.evaluate).not.toHaveBeenCalled(); expect(mocks.current).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled();
  });
  it("preserves original acceptance when a replay observes a later current account", async () => {
    const f = nativeFixture();
    mocks.submit.mockResolvedValue({ ...f.result, replayed: true,
      currentAccount: { ...f.result.currentAccount, revision: 5, revisionId: `${accountId}:v5`, accountSha256: "f".repeat(64) } });
    const result = await evaluateCustomerHealthNativeService(nativeCaller(), { ...f.request, accountId });
    expect(result.data.replayed).toBe(true); expect(result.data.acceptance).toEqual(f.result.acceptance);
    expect(result.data.currentAccount.revision).toBe(5); expect(mocks.submit).toHaveBeenCalledTimes(1);
  });
  it("reads an exact historical acceptance with current read access and no write scope", async () => {
    const f = nativeFixture(); mocks.requestAccess.mockResolvedValue(access(false));
    const result = await readCustomerHealthEvaluationService(createAppServiceCaller({ context: { ...context, role: "viewer" } }), {
      accountId, evaluationId: f.intent.evaluationId, workspaceId,
    });
    expect(result.data.context.canWrite).toBe(false); expect(result.data.acceptance).toEqual(f.result.acceptance);
    expect(result.receipt.operation).toBe("app.customer_accounts.health.evaluations.show");
    expect(result.receipt.idempotencyKeySha256).toBeNull();
    expect(mocks.evaluation).toHaveBeenCalledWith(expect.objectContaining({ canonicalActorId, readableActorIds: [canonicalActorId],
      purposeId: "customer_success.account.read" }), { accountId, evaluationId: f.intent.evaluationId });
    expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.current).not.toHaveBeenCalled();
  });
  it("returns an authorized absent receipt as null without treating it as cancellation", async () => {
    const f = nativeFixture(); mocks.evaluation.mockResolvedValue({ currentAccount: f.result.currentAccount, acceptance: null });
    const result = await readCustomerHealthEvaluationService(createAppServiceCaller({ context }), { accountId, evaluationId: f.intent.evaluationId, workspaceId });
    expect(result.data.acceptance).toBeNull(); expect(result.receipt.resourceCount).toBe(0);
    expect(result.data).not.toHaveProperty("admission"); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it.each([
    { executingPrincipalType: "agent" as const, executingPrincipalId: "agent:health" },
    { executingPrincipalId: "other@example.test" }, { delegationId: "delegation:health" },
    { contextGrantIds: ["context:health"] }, { capabilityGrantIds: ["capability:health"] },
    { workspaceId: "workspace:other" }, { projectId: "project:health" }, { missionId: "mission:health" },
    { causationId: "account:other" }, { purpose: "other" },
  ])("refuses authority that cannot be converted to an ordinary native user request: %j", async (changed) => {
    const f = nativeFixture(), valid = nativeCaller();
    await expect(evaluateCustomerHealthNativeService({ ...valid, executionScope: { ...valid.executionScope!, ...changed } }, { ...f.request, accountId })).rejects.toThrow();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("rejects changed canonical/workspace access and mismatched post-commit evidence without inventing refusal proof", async () => {
    const f = nativeFixture();
    mocks.requestAccess.mockResolvedValue({ ...access(), actorBinding: { ...access().actorBinding, canonicalActorId: "actor:22222222-2222-4222-8222-222222222222" } });
    await expect(evaluateCustomerHealthNativeService(nativeCaller(), { ...f.request, accountId })).rejects.toThrow();
    expect(mocks.submit).not.toHaveBeenCalled();
    mocks.requestAccess.mockResolvedValue(access());
    mocks.submit.mockResolvedValue({ ...f.result, currentAccount: { ...f.result.currentAccount, accountSha256: "f".repeat(64) } });
    await expect(evaluateCustomerHealthNativeService(nativeCaller(), { ...f.request, accountId })).rejects.not.toHaveProperty("admission");
  });
  it("passes through only a refusal proven for this exact submitted intent", async () => {
    const f = nativeFixture(), refusal = new CustomerHealthEvaluationRefusedError({
      code: "customer_health_account_changed", message: "Account changed.", evaluationId: f.intent.evaluationId, requestSha256: canonicalJsonSha256(f.intent),
    });
    mocks.submit.mockRejectedValue(refusal);
    await expect(evaluateCustomerHealthNativeService(nativeCaller(), { ...f.request, accountId })).rejects.toBe(refusal);
    mocks.submit.mockRejectedValue(new CustomerHealthEvaluationRefusedError({ ...refusal, message: refusal.message, requestSha256: "f".repeat(64) }));
    await expect(evaluateCustomerHealthNativeService(nativeCaller(), { ...f.request, accountId })).rejects.not.toHaveProperty("admission");
  });
});

describe("customer health app services", () => {
  it("reads the current score and immutable history through workspace authority", async () => {
    const result = await showCustomerHealthService(
      createAppServiceCaller({ context }),
      { accountId, historyLimit: 10 },
    );
    expect(result.receipt.operation).toBe("app.customer_accounts.health.show");
    expect(result.data.policy.policyVersion).toBe("asael-customer-health:1");
    expect(mocks.current).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      workspaceId,
      canonicalActorId,
      purposeId: "customer_success.account.read",
    }), accountId);
    expect(mocks.history).toHaveBeenCalledWith(expect.any(Object), accountId, { limit: 10 });
  });

  it("evaluates an exact account revision and marks model advice non-authoritative", async () => {
    const result = await evaluateCustomerHealthService(caller("health-evaluate-1"), {
      accountId,
      expectedAccountRevision: 4,
      expectedAccountSha256: "d".repeat(64),
      modelSuggestions: [{
        suggestionKind: "next_action",
        statement: "Review the open case.",
        citedEvidence: [{
          factRevisionId: `customer-fact:${"e".repeat(64)}:v1`,
          factSha256: "f".repeat(64),
        }],
        confidenceBasisPoints: 7_500,
        origin: {
          providerId: "openai",
          modelId: "gpt-5",
          promptSha256: "1".repeat(64),
        },
      }],
    });
    expect(result.receipt.operation).toBe("app.customer_accounts.health.evaluate");
    expect(mocks.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      accountId,
      expectedAccountRevision: 4,
      expectedAccountSha256: "d".repeat(64),
      evaluationId: expect.stringMatching(/^customer-health-evaluation:[a-f0-9]{64}$/),
      authority: expect.objectContaining({
        canonicalActorId,
        purposeId: "customer_success.account.manage",
        executionScope: expect.objectContaining({
          initiatingActorId: canonicalActorId,
          executingPrincipalId: canonicalActorId,
          workspaceId,
          purpose: "customer.health.evaluate",
        }),
      }),
      suggestions: [expect.objectContaining({
        authoritative: false,
        origin: expect.objectContaining({ kind: "model" }),
      })],
    }));
  });

  it("blocks health evaluation for a workspace reader", async () => {
    mocks.requestAccess.mockResolvedValue(access(false));
    await expect(evaluateCustomerHealthService(caller("health-denied"), {
      accountId,
      expectedAccountRevision: 1,
      expectedAccountSha256: "d".repeat(64),
    })).rejects.toThrow(/owner access/);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});
