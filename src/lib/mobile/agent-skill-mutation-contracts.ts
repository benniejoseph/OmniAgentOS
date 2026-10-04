import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { AGENT_SKILL_NATIVE_READ_CONTRACT, agentSkillNativeAcceptanceSchema, agentSkillNativeCreateRequestSchema,
  agentSkillNativeDeleteRequestSchema, agentSkillNativeReviewSchema, agentSkillNativeScopeSchema, agentSkillNativeUpdateRequestSchema,
  buildAgentSkillNativeIntent, type AgentSkillNativeIntent, type AgentSkillNativeScope } from "@/lib/skills/native-mutation-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const base = { contract: z.literal(AGENT_SKILL_NATIVE_READ_CONTRACT), scope: agentSkillNativeScopeSchema };
const operations = {
  "agent.delete": "app.agents.native.delete", "skill.create": "app.skills.native.create",
  "skill.update": "app.skills.native.update", "skill.delete": "app.skills.native.delete",
} as const;
function issue(context: z.RefinementCtx, message: string) { context.addIssue({ code: "custom", message }); }
function receipt(value: { scope: AgentSkillNativeScope; serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx,
  expected: { operation: string; action: "read" | "manage.workflow"; resourceType: "custom_agent" | "agent_skill"; mutation: boolean; count: number }) {
  const { serviceReceipt: proof, ...body } = value;
  if (proof.operation !== expected.operation || proof.action !== expected.action || proof.resourceType !== expected.resourceType ||
    proof.accessMode !== (expected.mutation ? "mutation" : "read") || proof.resourceCount !== expected.count ||
    proof.eventContract !== (expected.mutation ? "agent-skill-native-events.v1" : "read_only:no_domain_mutation") ||
    (proof.idempotencyKeySha256 !== null) !== expected.mutation || proof.outcomeSha256 !== canonicalJsonSha256(body)) issue(context, "Service receipt does not bind this exact native result.");
}
function scopeMatches(a: AgentSkillNativeScope, b: AgentSkillNativeScope) { return canonicalJsonSha256(a) === canonicalJsonSha256(b); }
export const nativeAgentSkillReviewResponseSchema = z.object({ ...base, review: agentSkillNativeReviewSchema, serviceReceipt: appServiceReceiptSchema }).strict()
  .superRefine((value, context) => {
    const agent = value.review.pin.resourceType === "custom_agent", resource = agent ? value.review.agent : value.review.skill;
    receipt(value, context, { operation: agent ? "app.agents.native.delete.review" : "app.skills.native.mutation.review",
      action: "manage.workflow", resourceType: value.review.pin.resourceType, mutation: false, count: 1 });
    if (resource?.tenantId !== value.scope.tenantId || resource.actorId !== value.scope.ownerActorId) issue(context, "Reviewed resource belongs to another exact owner.");
  });
export const nativeAgentSkillMutationResponseSchema = z.object({ ...base, acceptance: agentSkillNativeAcceptanceSchema, replayed: z.boolean(), serviceReceipt: appServiceReceiptSchema }).strict()
  .superRefine((value, context) => {
    receipt(value, context, { operation: operations[value.acceptance.operation], action: "manage.workflow", resourceType: value.acceptance.resourceType, mutation: true, count: 1 });
    if (!scopeMatches(value.scope, value.acceptance.scope) || value.serviceReceipt.idempotencyKeySha256 !== value.acceptance.keySha256) issue(context, "Mutation receipt does not bind its accepted owner or key.");
  });
export const nativeAgentSkillReadResponseSchema = z.object({ ...base, acceptance: agentSkillNativeAcceptanceSchema.nullable(), serviceReceipt: appServiceReceiptSchema }).strict()
  .superRefine((value, context) => {
    const agent = value.serviceReceipt.operation === "app.agents.native.mutations.show";
    receipt(value, context, { operation: agent ? "app.agents.native.mutations.show" : "app.skills.native.mutations.show", action: "read",
      resourceType: agent ? "custom_agent" : "agent_skill", mutation: false, count: value.acceptance ? 1 : 0 });
    if (value.acceptance && (!scopeMatches(value.scope, value.acceptance.scope) || value.acceptance.resourceType !== (agent ? "custom_agent" : "agent_skill"))) issue(context, "Recovery receipt belongs to another owner or resource type.");
  });
export type NativeAgentSkillResponseAuthority = { scope: AgentSkillNativeScope; requestActorId: string; role: string; executionScope?: ExecutionScope };
function authority(value: { scope: AgentSkillNativeScope; serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, expected: NativeAgentSkillResponseAuthority, context: z.RefinementCtx) {
  if (!scopeMatches(value.scope, expected.scope) || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    tenantId: expected.scope.tenantId, actorId: expected.requestActorId, role: expected.role, executionScope: expected.executionScope ?? null })) issue(context, "Native result belongs to another authenticated caller.");
}
export function nativeAgentSkillReviewResponseForScopeSchema(expected: NativeAgentSkillResponseAuthority & { resourceId: string; operation: string }) {
  return nativeAgentSkillReviewResponseSchema.superRefine((value, context) => { authority(value, expected, context);
    if (value.review.pin.resourceId !== expected.resourceId || value.review.pin.operation !== expected.operation) issue(context, "Response describes another review."); });
}
export function validateNativeAgentSkillAcceptanceIntent(acceptance: z.infer<typeof agentSkillNativeAcceptanceSchema>, intent: AgentSkillNativeIntent) {
  const request = intent.request, create = request.contract === "asael-skill-create:1";
  return scopeMatches(acceptance.scope, intent.scope) && acceptance.operation === intent.operation && acceptance.keySha256 === intent.keySha256 &&
    acceptance.requestSha256 === canonicalJsonSha256(intent) && (create || (acceptance.resourceId === request.review.resourceId &&
      acceptance.reviewSha256 === canonicalJsonSha256(request.review) && acceptance.beforeResourceSha256 === request.review.resourceSha256 &&
      acceptance.beforeVersion === request.review.resourceVersion && (request.contract !== "asael-agent-skill-delete:1" || acceptance.trash?.previewSha256 === request.preview.previewSha256)));
}
export function nativeAgentSkillMutationResponseForScopeSchema(expected: NativeAgentSkillResponseAuthority & { idempotencyKey: string; request: AgentSkillNativeIntent["request"] }) {
  const intent = buildAgentSkillNativeIntent(expected);
  return nativeAgentSkillMutationResponseSchema.superRefine((value, context) => { authority(value, expected, context);
    if (!validateNativeAgentSkillAcceptanceIntent(value.acceptance, intent)) issue(context, "Acceptance differs from the frozen request."); });
}
export function nativeAgentSkillReadResponseForScopeSchema(expected: NativeAgentSkillResponseAuthority & { keySha256: string; resourceType: "custom_agent" | "agent_skill" }) {
  return nativeAgentSkillReadResponseSchema.superRefine((value, context) => { authority(value, expected, context);
    if (value.serviceReceipt.resourceType !== expected.resourceType || (value.acceptance && value.acceptance.keySha256 !== expected.keySha256)) issue(context, "Recovery returned another exact key or resource type."); });
}
export const nativeAgentSkillMutationSchemas = Object.freeze({
  NativeAgentSkillCreateRequest: agentSkillNativeCreateRequestSchema, NativeAgentSkillUpdateRequest: agentSkillNativeUpdateRequestSchema,
  NativeAgentSkillDeleteRequest: agentSkillNativeDeleteRequestSchema,
  NativeAgentSkillReviewQuery: z.object({ operation: z.enum(["update", "delete"]) }).strict(),
  NativeAgentSkillReviewResponse: nativeAgentSkillReviewResponseSchema, NativeAgentSkillMutationResponse: nativeAgentSkillMutationResponseSchema,
  NativeAgentSkillReadResponse: nativeAgentSkillReadResponseSchema,
  NativeAgentSkillError: z.object({ error: z.string().min(1).max(4_000), code: z.string().min(1).max(200).optional(), message: z.string().max(4_000).optional() }).strict(),
});
