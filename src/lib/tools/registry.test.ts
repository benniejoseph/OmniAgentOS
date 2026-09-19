import { describe, expect, it } from "vitest";

import { getGovernedTool } from "@/lib/tools/registry";
import { MAIN_AGENT_EXCLUDED_APP_OPERATIONS } from "@/lib/app-services/registry";

describe("governed native tool schemas", () => {
  it("keeps memory.correct compatible with OpenAI function schemas", () => {
    const tool = getGovernedTool("memory.correct");

    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        confidence: { type: "number" },
        validTo: { type: "string" },
        contradiction: { type: "boolean" },
      },
    });
    expect(tool?.inputSchema).not.toHaveProperty("anyOf");
  });

  it("requires an exact deletion preview receipt before forgetting", () => {
    const preview = getGovernedTool("memory.forget.preview");
    const forget = getGovernedTool("memory.forget");

    expect(preview).toMatchObject({
      riskLevel: 0,
      approvalRequired: false,
      operationClass: "read_only",
    });
    expect(forget?.inputSchema).toMatchObject({
      required: ["id", "expectedReceiptManifestSha256"],
      properties: {
        id: { type: "string" },
        expectedReceiptManifestSha256: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          pattern: "^[a-f0-9]{64}$",
        },
      },
    });
  });

  it("exposes inspect, lifecycle, and transcript-safe export controls", () => {
    expect(getGovernedTool("memory.inspect")).toMatchObject({
      riskLevel: 0,
      operationClass: "read_only",
    });
    expect(getGovernedTool("memory.lifecycle")).toMatchObject({
      riskLevel: 1,
      operationClass: "mutation",
      reversible: true,
    });
    expect(getGovernedTool("memory.export")).toMatchObject({
      riskLevel: 0,
      operationClass: "read_only",
    });
  });

  it("registers executable workspace, project, and work-item app tools", () => {
    expect(getGovernedTool("app.workspaces.summary")).toMatchObject({
      category: "app",
      riskLevel: 0,
      operationClass: "read_only",
    });
    expect(getGovernedTool("app.projects.create")).toMatchObject({
      category: "app",
      riskLevel: 1,
      operationClass: "mutation",
    });
    expect(getGovernedTool("app.work_items.update")?.inputSchema).toMatchObject({
      required: ["projectId", "workItemId"],
    });
    for (const id of ["app.projects.execution.control", "app.projects.artifacts.feedback"]) {
      expect(getGovernedTool(id)).toMatchObject({ riskLevel: 2, approvalRequired: true });
    }
  });

  it("keeps destructive app data controls behind exact previews and approval", () => {
    expect(getGovernedTool("app.memory.forget.preview")).toMatchObject({
      riskLevel: 0,
      operationClass: "read_only",
    });
    expect(getGovernedTool("app.memory.forget")).toMatchObject({
      riskLevel: 2,
      approvalRequired: true,
      reversible: false,
    });
    expect(getGovernedTool("app.knowledge.delete.preview")).toMatchObject({
      riskLevel: 0,
      operationClass: "read_only",
    });
    expect(getGovernedTool("app.knowledge.delete")?.inputSchema).toMatchObject({
      required: ["source", "expectedTargetsSha256"],
    });
    for (const family of ["agents", "skills"]) {
      expect(getGovernedTool(`app.${family}.delete.preview`)).toMatchObject({
        riskLevel: 0,
        operationClass: "read_only",
      });
      expect(getGovernedTool(`app.${family}.delete`)).toMatchObject({
        riskLevel: 2,
        approvalRequired: true,
        reversible: true,
      });
      expect(getGovernedTool(`app.${family}.delete`)?.inputSchema).toMatchObject({
        required: ["id", "preview"],
      });
    }
  });

  it("registers exact-capability Google Workspace reads and approval-gated mutations", () => {
    for (const id of [
      "google.gmail.search",
      "google.gmail.read",
      "google.drive.search",
      "google.drive.download",
      "google.docs.read",
      "google.sheets.read",
      "google.slides.read",
    ]) {
      expect(getGovernedTool(id)).toMatchObject({
        category: "connector",
        riskLevel: 0,
        approvalRequired: false,
        operationClass: "read_only",
      });
    }
    for (const id of [
      "google.gmail.trash",
      "google.drive.create",
      "google.drive.move",
      "google.drive.rename",
      "google.drive.trash",
      "google.docs.create",
      "google.sheets.create",
      "google.slides.create",
    ]) {
      expect(getGovernedTool(id)).toMatchObject({
        category: "connector",
        riskLevel: 2,
        approvalRequired: true,
        operationClass: "mutation",
        reversible: true,
      });
    }
    for (const id of [
      "google.drive.update",
      "google.docs.update",
      "google.sheets.update",
      "google.slides.update",
      "calendar.update",
      "calendar.delete",
    ]) {
      expect(getGovernedTool(id)).toMatchObject({
        category: "connector",
        riskLevel: 2,
        approvalRequired: true,
        operationClass: "mutation",
        reversible: false,
      });
    }
    expect(getGovernedTool("app.communications.deliver")).toMatchObject({
      riskLevel: 2,
      approvalRequired: true,
    });
    expect(getGovernedTool("google.gmail.trash")?.description).toMatch(/never permanently deletes/i);
    expect(getGovernedTool("calendar.delete")?.inputSchema).toMatchObject({
      properties: { eventId: { minLength: 1, maxLength: 1_024 } },
    });
    expect(getGovernedTool("google.gmail.search")?.inputSchema).toMatchObject({
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        maxResults: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
    });
    expect(getGovernedTool("google.drive.search")?.inputSchema).toMatchObject({
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        maxResults: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
    });
    expect(getGovernedTool("google.docs.update")?.inputSchema).toMatchObject({
      required: [
        "documentId",
        "text",
        "expectedCurrentSha256",
        "expectedStructureSha256",
      ],
    });
    expect(getGovernedTool("google.drive.create")?.inputSchema).toMatchObject({
      properties: { contentBase64: { maxLength: 213_342 } },
    });
    expect(getGovernedTool("google.docs.create")?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["title"],
      properties: {
        bodyText: { type: "string", minLength: 1, maxLength: 100_000 },
        blocks: { type: "array", minItems: 1, maxItems: 100 },
      },
      oneOf: [
        { required: ["bodyText"], not: { required: ["blocks"] } },
        { required: ["blocks"], not: { required: ["bodyText"] } },
      ],
    });
    expect(getGovernedTool("google.docs.create")?.inputSchema)
      .not.toHaveProperty("properties.contentBase64");
    expect(getGovernedTool("google.sheets.create")?.inputSchema).toMatchObject({
      required: ["title", "sheetName", "values"],
      properties: {
        sheetName: { type: "string", minLength: 1, maxLength: 100 },
        values: { type: "array", minItems: 1, maxItems: 50 },
      },
    });
    expect(getGovernedTool("google.slides.create")?.inputSchema).toMatchObject({
      required: ["title", "slides"],
      properties: {
        slides: {
          type: "array",
          minItems: 1,
          maxItems: 24,
          items: {
            additionalProperties: false,
            required: ["title"],
            anyOf: [{ required: ["body"] }, { required: ["bullets"] }],
            properties: {
              title: { maxLength: 240 },
              body: { maxLength: 2_000 },
              bullets: { minItems: 1, maxItems: 12 },
            },
          },
        },
      },
    });
    expect(getGovernedTool("google.slides.create")?.inputSchema)
      .not.toHaveProperty("properties.slides.items.properties.imageBase64");
    expect(getGovernedTool("google.sheets.update")?.inputSchema).toMatchObject({
      properties: {
        values: {
          minItems: 1,
          maxItems: 50,
          items: {
            minItems: 1,
            maxItems: 100,
            items: {
              anyOf: [
                { type: "string", maxLength: 50_000, pattern: "^(?:[^=]|$)" },
                { type: "number" },
                { type: "boolean" },
              ],
            },
          },
        },
      },
    });
  });

  it("keeps workflow control bounded and approval-gated at signals", () => {
    expect(getGovernedTool("app.workflows.start")).toMatchObject({
      riskLevel: 1,
      operationClass: "mutation",
    });
    expect(getGovernedTool("app.workflows.signal")).toMatchObject({
      riskLevel: 2,
      approvalRequired: true,
    });
    expect(getGovernedTool("app.workflows.tick")?.inputSchema).toMatchObject({
      required: ["workflowId"],
    });
  });

  it("keeps run feedback and cancellation under explicit approval", () => {
    for (const id of ["app.runs.feedback", "app.runs.cancel"]) {
      expect(getGovernedTool(id)).toMatchObject({
        riskLevel: 2,
        approvalRequired: true,
        reversible: false,
      });
    }
  });

  it("governs agent releases, grants, and adaptations", () => {
    for (const id of [
      "app.agents.release.transition",
      "app.agents.release.retire",
      "app.agents.grants.create",
      "app.agents.grants.revoke",
      "app.agents.adaptations.manage",
    ]) {
      expect(getGovernedTool(id)).toMatchObject({ riskLevel: 2, approvalRequired: true });
    }
    expect(getGovernedTool("app.agents.release.retire")?.inputSchema).toMatchObject({
      required: ["agentId", "expectedTargetSha256"],
    });
    expect(getGovernedTool("app.agents.grants.revoke")?.inputSchema).toMatchObject({
      required: ["agentId", "grantId", "expectedTargetSha256"],
    });
  });

  it("keeps connector trust changes and deletion approval-gated", () => {
    for (const id of [
      "app.connectors.register",
      "app.connectors.update",
      "app.connectors.refresh",
      "app.connectors.review",
      "app.connectors.delete",
    ]) {
      expect(getGovernedTool(id)).toMatchObject({
        category: "app",
        riskLevel: 2,
        approvalRequired: true,
      });
    }
    expect(getGovernedTool("app.connectors.delete")?.inputSchema).toMatchObject({
      required: ["kind", "connectorId", "preview"],
    });
    expect(getGovernedTool("app.connectors.delete")).toMatchObject({ reversible: true });
  });

  it("exposes actor-private trash with approval-gated restore and permanent purge", () => {
    for (const id of ["app.trash.list", "app.trash.show", "app.trash.receipts.list"]) {
      expect(getGovernedTool(id)).toMatchObject({
        category: "app",
        riskLevel: 0,
        operationClass: "read_only",
      });
    }
    expect(getGovernedTool("app.trash.restore")).toMatchObject({
      riskLevel: 2,
      approvalRequired: true,
      reversible: true,
    });
    expect(getGovernedTool("app.trash.purge")).toMatchObject({
      riskLevel: 3,
      approvalRequired: true,
      reversible: false,
    });
    expect(getGovernedTool("app.trash.purge")?.inputSchema).toMatchObject({
      required: ["preview"],
      properties: { preview: { properties: { action: { enum: ["purge"] } } } },
    });
  });

  it("keeps settings secrets out of agent tools", () => {
    expect(MAIN_AGENT_EXCLUDED_APP_OPERATIONS.map((entry) => entry.operation)).toEqual(
      expect.arrayContaining([
        "app.connectors.credentials.write",
        "app.settings.providers.create",
        "app.settings.providers.rotate",
        "app.settings.api_keys.create",
      ]),
    );
    expect(getGovernedTool("app.settings.providers.create")).toBeUndefined();
    expect(getGovernedTool("app.settings.api_keys.create")).toBeUndefined();
    expect(getGovernedTool("app.settings.providers.revoke")).toMatchObject({
      riskLevel: 2,
      approvalRequired: true,
      reversible: false,
    });
  });

  it("keeps captured binary content out of transcripts and deletion at risk three", () => {
    expect(MAIN_AGENT_EXCLUDED_APP_OPERATIONS.map((entry) => entry.operation)).toEqual(
      expect.arrayContaining(["app.assets.upload", "app.assets.recordings.segment.write"]),
    );
    expect(getGovernedTool("app.assets.show")?.description).toContain(
      "without returning stored binary content",
    );
    expect(getGovernedTool("app.assets.index")).toMatchObject({
      riskLevel: 1,
      operationClass: "mutation",
    });
    expect(getGovernedTool("app.assets.delete")).toMatchObject({
      riskLevel: 3,
      approvalRequired: true,
      reversible: false,
    });
  });

  it("registers private non-destructive image and video production tools", () => {
    for (const id of [
      "media.image.generate",
      "media.image.edit",
      "media.video.generate",
      "media.video.edit",
      "media.video.clip",
    ]) {
      expect(getGovernedTool(id)).toMatchObject({
        category: "media",
        status: "active",
        riskLevel: 1,
        operationClass: "mutation",
        reversible: true,
      });
    }
    expect(getGovernedTool("media.image.edit")?.description).toContain(
      "without overwriting originals",
    );
    expect(getGovernedTool("media.video.clip")?.description).toContain(
      "deterministic FFmpeg",
    );
  });
});
