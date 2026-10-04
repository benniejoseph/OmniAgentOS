import { describe, expect, it } from "vitest";
import { agentSkillNativeAcceptanceSchema, agentSkillNativeCreateRequestSchema, agentSkillNativeDeleteRequestSchema,
  agentSkillNativeUpdateRequestSchema, buildAgentSkillNativeIntent } from "@/lib/skills/native-mutation-contracts";
import { catalogFixture, catalogRequest, catalogScope } from "@/lib/skills/native-mutation.test-fixtures";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { buildTrashActionPreviewV1 } from "@/lib/trash/contracts";

describe("native Agent/Skill pinned intents", () => {
  it("binds the actual normalized Skill request and namespaced key without a fresh timestamp", () => {
    const fixture = catalogFixture();
    expect(buildAgentSkillNativeIntent({ scope: catalogScope, idempotencyKey: fixture.key, request: catalogRequest })).toEqual(fixture.intent);
    expect(fixture.acceptance.requestSha256).toBe(canonicalJsonSha256(fixture.intent));
    expect(fixture.intent).not.toHaveProperty("acceptedAt");
    expect(buildAgentSkillNativeIntent({ scope: { ...catalogScope, canonicalActorId: "actor:22222222-2222-4222-8222-222222222222" },
      idempotencyKey: fixture.key, request: catalogRequest })).not.toEqual(fixture.intent);
  });
  it("refuses omitted defaults, lossy tool limits, duplicate identifiers and unreviewed update state", () => {
    for (const skill of [{ ...catalogRequest.skill, toolIds: undefined }, { ...catalogRequest.skill, toolIds: Array.from({ length: 41 }, (_, index) => `tool:${index}`) },
      { ...catalogRequest.skill, tags: ["same", "same"] }, { ...catalogRequest.skill, instructions: "  Unnormalized instructions  " }]) {
      expect(agentSkillNativeCreateRequestSchema.safeParse({ ...catalogRequest, skill }).success).toBe(false);
    }
    expect(agentSkillNativeUpdateRequestSchema.safeParse({ contract: "asael-skill-update:1", change: { name: "Changed name" } }).success).toBe(false);
  });
  it("requires the exact reviewed resource, impact and expiring Trash preview", () => {
    const review = { operation: "skill.delete" as const, resourceType: "agent_skill" as const, resourceId: "skill-one", resourceVersion: 3,
      resourceSha256: "a".repeat(64), impactSha256: "b".repeat(64) };
    const preview = buildTrashActionPreviewV1({ version: "p9.3-trash-preview:1", action: "trash", trashId: null, resourceType: "agent_skill", resourceId: review.resourceId,
      lifecycleRevision: 0, targetSha256: canonicalJsonSha256(review), effectSummary: "Move this Skill to Trash.", reversible: true,
      issuedAt: "2026-10-05T14:30:00.000Z", expiresAt: "2026-10-05T14:40:00.000Z" });
    const request = { contract: "asael-agent-skill-delete:1", review, preview };
    expect(agentSkillNativeDeleteRequestSchema.safeParse(request).success).toBe(true);
    expect(agentSkillNativeDeleteRequestSchema.safeParse({ ...request, review: { ...review, impactSha256: "c".repeat(64) } }).success).toBe(false);
  });
  it("refuses a resealed impossible acceptance", () => {
    const { acceptanceSha256: _digest, ...body } = catalogFixture().acceptance; void _digest;
    const changed = { ...body, afterVersion: 2 };
    expect(agentSkillNativeAcceptanceSchema.safeParse({ ...changed, acceptanceSha256: canonicalJsonSha256(changed) }).success).toBe(false);
  });
});
