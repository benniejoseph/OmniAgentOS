import { describe, expect, it } from "vitest";

import {
  buildWorkspaceTemplateVersion,
  parseWorkspaceTemplateVersion,
  workspaceTemplateDefinitionInputSchema,
} from "@/lib/workspace-templates/contracts";

const tenantId = "tenant-template";
const workspaceId = "workspace:actor:11111111-1111-4111-8111-111111111111";
const actorId = "actor:11111111-1111-4111-8111-111111111111";
const templateId = "workspace-template:22222222-2222-4222-8222-222222222222";

describe("workspace template contracts", () => {
  it("builds a digest-bound immutable version with normalized playbook aliases", () => {
    const version = buildWorkspaceTemplateVersion({
      tenantId,
      workspaceId,
      templateId,
      version: 2,
      publishedAt: "2026-09-07T09:00:00.000Z",
      ownerActorId: actorId,
      definition: {
        name: "Release checklist",
        description: "Ship a reviewed release.",
        project: {
          title: "Release",
          objective: "Ship safely",
          tasks: [
            { key: "verify", title: "Verify release" },
            { key: "publish", title: "Publish release", dependsOnKeys: ["verify"] },
          ],
        },
        playbook: {
          aliases: ["  Run Release Checklist!  "],
          toolBindings: [{ toolId: "app.projects.list", input: { limit: 10 } }],
          acceptanceCriteria: ["The release is verified."],
        },
      },
    });

    expect(version).toMatchObject({
      templateVersionId: `${templateId}:v2`,
      previousTemplateVersionId: `${templateId}:v1`,
      playbook: { aliases: ["run release checklist"] },
    });
    expect(parseWorkspaceTemplateVersion(version)).toEqual(version);
    expect(parseWorkspaceTemplateVersion({
      ...version,
      project: { ...version.project, objective: "Mutated" },
    })).toBeUndefined();
    expect(Object.isFrozen(version.project.tasks)).toBe(true);
  });

  it("rejects cyclic task graphs, duplicate normalized aliases, and credential fields", () => {
    expect(() => workspaceTemplateDefinitionInputSchema.parse({
      name: "Unsafe",
      project: {
        title: "Unsafe",
        objective: "Should fail",
        tasks: [
          { key: "a", title: "A", dependsOnKeys: ["b"] },
          { key: "b", title: "B", dependsOnKeys: ["a"] },
        ],
      },
      playbook: {
        aliases: ["Run unsafe", "run-unsafe"],
        toolBindings: [{ toolId: "http.request", input: { apiKey: "never-store-this" } }],
        acceptanceCriteria: ["Done"],
      },
    })).toThrow();
  });
});
