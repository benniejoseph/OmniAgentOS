import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  show: vi.fn(),
  evaluate: vi.fn(),
  nativeEvaluate: vi.fn(),
  forbidden: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: mocks.forbidden,
}));
vi.mock("@/lib/app-services/customer-health", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/customer-health")>()),
  showCustomerHealthService: mocks.show,
  evaluateCustomerHealthService: mocks.evaluate,
  evaluateCustomerHealthNativeService: mocks.nativeEvaluate,
}));

import {
  GET,
  POST,
} from "@/app/api/customer-accounts/[id]/health/route";
import { CustomerHealthEvaluationRefusedError } from "@/lib/customer-success/health-mutation-contracts";
import { CustomerAccountConflictError } from "@/lib/customer-success/store";
import { nativeCustomerHealthEvaluationErrorSchema } from "@/lib/mobile/customer-health-mutation-contracts";

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
const evaluationId = `customer-health-evaluation:${"e".repeat(64)}`, workspaceId = "workspace:health";
const nativeBody = { contract: "customer-health-evaluation-request:1", workspaceId,
  expectedAccountRevision: 4, expectedAccountSha256: "c".repeat(64), modelSuggestions: [] };
function nativePost(body: unknown = nativeBody, query = "", key: string | null = "health-native-key") {
  return POST(new Request(`http://localhost/api/customer-accounts/${accountId}/health${query}`, {
    method: "POST", headers: { "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), { params: Promise.resolve({ id: encodeURIComponent(accountId) }) });
}

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue(context);
  mocks.forbidden.mockReset().mockImplementation(() => Response.json({ error: "Forbidden" }, { status: 403 }));
  mocks.show.mockReset().mockResolvedValue({
    data: { context: {}, policy: {}, score: null, history: [] },
    receipt: { operation: "app.customer_accounts.health.show" },
  });
  mocks.evaluate.mockReset().mockResolvedValue({
    data: { context: {}, score: { scoreSha256: "b".repeat(64) } },
    receipt: { operation: "app.customer_accounts.health.evaluate" },
  });
  mocks.nativeEvaluate.mockReset().mockResolvedValue({
    data: { contract: "customer-health-evaluation-read:1", currentAccount: {}, acceptance: { evaluationId }, replayed: false },
    receipt: { operation: "app.customer_accounts.health.evaluate" },
  });
});

describe("versioned native health evaluation route", () => {
  it("uses the dedicated capability, selected workspace and exact account causation", async () => {
    const response = await nativePost();
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({ nativeMutationCapability: "customers.health.evaluate",
      action: "manage.workflow", resourceType: "customer_health_score", resourceId: accountId, riskLevel: 1 }));
    expect(mocks.nativeEvaluate).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "health-native-key",
      executionScope: expect.objectContaining({ purpose: "api.customer-health.evaluate", workspaceId, causationId: accountId }) }), { ...nativeBody, accountId });
    expect(mocks.evaluate).not.toHaveBeenCalled();
    mocks.nativeEvaluate.mockResolvedValueOnce({ data: { replayed: true }, receipt: {} });
    expect((await nativePost()).status).toBe(200);
  });
  it("rejects missing keys, query drift, nonempty suggestions and body account substitution before service admission", async () => {
    const responses = [await nativePost(nativeBody, "", null), await nativePost(nativeBody, "?workspaceId=workspace:other"),
      await nativePost({ ...nativeBody, modelSuggestions: [{}] }), await nativePost({ ...nativeBody, accountId }),
      await nativePost({ ...nativeBody, workspaceId: undefined }), await nativePost({ ...nativeBody, expectedAccountRevision: 2_147_483_648 }),
      await nativePost({ ...nativeBody, contract: "unknown:1" })];
    for (const response of responses) {
      expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(nativeCustomerHealthEvaluationErrorSchema.safeParse(await response.json()).success).toBe(true);
    }
    expect(mocks.nativeEvaluate).not.toHaveBeenCalled(); expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("counts whitespace in the UTF-8 body limit while preserving the larger legacy form", async () => {
    expect((await nativePost(`${JSON.stringify(nativeBody)}${" ".repeat(4_096)}`)).status).toBe(413);
    expect(mocks.nativeEvaluate).not.toHaveBeenCalled();
    const legacy = { expectedAccountRevision: 4, expectedAccountSha256: "c".repeat(64) };
    expect((await nativePost(`${JSON.stringify(legacy)}${" ".repeat(4_096)}`)).status).toBe(201);
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
  });
  it("never permits a mobile caller to fall through to legacy admission", async () => {
    mocks.authorizeRequest.mockResolvedValue({ ...context, source: "mobile" });
    const response = await nativePost({ expectedAccountRevision: 4, expectedAccountSha256: "c".repeat(64) });
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.evaluate).not.toHaveBeenCalled(); expect(mocks.nativeEvaluate).not.toHaveBeenCalled();
  });
  it("returns only the typed exact refusal as no-admission evidence", async () => {
    mocks.nativeEvaluate.mockRejectedValue(new CustomerHealthEvaluationRefusedError({ code: "customer_health_account_changed",
      message: "Account changed.", evaluationId, requestSha256: "f".repeat(64) }));
    const refused = await nativePost(), proof = await refused.json();
    expect(refused.status).toBe(409); expect(proof).toMatchObject({ contract: "customer-health-evaluation-refusal:1",
      admission: "not_admitted", evaluationId, requestSha256: "f".repeat(64) });
    expect(nativeCustomerHealthEvaluationErrorSchema.safeParse(proof).success).toBe(true);
    mocks.nativeEvaluate.mockRejectedValue(new CustomerAccountConflictError("Legacy intent cannot become a native acceptance."));
    const collision = await nativePost();
    expect(collision.status).toBe(409); expect(await collision.json()).not.toHaveProperty("admission");
    mocks.authorizeRequest.mockRejectedValue(new Error("Denied"));
    const denied = await nativePost();
    expect(denied.status).toBe(403); expect(denied.headers.get("cache-control")).toBe("private, no-store");
    expect(await denied.json()).not.toHaveProperty("admission");
  });
  it("keeps unknown authentication failures private and unproven", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("Session storage unavailable"));
    mocks.forbidden.mockImplementation(() => { throw new Error("Not a policy refusal"); });
    const response = await nativePost();
    expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).not.toHaveProperty("admission"); expect(mocks.nativeEvaluate).not.toHaveBeenCalled();
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
        headers: { "content-type": "application/json", "idempotency-key": "health-unbound" },
        body: JSON.stringify({ expectedAccountRevision: 3 }),
      }),
      { params: Promise.resolve({ id: encodeURIComponent(accountId) }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});
