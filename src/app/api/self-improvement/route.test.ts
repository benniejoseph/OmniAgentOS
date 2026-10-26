import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ authorize: vi.fn(), advance: vi.fn(), configure: vi.fn(), run: vi.fn(), retry: vi.fn(), pause: vi.fn(), review: vi.fn(), show: vi.fn(), repositories: vi.fn(), read: vi.fn(), stop: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mock.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/contracts", () => ({ createAppServiceCaller: (value: unknown) => value, createRequestMutationAppServiceCaller: (_request: Request, context: unknown) => ({ context }) }));
vi.mock("@/lib/app-services/self-improvement", () => ({ advanceSelfImprovementService: mock.advance, configureSelfImprovementService: mock.configure,
  runSelfImprovementService: mock.run, retrySelfImprovementService: mock.retry, pauseSelfImprovementService: mock.pause, reviewSelfImprovementService: mock.review,
  showSelfImprovementService: mock.show, listSelfImprovementRepositoriesService: mock.repositories, readSelfImprovementCycleService: mock.read, stopNativeSelfImprovementService: mock.stop }));
import { GET, POST, maxDuration } from "./route";
const endpoint = "https://asael.example.test/api/self-improvement";
const request = (key = "exact-phase") => new Request(endpoint, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
  body: JSON.stringify({ action: "advance", input: { cycleId: "cycle", expectedRevision: 7 } }) });
beforeEach(() => { for (const fn of Object.values(mock)) fn.mockReset(); mock.authorize.mockResolvedValue({ tenantId: "tenant", source: "session", role: "admin" }); });
describe("authenticated bounded improvement advance HTTP boundary", () => {
  it("routes explicit setup retry separately from run, resume and advance", async () => {
    const input = { configurationId: "config", expectedGeneration: 3, failedCycleId: "failed", expectedRevision: 5 };
    mock.retry.mockResolvedValue({ data: { outcome: "claimed", retryOf: { cycleId: "failed" } }, receipt: { operation: "app.self_improvement.retry" } });
    const response = await POST(new Request(endpoint, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "one-setup-retry" }, body: JSON.stringify({ action: "retry", input }) }));
    expect(response.status).toBe(200); expect(mock.retry).toHaveBeenCalledWith(expect.any(Object), input);
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.pause).not.toHaveBeenCalled(); expect(mock.advance).not.toHaveBeenCalled();
  });
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

describe("native owner improvement API", () => {
  const nativeContext = (version = 62) => ({ tenantId: "tenant", actorId: "owner@example.test", source: "mobile", role: "admin", native: { platform: "macos", clientContractVersion: version } });
  const cycleId = `self_cycle_${"a".repeat(64)}`;
  const mutation = (body: unknown, key = "one-native-operation") => new Request(endpoint, { method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });
  it("reads one exact retained cycle without substituting the recent list", async () => {
    mock.authorize.mockResolvedValue(nativeContext());
    mock.read.mockResolvedValue({ data: { cycle: { id: cycleId } }, receipt: { operation: "app.self_improvement.show" } });
    const response = await GET(new Request(`${endpoint}?cycleId=${cycleId}`));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mock.read).toHaveBeenCalledWith({ context: nativeContext() }, cycleId);
    expect(mock.show).not.toHaveBeenCalled(); expect(mock.repositories).not.toHaveBeenCalled();
  });
  it("returns the same private 404 for a missing or foreign cycle", async () => {
    mock.read.mockResolvedValue({ data: { cycle: null }, receipt: { operation: "app.self_improvement.show" } });
    const response = await GET(new Request(`${endpoint}?cycleId=${cycleId}`));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Improvement cycle was not found." });
    expect(mock.show).not.toHaveBeenCalled();
  });
  it.each(["view=controller", "ownerActorId=foreign", "cycleId=invalid", `view=repositories&cycleId=${cycleId}`, `cycleId=${cycleId}&cycleId=${cycleId}`])("rejects unsupported or ambiguous query %s", async query => {
    expect((await GET(new Request(`${endpoint}?${query}`))).status).toBe(400);
    expect(mock.read).not.toHaveBeenCalled(); expect(mock.show).not.toHaveBeenCalled(); expect(mock.repositories).not.toHaveBeenCalled();
  });
  it("dispatches repository discovery through the same authenticated owner caller", async () => {
    mock.authorize.mockResolvedValue(nativeContext()); mock.repositories.mockResolvedValue({ data: { repositories: [] }, receipt: {} });
    expect((await GET(new Request(`${endpoint}?view=repositories`))).status).toBe(200);
    expect(mock.repositories).toHaveBeenCalledWith({ context: nativeContext() });
  });
  it("keeps previous-client writes held without invoking a service", async () => {
    mock.authorize.mockResolvedValue(nativeContext(61));
    expect((await POST(mutation({ action: "run", input: { configurationId: "config", expectedGeneration: 2 } }))).status).toBe(403);
    expect(mock.run).not.toHaveBeenCalled();
  });
  it("does not expose operator advance to an otherwise valid native administrator", async () => {
    mock.authorize.mockResolvedValue(nativeContext());
    expect((await POST(request())).status).toBe(403); expect(mock.advance).not.toHaveBeenCalled();
  });
  it("requires native owner input bindings and idempotency before service dispatch", async () => {
    mock.authorize.mockResolvedValue(nativeContext());
    const input = { configurationId: "config", expectedGeneration: 2 };
    expect((await POST(mutation({ action: "run", input }, ""))).status).toBe(400);
    expect((await POST(mutation({ action: "run", input: { ...input, ownerActorId: "foreign" } }))).status).toBe(400);
    expect((await POST(mutation({ action: "run", input: { configurationId: "config" } }))).status).toBe(400);
    expect(mock.run).not.toHaveBeenCalled();
    mock.run.mockResolvedValue({ data: { outcome: "claimed", cycle: null, operationJob: null }, receipt: {} });
    expect((await POST(mutation({ action: "run", input }))).status).toBe(200);
    expect(mock.authorize).toHaveBeenLastCalledWith(expect.objectContaining({ nativeMutationCapability: "workspaces.update", action: "manage.workflow" }));
    expect(mock.run).toHaveBeenCalledOnce(); expect(mock.run).toHaveBeenCalledWith({ context: nativeContext() }, input);
  });
  it("routes one exact native held-check stop with no run or controller action", async () => {
    mock.authorize.mockResolvedValue(nativeContext());
    const input = { cycleId, expectedRevision: 9, requestId: `self_native_${"a".repeat(64)}`, requestSha256: "b".repeat(64) };
    mock.stop.mockResolvedValue({ data: { cycle: { id: cycleId, stage: "cancelled", revision: 10 } }, receipt: { operation: "app.self_improvement.stop_native_check" } });
    expect((await POST(mutation({ action: "stop_native_check", input }))).status).toBe(200);
    expect(mock.stop).toHaveBeenCalledOnce(); expect(mock.stop).toHaveBeenCalledWith({ context: nativeContext() }, input);
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.advance).not.toHaveBeenCalled();
    expect((await POST(mutation({ action: "stop_native_check", input: { ...input, leaseToken: "injected" } }))).status).toBe(400);
    expect(mock.stop).toHaveBeenCalledOnce();
  });
  it("rejects mutation query overrides before dispatch", async () => {
    const request = new Request(`${endpoint}?tenantId=other`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "query-override" },
      body: JSON.stringify({ action: "run", input: { configurationId: "config", expectedGeneration: 2 } }) });
    expect((await POST(request)).status).toBe(400); expect(mock.run).not.toHaveBeenCalled();
  });
  it.each(["claim", "prepare", "complete", "heartbeat", "status"])("never routes controller action %s through the native owner API", async action => {
    mock.authorize.mockResolvedValue(nativeContext());
    expect((await POST(mutation({ action, input: { cycleId } }))).status).toBe(400);
    expect(mock.advance).not.toHaveBeenCalled(); expect(mock.run).not.toHaveBeenCalled();
  });
});
