import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), mutate: vi.fn(), review: vi.fn(), read: vi.fn(), legacyCreate: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: <T>(handler: T) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/agents", () => ({ createSkillService: mocks.legacyCreate, listSkillsService: vi.fn() }));
vi.mock("@/lib/app-services/agent-skill-mutations", async (original) => ({
  ...(await original<typeof import("@/lib/app-services/agent-skill-mutations")>()),
  mutateNativeAgentSkillService: mocks.mutate, reviewNativeAgentSkillService: mocks.review, readNativeAgentSkillAcceptanceService: mocks.read,
}));
import { POST } from "@/app/api/skills/route";
import { GET as receiptGet } from "@/app/api/skills/mutations/[keySha256]/route";
import { GET as reviewGet } from "@/app/api/skills/[id]/mutation-review/route";
import { catalogContext, catalogFixture, catalogRequest } from "@/lib/skills/native-mutation.test-fixtures";
const fixture = catalogFixture();
function post(body: unknown = catalogRequest, query = "", key: string | null = fixture.key) {
  return new Request(`http://localhost/api/skills${query}`, { method: "POST", headers: {
    "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}),
  }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); mocks.authorize.mockResolvedValue(catalogContext);
  mocks.mutate.mockResolvedValue({ data: { acceptance: fixture.acceptance, replayed: false }, receipt: {} });
  mocks.read.mockResolvedValue({ data: { acceptance: null }, receipt: {} }); mocks.review.mockResolvedValue({ data: {}, receipt: {} }); });
describe("strict native catalog ingress and exact recovery", () => {
  it("uses the native capability, exact purpose and first/replay status", async () => {
    expect((await POST(post())).status).toBe(201);
    expect(mocks.authorize.mock.calls[0][0]).toMatchObject({ action: "manage.workflow", nativeMutationCapability: "skills.create" });
    expect(mocks.mutate.mock.calls[0][0]).toMatchObject({ idempotencyKey: fixture.key,
      executionScope: { purpose: "skill.create", causationId: "skills:create", workspaceId: null } });
    mocks.mutate.mockResolvedValue({ data: { acceptance: fixture.acceptance, replayed: true }, receipt: {} });
    expect((await POST(post())).status).toBe(200); expect(mocks.legacyCreate).not.toHaveBeenCalled();
  });
  it("rejects missing keys, actual byte overflow, unknown contracts, omitted defaults and query overrides", async () => {
    for (const [request, status] of [[post(catalogRequest, "", null), 400], [post(catalogRequest, "?owner=other"), 400],
      [post({ ...catalogRequest, contract: "unsupported" }), 400], [post({ ...catalogRequest, skill: { ...catalogRequest.skill, tags: undefined } }), 400],
      [post(JSON.stringify(catalogRequest) + " ".repeat(65_537)), 413]] as const) {
      const response = await POST(request); expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.legacyCreate).not.toHaveBeenCalled();
  });
  it("keeps mobile requests off the legacy unreceipted path", async () => {
    mocks.authorize.mockResolvedValue({ ...catalogContext, source: "mobile" });
    expect((await POST(post(catalogRequest.skill))).status).toBe(403); expect(mocks.legacyCreate).not.toHaveBeenCalled();
  });
  it("keeps every denied or uncertain response private and without no-admission proof", async () => {
    mocks.authorize.mockRejectedValueOnce(new Error("denied"));
    const denied = await POST(post()); expect(denied.status).toBe(403); expect(denied.headers.get("cache-control")).toBe("private, no-store");
    mocks.mutate.mockRejectedValueOnce(new Error("connection lost after commit"));
    const unknown = await POST(post()); expect(unknown.status).toBe(503); expect(await unknown.json()).not.toHaveProperty("admission");
  });
  it("recovers by exact key without mutation or current resource lookup", async () => {
    const response = await receiptGet(new Request("http://localhost/api/receipt"), { params: Promise.resolve({ keySha256: fixture.intent.keySha256 }) });
    expect(response.status).toBe(200); expect((await response.json()).acceptance).toBeNull();
    expect(mocks.read.mock.calls[0][0]).not.toHaveProperty("executionScope");
    expect(mocks.read.mock.calls[0][1]).toEqual({ resourceType: "agent_skill", keySha256: fixture.intent.keySha256 });
    expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled();
    expect((await receiptGet(new Request("http://localhost/api/receipt?operation=create"), {
      params: Promise.resolve({ keySha256: fixture.intent.keySha256 }),
    })).status).toBe(400);
  });
  it("requires exactly one explicit Skill review operation", async () => {
    for (const query of ["", "?operation=update&operation=delete", "?operation=create", "?operation=update&owner=x"]) {
      expect((await reviewGet(new Request(`http://localhost/api/review${query}`), { params: Promise.resolve({ id: fixture.skill.id }) })).status).toBe(400);
    }
    expect(mocks.review).not.toHaveBeenCalled();
    expect((await reviewGet(new Request("http://localhost/api/review?operation=update"), { params: Promise.resolve({ id: fixture.skill.id }) })).status).toBe(200);
    expect(mocks.review.mock.calls[0][1]).toEqual({ resourceId: fixture.skill.id, operation: "skill.update" });
  });
});
