import { describe, expect, it } from "vitest";

import {
  initialSalesforceSyncCursor,
  salesforceConnectionId,
} from "@/lib/customer-success/salesforce-contracts";
import {
  projectSalesforceSyncHealth,
  type SalesforceConnection,
} from "@/lib/customer-success/salesforce-store";

const workspaceId = "workspace:personal-a";
const evaluatedAt = "2026-09-07T12:00:00.000Z";

function connection(): SalesforceConnection {
  const cursor = initialSalesforceSyncCursor();
  cursor.objects.Account.phase = "current";
  cursor.objects.Account.watermarkAt = "2026-09-07T11:58:00.000Z";
  cursor.objects.Account.watermarkExternalId = "001000000000001AAA";
  return {
    connectionId: salesforceConnectionId({
      tenantId: "tenant-a",
      workspaceId,
      organizationIdSha256: "a".repeat(64),
    }),
    tenantId: "tenant-a",
    workspaceId,
    ownerActorId: "actor:owner",
    oauthGrantId: "grant-a",
    authorizationGeneration: 1,
    organizationIdSha256: "a".repeat(64),
    instanceOrigin: "https://tenant.my.salesforce.com",
    connectionState: "active",
    cursor,
    syncStatus: "healthy",
    syncError: null,
    lastSuccessfulSyncAt: "2026-09-07T11:59:00.000Z",
    lastWebhookAt: null,
    lastReplayIdSha256: null,
    createdAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T11:59:00.000Z",
  };
}

describe("Salesforce synchronization health", () => {
  it("distinguishes missing configuration from a disconnected workspace", () => {
    expect(projectSalesforceSyncHealth({
      workspaceId,
      configured: false,
      evaluatedAt,
    })).toMatchObject({
      status: "configuration_required",
      connected: false,
      lagSeconds: null,
    });
    expect(projectSalesforceSyncHealth({
      workspaceId,
      configured: true,
      evaluatedAt,
    })).toMatchObject({
      status: "disconnected",
      connected: false,
    });
  });

  it("projects cursor, lag, scope and errors without provider secrets", () => {
    const health = projectSalesforceSyncHealth({
      workspaceId,
      configured: true,
      connection: connection(),
      evaluatedAt,
    });

    expect(health.status).toBe("healthy");
    expect(health.lagSeconds).toBe(60);
    expect(health.objectScope).toHaveLength(8);
    expect(health.purposeScope).toEqual([
      "customer_success.account.read",
      "customer_success.crm_sync",
    ]);
    expect(JSON.stringify(health)).not.toContain("access_token");
    expect(JSON.stringify(health)).not.toContain("refresh_token");
    expect(JSON.stringify(health)).not.toContain("instanceOrigin");
  });
});
