import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), authorize: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/app-services/memory-reconciliation", () => ({ inspectMemoryReconciliationService: mocks.inspect }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
import { GET } from "@/app/api/memory/reconciliation/[id]/route";
import { MemoryReconciliationNativeError } from "@/lib/memory/reconciliation-native-contracts";
const context = { tenantId: "tenant-review", actorId: "owner@example.test", role: "viewer" as const, source: "session" as const };
beforeEach(() => { mocks.inspect.mockReset(); mocks.authorize.mockReset(); mocks.authorize.mockResolvedValue(context); });
function exact(id = "review-outside-first-200", query = "") { return GET(new Request(`http://localhost/api/memory/reconciliation/${id}${query}`), { params: Promise.resolve({ id }) }); }
describe("native exact Memory reconciliation recovery route", () => {
  it("reads the exact authorized ID and optional acceptance key digest", async () => {
    mocks.inspect.mockResolvedValue({ data: { review: { id: "review-outside-first-200" }, acceptance: null }, receipt: { operation: "memory.reconciliation.read" } });
    const response = await exact(undefined, `?acceptanceKeySha256=${"a".repeat(64)}`);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ resourceId: "review-outside-first-200", action: "read" }));
    expect(mocks.inspect).toHaveBeenCalledWith(expect.objectContaining({ context }), "review-outside-first-200", { acceptanceKeySha256: "a".repeat(64) });
  });
  it.each(["?reviewId=other", "?acceptanceKeySha256=bad", `?acceptanceKeySha256=${"a".repeat(64)}&acceptanceKeySha256=${"b".repeat(64)}`])("rejects a non-exact query %s", async (query) => {
    const response = await exact("review-a", query); expect(response.status).toBe(400); expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.inspect).not.toHaveBeenCalled();
  });
  it("returns a scoped missing review without manufacturing a recovery result", async () => {
    mocks.inspect.mockRejectedValue(new MemoryReconciliationNativeError("memory_reconciliation_not_found", 404, "Review unavailable."));
    const response = await exact(); expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: "memory_reconciliation_not_found" });
  });
  it("keeps inaccessible and unavailable exact reads private", async () => {
    mocks.authorize.mockRejectedValueOnce(new Error("forbidden"));
    const denied = await exact(); expect(denied.status).toBe(403); expect(denied.headers.get("cache-control")).toBe("private, no-store");
    mocks.inspect.mockRejectedValueOnce(new Error("storage down"));
    const unavailable = await exact(); expect(unavailable.status).toBe(503); expect(unavailable.headers.get("cache-control")).toBe("private, no-store");
  });
});
