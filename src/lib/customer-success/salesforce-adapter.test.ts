import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOAuthGrantSecrets: vi.fn(),
  saveOAuthGrant: vi.fn(),
  refreshOAuthAccess: vi.fn(),
}));

vi.mock("@/lib/connectors/oauth-store", () => ({
  getOAuthGrantSecrets: mocks.getOAuthGrantSecrets,
  saveOAuthGrant: mocks.saveOAuthGrant,
}));
vi.mock("@/lib/connectors/oauth-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/oauth-providers")>()),
  refreshOAuthAccess: mocks.refreshOAuthAccess,
}));

import {
  executeSalesforceWrite,
  fetchSalesforcePage,
  fetchSalesforceRecord,
  SalesforceProviderError,
} from "@/lib/customer-success/salesforce-adapter";
import {
  initialSalesforceSyncCursor,
  salesforceConnectionId,
} from "@/lib/customer-success/salesforce-contracts";
import type { SalesforceConnection } from "@/lib/customer-success/salesforce-store";
import { salesforceWriteExternalKey } from "@/lib/customer-success/salesforce-write-contracts";

const connection = {
  connectionId: salesforceConnectionId({
    tenantId: "tenant-a",
    workspaceId: "workspace:personal-a",
    organizationIdSha256: "a".repeat(64),
  }),
  tenantId: "tenant-a",
  workspaceId: "workspace:personal-a",
  ownerActorId: "actor:owner",
  oauthGrantId: "grant-a",
  authorizationGeneration: 1,
  organizationIdSha256: "a".repeat(64),
  instanceOrigin: "https://tenant.my.salesforce.com",
  connectionState: "active",
  cursor: initialSalesforceSyncCursor(),
  syncStatus: "idle",
  syncError: null,
  lastSuccessfulSyncAt: null,
  lastWebhookAt: null,
  lastReplayIdSha256: null,
  createdAt: "2026-09-07T10:00:00.000Z",
  updatedAt: "2026-09-07T10:00:00.000Z",
} satisfies SalesforceConnection;

afterEach(() => {
  vi.restoreAllMocks();
  mocks.getOAuthGrantSecrets.mockReset();
  mocks.saveOAuthGrant.mockReset();
  mocks.refreshOAuthAccess.mockReset();
  delete process.env.SALESFORCE_WRITE_ENABLED;
  delete process.env.SALESFORCE_WRITE_EXTERNAL_ID_FIELD;
});

function enableWrites() {
  process.env.SALESFORCE_WRITE_ENABLED = "true";
  process.env.SALESFORCE_WRITE_EXTERNAL_ID_FIELD = "Asael_Idempotency_Key__c";
}

function authorize() {
  mocks.getOAuthGrantSecrets.mockResolvedValue({
    grant: { id: "grant-a" },
    tokens: {
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      instance_url: connection.instanceOrigin,
    },
  });
}

describe("Salesforce REST read adapter", () => {
  it("discovers the current API, intersects described fields and emits a fenced backfill query", async () => {
    authorize();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { version: "65.0" }, { version: "67.0" },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        fields: ["Id", "Name", "SystemModstamp", "IsDeleted", "Secret__c"]
          .map((name) => ({ name, permissionable: true })),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        done: true,
        totalSize: 1,
        records: [{
          Id: "001000000000001AAA",
          Name: "Acme",
          SystemModstamp: "2026-09-07T10:00:00.000Z",
          IsDeleted: false,
          Secret__c: "not allowed",
        }],
      }), { status: 200 }));

    const page = await fetchSalesforcePage({
      connection,
      objectType: "Account",
      cursor: initialSalesforceSyncCursor().objects.Account,
    });

    expect(page.sourceKind).toBe("backfill");
    expect(page.done).toBe(true);
    expect(page.observations[0]?.fields).toEqual(expect.objectContaining({
      Id: "001000000000001AAA",
      Name: "Acme",
    }));
    expect(page.observations[0]?.fields).not.toHaveProperty("Secret__c");
    const queryUrl = String(fetchMock.mock.calls[2]?.[0]);
    expect(queryUrl).toContain("/services/data/v67.0/queryAll?q=");
    expect(decodeURIComponent(queryUrl)).toContain("SystemModstamp <=");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("refresh-secret");
  });

  it("fetches a complete record for webhook or reconciliation projection", async () => {
    authorize();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([{ version: "67.0" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        fields: ["Id", "AccountId", "Name", "SystemModstamp"]
          .map((name) => ({ name, permissionable: true })),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        done: true,
        records: [{
          Id: "003000000000001AAA",
          AccountId: "001000000000001AAA",
          Name: "Ada",
          SystemModstamp: "2026-09-07T10:00:00.000Z",
        }],
      }), { status: 200 }));

    await expect(fetchSalesforceRecord({
      connection,
      objectType: "Contact",
      externalId: "003000000000001AAA",
      sourceKind: "webhook",
      replayIdSha256: "b".repeat(64),
    })).resolves.toMatchObject({
      sourceKind: "webhook",
      accountExternalId: "001000000000001AAA",
      replayIdSha256: "b".repeat(64),
    });
  });

  it("normalizes provider permission failures into an actionable error", async () => {
    authorize();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([{ version: "67.0" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { errorCode: "INSUFFICIENT_ACCESS", message: "sensitive provider detail" },
      ]), { status: 403 }));

    const promise = fetchSalesforcePage({
      connection,
      objectType: "Account",
      cursor: initialSalesforceSyncCursor().objects.Account,
    });
    await expect(promise).rejects.toBeInstanceOf(SalesforceProviderError);
    await expect(promise).rejects.toMatchObject({
      actionableError: {
        code: "insufficient_scope",
        action: "review_permissions",
      },
    });
  });
});

describe("Salesforce guarded-write adapter", () => {
  it("creates through a unique external-ID upsert and verifies the exact linked state", async () => {
    authorize();
    enableWrites();
    let created = false;
    const executionId = "idem_contact_create";
    const externalKey = salesforceWriteExternalKey(executionId);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/services/data/")) return Response.json([{ version: "67.0" }]);
      if (url.endsWith("/sobjects/Contact/describe")) return Response.json({ fields: [
        { name: "LastName", createable: true, updateable: true },
        { name: "AccountId", createable: true, updateable: true },
        { name: "Asael_Idempotency_Key__c", createable: true, updateable: true, externalId: true, unique: true },
      ] });
      if (init?.method === "PATCH") {
        created = true;
        return Response.json({ id: "003000000000001AAA", success: true }, { status: 201 });
      }
      if (url.includes("/query?q=")) return Response.json({ done: true, records: created ? [{
        Id: "003000000000001AAA",
        LastName: "Lovelace",
        AccountId: "001000000000001AAA",
        Asael_Idempotency_Key__c: externalKey,
        SystemModstamp: "2026-09-07T12:00:01.000Z",
        LastModifiedDate: "2026-09-07T12:00:01.000Z",
      }] : [] });
      throw new Error(`Unexpected Salesforce request ${url}`);
    });

    await expect(executeSalesforceWrite({
      connection,
      toolId: "app.customer_accounts.salesforce.contact.create",
      value: {
        accountId: `customer-account:${"c".repeat(64)}`,
        expectedAccountRevision: 2,
        fields: { LastName: "Lovelace" },
      },
      executionId,
      salesforceAccountId: "001000000000001AAA",
    })).resolves.toMatchObject({
      status: "commit",
      commit: {
        verificationState: "verified",
        verificationReasonCode: "state_matched",
        providerAcknowledgement: "provider_response",
      },
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"))
      .toHaveLength(1);
  });

  it("refuses to overwrite an update target that changed after approval", async () => {
    authorize();
    enableWrites();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const url = String(request);
      if (url.endsWith("/services/data/")) return Response.json([{ version: "67.0" }]);
      if (url.endsWith("/sobjects/Account/describe")) return Response.json({
        fields: [{ name: "Name", updateable: true }],
      });
      return Response.json({ done: true, records: [{
        Id: "001000000000001AAA",
        Name: "Changed elsewhere",
        SystemModstamp: "2026-09-07T12:01:00.000Z",
        LastModifiedDate: "2026-09-07T12:01:00.000Z",
      }] });
    });

    await expect(executeSalesforceWrite({
      connection,
      toolId: "app.customer_accounts.salesforce.account.update",
      value: {
        accountId: `customer-account:${"c".repeat(64)}`,
        expectedAccountRevision: 2,
        recordId: "001000000000001AAA",
        expectedProviderModifiedAt: "2026-09-07T12:00:00.000Z",
        fields: { Name: "Approved name" },
      },
      executionId: "idem_account_update",
      salesforceAccountId: "001000000000001AAA",
    })).resolves.toMatchObject({
      status: "commit",
      commit: {
        verificationState: "failed",
        verificationReasonCode: "state_mismatch",
      },
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("allows a missing deterministic create target to resume safely", async () => {
    authorize();
    enableWrites();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const url = String(request);
      if (url.endsWith("/services/data/")) return Response.json([{ version: "67.0" }]);
      if (url.endsWith("/sobjects/Task/describe")) return Response.json({ fields: [
        { name: "Subject", createable: true },
        { name: "Status", createable: true },
        { name: "Priority", createable: true },
        { name: "WhatId", createable: true },
        { name: "Asael_Idempotency_Key__c", createable: true, updateable: true, externalId: true, unique: true },
      ] });
      return Response.json({ done: true, records: [] });
    });
    await expect(executeSalesforceWrite({
      connection,
      toolId: "app.customer_accounts.salesforce.task.create",
      value: {
        accountId: `customer-account:${"c".repeat(64)}`,
        expectedAccountRevision: 2,
        fields: { Subject: "Follow up", Status: "Not Started", Priority: "Normal" },
      },
      executionId: "idem_task_create",
      salesforceAccountId: "001000000000001AAA",
      reconcileOnly: true,
    })).resolves.toEqual({ status: "retryable" });
  });

  it("reports a write target deleted during the conditional update as a conflict", async () => {
    authorize();
    enableWrites();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json([{ version: "67.0" }]))
      .mockResolvedValueOnce(Response.json({
        fields: [{ name: "Name", updateable: true }],
      }))
      .mockResolvedValueOnce(Response.json({ done: true, records: [{
        Id: "001000000000001AAA",
        Name: "Current name",
        SystemModstamp: "2026-09-07T12:00:00.000Z",
        LastModifiedDate: "2026-09-07T12:00:00.000Z",
      }] }))
      .mockResolvedValueOnce(Response.json([{
        errorCode: "ENTITY_IS_DELETED",
        message: "provider detail",
      }], { status: 404 }));
    const promise = executeSalesforceWrite({
      connection,
      toolId: "app.customer_accounts.salesforce.account.update",
      value: {
        accountId: `customer-account:${"c".repeat(64)}`,
        expectedAccountRevision: 2,
        recordId: "001000000000001AAA",
        expectedProviderModifiedAt: "2026-09-07T12:00:00.000Z",
        fields: { Name: "Approved name" },
      },
      executionId: "idem_deleted_account_update",
      salesforceAccountId: "001000000000001AAA",
    });
    await expect(promise).rejects.toMatchObject({
      actionableError: {
        code: "record_conflict",
        action: "review_conflict",
      },
    });
  });
});
