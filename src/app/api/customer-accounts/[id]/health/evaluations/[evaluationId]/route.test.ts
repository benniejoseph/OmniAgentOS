import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn(), forbidden: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: mocks.forbidden }));
vi.mock("@/lib/app-services/customer-health", async (original) => ({
  ...(await original<typeof import("@/lib/app-services/customer-health")>()), readCustomerHealthEvaluationService: mocks.read,
}));
import { GET } from "@/app/api/customer-accounts/[id]/health/evaluations/[evaluationId]/route";
import { CustomerAccountNotFoundError } from "@/lib/customer-success/store";

const accountId = `customer-account:${"a".repeat(64)}`, evaluationId = `customer-health-evaluation:${"e".repeat(64)}`;
const context = { tenantId: "tenant-health", actorId: "owner@example.test", role: "viewer" as const, source: "session" as const };
function read(query = "?workspaceId=workspace:health", id = accountId, evaluation = evaluationId) {
  return GET(new Request(`http://localhost/api/customer-accounts/${id}/health/evaluations/${evaluation}${query}`), {
    params: Promise.resolve({ id: encodeURIComponent(id), evaluationId: encodeURIComponent(evaluation) }),
  });
}
beforeEach(() => {
  mocks.authorize.mockReset().mockResolvedValue(context);
  mocks.forbidden.mockReset().mockImplementation(() => Response.json({ error: "Forbidden" }, { status: 403 }));
  mocks.read.mockReset().mockResolvedValue({ data: { contract: "customer-health-evaluation-read:1", currentAccount: {}, acceptance: null }, receipt: {} });
});
describe("exact native health evaluation receipt route", () => {
  it("performs only the exact authenticated read and permits nullable acceptance", async () => {
    const response = await read();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ acceptance: null });
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ context }), { accountId, evaluationId, workspaceId: "workspace:health" });
    expect(mocks.authorize).toHaveBeenCalledWith({ request: expect.any(Request), action: "read", resourceType: "customer_health_score", resourceId: accountId });
    expect(mocks.authorize.mock.calls[0][0]).not.toHaveProperty("nativeMutationCapability");
  });
  it.each(["", "?workspaceId=", "?workspaceId=workspace:health&workspaceId=workspace:health", "?workspaceId=workspace:health&other=x", "?limit=1"])("rejects nonexact query %s before lookup", async (query) => {
    const response = await read(query);
    expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it("rejects malformed account and evaluation identities", async () => {
    expect((await read("?workspaceId=workspace:health", "another-account")).status).toBe(400);
    expect((await read("?workspaceId=workspace:health", accountId, "latest")).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("returns private ordinary denial without a false non-admission receipt", async () => {
    mocks.read.mockRejectedValueOnce(new CustomerAccountNotFoundError());
    const missing = await read(); expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("private, no-store"); expect(await missing.json()).not.toHaveProperty("admission");
    mocks.authorize.mockRejectedValue(new Error("Owner denied"));
    const denied = await read(); expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("private, no-store"); expect(mocks.read).toHaveBeenCalledTimes(1);
  });
});
