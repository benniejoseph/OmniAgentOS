import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { AGENT_SKILL_NATIVE_READ_CONTRACT, AgentSkillNativeError, agentSkillNativeIdSchema, agentSkillNativeRequestSchema,
  type AgentSkillNativeRequest } from "@/lib/skills/native-mutation-contracts";
import { readAgentSkillNativeAcceptance, reviewAgentSkillNativeMutation, submitAgentSkillNativeMutation } from "@/lib/skills/native-mutation-store";
import { nativeAgentSkillMutationResponseForScopeSchema, nativeAgentSkillReadResponseForScopeSchema, nativeAgentSkillReviewResponseForScopeSchema } from "@/lib/mobile/agent-skill-mutation-contracts";

export const nativeAgentSkillReviewServiceInputSchema = z.object({ resourceId: agentSkillNativeIdSchema,
  operation: z.enum(["agent.delete", "skill.update", "skill.delete"]) }).strict();
export const nativeAgentSkillReadServiceInputSchema = z.object({ resourceType: z.enum(["custom_agent", "agent_skill"]), keySha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const mutationSchema = z.object({ resourceType: z.enum(["custom_agent", "agent_skill"]), resourceId: agentSkillNativeIdSchema.optional(), request: agentSkillNativeRequestSchema }).strict();
const operationNames = { "agent.delete": "app.agents.native.delete", "skill.create": "app.skills.native.create",
  "skill.update": "app.skills.native.update", "skill.delete": "app.skills.native.delete" } as const;
function authority(caller: AppServiceCaller, mutation = false) {
  const binding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  if (!binding || (!mutation && (caller.executionScope !== undefined || caller.idempotencyKey !== undefined))) {
    throw new AgentSkillNativeError("agent_skill_authority_invalid", 403, "An authenticated exact catalog owner is required.");
  }
  return { scope: { tenantId: caller.context.tenantId, ownerActorId: caller.context.actorId, canonicalActorId: binding.canonicalActorId },
    ...(mutation ? { executionScope: caller.executionScope } : {}) };
}
function expected(caller: AppServiceCaller, value: ReturnType<typeof authority>) {
  return { ...value, requestActorId: caller.context.actorId, role: caller.context.role };
}
export async function reviewNativeAgentSkillService(caller: AppServiceCaller, input: z.input<typeof nativeAgentSkillReviewServiceInputSchema>) {
  const value = nativeAgentSkillReviewServiceInputSchema.parse(input), agent = value.operation === "agent.delete";
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract(agent ? "app.agents.native.delete.review" : "app.skills.native.mutation.review"));
  const current = authority(caller), review = await reviewAgentSkillNativeMutation(current, value);
  const result = completeAppServiceCall(authorized, { contract: AGENT_SKILL_NATIVE_READ_CONTRACT, scope: current.scope, review }, { resourceCount: 1 });
  nativeAgentSkillReviewResponseForScopeSchema({ ...expected(caller, current), ...value }).parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}
export async function readNativeAgentSkillAcceptanceService(caller: AppServiceCaller, input: z.input<typeof nativeAgentSkillReadServiceInputSchema>) {
  const value = nativeAgentSkillReadServiceInputSchema.parse(input), agent = value.resourceType === "custom_agent";
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract(agent ? "app.agents.native.mutations.show" : "app.skills.native.mutations.show"));
  const current = authority(caller), acceptance = await readAgentSkillNativeAcceptance(current, value);
  const result = completeAppServiceCall(authorized, { contract: AGENT_SKILL_NATIVE_READ_CONTRACT, scope: current.scope, acceptance }, { resourceCount: acceptance ? 1 : 0 });
  nativeAgentSkillReadResponseForScopeSchema({ ...expected(caller, current), ...value }).parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}
export async function mutateNativeAgentSkillService(caller: AppServiceCaller, input: z.input<typeof mutationSchema>) {
  const value = mutationSchema.parse(input), request: AgentSkillNativeRequest = value.request;
  const operation = request.contract === "asael-skill-create:1" ? "skill.create" : request.review.operation;
  if ((value.resourceType === "custom_agent") !== (operation === "agent.delete") ||
    (request.contract === "asael-skill-create:1" ? value.resourceId !== undefined : value.resourceId !== request.review.resourceId)) {
    throw new AgentSkillNativeError("agent_skill_target_invalid", 400, "The mutation must bind the exact route resource.");
  }
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract(operationNames[operation]));
  const current = authority(caller, true);
  const committed = await submitAgentSkillNativeMutation({ authority: current, idempotencyKey: caller.idempotencyKey!, request });
  const result = completeAppServiceCall(authorized, { contract: AGENT_SKILL_NATIVE_READ_CONTRACT, scope: current.scope, ...committed }, { resourceCount: 1 });
  nativeAgentSkillMutationResponseForScopeSchema({ ...expected(caller, current), idempotencyKey: caller.idempotencyKey!, request }).parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}
