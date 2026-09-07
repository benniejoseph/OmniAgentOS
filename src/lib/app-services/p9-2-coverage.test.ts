import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  APP_SERVICE_OPERATION_CONTRACTS,
  MAIN_AGENT_APP_SERVICE_BINDINGS,
  MAIN_AGENT_EXCLUDED_APP_OPERATIONS,
} from "@/lib/app-services/registry";
import { FIRST_PARTY_APP_TOOLS } from "@/lib/tools/app-registry";

const requiredFamilies = [
  "app.workspaces.",
  "app.projects.",
  "app.work_items.",
  "app.assets.",
  "app.memory.",
  "app.agents.",
  "app.skills.",
  "app.runs.",
  "app.workflows.",
  "app.connectors.",
  "app.trash.",
  "app.settings.",
  "app.today.",
  "app.notifications.",
] as const;

describe("P9.2 complete governed application control", () => {
  it("registers every required first-party app family with complete tool metadata", () => {
    expect(FIRST_PARTY_APP_TOOLS.length).toBeGreaterThanOrEqual(100);
    for (const prefix of requiredFamilies) {
      expect(FIRST_PARTY_APP_TOOLS.some((tool) => tool.id.startsWith(prefix)), prefix).toBe(true);
    }
    for (const tool of FIRST_PARTY_APP_TOOLS) {
      expect(tool, tool.id).toMatchObject({
        category: "app",
        status: "active",
        dryRunSupported: true,
      });
      expect(["read_only", "mutation"]).toContain(tool.operationClass);
      if (tool.riskLevel >= 2) expect(tool.approvalRequired, tool.id).toBe(true);
    }
  });

  it("binds and dispatches every registered app tool through an application service", async () => {
    const toolIds = FIRST_PARTY_APP_TOOLS.map((tool) => tool.id);
    const appBindings = MAIN_AGENT_APP_SERVICE_BINDINGS.filter((binding) => binding.toolId.startsWith("app."));
    const operationIds = new Set(APP_SERVICE_OPERATION_CONTRACTS.map((contract) => contract.operation));
    expect(new Set(toolIds).size).toBe(toolIds.length);
    expect(new Set(appBindings.map((binding) => binding.toolId)).size).toBe(appBindings.length);
    expect(appBindings.map((binding) => binding.toolId).sort()).toEqual([...toolIds].sort());
    for (const binding of appBindings) expect(operationIds.has(binding.operation), binding.toolId).toBe(true);

    const dispatcher = await readFile(resolve(process.cwd(), "src/lib/app-services/tool-dispatcher.ts"), "utf8");
    for (const toolId of toolIds) expect(dispatcher, toolId).toContain(`"${toolId}"`);
  });

  it("keeps excluded secret, binary, and recursive execution paths explicit and unavailable", () => {
    const toolIds = new Set(FIRST_PARTY_APP_TOOLS.map((tool) => tool.id));
    for (const excluded of MAIN_AGENT_EXCLUDED_APP_OPERATIONS) {
      expect(excluded.reason.length, excluded.operation).toBeGreaterThan(24);
      expect(toolIds.has(excluded.operation), excluded.operation).toBe(false);
    }
  });

  it("requires exact previews before permanent application effects", () => {
    const byId = new Map(FIRST_PARTY_APP_TOOLS.map((tool) => [tool.id, tool]));
    const permanentEffects = [
      ["app.memory.forget.preview", "app.memory.forget"],
      ["app.knowledge.delete.preview", "app.knowledge.delete"],
      ["app.agents.release.retire.preview", "app.agents.release.retire"],
      ["app.agents.grants.revoke.preview", "app.agents.grants.revoke"],
      ["app.settings.providers.revoke.preview", "app.settings.providers.revoke"],
      ["app.settings.api_keys.revoke.preview", "app.settings.api_keys.revoke"],
      ["app.assets.delete.preview", "app.assets.delete"],
    ] as const;
    for (const [previewId, effectId] of permanentEffects) {
      expect(byId.get(previewId), previewId).toMatchObject({ operationClass: "read_only", riskLevel: 0 });
      expect(byId.get(effectId), effectId).toMatchObject({ operationClass: "mutation", approvalRequired: true, reversible: false });
      const properties = (byId.get(effectId)?.inputSchema as { properties?: Record<string, unknown> }).properties || {};
      expect(Object.keys(properties).some((key) => /expected.*sha256/i.test(key)), effectId).toBe(true);
    }
    const reversibleEffects = [
      ["app.agents.delete.preview", "app.agents.delete"],
      ["app.skills.delete.preview", "app.skills.delete"],
      ["app.connectors.delete.preview", "app.connectors.delete"],
    ] as const;
    for (const [previewId, effectId] of reversibleEffects) {
      expect(byId.get(previewId), previewId).toMatchObject({ operationClass: "read_only", riskLevel: 0 });
      expect(byId.get(effectId), effectId).toMatchObject({ operationClass: "mutation", approvalRequired: true, reversible: true });
      const properties = (byId.get(effectId)?.inputSchema as { properties?: Record<string, unknown> }).properties || {};
      expect(properties.preview, effectId).toBeDefined();
    }
  });
});
