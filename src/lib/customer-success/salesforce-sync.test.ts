import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  fetchPage: vi.fn(),
  settle: vi.fn(),
  fail: vi.fn(),
  project: vi.fn(),
}));

vi.mock("@/lib/customer-success/salesforce-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/customer-success/salesforce-adapter")>()),
  fetchSalesforcePage: mocks.fetchPage,
}));
vi.mock("@/lib/customer-success/salesforce-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/customer-success/salesforce-store")>()),
  claimSalesforceSyncLease: mocks.claim,
  settleSalesforceSyncPage: mocks.settle,
  failSalesforceSync: mocks.fail,
}));
vi.mock("@/lib/customer-success/salesforce-projection", () => ({
  projectPendingSalesforceRecords: mocks.project,
}));

import { syncSalesforceWorkspace } from "@/lib/customer-success/salesforce-sync";
import {
  SALESFORCE_OBJECT_TYPES,
  initialSalesforceSyncCursor,
  salesforceConnectionId,
} from "@/lib/customer-success/salesforce-contracts";
import type {
  SalesforceConnection,
  SalesforceMutationAuthority,
} from "@/lib/customer-success/salesforce-store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const authority = {
  tenantId: "tenant-a",
  workspaceId: "workspace:personal-a",
  canonicalActorId: "actor:owner",
  readableActorIds: ["actor:owner"],
  executionScope: createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "actor:owner",
    executingPrincipalType: "user",
    executingPrincipalId: "actor:owner",
    workspaceId: "workspace:personal-a",
    correlationId: "sync-a",
    purpose: "customer.salesforce.read_sync",
  }),
} satisfies SalesforceMutationAuthority;

const connection = {
  connectionId: salesforceConnectionId({
    tenantId: authority.tenantId,
    workspaceId: authority.workspaceId,
    organizationIdSha256: "a".repeat(64),
  }),
  tenantId: authority.tenantId,
  workspaceId: authority.workspaceId,
  ownerActorId: authority.canonicalActorId,
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

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.claim.mockResolvedValue({
    status: "claimed",
    connection,
    lease: { ownerId: "lease-a", generation: 1, expiresAt: "2026-09-07T11:00:00.000Z" },
  });
  mocks.fetchPage.mockImplementation(({ objectType }) => ({
    objectType,
    sourceKind: "backfill",
    upperBoundAt: "2026-09-07T10:30:00.000Z",
    observations: [],
    nextRecordsPath: null,
    done: true,
    totalSize: 0,
  }));
  mocks.settle.mockImplementation(({ cursor }) => ({
    connection: { ...connection, cursor: structuredClone(cursor) },
    advancedRecords: [],
    inserted: 0,
    advanced: 0,
    stale: 0,
    duplicate: 0,
    conflicts: 0,
  }));
  mocks.project.mockResolvedValue({ examined: 0, projected: 0, held: 0, failed: 0 });
  mocks.fail.mockResolvedValue(undefined);
});

describe("Salesforce backfill and delta orchestration", () => {
  it("settles every object cursor then releases one healthy lease", async () => {
    const result = await syncSalesforceWorkspace({ authority, maxPages: 16 });

    expect(result.status).toBe("healthy");
    expect(mocks.fetchPage).toHaveBeenCalledTimes(SALESFORCE_OBJECT_TYPES.length);
    expect(mocks.settle).toHaveBeenCalledTimes(SALESFORCE_OBJECT_TYPES.length + 1);
    expect(mocks.settle).toHaveBeenLastCalledWith(expect.objectContaining({
      releaseLease: true,
      healthy: true,
    }));
    const finalCursor = mocks.settle.mock.calls.at(-1)?.[0].cursor as {
      objects: Record<string, { phase: string }>;
    };
    expect(Object.values(finalCursor.objects).every((item) =>
      item.phase === "current"
    )).toBe(true);
  });

  it("releases a resumable partial cursor at the request page budget", async () => {
    mocks.fetchPage.mockImplementation(({ objectType }) => ({
      objectType,
      sourceKind: "backfill",
      upperBoundAt: "2026-09-07T10:30:00.000Z",
      observations: [],
      nextRecordsPath: "/services/data/v67.0/query/next",
      done: false,
      totalSize: 10_000,
    }));

    const result = await syncSalesforceWorkspace({ authority, maxPages: 2 });

    expect(result.status).toBe("partial");
    expect(mocks.fetchPage).toHaveBeenCalledTimes(2);
    expect(mocks.settle).toHaveBeenLastCalledWith(expect.objectContaining({
      releaseLease: true,
      healthy: false,
    }));
  });

  it("records an actionable failure under the exact lease", async () => {
    mocks.fetchPage.mockRejectedValue(new Error("provider failed"));

    await expect(syncSalesforceWorkspace({ authority })).rejects.toThrow("provider failed");
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: connection.connectionId,
      lease: expect.objectContaining({ ownerId: "lease-a", generation: 1 }),
      error: expect.objectContaining({ code: "internal_error", action: "retry" }),
    }));
  });
});
