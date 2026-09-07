import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestAccess: vi.fn(),
  loadPortfolioSources: vi.fn(),
  loadAccountSource: vi.fn(),
  getApprovalQueue: vi.fn(),
  buildIntelligence: vi.fn(),
  buildPortfolio: vi.fn(),
}));

vi.mock("@/lib/memory/shared-context", () => ({
  requestSharedMemoryAccessFromSecurityContext: mocks.requestAccess,
}));
vi.mock("@/lib/customer-success/intelligence-store", () => ({
  loadCustomerSuccessPortfolioSourceSets: mocks.loadPortfolioSources,
  loadCustomerSuccessAccountSourceSet: mocks.loadAccountSource,
}));
vi.mock("@/lib/operations/queue", () => ({
  getApprovalQueue: mocks.getApprovalQueue,
}));
vi.mock("@/lib/customer-success/intelligence", () => ({
  buildCustomerSuccessAccountIntelligence: mocks.buildIntelligence,
  buildCustomerSuccessPortfolio: mocks.buildPortfolio,
}));

import {
  showCustomerSuccessIntelligenceService,
  showCustomerSuccessPortfolioService,
} from "@/lib/app-services/customer-success-intelligence";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import type { SecurityContext } from "@/lib/security/types";

const accountId = `customer-account:${"a".repeat(64)}`;
const canonicalActorId = "actor:11111111-1111-4111-8111-111111111111";
const context = {
  tenantId: "tenant-csm",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
} satisfies SecurityContext;

const source = {
  account360: {
    account: {
      accountId,
      accountEntityId: "account-entity:acme",
      organizationEntityId: "organization:acme",
      revisionId: `${accountId}:v2`,
      accountSha256: "b".repeat(64),
    },
  },
  workflowRuns: [{
    runId: "customer-success-run:one",
    projectId: "project:acme-risk",
    projectTaskIds: [{ projectTaskId: "project-task:acme-risk" }],
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestAccess.mockResolvedValue({
    actorBinding: {
      canonicalActorId,
      readableOwnerActorIds: [canonicalActorId, context.actorId],
    },
    authority: {
      workspaceId: "workspace:personal:owner",
      accessLevel: "manager",
      canWrite: true,
      authoritySha256: "c".repeat(64),
    },
  });
  mocks.loadPortfolioSources.mockResolvedValue([source]);
  mocks.loadAccountSource.mockResolvedValue(source);
  mocks.getApprovalQueue.mockResolvedValue({
    items: [
      approval("approval:related", { accountId }),
      approval("approval:project", { projectId: "project:acme-risk" }),
      approval("approval:unrelated", { accountId: `customer-account:${"d".repeat(64)}` }),
      { ...approval("approval:slo", { accountId }), kind: "slo_policy", status: "pending" },
    ],
  });
  mocks.buildIntelligence.mockImplementation((input) => ({
    portfolio: { accountId: input.account360.account.accountId },
    approvals: input.approvals,
  }));
  mocks.buildPortfolio.mockImplementation((items) => ({
    accounts: items.map((item: { portfolio: unknown }) => item.portfolio),
  }));
});

describe("customer-success intelligence app services", () => {
  it("builds portfolio rows through exact workspace and account approval linkage", async () => {
    const result = await showCustomerSuccessPortfolioService(
      createAppServiceCaller({ context }),
      { limit: 25 },
    );

    expect(result.receipt.operation).toBe("app.customer_accounts.portfolio.show");
    expect(mocks.loadPortfolioSources).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      workspaceId: "workspace:personal:owner",
      canonicalActorId,
      purposeId: "customer_success.account.read",
    }), { limit: 25 });
    expect(mocks.buildIntelligence).toHaveBeenCalledWith(expect.objectContaining({
      approvals: [
        expect.objectContaining({ id: "approval:related" }),
        expect.objectContaining({ id: "approval:project", projectId: "project:acme-risk" }),
      ],
    }));
    expect(result.data.portfolio.accounts).toHaveLength(1);
  });

  it("returns an evidence-safe account projection without approval inputs", async () => {
    const result = await showCustomerSuccessIntelligenceService(
      createAppServiceCaller({ context }),
      { accountId, historyLimit: 40, timelineLimit: 30 },
    );

    expect(result.receipt.operation).toBe("app.customer_accounts.intelligence.show");
    expect(mocks.loadAccountSource).toHaveBeenCalledWith(expect.anything(), accountId, {
      historyLimit: 40,
    });
    expect(result.data.intelligence.approvals).toEqual([
      expect.objectContaining({ id: "approval:related" }),
      expect.objectContaining({ id: "approval:project" }),
    ]);
    expect(result.data.intelligence.approvals[0]).not.toHaveProperty("input");
  });

  it("withholds approval projections from a viewer while preserving account intelligence", async () => {
    const viewer = { ...context, role: "viewer" as const };
    const result = await showCustomerSuccessIntelligenceService(
      createAppServiceCaller({ context: viewer }),
      { accountId },
    );

    expect(mocks.getApprovalQueue).not.toHaveBeenCalled();
    expect(result.data.intelligence.approvals).toEqual([]);
  });
});

function approval(id: string, input: Record<string, unknown>) {
  return {
    kind: "tool" as const,
    id,
    title: "Governed customer action",
    status: "approval_required" as const,
    canonicalStatus: { status: "waiting" },
    riskLevel: 2,
    reason: "Human review required.",
    createdAt: "2026-09-08T12:00:00.000Z",
    input,
    record: {},
  };
}
