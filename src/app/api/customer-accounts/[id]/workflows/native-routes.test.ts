import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), start: vi.fn(), outcome: vi.fn(), read: vi.fn(), acceptance: vi.fn(), legacyStart: vi.fn(), legacyOutcome: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: <T>(handler: T) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize,
  forbiddenResponse: (error: unknown) => { if (error instanceof Error && error.message === "denied") return Response.json({ error: "Forbidden", message: "denied" }, { status: 403 }); throw error; } }));
vi.mock("@/lib/app-services/customer-success-workflows", async (original) => ({
  ...(await original<typeof import("@/lib/app-services/customer-success-workflows")>()),
  startCustomerSuccessWorkflowNativeService: mocks.start, recordCustomerSuccessWorkflowNativeOutcomeService: mocks.outcome,
  showCustomerSuccessWorkflowNativeService: mocks.read, readCustomerSuccessWorkflowNativeAcceptanceService: mocks.acceptance,
  startCustomerSuccessWorkflowService: mocks.legacyStart, recordCustomerSuccessWorkflowOutcomeService: mocks.legacyOutcome,
}));
import { POST, PATCH } from "@/app/api/customer-accounts/[id]/workflows/route";
import { GET as runGet } from "@/app/api/customer-accounts/[id]/workflows/[runId]/route";
import { GET as receiptGet } from "@/app/api/customer-accounts/[id]/workflows/[runId]/mutations/[keySha256]/route";
import { workflowContext, workflowFixture } from "@/lib/customer-success/workflow-mutation.test-fixtures";
const fixture = workflowFixture();
const route = () => ({ params: Promise.resolve({ id: fixture.accountId }) });
function mutation(method: "POST" | "PATCH", body: unknown, query = "", key: string | null = "workflow-key") {
  return new Request(`http://localhost/api/customer-accounts/${fixture.accountId}/workflows${query}`, { method,
    headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); mocks.authorize.mockResolvedValue(workflowContext);
  mocks.start.mockResolvedValue({ data: { replayed: false }, receipt: {} }); mocks.outcome.mockResolvedValue({ data: { replayed: false }, receipt: {} });
  mocks.read.mockResolvedValue({ data: { run: fixture.run }, receipt: {} }); mocks.acceptance.mockResolvedValue({ data: { acceptance: null }, receipt: {} }); });
describe("native Account workflow routes", () => {
  it("routes all setup to the atomic native service with exact purpose, workspace and Account causation", async () => {
    expect((await POST(mutation("POST", fixture.start), route())).status).toBe(201);
    expect(mocks.start.mock.calls[0][0]).toMatchObject({ executionScope: { purpose: "api.customer-success-workflow.start", workspaceId: fixture.workspaceId, causationId: fixture.accountId } });
    expect(mocks.authorize.mock.calls[0][0]).toMatchObject({ action: "run.agent", nativeMutationCapability: "customers.workflows.start" });
    expect(mocks.legacyStart).not.toHaveBeenCalled();
    mocks.start.mockResolvedValue({ data: { replayed: true }, receipt: {} });
    expect((await POST(mutation("POST", fixture.start), route())).status).toBe(200);
  });
  it("uses exact run causation and separate outcome capability", async () => {
    expect((await PATCH(mutation("PATCH", fixture.outcome), route())).status).toBe(200);
    expect(mocks.outcome.mock.calls[0][0].executionScope.causationId).toBe(fixture.run.runId);
    expect(mocks.authorize.mock.calls[0][0]).toMatchObject({ action: "manage.workflow", nativeMutationCapability: "customers.workflows.outcomes.manage" });
    expect(mocks.legacyOutcome).not.toHaveBeenCalled();
  });
  it("enforces actual UTF8 native body bounds, keys, strict fields and exact queries", async () => {
    const cases = [
      [POST, mutation("POST", fixture.start, "", null), 400],
      [POST, mutation("POST", fixture.start, "?workspaceId=other"), 400],
      [POST, mutation("POST", { ...fixture.start, accountId: fixture.accountId }), 400],
      [POST, mutation("POST", JSON.stringify(fixture.start) + " ".repeat(32_769)), 413],
      [PATCH, mutation("PATCH", JSON.stringify(fixture.outcome) + " ".repeat(131_073)), 413],
      [POST, mutation("POST", { ...fixture.start, contract: "unsupported" }), 400],
    ] as const;
    for (const [handler, request, status] of cases) { const response = await handler(request, route());
      expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store"); }
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.outcome).not.toHaveBeenCalled(); expect(mocks.legacyStart).not.toHaveBeenCalled();
  });
  it("holds mobile callers off the legacy partial setup path", async () => {
    mocks.authorize.mockResolvedValue({ ...workflowContext, source: "mobile" });
    const { contract: _contract, workspaceId: _workspace, expectedDefinitionSha256: _definition, ...legacy } = fixture.start;
    void _contract; void _workspace; void _definition;
    expect((await POST(mutation("POST", legacy), route())).status).toBe(403); expect(mocks.legacyStart).not.toHaveBeenCalled();
  });
  it("uses exact read-only receipt recovery with a nullable acceptance", async () => {
    const response = await receiptGet(new Request(`http://localhost/api/receipt?workspaceId=${encodeURIComponent(fixture.workspaceId)}`), {
      params: Promise.resolve({ id: fixture.accountId, runId: fixture.run.runId, keySha256: fixture.intent.idempotencyKeySha256 }),
    });
    expect(response.status).toBe(200); expect((await response.json()).acceptance).toBeNull();
    expect(mocks.authorize.mock.calls[0][0]).not.toHaveProperty("nativeMutationCapability");
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.outcome).not.toHaveBeenCalled();
  });
  it.each(["", "?workspaceId=x", `?workspaceId=${encodeURIComponent(fixture.workspaceId)}&workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
    `?workspaceId=${encodeURIComponent(fixture.workspaceId)}&extra=x`])("requires exactly one valid workspace on current-run read %s", async (query) => {
    expect((await runGet(new Request(`http://localhost/api/run${query}`), { params: Promise.resolve({ id: fixture.accountId, runId: fixture.run.runId }) })).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
