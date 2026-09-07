import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestAccess: vi.fn(),
  list: vi.fn(),
  show: vi.fn(),
  save: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/memory/shared-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/shared-context")>()),
  requestSharedMemoryAccessFromSecurityContext: mocks.requestAccess,
}));
vi.mock("@/lib/customer-success/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/customer-success/store")>()),
  listCustomerAccounts: mocks.list,
  getCustomerAccount360: mocks.show,
  saveCustomerAccount: mocks.save,
  recordCustomerFact: mocks.record,
}));

import {
  createCustomerAccountService,
  listCustomerAccountsService,
  recordCustomerFactService,
} from "@/lib/app-services/customer-accounts";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const authUserId = "11111111-1111-4111-8111-111111111111";
const canonicalActorId = `actor:${authUserId}`;
const workspaceId = `workspace:personal:${authUserId}`;
const context = {
  tenantId: "tenant-customer",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: authUserId,
    email: "owner@example.test",
    sessionId: "session-customer",
    tenantName: "Customer tenant",
  },
} satisfies SecurityContext;

const account = {
  accountId: `customer-account:${"a".repeat(64)}`,
  revision: 1,
  name: "Acme",
};

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
      purpose: "api.customer-account.manage",
    }),
  });
}

beforeEach(() => {
  mocks.requestAccess.mockReset().mockResolvedValue(access());
  mocks.list.mockReset().mockResolvedValue([account]);
  mocks.show.mockReset().mockResolvedValue({ account, facts: [] });
  mocks.save.mockReset().mockResolvedValue(account);
  mocks.record.mockReset().mockResolvedValue({ factId: `customer-fact:${"c".repeat(64)}` });
});

describe("customer Account 360 app services", () => {
  it("lists through the canonical workspace membership boundary", async () => {
    const result = await listCustomerAccountsService(
      createAppServiceCaller({ context }),
      { limit: 20 },
    );
    expect(result.receipt.operation).toBe("app.customer_accounts.list");
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      workspaceId,
      canonicalActorId,
      purposeId: "customer_success.account.read",
    }), { limit: 20, lifecycle: undefined });
  });

  it("creates a deterministic account with external CRM writes disabled", async () => {
    const result = await createCustomerAccountService(caller("account-create-1"), {
      name: "Acme",
      lifecycle: "active",
      accountOwner: { ownerKind: "actor", ownerId: canonicalActorId, displayName: "Owner" },
    });
    expect(result.receipt.operation).toBe("app.customer_accounts.create");
    const saved = mocks.save.mock.calls[0][0];
    expect(saved.accountId).toMatch(/^customer-account:[a-f0-9]{64}$/);
    expect(saved.crmPermissions).toMatchObject({
      readScope: "workspace_members",
      writeScope: "account_owner",
      externalWriteState: "disabled",
    });
    expect(saved.authority.executionScope).toMatchObject({
      initiatingActorId: canonicalActorId,
      executingPrincipalId: canonicalActorId,
      workspaceId,
      purpose: "customer.account.manage",
    });
  });

  it("records only exact source revisions and preserves their purpose boundary", async () => {
    await recordCustomerFactService(caller("fact-1"), {
      accountId: account.accountId,
      factKey: "health.overall",
      value: { kind: "health", dimension: "overall", status: "watch", scoreBasisPoints: null, summary: "Review adoption." },
      source: {
        sourceKind: "meeting",
        sourceId: "meeting:one",
        sourceRevisionId: "meeting:one:v1",
        sourceRevisionSha256: "d".repeat(64),
        sourceLabel: "Customer review",
        providerId: null,
        providerObjectType: null,
        providerObjectIdSha256: null,
        permissionBasis: "derived_from_cited_evidence",
        allowedPurposeIds: ["customer_success.account.read"],
        observedAt: "2026-09-08T00:00:00.000Z",
        ingestedAt: "2026-09-08T00:01:00.000Z",
      },
      owner: { ownerKind: "actor", ownerId: canonicalActorId, displayName: "Owner" },
      confidenceBasisPoints: 8_000,
      validFrom: "2026-09-08T00:00:00.000Z",
    });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({
      factKey: "health.overall",
      source: expect.objectContaining({
        sourceRevisionSha256: "d".repeat(64),
        allowedPurposeIds: ["customer_success.account.read"],
      }),
    }));
  });

  it("blocks account mutations for a workspace reader", async () => {
    mocks.requestAccess.mockResolvedValue(access(false));
    await expect(createCustomerAccountService(caller("reader-create"), {
      name: "Denied",
      accountOwner: { ownerKind: "actor", ownerId: canonicalActorId, displayName: "Owner" },
    })).rejects.toThrow(/owner access/);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
