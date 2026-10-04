import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { agentSkillNativeCreateRequestSchema, buildAgentSkillNativeAcceptance, buildAgentSkillNativeIntent, agentSkillNativeAcceptanceId,
  type AgentSkillNativeScope } from "@/lib/skills/native-mutation-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { SecurityContext } from "@/lib/security/types";

export const catalogContext: SecurityContext = { tenantId: "native-catalog", actorId: "catalog@example.test", role: "admin", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "catalog@example.test", sessionId: "catalog-fixture", tenantName: "Catalog" } };
export const catalogScope: AgentSkillNativeScope = { tenantId: catalogContext.tenantId, ownerActorId: catalogContext.actorId,
  canonicalActorId: `actor:${catalogContext.auth!.userId}` };
export const catalogAt = "2026-10-05T14:30:00.123Z";
export const catalogRequest = agentSkillNativeCreateRequestSchema.parse({ contract: "asael-skill-create:1", skill: {
  name: "Review notes", description: "Prepare the agreed review.", instructions: "Prepare a short review with citations.", category: "personal",
  status: "active", toolIds: [], tags: [], knowledgeTags: [],
} });
export function catalogFixture() {
  const key = "catalog-create-one", intent = buildAgentSkillNativeIntent({ scope: catalogScope, idempotencyKey: key, request: catalogRequest });
  const skill = { ...catalogRequest.skill, id: "catalog-skill-one", tenantId: catalogScope.tenantId, actorId: catalogScope.ownerActorId,
    slug: "review-notes", version: 1, createdAt: catalogAt, updatedAt: catalogAt };
  const acceptance = buildAgentSkillNativeAcceptance({ contract: "asael-agent-skill-acceptance:1", id: agentSkillNativeAcceptanceId(catalogScope, intent.keySha256),
    scope: catalogScope, operation: "skill.create", resourceType: "agent_skill", resourceId: skill.id, keySha256: intent.keySha256,
    requestSha256: canonicalJsonSha256(intent), reviewSha256: null, beforeVersion: null, afterVersion: 1,
    beforeResourceSha256: null, afterResourceSha256: canonicalJsonSha256(skill), affectedAgentIds: [], trash: null, acceptedAt: catalogAt });
  return { key, intent, skill, acceptance };
}
export function catalogCaller(mutation = true) {
  return mutation ? createRequestMutationAppServiceCaller(new Request("http://localhost/api/skills", { method: "POST", headers: { "Idempotency-Key": catalogFixture().key } }),
    catalogContext, { purpose: "skill.create", causationId: "skills:create" }) : createAppServiceCaller({ context: catalogContext });
}
