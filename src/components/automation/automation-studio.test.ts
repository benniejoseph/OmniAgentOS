import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appNav, appNavGroups } from "@/lib/navigation";
import {
  buildCapabilitySummary,
  importedPluginPreviewPayload,
  integrationsOverviewAt,
  MAX_PLUGIN_MANIFEST_BYTES,
  parseImportedPluginManifest,
  pluginManifestByteLength,
  recordsAt,
  summarizeRisk,
  type AutomationSnapshot,
} from "./automation-model";

describe("Automation Studio capability projection", () => {
  it("keeps access, actions, guidance, repetition, and bundles distinct", () => {
    const snapshot: AutomationSnapshot = {
      connections: {
        overview: {
          installed: [
            { id: "gmail", kind: "google_service", connected: true },
            { id: "drive", kind: "google_service", connected: false },
            { id: "legacy-mcp", kind: "mcp", connected: true },
          ],
        },
      },
      mcp: {
        connectors: [
          { id: "mcp-1", status: "active" },
          { id: "mcp-2", status: "disabled" },
        ],
      },
      tools: {
        tools: [
          { id: "tool-1", status: "active", riskLevel: 0 },
          { id: "tool-2", status: "active", riskLevel: 2 },
          { id: "tool-3", status: "planned", riskLevel: 3 },
        ],
      },
      skills: {
        skills: [
          { id: "skill-1", status: "active" },
          { id: "skill-2", status: "disabled" },
        ],
      },
      triggers: {
        triggers: [
          { id: "trigger-1", status: "active" },
          { id: "trigger-2", status: "paused" },
        ],
      },
      workflows: {
        runs: [
          { id: "run-1", canonicalStatus: "queued" },
          { id: "run-2", canonicalStatus: "completed" },
        ],
      },
      plugins: {
        installations: [
          { installationId: "plugin-1", state: "enabled" },
          { installationId: "plugin-2", state: "disabled" },
        ],
      },
    };

    expect(buildCapabilitySummary(snapshot)).toEqual([
      expect.objectContaining({ key: "access", value: "2", state: "available" }),
      expect.objectContaining({ key: "actions", value: "2", state: "available" }),
      expect.objectContaining({ key: "guidance", value: "1", state: "available" }),
      expect.objectContaining({ key: "repeat", value: "1", state: "available" }),
      expect.objectContaining({ key: "bundles", value: "1", state: "available" }),
    ]);
    expect(summarizeRisk(snapshot.tools)).toEqual([
      { level: 0, count: 1 },
      { level: 1, count: 0 },
      { level: 2, count: 1 },
      { level: 3, count: 1 },
    ]);
  });

  it("reports missing sources as unavailable instead of inventing zero inventory", () => {
    const summary = buildCapabilitySummary({
      connections: { installed: [] },
    });

    expect(summary.find((item) => item.key === "access")).toEqual(
      expect.objectContaining({ value: "0", state: "partial" }),
    );
    expect(summary.find((item) => item.key === "bundles")).toEqual(
      expect.objectContaining({ value: "—", state: "unavailable" }),
    );
  });

  it("treats malformed arrays as unavailable records", () => {
    expect(recordsAt({ skills: "not-an-array" }, "skills")).toEqual([]);
    expect(recordsAt({ skills: [null, "unsafe", { id: "safe" }] }, "skills")).toEqual([
      { id: "safe" },
    ]);
  });

  it("reads the canonical nested integrations overview response", () => {
    expect(integrationsOverviewAt({
      overview: { installed: [{ id: "google" }] },
      serviceReceipt: { schemaVersion: 1 },
    })).toEqual({ installed: [{ id: "google" }] });
  });

  it("parses a bounded declarative Plugin manifest before network review", () => {
    const manifest = parseImportedPluginManifest(JSON.stringify({
      schemaVersion: 1,
      pluginId: "personal.research-kit",
      version: "1.0.0",
    }));
    expect(manifest.pluginId).toBe("personal.research-kit");
    expect(pluginManifestByteLength("é")).toBe(2);
    expect(importedPluginPreviewPayload('{"schemaVersion":1,"pluginId":"personal.research-kit"}')).toEqual({
      manifest: { schemaVersion: 1, pluginId: "personal.research-kit" },
    });
  });

  it("rejects invalid or oversized manifest JSON locally", () => {
    expect(() => parseImportedPluginManifest('{"schemaVersion":1')).toThrow(
      "Plugin manifest JSON could not be parsed",
    );
    expect(() => parseImportedPluginManifest("[]")).toThrow(
      "must be one JSON object",
    );
    expect(() => parseImportedPluginManifest('{"schemaVersion":2}')).toThrow(
      "schemaVersion 1",
    );
    expect(() => parseImportedPluginManifest(`{"schemaVersion":1,"padding":"${"x".repeat(MAX_PLUGIN_MANIFEST_BYTES)}"}`)).toThrow(
      "the maximum is 128,000 bytes",
    );
  });
});

describe("Automation Studio contracts", () => {
  it("uses live inventories and digest-bound Plugin mutations", async () => {
    const source = `${await readFile(
      path.join(process.cwd(), "src/components/automation/automation-studio.tsx"),
      "utf8",
    )}\n${await readFile(
      path.join(process.cwd(), "src/components/automation/automation-model.ts"),
      "utf8",
    )}`;

    expect(source).toContain("/api/skills");
    expect(source).toContain("/api/integrations/overview");
    expect(source).toContain("/api/connectors");
    expect(source).toContain("/api/tools");
    expect(source).toContain("/api/workflows?limit=24");
    expect(source).toContain("/api/triggers?limit=48");
    expect(source).toContain("Reviewed routines");
    expect(source).toContain("Schedule a saved procedure");
    expect(source).toContain("read-only canary");
    expect(source).toContain('controlSchedule(id, "run_once")');
    expect(source).toContain("Create replacement");
    expect(source).toContain("configSha256");
    expect(source).toContain("receiptSha256");
    expect(source).toContain("/api/plugins/preview");
    expect(source).toContain("/api/plugins/install");
    expect(source).toContain('"Idempotency-Key"');
    expect(source).toContain("manifestSha256");
    expect(source).toContain("expectedRevision");
    expect(source).toContain("updateRequiresUninstall");
    expect(source).not.toContain("updateAvailable");
    expect(source).toContain("parseImportedPluginManifest");
    expect(source).toContain("MAX_PLUGIN_MANIFEST_BYTES");
    expect(source).toContain("importedPluginPreviewPayload");
    expect(source).toContain("Import declarative manifest");
    expect(source).toContain("Connections and Tools keep their existing approval boundaries");
    expect(source).toContain("currently read-only MCP surface");
    expect(source).toContain("useSearchParams");
    expect(source).toContain("ArrowRight");
    expect(source).toContain("ArrowLeft");
  });

  it("makes Automation primary while retaining legacy destinations", () => {
    const automationGroup = appNavGroups.find((group) => group.label === "Automation");
    expect(automationGroup?.items.map((item) => item.href)).toEqual(["/app/automation"]);
    expect(appNav.some((item) => item.href === "/app/workflows")).toBe(true);
    expect(appNav.some((item) => item.href === "/app/connectors")).toBe(true);
    expect(appNav.some((item) => item.href === "/app/tools")).toBe(true);
  });
});
