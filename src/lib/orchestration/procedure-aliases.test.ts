import { describe, expect, it } from "vitest";
import { isUsableProcedureAlias } from "@/lib/orchestration/procedure-aliases";
import { resolveKnownProcedure } from "@/lib/orchestration/supervisor";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  buildWorkspaceTemplateVersion,
  parseWorkspaceTemplateVersion,
  workspaceTemplateDefinitionInputSchema,
} from "@/lib/workspace-templates/contracts";
import { savedProceduresFromWorkspaceTemplates } from "@/lib/workflows/saved-procedures";

const OWNER = "actor:11111111-1111-4111-8111-111111111111";
const MEMBER = "actor:33333333-3333-4333-8333-333333333333";
const STORED_TEMPLATE = "workspace-template:55555555-5555-4555-8555-555555555555";
const OWN_TEMPLATE = "workspace-template:66666666-6666-4666-8666-666666666666";
const OTHER_TEMPLATE = "workspace-template:77777777-7777-4777-8777-777777777777";

function template(ownerActorId: string, templateId: string, aliases: string[]) {
  return buildWorkspaceTemplateVersion({
    tenantId: "tenant-a",
    workspaceId: "workspace:shared:44444444-4444-4444-8444-444444444444",
    templateId,
    version: 1,
    ownerActorId,
    publishedAt: "2026-09-30T09:00:00.000Z",
    definition: {
      name: "Digest",
      project: { title: "Digest", objective: "Send the digest" },
      playbook: {
        aliases,
        toolBindings: [{ toolId: "app.projects.list", input: { limit: 5 } }],
        acceptanceCriteria: ["The digest is listed."],
      },
    },
  });
}

describe("procedure aliases", () => {
  it("refuses aliases that read as a reply or an invocation word", () => {
    for (const alias of [
      "xy", "Yes", "OK!", "continue", "please continue", "yes please",
      "go ahead now", "run now", "now", "the", "kick off", "thank you",
    ]) {
      expect(isUsableProcedureAlias(alias), alias).toBe(false);
    }
    for (const alias of [
      "gym", "standup", "go live", "run release", "weekly digest", "start the day",
    ]) {
      expect(isUsableProcedureAlias(alias), alias).toBe(true);
    }
  });

  it("never lets a reserved alias route Command, while its other aliases still do", () => {
    const procedures = [{
      id: "digest",
      aliases: ["yes", "continue", "weekly digest"],
      requiredToolIds: ["app.projects.list"],
    }];

    for (const request of ["yes", "Yes please", "continue", "please continue"]) {
      expect(resolveKnownProcedure(request, procedures), request)
        .toEqual({ state: "none" });
    }
    expect(resolveKnownProcedure("run my weekly digest", procedures)).toMatchObject({
      state: "resolved",
      matchedAlias: "weekly digest",
      procedure: { id: "digest", aliases: ["weekly digest"] },
    });
  });

  it("refuses a reserved alias at publish but still loads a version stored with one", () => {
    const refused = workspaceTemplateDefinitionInputSchema.safeParse({
      name: "Digest",
      project: { title: "Digest", objective: "Send the digest" },
      playbook: {
        aliases: ["weekly digest", "Continue"],
        toolBindings: [{ toolId: "app.projects.list", input: {} }],
        acceptanceCriteria: ["The digest is listed."],
      },
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues).toEqual([
      expect.objectContaining({ path: ["playbook", "aliases", 1] }),
    ]);

    const stored = template(OWNER, STORED_TEMPLATE, ["weekly digest"]);
    const { templateSha256: _digest, ...body } = stored;
    void _digest;
    const legacyBody = {
      ...body,
      playbook: { ...body.playbook!, aliases: ["continue", "weekly digest"] },
    };
    const legacy = parseWorkspaceTemplateVersion({
      ...legacyBody,
      templateSha256: canonicalJsonSha256(legacyBody),
    });
    expect(legacy?.playbook?.aliases).toEqual(["continue", "weekly digest"]);
  });

  it("routes only the playbooks the requester published", () => {
    const own = template(OWNER, OWN_TEMPLATE, ["weekly digest"]);
    const other = template(MEMBER, OTHER_TEMPLATE, ["send the report"]);

    const procedures = savedProceduresFromWorkspaceTemplates(
      [own, other],
      { canonicalActorId: OWNER },
    );
    expect(procedures.map((procedure) => procedure.id))
      .toEqual([OWN_TEMPLATE]);
    expect(savedProceduresFromWorkspaceTemplates(
      [own, other],
      { canonicalActorId: MEMBER },
    ).map((procedure) => procedure.id)).toEqual([OTHER_TEMPLATE]);
  });
});
