import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  show: vi.fn(),
  evaluate: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(),
}));
vi.mock("@/lib/app-services/customer-health", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/customer-health")>()),
  showCustomerHealthService: mocks.show,
  evaluateCustomerHealthService: mocks.evaluate,
}));

import {
  GET,
  POST,
} from "@/app/api/customer-accounts/[id]/health/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const accountId = `customer-account:${"a".repeat(64)}`;

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue(context);
  mocks.show.mockReset().mockResolvedValue({
    data: { context: {}, policy: {}, score: null, history: [] },
    receipt: { operation: "app.customer_accounts.health.show" },
  });
  mocks.evaluate.mockReset().mockResolvedValue({
    data: { context: {}, score: { scoreSha256: "b".repeat(64) } },
    receipt: { operation: "app.customer_accounts.health.evaluate" },
  });
});

describe("customer health route", () => {
  it("reads current and historical scoring evidence with private caching", async () => {
    const response = await GET(
      new Request(`http://localhost/api/customer-accounts/${accountId}/health?historyLimit=7`),
      { params: Promise.resolve({ id: encodeURIComponent(accountId) }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.show).toHaveBeenCalledWith(expect.any(Object), {
      accountId,
      historyLimit: 7,
    });
  });

  it("evaluates through a request-bound idempotent mutation caller", async () => {
    const response = await POST(
      new Request(`http://localhost/api/customer-accounts/${accountId}/health`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "health-evaluate-1",
        },
        body: JSON.stringify({
          expectedAccountRevision: 3,
          expectedAccountSha256: "c".repeat(64),
        }),
      }),
      { params: Promise.resolve({ id: encodeURIComponent(accountId) }) },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "health-evaluate-1" }),
      expect.objectContaining({
        accountId,
        expectedAccountRevision: 3,
        expectedAccountSha256: "c".repeat(64),
        modelSuggestions: [],
      }),
    );
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "manage.workflow",
      resourceType: "customer_health_score",
      riskLevel: 1,
    }));
  });

  it("rejects evaluation without an exact Account 360 digest", async () => {
    const response = await POST(
      new Request(`http://localhost/api/customer-accounts/${accountId}/health`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedAccountRevision: 3 }),
      }),
      { params: Promise.resolve({ id: encodeURIComponent(accountId) }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});
