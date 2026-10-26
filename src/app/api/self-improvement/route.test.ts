import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ authorize: vi.fn(), advance: vi.fn(), configure: vi.fn(), run: vi.fn(), pause: vi.fn(), review: vi.fn(), show: vi.fn(), repositories: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mock.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/contracts", () => ({ createAppServiceCaller: (value: unknown) => value, createRequestMutationAppServiceCaller: (_request: Request, context: unknown) => ({ context }) }));
vi.mock("@/lib/app-services/self-improvement", () => ({ advanceSelfImprovementService: mock.advance, configureSelfImprovementService: mock.configure,
  runSelfImprovementService: mock.run, pauseSelfImprovementService: mock.pause, reviewSelfImprovementService: mock.review,
  showSelfImprovementService: mock.show, listSelfImprovementRepositoriesService: mock.repositories }));
import { POST, maxDuration } from "./route";
const endpoint = "https://asael.example.test/api/self-improvement";
const request = (key = "exact-phase") => new Request(endpoint, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
  body: JSON.stringify({ action: "advance", input: { cycleId: "cycle", expectedRevision: 7 } }) });
beforeEach(() => { for (const fn of Object.values(mock)) fn.mockReset(); mock.authorize.mockResolvedValue({ tenantId: "tenant", source: "session", role: "admin" }); });
describe("authenticated bounded improvement advance HTTP boundary", () => {
  it("routes one exact phase with the HTTP cancellation signal and no scheduler admission", async () => {
    mock.advance.mockResolvedValue({ data: { cycle: { id: "cycle", revision: 9 } }, receipt: { operation: "advance" } });
    const incoming = request(), response = await POST(incoming);
    expect(maxDuration).toBe(300); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mock.advance).toHaveBeenCalledWith(expect.any(Object), { cycleId: "cycle", expectedRevision: 7 }, { abortSignal: incoming.signal });
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.configure).not.toHaveBeenCalled();
  });
  it("requires a retry identity and authenticated authorization before execution", async () => {
    expect((await POST(request(""))).status).toBe(400);
    mock.authorize.mockRejectedValue(new Error("No owner session"));
    expect((await POST(request())).status).toBe(403); expect(mock.advance).not.toHaveBeenCalled();
  });
  it("returns an exact-revision conflict without an automatic retry", async () => {
    mock.advance.mockRejectedValue(new Error("The improvement phase revision changed."));
    const response = await POST(request());
    expect(response.status).toBe(409); expect(mock.advance).toHaveBeenCalledOnce(); expect(mock.run).not.toHaveBeenCalled();
  });
});
