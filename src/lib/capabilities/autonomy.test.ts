import { describe, expect, it, vi } from "vitest";
import {
  AUTONOMY_RETRIEVAL_QUERY_MAX_LENGTH,
  buildAutomaticRetrievalQuery,
  buildCapabilitySearchQuery,
  formatWorkspaceAccessContext,
  loadWorkspaceAccessSnapshot,
  type WorkspaceAccessDependencies,
} from "@/lib/capabilities/autonomy";
import { CAPABILITY_MAX_QUERY_LENGTH } from "@/lib/capabilities/types";
import { connectionCatalog } from "@/lib/connectors/catalog";
import type { OAuthGrant } from "@/lib/connectors/oauth-store";
import type { OpenApiConnectorRecord } from "@/lib/connectors/openapi-types";
import type { McpConnectorRecord } from "@/lib/connectors/types";

describe("capability-aware autonomy", () => {
  it("expands short natural language with recent resources and generic tool synonyms", () => {
    const query = buildCapabilitySearchQuery({
      request: "Do that again",
      recentConversation: [{
        role: "user",
        content: "Generate a blog post using my portfolio repository",
      }],
    });

    expect(query.startsWith("Do that again")).toBe(true);
    expect(query).toMatch(/portfolio repository/i);
    expect(query).toMatch(/github|repo/i);
    expect(query).toMatch(/blog|article|post/i);
    expect(query.length).toBeLessThanOrEqual(CAPABILITY_MAX_QUERY_LENGTH);
  });

  it("turns a concise portfolio automation request into GitHub action discovery terms", () => {
    const query = buildCapabilitySearchQuery({
      request: "Run my portfolio blog automation",
    });

    expect(query.startsWith("Run my portfolio blog automation")).toBe(true);
    expect(query).toMatch(/github|repository/);
    expect(query).toMatch(/trigger|dispatch/);
    expect(query).toMatch(/workflow|action/);
  });

  it("expands natural browser work into Browser Use discovery terms", () => {
    const query = buildCapabilitySearchQuery({
      request: "Sign in to the portal and submit the form",
    });

    expect(query).toMatch(/browser/);
    expect(query).toMatch(/navigate|click|form|automation/);
  });

  it("keeps the newest useful history when discovery reaches its query limit", () => {
    const query = buildCapabilitySearchQuery({
      request: "Do it again",
      recentConversation: [
        { role: "user", content: "Run the GitHub portfolio blog workflow" },
        { role: "assistant", content: "The previous task completed with a very long explanation containing many unrelated status details and observations" },
      ],
    });

    expect(query).toMatch(/GitHub portfolio blog workflow/i);
    expect(query.length).toBeLessThanOrEqual(CAPABILITY_MAX_QUERY_LENGTH);
  });

  it("uses safe memory titles to resolve a short alias in a new conversation", () => {
    const query = buildCapabilitySearchQuery({
      request: "Run my weekly thing",
      relevantMemoryHints: ["Portfolio GitHub blog workflow"],
    });

    expect(query).toMatch(/Portfolio GitHub blog workflow/i);
    expect(query).toMatch(/action|automation|trigger|workflow/i);
    expect(query.length).toBeLessThanOrEqual(CAPABILITY_MAX_QUERY_LENGTH);
  });

  it("keeps an explicit current intent first and redacts history used for retrieval", () => {
    const query = buildAutomaticRetrievalQuery({
      request: "Run it again",
      recentConversation: [
        { role: "user", content: "Use portfolio2k25 to generate the weekly blog post" },
        { role: "assistant", content: "GitHub token=github_pat_abcdefghijklmnopqrstuvwxyz123456" },
      ],
    });

    expect(query.startsWith("Current request: Run it again")).toBe(true);
    expect(query).toContain("portfolio2k25");
    expect(query).toContain("[redacted");
    expect(query).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(query.length).toBeLessThanOrEqual(AUTONOMY_RETRIEVAL_QUERY_MAX_LENGTH);
  });

  it("does not dilute a detailed standalone retrieval request with old history", () => {
    const request = "Compare all active release failures by provider and summarize their retry outcomes for the current deployment.";
    expect(buildAutomaticRetrievalQuery({
      request,
      recentConversation: [{ role: "user", content: "Delete the unrelated calendar event" }],
    })).toBe(request);
  });

  it("loads tenant and actor scoped access without returning connector internals", async () => {
    const dependencies = accessDependencies({
      mcp: [
        mcpConnector({
          tenantId: "tenant-a",
          name: "GitHub MCP",
          endpoint: "https://api.githubcopilot.com/mcp/x/all",
          authType: "bearer_vault",
          credentialConfigured: true,
          credentialOriginMatch: true,
          toolCount: 89,
        }),
        mcpConnector({
          id: "other-tenant",
          tenantId: "tenant-b",
          name: "Do not expose",
          endpoint: "https://secret.example.test/mcp",
        }),
      ],
      openapi: [openApiConnector({
        tenantId: "tenant-a",
        name: "Slack",
        status: "error",
        lastError: "authorization: Bearer hidden-secret-value",
      })],
      oauth: [
        googleGrant({ tenantId: "tenant-a", actorId: "actor-a" }),
        googleGrant({ tenantId: "tenant-a", actorId: "actor-b", syncStatus: "error" }),
      ],
    });

    const snapshot = await loadWorkspaceAccessSnapshot(
      { tenantId: "tenant-a", actorId: "actor-a" },
      dependencies,
    );

    expect(dependencies.listMcp).toHaveBeenCalledWith({ tenantId: "tenant-a", actorId: "actor-a" });
    expect(dependencies.listOpenApi).toHaveBeenCalledWith({ tenantId: "tenant-a", actorId: "actor-a" });
    expect(dependencies.listGoogleOAuth).toHaveBeenCalledWith({ tenantId: "tenant-a", actorId: "actor-a" });
    expect(snapshot.connected.map((item) => item.id)).toEqual(
      expect.arrayContaining(["github", "gmail", "google-calendar", "google-drive"]),
    );
    expect(snapshot.needsAttention).toEqual([
      expect.objectContaining({ id: "slack", attentionReason: "connection_error" }),
    ]);
    expect(snapshot.setupOptions.map((item) => item.id)).toContain("notion");
    expect(JSON.stringify(snapshot)).not.toMatch(/api\.githubcopilot|secret\.example|Bearer|lastError|endpoint|baseUrl|instructions/);
    expect(JSON.stringify(snapshot)).not.toContain("Do not expose");
  });

  it("fails closed on missing scope and does not claim setup when inventory is unavailable", async () => {
    const dependencies = accessDependencies();
    dependencies.listMcp = vi.fn(async () => { throw new Error("offline"); });

    await expect(loadWorkspaceAccessSnapshot(
      { tenantId: "", actorId: "actor-a" },
      dependencies,
    )).rejects.toThrow(/explicit tenant and actor/i);

    const snapshot = await loadWorkspaceAccessSnapshot(
      { tenantId: "tenant-a", actorId: "actor-a" },
      dependencies,
    );
    expect(snapshot.inventoryUnavailable).toContain("mcp");
    expect(snapshot.setupOptions.every((item) => item.adapter !== "mcp")).toBe(true);
  });

  it("keeps disabled and undiscovered connections visible as actionable attention states", async () => {
    const snapshot = await loadWorkspaceAccessSnapshot(
      { tenantId: "tenant-a", actorId: "actor-a" },
      accessDependencies({
        mcp: [mcpConnector({ status: "disabled" })],
        openapi: [openApiConnector({
          id: "custom-api",
          name: "Release API",
          baseUrl: "https://release.example.test/v1",
          operationCount: 0,
        })],
      }),
    );

    expect(snapshot.needsAttention).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "github", attentionReason: "disabled" }),
      expect.objectContaining({
        id: "external-openapi-release-api",
        attentionReason: "no_governed_operations",
      }),
    ]));
  });

  it("formats a compact untrusted block with governed risk and approval metadata", () => {
    const context = formatWorkspaceAccessContext({
      connected: [{
        id: "github",
        name: "GitHub",
        category: "code",
        adapter: "mcp",
        state: "connected",
        capabilities: ["repositories", "actions"],
        riskLevel: 2,
        approvalRequired: false,
      }],
      needsAttention: [],
      setupOptions: [],
      inventoryUnavailable: [],
    }, {
      selectedGovernedTools: [{
        id: "mcp:github:actions_run_trigger",
        name: "Run GitHub action",
        source: "mcp",
        riskLevel: 2,
        approvalRequired: true,
      }],
    });

    expect(context).toContain("untrusted metadata");
    expect(context).toContain("Connected: GitHub — repositories, actions");
    expect(context).toContain("Run GitHub action (risk 2; approval required)");
    expect(context).not.toMatch(/endpoint|credential|secret|instructions:/i);
  });
});

function accessDependencies({
  mcp = [],
  openapi = [],
  oauth = [],
}: {
  mcp?: McpConnectorRecord[];
  openapi?: OpenApiConnectorRecord[];
  oauth?: OAuthGrant[];
} = {}): WorkspaceAccessDependencies {
  return {
    listMcp: vi.fn(async () => mcp),
    listOpenApi: vi.fn(async () => openapi),
    listGoogleOAuth: vi.fn(async () => oauth),
    catalog: connectionCatalog,
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  };
}

function mcpConnector(
  overrides: Partial<McpConnectorRecord> = {},
): McpConnectorRecord {
  const now = "2026-09-01T00:00:00.000Z";
  return {
    id: "github-connector",
    tenantId: "tenant-a",
    name: "GitHub",
    endpoint: "https://api.githubcopilot.com/mcp/x/all",
    transport: "streamable_http",
    authType: "none",
    status: "active",
    defaultRiskLevel: 2,
    approvalRequired: true,
    toolCount: 2,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function openApiConnector(
  overrides: Partial<OpenApiConnectorRecord> = {},
): OpenApiConnectorRecord {
  const now = "2026-09-01T00:00:00.000Z";
  return {
    id: "slack-connector",
    tenantId: "tenant-a",
    name: "Slack",
    baseUrl: "https://slack.com/api",
    authType: "none",
    status: "active",
    defaultRiskLevel: 2,
    approvalRequired: true,
    operationCount: 3,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function googleGrant(overrides: Partial<OAuthGrant> = {}): OAuthGrant {
  const now = "2026-09-01T00:00:00.000Z";
  return {
    id: "google-grant",
    tenantId: "tenant-a",
    actorId: "actor-a",
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
    status: "active",
    syncStatus: "healthy",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
