import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  list: vi.fn(),
  start: vi.fn(),
  outcome: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(),
}));
vi.mock("@/lib/app-services/customer-success-workflows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/customer-success-workflows")>()),
  listCustomerSuccessWorkflowsService: mocks.list,
  startCustomerSuccessWorkflowService: mocks.start,
  recordCustomerSuccessWorkflowOutcomeService: mocks.outcome,
}));

import { GET, PATCH, POST } from "@/app/api/customer-accounts/[id]/workflows/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-a111-111111111111",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const accountId = `customer-account:${"a".repeat(64)}`;
const runId = `customer-success-run:${"b".repeat(64)}`;

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue(context);
  mocks.list.mockReset().mockResolvedValue({
    data: { context: {}, pack: [], runs: [] },
    receipt: { operation: "app.customer_accounts.workflows.list" },
  });
  mocks.start.mockReset().mockResolvedValue({
    data: { context: {}, definition: {}, run: { runId }, project: {} },
    receipt: { operation: "app.customer_accounts.workflows.start" },
  });
  mocks.outcome.mockReset().mockResolvedValue({
    data: { context: {}, definition: {}, run: { runId }, project: {} },
    receipt: { operation: "app.customer_accounts.workflows.outcome.record" },
  });
});

describe("customer-success workflow route", () => {
  it("lists the pack and account runs with private caching", async () => {
    const response = await GET(
      new Request(`http://localhost/api/customer-accounts/${accountId}/workflows?limit=20`),
      routeContext(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledWith(expect.any(Object), { accountId, limit: 20 });
  });

  it("starts a typed workflow through an idempotent governed caller", async () => {
    const response = await POST(
      request("POST", "start-risk", {
        expectedAccountRevision: 3,
        expectedAccountSha256: "c".repeat(64),
        input: {
          workflowId: "risk_escalation",
          objective: "Restore confidence.",
          riskTitle: "Adoption stalled",
          severity: "high",
          signals: ["Use declined."],
        },
      }),
      routeContext(),
    );
    expect(response.status).toBe(201);
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "start-risk" }),
      expect.objectContaining({
        accountId,
        input: expect.objectContaining({
          workflowId: "risk_escalation",
          targetDate: null,
        }),
      }),
    );
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "run.agent",
      resourceType: "customer_success_workflow",
      metadata: expect.objectContaining({ directExternalEffectsAllowed: false }),
    }));
  });

  it("records an exact terminal outcome receipt", async () => {
    const response = await PATCH(
      request("PATCH", "close-risk", {
        runId,
        expectedRevision: 1,
        status: "blocked",
        summary: "Sponsor confirmation is missing.",
        nextAction: "Confirm the sponsor.",
      }),
      routeContext(),
    );
    expect(response.status).toBe(200);
    expect(mocks.outcome).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "close-risk" }),
      expect.objectContaining({
        accountId,
        runId,
        artifactReceipts: [],
      }),
    );
  });

  it("rejects an untyped workflow before authorization", async () => {
    const response = await POST(
      request("POST", "bad", {
        expectedAccountRevision: 3,
        expectedAccountSha256: "c".repeat(64),
        input: { workflowId: "risk_escalation", objective: "Missing risk fields." },
      }),
      routeContext(),
    );
    expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

function request(method: string, idempotencyKey: string, body: unknown) {
  return new Request(`http://localhost/api/customer-accounts/${accountId}/workflows`, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

function routeContext() {
  return { params: Promise.resolve({ id: encodeURIComponent(accountId) }) };
}
