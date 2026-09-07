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
  fetchSalesforcePage,
  fetchSalesforceRecord,
  SalesforceProviderError,
} from "@/lib/customer-success/salesforce-adapter";
import {
  initialSalesforceSyncCursor,
  salesforceConnectionId,
} from "@/lib/customer-success/salesforce-contracts";
import type { SalesforceConnection } from "@/lib/customer-success/salesforce-store";

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
});

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
