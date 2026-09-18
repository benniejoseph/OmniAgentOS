import { describe, expect, it } from "vitest";

import { PLUGIN_CATALOG } from "@/lib/plugins/catalog";
import {
  buildPluginInstallation,
  buildPluginPreview,
  parsePluginManifest,
  pluginManifestSha256,
} from "@/lib/plugins/contracts";
import { pluginInstallationIdForActor } from "@/lib/plugins/store";
import {
  isAgentSkillRuntimeActive,
  pluginSkillIdForInstallation,
  pluginSkillStatusForInstallation,
} from "@/lib/skills/store";

const manifest = PLUGIN_CATALOG[0].manifest;

describe("declarative Plugin v1 contracts", () => {
  it("binds previews and installations to the exact normalized manifest", () => {
    const digest = pluginManifestSha256(manifest);
    const preview = buildPluginPreview({
      previewId: "plugin-preview:1111111111111111",
      manifest,
      createdAt: "2026-09-18T10:00:00.000Z",
    });
    const installation = buildPluginInstallation({
      installationId: "plugin-installation:1111111111111111",
      manifest,
      installedAt: "2026-09-18T10:01:00.000Z",
    });
    expect(preview.manifestSha256).toBe(digest);
    expect(preview.expiresAt).toBe("2026-09-18T10:15:00.000Z");
    expect(preview.effects).toContain(
      "Install its declared Skills into the existing actor-owned Skill catalog while the Plugin is enabled.",
    );
    expect(preview.limitations).toContain(
      "Disabling or uninstalling the Plugin deactivates its projected Skills without deleting their history.",
    );
    expect(installation.manifestSha256).toBe(digest);
    expect(installation.components.skills).toEqual([
      expect.objectContaining({ state: "active" }),
    ]);
    expect(installation.components.mcpTemplates).toEqual([
      expect.objectContaining({ state: "connection_and_review_required" }),
    ]);
    expect(installation.components.workflowTemplates).toEqual([
      expect.objectContaining({ state: "metadata_only" }),
    ]);
  });

  it("makes projected Skill identities tenant-and-actor private", () => {
    const ownerA = pluginInstallationIdForActor({
      tenantId: "tenant-one",
      actorId: "actor-a@example.test",
      pluginId: manifest.pluginId,
    });
    const ownerB = pluginInstallationIdForActor({
      tenantId: "tenant-one",
      actorId: "actor-b@example.test",
      pluginId: manifest.pluginId,
    });
    const otherTenant = pluginInstallationIdForActor({
      tenantId: "tenant-two",
      actorId: "actor-a@example.test",
      pluginId: manifest.pluginId,
    });
    expect(new Set([ownerA, ownerB, otherTenant]).size).toBe(3);
    expect(pluginSkillIdForInstallation(ownerA, manifest.skills[0].key))
      .not.toBe(pluginSkillIdForInstallation(ownerB, manifest.skills[0].key));
    expect(pluginSkillIdForInstallation(ownerA, manifest.skills[0].key))
      .not.toBe(pluginSkillIdForInstallation(otherTenant, manifest.skills[0].key));
  });

  it("deactivates declared Skills when a plugin is disabled or uninstalled", () => {
    for (const state of ["disabled", "uninstalled"] as const) {
      const installation = buildPluginInstallation({
        installationId: `plugin-installation:${state}:1111111111111111`,
        manifest,
        state,
      });
      expect(installation.components.skills.every((skill) => skill.state === "disabled"))
        .toBe(true);
      const projectedStatus = pluginSkillStatusForInstallation(state);
      expect(projectedStatus).toBe("disabled");
      expect(isAgentSkillRuntimeActive({ status: projectedStatus })).toBe(false);
    }
  });

  it("rejects arbitrary executable fields and secret-bearing manifests", () => {
    expect(() => parsePluginManifest({
      ...manifest,
      entrypoint: "./run.js",
    })).toThrow();
    expect(() => parsePluginManifest({
      ...manifest,
      description: "Use Bearer abcdefghijklmnopqrstuvwxyz123456789 for this integration.",
    })).toThrow(/credentials|tokens|private keys|secret/i);
  });

  it("rejects retired remote-browser MCP endpoints and dangling workflow references", () => {
    expect(() => parsePluginManifest({
      ...manifest,
      mcpTemplates: [{
        ...manifest.mcpTemplates[0],
        endpoint: "https://api.browser-use.com/mcp",
      }],
    })).toThrow(/retired/i);
    expect(() => parsePluginManifest({
      ...manifest,
      workflowTemplates: [{
        ...manifest.workflowTemplates[0],
        requiredSkillKeys: ["missing-skill"],
      }],
    })).toThrow(/missing Skill/i);
  });
});
