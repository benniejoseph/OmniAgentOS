import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestAccess: vi.fn(),
  list: vi.fn(),
  show: vi.fn(),
  save: vi.fn(),
  submit: vi.fn(),
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
  submitCustomerAccountMutation: mocks.submit,
  recordCustomerFact: mocks.record,
}));

import {
  createCustomerAccountService,
  listCustomerAccountsService,
  recordCustomerFactService,
  showCustomerAccountService,
  reviseCustomerAccountService,
  customerAccountReviseServiceInputSchema,
} from "@/lib/app-services/customer-accounts";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { CustomerAccountProjectionLimitError } from "@/lib/customer-success/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

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
  mocks.submit.mockReset().mockResolvedValue({ account, acceptance: { requestSha256: "d".repeat(64) } });
  mocks.record.mockReset().mockResolvedValue({ factId: `customer-fact:${"c".repeat(64)}` });
});

describe("customer Account 360 app services", () => {
  it("propagates bounded projection overflow without issuing a partial success receipt or fallback read", async () => {
    const overflow = new CustomerAccountProjectionLimitError();
    mocks.show.mockRejectedValueOnce(overflow);
    await expect(showCustomerAccountService(createAppServiceCaller({ context }), {
      accountId: account.accountId, workspaceId,
    })).rejects.toBe(overflow);
    expect(mocks.show).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId, workspaceId, canonicalActorId, purposeId: "customer_success.account.read",
    }), account.accountId);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

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
    const saved = mocks.submit.mock.calls[0][0];
    expect(saved.request).toEqual({ operation: "account.create", name: "Acme", lifecycle: "active", organizationEntityId: null, accountOwner: { ownerKind: "actor", ownerId: canonicalActorId, displayName: "Owner" }, customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"] });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(saved.authority.executionScope).toMatchObject({
      initiatingActorId: canonicalActorId,
      executingPrincipalId: canonicalActorId,
      workspaceId,
      purpose: "customer.account.manage",
    });
    expect(result.data.acceptance).toEqual({ requestSha256: "d".repeat(64) });
    expect(result.receipt.outcomeSha256).toBe(canonicalJsonSha256(result.data));
  });

  it("passes immutable sparse revise input to replay admission before any current Account360/fact read", async () => {
    mocks.show.mockRejectedValue(new CustomerAccountProjectionLimitError());
    const accepted = { account: { ...account, revision: 2 }, acceptance: { requestSha256: "e".repeat(64) } };
    mocks.submit.mockResolvedValue(accepted);
    const input = { accountId: account.accountId, workspaceId, expectedRevision: 1, lifecycle: "at_risk" as const };
    const first = await reviseCustomerAccountService(caller("exact-revise"), input);
    const replay = await reviseCustomerAccountService(caller("exact-revise"), input);
    expect(first.data).toEqual(replay.data);
    expect(replay.data).toMatchObject(accepted);
    expect(mocks.submit).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: account.accountId, request: { operation: "account.revise", expectedRevision: 1, lifecycle: "at_risk" } }));
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(replay.receipt.outcomeSha256).toBe(canonicalJsonSha256(replay.data));
  });

  it("requires current workspace write access even when the store could return acceptance", async () => {
    mocks.requestAccess.mockResolvedValue(access(false));
    await expect(reviseCustomerAccountService(caller("accepted-revise"), { accountId: account.accountId, expectedRevision: 1, name: "Acme" })).rejects.toThrow(/owner access/);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not count workspace or exact account identity as a patch change", () => {
    expect(customerAccountReviseServiceInputSchema.safeParse({ accountId: account.accountId, workspaceId, expectedRevision: 1 }).success).toBe(false);
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
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
