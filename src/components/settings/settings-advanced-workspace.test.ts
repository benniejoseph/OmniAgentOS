import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceSessionProvider } from "@/components/app-shell/session-context";
import { AdvancedSettingsWorkspace, McpConfigurationSurface } from "./settings-advanced-workspace";

describe("Advanced Settings presentation boundaries", () => {
  it("offers all category return paths without claiming zero counts before reads", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSessionProvider, {
      initialSession: { authEnabled: true, authenticated: true, context: { tenantId: "synthetic-tenant", actorId: "synthetic-actor", role: "admin" } },
    } as Parameters<typeof WorkspaceSessionProvider>[0], createElement(AdvancedSettingsWorkspace, { section: "overview", onNavigate: () => undefined })));
    for (const name of ["General", "Workspace", "AI providers", "Model routing", "Agent control", "API &amp; MCP", "Data &amp; privacy"]) expect(html).toContain(name);
    expect(html).toContain("Workspace readiness has not been verified");
    expect(html).toContain("Installation count unavailable");
    expect(html).not.toContain("No active native installation was returned");
    expect(html).toContain("<h1>Settings</h1>");
  });
  it("never seeds editable MCP controls from unacknowledged ownership metadata", () => {
    const html = renderToStaticMarkup(createElement(McpConfigurationSurface, {
      config: { tenantId: "synthetic", actorId: "retained-owner-with-a-full-long-identity", enabled: true, serverName: "Retained policy", allowedScopes: ["memory:read"], defaultApprovalMode: "governed", exposeResources: true, endpointPath: "/api/mcp", readiness: "ready", createdAt: "2026-10-04T10:00:00.000Z", updatedAt: "2026-10-04T10:00:00.000Z" },
      gate: { loading: false, snapshotFresh: true, manageable: true, requestReadContract: "exact_v1" }, busy: false, onSave: async () => undefined,
    }));
    expect(html).toContain("retained-owner-with-a-full-long-identity"); expect(html).toContain("ownership metadata"); expect(html).not.toContain("<input"); expect(html).not.toContain("Save MCP policy");
  });
});
