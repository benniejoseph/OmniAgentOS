import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAccess: vi.fn(),
  getAccount: vi.fn(),
  saveAccount: vi.fn(),
  getConnection: vi.fn(),
  getLink: vi.fn(),
  prepare: vi.fn(),
  begin: vi.fn(),
  settle: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/lib/customer-success/salesforce-access", () => ({
  resolveSalesforceRequestAccess: mocks.resolveAccess,
}));
vi.mock("@/lib/customer-success/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/customer-success/store")>()),
  getCustomerAccount360: mocks.getAccount,
  saveCustomerAccount: mocks.saveAccount,
}));
vi.mock("@/lib/customer-success/salesforce-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/customer-success/salesforce-store")>()),
  getSalesforceConnection: mocks.getConnection,
  getSalesforceAccountLinkByCustomerAccount: mocks.getLink,
  prepareSalesforceWriteOperation: mocks.prepare,
  beginSalesforceWriteAttempt: mocks.begin,
  settleSalesforceWriteOperation: mocks.settle,
}));
vi.mock("@/lib/customer-success/salesforce-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/customer-success/salesforce-adapter")>()),
  executeSalesforceWrite: mocks.execute,
}));

import {
  configureSalesforceWritesService,
  executeSalesforceRecordWriteService,
} from "@/lib/app-services/salesforce-writes";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const actorId = "actor:11111111-1111-4111-8111-111111111111";
const accountId = `customer-account:${"a".repeat(64)}`;
const workspaceId = "workspace:personal:11111111-1111-4111-8111-111111111111";
const context = {
  tenantId: "tenant-salesforce-write",
  actorId,
  role: "admin",
  source: "session",
} satisfies SecurityContext;
const executionScope = createExecutionScope({
  tenantId: context.tenantId,
  initiatingActorId: actorId,
  executingPrincipalType: "user",
  executingPrincipalId: actorId,
  workspaceId,
  correlationId: "tool-execution-1",
  purpose: "test.salesforce.write",
});
const account = {
  accountId,
  revision: 3,
  name: "Acme",
  lifecycle: "active",
  organizationEntityId: null,
  ownerActorId: actorId,
  accountOwner: { ownerKind: "actor", ownerId: actorId, displayName: "Owner" },
  crmPermissions: {
    readScope: "workspace_members",
    writeScope: "account_owner",
    externalWriteState: "approval_required",
    customerDataPurposeIds: [
      "customer_success.account.read",
      "customer_success.account.manage",
      "customer_success.crm_sync",
    ],
  },
};
const connection = {
  connectionId: `salesforce-connection:${"b".repeat(64)}`,
  ownerActorId: actorId,
  connectionState: "active",
  organizationIdSha256: "c".repeat(64),
};
const link = {
  connectionId: connection.connectionId,
  salesforceAccountId: "001000000000001AAA",
};
const commit = {
  schemaVersion: 1,
  contractVersion: "p10.11-salesforce-guarded-write:1",
  operationId: `salesforce-write:${"d".repeat(64)}`,
  toolId: "app.customer_accounts.salesforce.contact.create",
  objectType: "Contact",
  action: "create",
  providerRecordIdSha256: "e".repeat(64),
  providerModifiedAt: "2026-09-08T02:00:00.000Z",
  providerAcknowledgement: "provider_response",
  providerAcknowledgementId: `salesforce_ack_${"f".repeat(48)}`,
  providerAcknowledgementSha256: "1".repeat(64),
  expectedTargetStateSha256: "2".repeat(64),
  observedTargetStateSha256: "2".repeat(64),
  verificationState: "verified",
  verificationReasonCode: "state_matched",
} as const;

function caller(idempotencyKey = "tool-execution-1") {
  return createAppServiceCaller({ context, executionScope, idempotencyKey });
}

function operation(state: "prepared" | "verified", receipt = state === "verified" ? commit : null) {
  return {
    operationId: commit.operationId,
    toolExecutionId: "tool-execution-1",
    toolId: commit.toolId,
    objectType: commit.objectType,
    action: commit.action,
    customerAccountId: accountId,
    providerRecordIdSha256: state === "verified" ? commit.providerRecordIdSha256 : null,
    requestSha256: "3".repeat(64),
    expectedTargetStateSha256: commit.expectedTargetStateSha256,
    state,
    providerAcknowledgementSha256: state === "verified"
      ? commit.providerAcknowledgementSha256
      : null,
    observedTargetStateSha256: state === "verified"
      ? commit.observedTargetStateSha256
      : null,
    verificationReasonCode: state === "verified" ? "state_matched" : null,
    commit: receipt,
    attemptCount: state === "verified" ? 1 : 0,
    lastAttemptAt: state === "verified" ? "2026-09-08T02:00:00.000Z" : null,
    completedAt: state === "verified" ? "2026-09-08T02:00:01.000Z" : null,
    createdAt: "2026-09-08T01:59:59.000Z",
    updatedAt: "2026-09-08T02:00:01.000Z",
  };
}

beforeEach(() => {
  process.env.SALESFORCE_WRITE_ENABLED = "true";
  process.env.SALESFORCE_WRITE_EXTERNAL_ID_FIELD = "Asael_Idempotency_Key__c";
  mocks.resolveAccess.mockReset().mockResolvedValue({
    readAuthority: {
      tenantId: context.tenantId,
      workspaceId,
      canonicalActorId: actorId,
      readableActorIds: [actorId],
    },
    mutationAuthority: {
      tenantId: context.tenantId,
      workspaceId,
      canonicalActorId: actorId,
      readableActorIds: [actorId],
      executionScope,
    },
  });
  mocks.getAccount.mockReset().mockResolvedValue({ account });
  mocks.saveAccount.mockReset().mockImplementation(async (input) => ({
    ...account,
    revision: account.revision + 1,
    crmPermissions: input.crmPermissions,
  }));
  mocks.getConnection.mockReset().mockResolvedValue(connection);
  mocks.getLink.mockReset().mockResolvedValue(link);
  mocks.prepare.mockReset().mockResolvedValue(operation("prepared"));
  mocks.begin.mockReset().mockResolvedValue({ ...operation("prepared"), attemptCount: 1 });
  mocks.execute.mockReset().mockResolvedValue({ status: "commit", commit });
  mocks.settle.mockReset().mockResolvedValue(operation("verified"));
});

afterEach(() => {
  delete process.env.SALESFORCE_WRITE_ENABLED;
  delete process.env.SALESFORCE_WRITE_EXTERNAL_ID_FIELD;
});

describe("Salesforce guarded-write app services", () => {
  it("activates approval-bound writes on an exact linked Account 360 revision", async () => {
    const result = await configureSalesforceWritesService(caller("configure-1"), {
      accountId,
      expectedAccountRevision: 3,
      enabled: true,
    });
    expect(result.data.salesforceWrites).toEqual({
      state: "approval_required",
      providerReady: true,
      approvalRequired: true,
    });
    expect(mocks.saveAccount).toHaveBeenCalledWith(expect.objectContaining({
      accountId,
      expectedRevision: 3,
      crmPermissions: expect.objectContaining({ externalWriteState: "approval_required" }),
    }));
  });

  it("ledgers, executes and returns only a terminal verified write receipt", async () => {
    const result = await executeSalesforceRecordWriteService(
      caller(),
      "app.customer_accounts.salesforce.contact.create",
      {
        accountId,
        expectedAccountRevision: 3,
        fields: { LastName: "Lovelace" },
      },
    );
    expect(result.data.commit).toBe(commit);
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      customerAccountId: accountId,
      toolExecutionId: "tool-execution-1",
      providerIdempotencyKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      salesforceAccountId: link.salesforceAccountId,
      reconcileOnly: false,
    }));
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ commit }));
  });

  it("blocks provider execution until the account owner explicitly activates writes", async () => {
    mocks.getAccount.mockResolvedValue({
      account: {
        ...account,
        crmPermissions: { ...account.crmPermissions, externalWriteState: "disabled" },
      },
    });
    await expect(executeSalesforceRecordWriteService(
      caller(),
      "app.customer_accounts.salesforce.contact.create",
      { accountId, expectedAccountRevision: 3, fields: { LastName: "Lovelace" } },
    )).rejects.toThrow(/explicit activation/);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
