import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestAccess: vi.fn(),
  current: vi.fn(),
  history: vi.fn(),
  evaluate: vi.fn(),
}));

vi.mock("@/lib/memory/shared-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/shared-context")>()),
  requestSharedMemoryAccessFromSecurityContext: mocks.requestAccess,
}));
vi.mock("@/lib/customer-success/health-store", () => ({
  getCurrentCustomerHealthScore: mocks.current,
  listCustomerHealthScoreHistory: mocks.history,
  evaluateAndSaveCustomerHealth: mocks.evaluate,
}));

import {
  evaluateCustomerHealthService,
  showCustomerHealthService,
} from "@/lib/app-services/customer-health";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

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
