import { describe, expect, it } from "vitest";
import { authorizeAppServiceCall, completeAppServiceCall } from "@/lib/app-services/contracts";
import { nativeAgentSkillMutationResponseForScopeSchema, nativeAgentSkillReadResponseForScopeSchema } from "@/lib/mobile/agent-skill-mutation-contracts";
import { catalogCaller, catalogFixture, catalogRequest, catalogScope, catalogContext } from "@/lib/skills/native-mutation.test-fixtures";
describe("native catalog wire owner and receipt binding", () => {
  it("binds the compact mutation receipt to its original request and current caller", () => {
    const fixture = catalogFixture(), caller = catalogCaller();
    const data = { contract: "asael-agent-skill-read:1" as const, scope: catalogScope, acceptance: fixture.acceptance, replayed: false };
    const result = completeAppServiceCall(authorizeAppServiceCall(caller, { operation: "app.skills.native.create", action: "manage.workflow", resourceType: "agent_skill",
      accessMode: "mutation", eventContract: "agent-skill-native-events.v1" }), data, { resourceCount: 1 });
    const expected = { scope: catalogScope, requestActorId: catalogContext.actorId, role: catalogContext.role,
      executionScope: caller.executionScope, idempotencyKey: fixture.key, request: catalogRequest };
    expect(nativeAgentSkillMutationResponseForScopeSchema(expected).safeParse({ ...data, serviceReceipt: result.receipt }).success).toBe(true);
    expect(nativeAgentSkillMutationResponseForScopeSchema({ ...expected, role: "viewer" }).safeParse({ ...data, serviceReceipt: result.receipt }).success).toBe(false);
    expect(nativeAgentSkillMutationResponseForScopeSchema({ ...expected, idempotencyKey: "another-key" }).safeParse({ ...data, serviceReceipt: result.receipt }).success).toBe(false);
  });
  it("allows exact nullable read evidence and rejects another type/key", () => {
    const fixture = catalogFixture(), data = { contract: "asael-agent-skill-read:1" as const, scope: catalogScope, acceptance: fixture.acceptance };
    const result = completeAppServiceCall(authorizeAppServiceCall(catalogCaller(false), { operation: "app.skills.native.mutations.show", action: "read", resourceType: "agent_skill",
      accessMode: "read", eventContract: "read_only:no_domain_mutation" }), data, { resourceCount: 1 });
    const expected = { scope: catalogScope, requestActorId: catalogContext.actorId, role: catalogContext.role, resourceType: "agent_skill" as const, keySha256: fixture.intent.keySha256 };
    expect(nativeAgentSkillReadResponseForScopeSchema(expected).safeParse({ ...data, serviceReceipt: result.receipt }).success).toBe(true);
    expect(nativeAgentSkillReadResponseForScopeSchema({ ...expected, keySha256: "f".repeat(64) }).safeParse({ ...data, serviceReceipt: result.receipt }).success).toBe(false);
  });
});
