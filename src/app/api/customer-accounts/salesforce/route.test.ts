import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  resolveAccess: vi.fn(),
  getHealth: vi.fn(),
  listFindings: vi.fn(),
  listWrites: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope: (handler: (request: Request) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest,
}));
vi.mock("@/lib/connectors/oauth-providers", () => ({ oauthConfigured: () => false }));
vi.mock("@/lib/customer-success/salesforce-access", () => ({
  resolveSalesforceRequestAccess: mocks.resolveAccess,
  publicSalesforceWorkspaceContext: () => ({
    workspaceId: "workspace:personal-a",
    canWrite: true,
  }),
}));
vi.mock("@/lib/customer-success/salesforce-store", () => ({
  getSalesforceSyncHealth: mocks.getHealth,
  listSalesforceReconciliationFindings: mocks.listFindings,
  listSalesforceWriteOperations: mocks.listWrites,
}));

import { GET } from "@/app/api/customer-accounts/salesforce/route";

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "owner@example.test",
  });
  mocks.resolveAccess.mockReset().mockResolvedValue({
    access: {},
    readAuthority: {
      tenantId: "tenant-a",
      workspaceId: "workspace:personal-a",
      canonicalActorId: "actor:owner",
      readableActorIds: ["actor:owner"],
    },
  });
  mocks.getHealth.mockReset().mockResolvedValue({
    configured: false,
    connected: false,
    status: "configuration_required",
  });
  mocks.listFindings.mockReset().mockResolvedValue([]);
  mocks.listWrites.mockReset().mockResolvedValue([]);
});

describe("Salesforce connection health route", () => {
  it("returns a private workspace-bound health projection without credentials", async () => {
    const response = await GET(new Request("http://localhost/api/customer-accounts/salesforce"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      context: { workspaceId: "workspace:personal-a", canWrite: true },
      health: { configured: false, connected: false, status: "configuration_required" },
      findings: [],
      writes: {
        configured: false,
        enabled: false,
        mode: "approval_required",
        operations: [],
      },
      webhook: { configured: false, signature: "hmac-sha256-v1" },
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "salesforce_connection",
    }));
    expect(JSON.stringify(await mocks.getHealth.mock.results[0]?.value)).not.toContain("token");
  });
});
