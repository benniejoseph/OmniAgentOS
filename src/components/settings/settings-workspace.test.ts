import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  McpConfigurationSurface,
  mcpConfigurationActionBlocked,
  mcpConfigurationIsEditable,
  mcpContinuityMetadata,
  settingsLoadMayClearLoading,
  settingsLoadNeedsVerificationWarning,
  settingsRequestResultIsCurrent,
} from "@/components/settings/settings-workspace";
import type { RequestMcpExportConfiguration } from "@/lib/settings/types";

const editableGate = {
  loading: false,
  snapshotFresh: true,
  requestReadContract: "readable_v1" as const,
  manageable: true,
  permissionBlocked: undefined,
};

const blockedGates: Array<{
  gate: Parameters<typeof mcpConfigurationActionBlocked>[0];
  message: string;
}> = [
  { gate: { ...editableGate, loading: true }, message: "not current" },
  { gate: { ...editableGate, snapshotFresh: false }, message: "not current" },
  {
    gate: { ...editableGate, requestReadContract: "exact_v1" },
    message: "ownership metadata",
  },
  {
    gate: { ...editableGate, requestReadContract: undefined },
    message: "ownership metadata",
  },
  {
    gate: { ...editableGate, manageable: false },
    message: "retained MCP policy",
  },
  {
    gate: {
      ...editableGate,
      permissionBlocked: "Administrator access required.",
    },
    message: "Administrator access required.",
  },
];

const retainedConfig: RequestMcpExportConfiguration = {
  tenantId: "tenant-a",
  actorId: "request-actor",
  enabled: true,
  serverName: "Retained MCP",
  allowedScopes: ["mcp:discover", "mcp:tools:list"],
  defaultApprovalMode: "governed",
  exposeResources: false,
  endpointPath: "/api/mcp",
  readiness: "ready",
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T01:00:00.000Z",
  manageable: false,
};

describe("Settings MCP configuration gate", () => {
  it("allows editing only for a fresh acknowledged manageable policy", () => {
    expect(mcpConfigurationActionBlocked(editableGate)).toBeUndefined();
    expect(mcpConfigurationIsEditable(editableGate)).toBe(true);
  });

  it.each(blockedGates)("fails closed when an edit prerequisite is absent", ({ gate, message }) => {
    expect(mcpConfigurationActionBlocked(gate)).toContain(message);
    expect(mcpConfigurationIsEditable(gate)).toBe(false);
  });

  it("treats only an actual refresh failure as unverified", () => {
    expect(settingsLoadNeedsVerificationWarning("failure")).toBe(true);
    expect(settingsLoadNeedsVerificationWarning("success")).toBe(false);
    expect(settingsLoadNeedsVerificationWarning("superseded")).toBe(false);
  });

  it("suppresses state changes from stale mutation results", () => {
    expect(settingsRequestResultIsCurrent(7, 7)).toBe(true);
    expect(settingsRequestResultIsCurrent(6, 7)).toBe(false);
  });

  it("clears loading only for the current or unbound current controller", () => {
    expect(settingsLoadMayClearLoading({
      controllerCurrent: true,
      requestGeneration: 7,
      currentRequestGeneration: 7,
    })).toBe(true);
    expect(settingsLoadMayClearLoading({
      controllerCurrent: true,
      requestGeneration: 6,
      currentRequestGeneration: 7,
    })).toBe(false);
    expect(settingsLoadMayClearLoading({
      controllerCurrent: true,
      currentRequestGeneration: 7,
    })).toBe(true);
    expect(settingsLoadMayClearLoading({
      controllerCurrent: false,
      currentRequestGeneration: 7,
    })).toBe(false);
  });

  it("server-renders retained MCP continuity without editable controls", () => {
    const html = renderToStaticMarkup(createElement(McpConfigurationSurface, {
      config: retainedConfig,
      gate: { ...editableGate, manageable: false },
      busy: false,
      onSave: async () => undefined,
    }));

    expect(html).toContain("Retained MCP policy");
    expect(html).toContain("cannot be edited from this session");
    expect(html).toContain("may still govern service keys owned by the retained identity");
    expect(html).toContain("Retained MCP");
    expect(html).toContain("mcp:discover");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Save MCP policy");
  });

  it("projects retained policy continuity without editable draft fields", () => {
    expect(mcpContinuityMetadata({
      enabled: true,
      readiness: "ready",
      serverName: "Retained MCP",
      allowedScopes: ["mcp:discover", "mcp:tools:list"],
      exposeResources: false,
    })).toEqual([
      { label: "Status", value: "Enabled" },
      { label: "Readiness", value: "Ready" },
      { label: "Server name", value: "Retained MCP" },
      { label: "Maximum scopes", value: "mcp:discover · mcp:tools:list" },
      { label: "Resources", value: "Not exposed" },
    ]);
  });
});
