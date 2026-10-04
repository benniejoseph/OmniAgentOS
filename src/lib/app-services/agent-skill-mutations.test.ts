import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ submit: vi.fn(), read: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/skills/native-mutation-store", () => ({ submitAgentSkillNativeMutation: mocks.submit,
  readAgentSkillNativeAcceptance: mocks.read, reviewAgentSkillNativeMutation: mocks.review }));
import { mutateNativeAgentSkillService, readNativeAgentSkillAcceptanceService } from "@/lib/app-services/agent-skill-mutations";
import { catalogCaller, catalogFixture, catalogRequest, catalogScope } from "@/lib/skills/native-mutation.test-fixtures";
import { MAIN_AGENT_APP_SERVICE_BINDINGS } from "@/lib/app-services/registry";
beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); });
describe("native catalog service authority and acceptance", () => {
  it("uses exact request owner plus canonical binding and returns the compact accepted result", async () => {
    const fixture = catalogFixture(); mocks.submit.mockResolvedValue({ acceptance: fixture.acceptance, replayed: false });
    const result = await mutateNativeAgentSkillService(catalogCaller(), { resourceType: "agent_skill", request: catalogRequest });
    expect(result.data.acceptance).toEqual(fixture.acceptance);
    expect(mocks.submit.mock.calls[0][0].authority).toMatchObject({ scope: catalogScope,
      executionScope: { initiatingActorId: catalogScope.ownerActorId, purpose: "skill.create", causationId: "skills:create" } });
    expect(result.data).not.toHaveProperty("skill");
    expect(JSON.stringify(MAIN_AGENT_APP_SERVICE_BINDINGS)).not.toContain("app.skills.native");
  });
  it("recovers with current read authority without invoking another mutation or review", async () => {
    const fixture = catalogFixture(); mocks.read.mockResolvedValue(fixture.acceptance);
    const current = catalogCaller(false);
    const result = await readNativeAgentSkillAcceptanceService({ ...current, context: { ...current.context, role: "viewer" } }, {
      resourceType: "agent_skill", keySha256: fixture.intent.keySha256,
    });
    expect(result.data.acceptance).toEqual(fixture.acceptance); expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled();
  });
  it("rejects route overrides and unbound authentication before storage", async () => {
    await expect(mutateNativeAgentSkillService(catalogCaller(), { resourceType: "custom_agent", request: catalogRequest })).rejects.toMatchObject({ status: 400 });
    const caller = catalogCaller();
    await expect(mutateNativeAgentSkillService({ ...caller, context: { ...caller.context, source: "headers" } }, {
      resourceType: "agent_skill", request: catalogRequest,
    })).rejects.toMatchObject({ status: 403 });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
