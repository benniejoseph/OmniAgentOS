import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  list: vi.fn(),
  show: vi.fn(),
  create: vi.fn(),
  revise: vi.fn(),
  record: vi.fn(),
  portfolio: vi.fn(),
  intelligence: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(),
}));
vi.mock("@/lib/app-services/customer-accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/customer-accounts")>()),
  listCustomerAccountsService: mocks.list,
  showCustomerAccountService: mocks.show,
  createCustomerAccountService: mocks.create,
  reviseCustomerAccountService: mocks.revise,
  recordCustomerFactService: mocks.record,
}));
vi.mock("@/lib/app-services/customer-success-intelligence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/customer-success-intelligence")>()),
  showCustomerSuccessPortfolioService: mocks.portfolio,
  showCustomerSuccessIntelligenceService: mocks.intelligence,
}));

import {
  GET as GETAccount,
  PATCH as PATCHAccount,
} from "@/app/api/customer-accounts/[id]/route";
import { POST as POSTFact } from "@/app/api/customer-accounts/[id]/facts/route";
import { GET as GETIntelligence } from "@/app/api/customer-accounts/[id]/intelligence/route";
import { GET as GETPortfolio } from "@/app/api/customer-accounts/portfolio/route";
import {
  GET as GETAccounts,
  POST as POSTAccount,
} from "@/app/api/customer-accounts/route";

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
const account = { account: { accountId, revision: 1, name: "Acme" }, facts: [] };

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue(context);
  mocks.list.mockReset().mockResolvedValue({
    data: { context: {}, accounts: [account.account] },
    receipt: { operation: "app.customer_accounts.list" },
  });
  mocks.show.mockReset().mockResolvedValue({
    data: { context: {}, account },
    receipt: { operation: "app.customer_accounts.show" },
  });
  mocks.create.mockReset().mockResolvedValue({
    data: { context: {}, account: account.account },
    receipt: { operation: "app.customer_accounts.create" },
  });
  mocks.revise.mockReset().mockResolvedValue({
    data: { context: {}, account: { ...account.account, revision: 2 } },
    receipt: { operation: "app.customer_accounts.revise" },
  });
  mocks.record.mockReset().mockResolvedValue({
    data: { context: {}, fact: { factId: `customer-fact:${"b".repeat(64)}` } },
    receipt: { operation: "app.customer_accounts.facts.record" },
  });
  mocks.portfolio.mockReset().mockResolvedValue({
    data: { context: {}, portfolio: { accounts: [], counts: { total: 0 } } },
    receipt: { operation: "app.customer_accounts.portfolio.show" },
  });
  mocks.intelligence.mockReset().mockResolvedValue({
    data: { context: {}, intelligence: { portfolio: { accountId }, timeline: [] } },
    receipt: { operation: "app.customer_accounts.intelligence.show" },
  });
});

describe("customer Account 360 routes", () => {
  it("lists and reads account projections with private no-store semantics", async () => {
    const list = await GETAccounts(new Request(
      "http://localhost/api/customer-accounts?lifecycle=active&limit=20",
    ));
    const show = await GETAccount(
      new Request(`http://localhost/api/customer-accounts/${accountId}`),
      { params: Promise.resolve({ id: encodeURIComponent(accountId) }) },
    );
    expect([list.status, show.status]).toEqual([200, 200]);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect(show.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledWith(expect.any(Object), {
      lifecycle: "active",
      limit: 20,
    });
  });

  it("creates and revises through request-bound idempotent mutation callers", async () => {
    const create = await POSTAccount(new Request("http://localhost/api/customer-accounts", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "account-create-1" },
      body: JSON.stringify({
        name: "Acme",
        lifecycle: "active",
        accountOwner: { ownerKind: "actor", ownerId: `actor:${context.auth.userId}`, displayName: "Owner" },
      }),
    }));
    const revise = await PATCHAccount(
      new Request(`http://localhost/api/customer-accounts/${accountId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": "account-revise-1" },
        body: JSON.stringify({ expectedRevision: 1, lifecycle: "at_risk" }),
      }),
      { params: Promise.resolve({ id: encodeURIComponent(accountId) }) },
    );
    expect([create.status, revise.status]).toEqual([201, 200]);
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ idempotencyKey: "account-create-1" });
    expect(mocks.revise).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "account-revise-1" }),
      expect.objectContaining({ accountId, expectedRevision: 1, lifecycle: "at_risk" }),
    );
  });

  it("records a fact only with exact source, owner, confidence, and validity", async () => {
    const response = await POSTFact(
      new Request(`http://localhost/api/customer-accounts/${accountId}/facts`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "fact-1" },
        body: JSON.stringify({
          factKey: "health.overall",
          value: { kind: "health", dimension: "overall", status: "watch", scoreBasisPoints: null, summary: "Review adoption." },
          source: {
            sourceKind: "manual",
            sourceId: "operator:fact-1",
            sourceRevisionId: "operator:fact-1:v1",
            sourceRevisionSha256: "c".repeat(64),
            sourceLabel: "Operator assertion",
            providerId: null,
            providerObjectType: null,
            providerObjectIdSha256: null,
            permissionBasis: "operator_assertion",
            allowedPurposeIds: ["customer_success.account.read"],
            observedAt: "2026-09-08T00:00:00.000Z",
            ingestedAt: "2026-09-08T00:01:00.000Z",
          },
          owner: { ownerKind: "actor", ownerId: `actor:${context.auth.userId}`, displayName: "Owner" },
          confidenceBasisPoints: 8_000,
          validFrom: "2026-09-08T00:00:00.000Z",
        }),
      }),
      { params: Promise.resolve({ id: encodeURIComponent(accountId) }) },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "fact-1" }),
      expect.objectContaining({ accountId, factKey: "health.overall" }),
    );
  });

  it("rejects incomplete fact provenance before authorization", async () => {
    const response = await POSTFact(
      new Request(`http://localhost/api/customer-accounts/${accountId}/facts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ factKey: "health.overall", value: { kind: "health" } }),
      }),
      { params: Promise.resolve({ id: encodeURIComponent(accountId) }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("serves private portfolio and account intelligence projections", async () => {
    const portfolio = await GETPortfolio(new Request(
      "http://localhost/api/customer-accounts/portfolio?limit=25",
    ));
    const intelligence = await GETIntelligence(
      new Request(
        `http://localhost/api/customer-accounts/${encodeURIComponent(accountId)}/intelligence?historyLimit=40&timelineLimit=30`,
      ),
      { params: Promise.resolve({ id: encodeURIComponent(accountId) }) },
    );

    expect([portfolio.status, intelligence.status]).toEqual([200, 200]);
    expect(portfolio.headers.get("cache-control")).toBe("private, no-store");
    expect(intelligence.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.portfolio).toHaveBeenCalledWith(expect.any(Object), { limit: 25 });
    expect(mocks.intelligence).toHaveBeenCalledWith(expect.any(Object), {
      accountId,
      historyLimit: 40,
      timelineLimit: 30,
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: "customer_success_intelligence",
      resourceId: accountId,
    }));
  });
});
