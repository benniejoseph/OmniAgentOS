import { z } from "zod";
import { customAgentInputSchema, skillInputSchema, skillPatchSchema } from "@/lib/skills/schema";
import { trashActionPreviewV1Schema } from "@/lib/trash/contracts";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

export const AGENT_SKILL_NATIVE_READ_CONTRACT = "asael-agent-skill-read:1" as const;
export const agentSkillNativeIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const textId = z.string().min(1).max(240).refine((value) => value === value.trim());
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(1).max(2_147_483_647);
const at = z.string().datetime({ offset: true }).refine((value) => new Date(value).toISOString() === value);
export const agentSkillNativeScopeSchema = z.object({ tenantId: textId, ownerActorId: textId,
  canonicalActorId: z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/) }).strict();
export const agentSkillNativeOperationSchema = z.enum(["agent.delete", "skill.create", "skill.update", "skill.delete"]);
export const agentSkillNativeResourceTypeSchema = z.enum(["custom_agent", "agent_skill"]);

function normalizedSkill(value: Record<string, unknown>, context: z.RefinementCtx) {
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && item !== item.trim()) context.addIssue({ code: "custom", path: [key], message: "Skill text must be normalized before review." });
    if (Array.isArray(item) && (new Set(item).size !== item.length || item.some((entry) => typeof entry !== "string" || entry !== entry.trim() || !entry))) {
      context.addIssue({ code: "custom", path: [key], message: "Skill lists must contain unique normalized values." });
    }
  }
  if (Array.isArray(value.toolIds) && value.toolIds.length > 40) context.addIssue({ code: "custom", path: ["toolIds"], message: "At most forty tools can be saved." });
}
// The native journal seals the complete submitted value. Legacy defaults must
// not silently fill absent fields in requests or returned review snapshots.
const completeSkillSchema = skillInputSchema.extend({ status: skillInputSchema.shape.status.unwrap(),
  toolIds: skillInputSchema.shape.toolIds.unwrap(), tags: skillInputSchema.shape.tags.unwrap(),
  knowledgeTags: skillInputSchema.shape.knowledgeTags.unwrap() }).strict();
const completeAgentSchema = customAgentInputSchema.extend({ persona: customAgentInputSchema.shape.persona.unwrap(),
  status: customAgentInputSchema.shape.status.unwrap(), accent: customAgentInputSchema.shape.accent.unwrap(),
  modelPolicy: customAgentInputSchema.shape.modelPolicy.unwrap(), autonomy: customAgentInputSchema.shape.autonomy.unwrap(),
  approvalPolicy: customAgentInputSchema.shape.approvalPolicy.unwrap(), memoryScope: customAgentInputSchema.shape.memoryScope.unwrap(),
  skillIds: customAgentInputSchema.shape.skillIds.unwrap(), toolIds: customAgentInputSchema.shape.toolIds.unwrap() }).strict();
export const nativeSkillInputSchema = completeSkillSchema.superRefine(normalizedSkill);
export const nativeSkillPatchSchema = skillPatchSchema.superRefine(normalizedSkill);
export const nativeSkillRecordSchema = completeSkillSchema.extend({ id: agentSkillNativeIdSchema,
  tenantId: textId, actorId: textId, slug: z.string().min(1).max(80), version,
  createdAt: at, updatedAt: at }).strict();
export const nativeAgentRecordSchema = completeAgentSchema.extend({ id: agentSkillNativeIdSchema,
  tenantId: textId, actorId: textId, slug: z.string().min(1).max(80), createdAt: at, updatedAt: at }).strict();
export const agentSkillNativeReviewPinSchema = z.object({
  operation: z.enum(["agent.delete", "skill.update", "skill.delete"]), resourceType: agentSkillNativeResourceTypeSchema,
  resourceId: agentSkillNativeIdSchema, resourceVersion: version.nullable(), resourceSha256: sha, impactSha256: sha,
}).strict().superRefine((value, context) => {
  if ((value.operation === "agent.delete") !== (value.resourceType === "custom_agent") ||
    (value.resourceType === "custom_agent") !== (value.resourceVersion === null)) context.addIssue({ code: "custom", message: "Reviewed resource identity is inconsistent." });
});
export const agentSkillNativeReviewSchema = z.object({ pin: agentSkillNativeReviewPinSchema,
  agent: nativeAgentRecordSchema.nullable(), skill: nativeSkillRecordSchema.nullable(),
  affectedAgents: z.array(z.object({ id: agentSkillNativeIdSchema, name: z.string().min(1).max(120) }).strict()).max(100),
  agentLifecycle: z.object({ releaseState: z.enum(["active", "retired"]), releaseRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    activeDefinitionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), latestDefinitionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    principalGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), principalState: z.enum(["held", "active", "revoked"]) }).strict().nullable(),
  preview: trashActionPreviewV1Schema.nullable(),
}).strict().superRefine((value, context) => {
  const agent = value.pin.resourceType === "custom_agent", resource = agent ? value.agent : value.skill;
  if (!resource || (agent ? value.skill !== null || value.agentLifecycle === null : value.agent !== null || value.agentLifecycle !== null) ||
    resource.id !== value.pin.resourceId || canonicalJsonSha256(resource) !== value.pin.resourceSha256 ||
    (!agent && value.skill?.version !== value.pin.resourceVersion) ||
    new Set(value.affectedAgents.map((item) => item.id)).size !== value.affectedAgents.length ||
    (value.pin.operation === "skill.update" ? value.preview !== null : !value.preview || value.preview.action !== "trash" ||
      value.preview.resourceId !== value.pin.resourceId || value.preview.resourceType !== value.pin.resourceType ||
      value.preview.targetSha256 !== canonicalJsonSha256(value.pin))) context.addIssue({ code: "custom", message: "Current review does not match its resource or deletion consequences." });
});
export const agentSkillNativeCreateRequestSchema = z.object({ contract: z.literal("asael-skill-create:1"), skill: nativeSkillInputSchema }).strict();
export const agentSkillNativeUpdateRequestSchema = z.object({ contract: z.literal("asael-skill-update:1"), review: agentSkillNativeReviewPinSchema,
  change: nativeSkillPatchSchema }).strict().refine((value) => value.review.operation === "skill.update", "An exact Skill update review is required.");
export const agentSkillNativeDeleteRequestSchema = z.object({ contract: z.literal("asael-agent-skill-delete:1"), review: agentSkillNativeReviewPinSchema,
  preview: trashActionPreviewV1Schema }).strict().superRefine((value, context) => {
  if (value.review.operation === "skill.update" || value.preview.action !== "trash" || value.preview.trashId !== null ||
    value.preview.lifecycleRevision !== 0 || value.preview.resourceType !== value.review.resourceType || value.preview.resourceId !== value.review.resourceId ||
    value.preview.targetSha256 !== canonicalJsonSha256(value.review)) context.addIssue({ code: "custom", message: "Deletion preview must bind the exact reviewed resource and impact." });
});
export const agentSkillNativeRequestSchema = z.union([agentSkillNativeCreateRequestSchema, agentSkillNativeUpdateRequestSchema, agentSkillNativeDeleteRequestSchema]);
export const agentSkillNativeIntentSchema = z.object({ contract: z.literal("asael-agent-skill-intent:1"), scope: agentSkillNativeScopeSchema,
  operation: agentSkillNativeOperationSchema, resourceId: agentSkillNativeIdSchema.nullable(), keySha256: sha,
  request: agentSkillNativeRequestSchema }).strict().superRefine((value, context) => {
  const request = value.request;
  const operation = request.contract === "asael-skill-create:1" ? "skill.create" : request.review.operation;
  if (value.operation !== operation || value.resourceId !== (request.contract === "asael-skill-create:1" ? null : request.review.resourceId)) {
    context.addIssue({ code: "custom", message: "Native intent must bind the exact operation and resource." });
  }
});
const acceptanceBody = z.object({ contract: z.literal("asael-agent-skill-acceptance:1"),
  id: z.string().regex(/^agent-skill-acceptance:[a-f0-9]{64}$/), scope: agentSkillNativeScopeSchema,
  operation: agentSkillNativeOperationSchema, resourceType: agentSkillNativeResourceTypeSchema, resourceId: agentSkillNativeIdSchema,
  keySha256: sha, requestSha256: sha, reviewSha256: sha.nullable(), beforeVersion: version.nullable(), afterVersion: version.nullable(),
  beforeResourceSha256: sha.nullable(), afterResourceSha256: sha.nullable(), affectedAgentIds: z.array(agentSkillNativeIdSchema).max(100),
  trash: z.object({ trashId: z.string().regex(/^trash:[0-9a-f-]{36}$/), previewSha256: sha, targetSha256: sha, snapshotSha256: sha,
    receiptSha256: sha, compensation: z.enum(["exact_restore", "equivalent_action"]) }).strict().nullable(), acceptedAt: at,
}).strict();
export const agentSkillNativeAcceptanceSchema = acceptanceBody.extend({ acceptanceSha256: sha }).strict().superRefine((value, context) => {
  const { acceptanceSha256, ...body } = value;
  const create = value.operation === "skill.create", update = value.operation === "skill.update", agent = value.operation === "agent.delete";
  if (acceptanceSha256 !== canonicalJsonSha256(body) || value.id !== agentSkillNativeAcceptanceId(value.scope, value.keySha256) ||
    (value.resourceType === "custom_agent") !== agent || new Set(value.affectedAgentIds).size !== value.affectedAgentIds.length ||
    (create ? value.reviewSha256 !== null || value.beforeVersion !== null || value.beforeResourceSha256 !== null || value.afterVersion !== 1 || !value.afterResourceSha256 || value.trash !== null
      : update ? value.reviewSha256 === null || value.beforeVersion === null || value.afterVersion !== value.beforeVersion + 1 || !value.beforeResourceSha256 || !value.afterResourceSha256 || value.trash !== null
        : !value.reviewSha256 || !value.beforeResourceSha256 || value.afterVersion !== null || value.afterResourceSha256 !== null || !value.trash ||
          (agent ? value.beforeVersion !== null || value.trash.compensation !== "equivalent_action" : value.beforeVersion === null || value.trash.compensation !== "exact_restore")) ||
    (value.trash && value.trash.targetSha256 !== value.reviewSha256)) context.addIssue({ code: "custom", message: "Accepted mutation identity, version, Trash proof or digest is inconsistent." });
});
export type AgentSkillNativeScope = z.infer<typeof agentSkillNativeScopeSchema>;
export type AgentSkillNativeOperation = z.infer<typeof agentSkillNativeOperationSchema>;
export type AgentSkillNativeRequest = z.infer<typeof agentSkillNativeRequestSchema>;
export type AgentSkillNativeIntent = z.infer<typeof agentSkillNativeIntentSchema>;
export type AgentSkillNativeAcceptance = z.infer<typeof agentSkillNativeAcceptanceSchema>;
export type AgentSkillNativeReviewPin = z.infer<typeof agentSkillNativeReviewPinSchema>;
export type AgentSkillNativeReview = z.infer<typeof agentSkillNativeReviewSchema>;
export function agentSkillNativeAcceptanceId(scope: AgentSkillNativeScope, keySha256: string) {
  return `agent-skill-acceptance:${canonicalJsonSha256({ scope, keySha256 })}`;
}
export function buildAgentSkillNativeIntent(input: { scope: AgentSkillNativeScope; idempotencyKey: string; request: AgentSkillNativeRequest }) {
  const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/).parse(input.idempotencyKey);
  const request = agentSkillNativeRequestSchema.parse(input.request), create = request.contract === "asael-skill-create:1";
  return agentSkillNativeIntentSchema.parse({ contract: "asael-agent-skill-intent:1", scope: input.scope,
    operation: create ? "skill.create" : request.review.operation, resourceId: create ? null : request.review.resourceId,
    keySha256: idempotencyKeySha256({ tenantId: input.scope.tenantId, idempotencyKey: key }), request });
}
export function buildAgentSkillNativeAcceptance(body: z.input<typeof acceptanceBody>) {
  const parsed = acceptanceBody.parse(body);
  return agentSkillNativeAcceptanceSchema.parse({ ...parsed, acceptanceSha256: canonicalJsonSha256(parsed) });
}
export class AgentSkillNativeError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = "AgentSkillNativeError"; }
}
