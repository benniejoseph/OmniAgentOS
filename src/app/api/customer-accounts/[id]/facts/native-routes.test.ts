import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), submit: vi.fn(), read: vi.fn(), legacy: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: <T>(handler: T) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/customer-facts", async (original) => ({ ...(await original<typeof import("@/lib/app-services/customer-facts")>()),
  recordCustomerFactNativeService: mocks.submit, readCustomerFactNativeAcceptanceService: mocks.read }));
vi.mock("@/lib/app-services/customer-accounts", async (original) => ({ ...(await original<typeof import("@/lib/app-services/customer-accounts")>()), recordCustomerFactService: mocks.legacy }));
import { POST } from "@/app/api/customer-accounts/[id]/facts/route";
import { GET } from "@/app/api/customer-accounts/[id]/facts/acceptances/[keySha256]/route";
import { factContext, factFixture } from "@/lib/customer-success/fact-mutation.test-fixtures";
const f = factFixture(), route = () => ({ params: Promise.resolve({ id: f.accountId }) });
function post(body: unknown, key: string | null = f.key, query = "") {
  return new Request(`https://example.test/api/customer-accounts/${f.accountId}/facts${query}`, { method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue(factContext); mocks.submit.mockResolvedValue({ data: f.committed, receipt: {} });
  mocks.read.mockResolvedValue({ data: { currentAccount: f.currentAccount, acceptance: null }, receipt: {} }); });
describe("native manual fact routes", () => {
  it("publishes only the strict native branch with exact scope and capability", async () => {
    expect((await POST(post(f.request), route())).status).toBe(201);
    expect(mocks.authorize.mock.calls[0][0]).toMatchObject({ action: "manage.workflow", nativeMutationCapability: "customers.facts.mutate" });
    expect(mocks.submit.mock.calls[0][0].executionScope).toMatchObject({ purpose: "api.customer-account.fact.record", workspaceId: f.workspaceId, causationId: f.accountId });
    expect(mocks.legacy).not.toHaveBeenCalled();
    mocks.submit.mockResolvedValue({ data: { ...f.committed, replayed: true }, receipt: {} });
    expect((await POST(post(f.request), route())).status).toBe(200);
  });
  it("requires a stable key, exact query-free body and actual UTF8 bound before dispatch", async () => {
    for (const [request, status] of [[post(f.request, null), 400], [post(f.request, f.key, "?workspaceId=other"), 400],
      [post({ ...f.request, source: f.fact.source }), 400], [post({ ...f.request, contract: "unsupported" }), 400],
      [post(JSON.stringify(f.request) + " ".repeat(65_537)), 413]] as const) {
      const response = await POST(request, route()); expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("keeps mobile callers out of the legacy provenance lane", async () => {
    mocks.authorize.mockResolvedValue({ ...factContext, source: "mobile" });
    const body = { workspaceId: f.workspaceId, factKey: f.request.factKey, value: f.request.value, owner: f.request.owner,
      confidenceBasisPoints: f.request.confidenceBasisPoints, validFrom: f.request.validFrom, source: f.fact.source };
    expect((await POST(post(body), route())).status).toBe(403); expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("recovers only by exact authenticated GET and retains missing acceptance uncertainty", async () => {
    const params = { params: Promise.resolve({ id: f.accountId, keySha256: f.intent.idempotencyKeySha256 }) };
    const response = await GET(new Request(`https://example.test/api/read?workspaceId=${encodeURIComponent(f.workspaceId)}`), params);
    expect(response.status).toBe(200); expect((await response.json()).acceptance).toBeNull();
    expect(mocks.authorize.mock.calls[0][0]).toMatchObject({ action: "read" }); expect(mocks.submit).not.toHaveBeenCalled();
    for (const query of ["", "?workspaceId=wrong", `?workspaceId=${f.workspaceId}&workspaceId=${f.workspaceId}`]) {
      expect((await GET(new Request(`https://example.test/api/read${query}`), params)).status).toBe(400);
    }
  });
});
