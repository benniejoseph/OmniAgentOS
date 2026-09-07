import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  createAgentSkill,
  createCustomAgent,
  getAgentSkill,
  getCustomAgent,
  listCustomAgents,
} from "@/lib/skills/store";
import {
  captureRestorableResource,
  compensationForSnapshot,
  moveRestorableResourceToTrash,
  restoreTrashResource,
} from "@/lib/trash/resources";
import {
  createTrashLifecyclePreview,
  createTrashPreview,
  getTrashItem,
} from "@/lib/trash/store";
import {
  createMcpToolId,
  getMcpConnector,
  listMcpTools,
  saveMcpConnector,
  saveMcpTool,
} from "@/lib/connectors/store";
import {
  createOpenApiToolId,
  getOpenApiConnector,
  listOpenApiOperations,
  saveOpenApiConnector,
  saveOpenApiOperation,
} from "@/lib/connectors/openapi-store";

let dataDir = "";
let priorDatabaseUrl: string | undefined;
let priorDataDir: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "omni-trash-resources-"));
  priorDatabaseUrl = process.env.DATABASE_URL;
  priorDataDir = process.env.OMNIAGENT_DATA_DIR;
  delete process.env.DATABASE_URL;
  process.env.OMNIAGENT_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
  if (priorDataDir === undefined) delete process.env.OMNIAGENT_DATA_DIR;
  else process.env.OMNIAGENT_DATA_DIR = priorDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe("P9.3 restorable resources", () => {
  it("restores a Skill ID and its surviving Agent assignments", async () => {
    const executionScope = scope();
    const owner = { tenantId: "tenant-a", actorId: "alice" };
    const skill = await createAgentSkill({
      name: "Source synthesis",
      description: "Synthesizes bounded source material.",
      instructions: "Read the supplied sources and produce a grounded synthesis.",
      category: "research",
      status: "active",
      toolIds: [],
      tags: ["sources"],
      knowledgeTags: [],
    }, owner);
    const agent = await createCustomAgent(agentInput("Researcher", [skill.id]), owner);
    const snapshot = await captureRestorableResource("agent_skill", skill.id, executionScope);
    expect(snapshot).toBeDefined();
    const target = {
      id: skill.id,
      name: skill.name,
      slug: skill.slug,
      affectedAgents: [{ id: agent.id, name: agent.name }],
    };
    const preview = createTrashPreview({
      resourceType: "agent_skill",
      resourceId: skill.id,
      target,
      effectSummary: "Move the Skill and its assignment to trash.",
    });
    const moved = await moveRestorableResourceToTrash({
      preview,
      displayLabel: skill.name,
      target,
      snapshot: snapshot!,
      executionScope,
    });
    await expect(getAgentSkill(skill.id, owner)).resolves.toBeUndefined();
    await expect(getCustomAgent(agent.id, owner)).resolves.toMatchObject({ skillIds: [] });

    const restorePreview = await createTrashLifecyclePreview(
      moved.item.trashId,
      "restore",
      { executionScope },
    );
    const restored = await restoreTrashResource({
      preview: restorePreview!,
      executionScope,
    });
    expect(restored.restoredResourceIds).toContain(skill.id);
    await expect(getAgentSkill(skill.id, owner)).resolves.toMatchObject({ id: skill.id });
    await expect(getCustomAgent(agent.id, owner)).resolves.toMatchObject({
      skillIds: [skill.id],
    });
  });

  it("compensates a retired custom Agent with a new immutable identity", async () => {
    const executionScope = scope();
    const owner = { tenantId: "tenant-a", actorId: "alice" };
    const agent = await createCustomAgent(agentInput("Planner", []), owner);
    const snapshot = await captureRestorableResource("custom_agent", agent.id, executionScope);
    expect(compensationForSnapshot(snapshot!)).toMatchObject({
      kind: "equivalent_action",
      handlerId: "trash.compensate.custom_agent",
    });
    const target = {
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
      skillIds: [],
      toolIds: [],
    };
    const moved = await moveRestorableResourceToTrash({
      preview: createTrashPreview({
        resourceType: "custom_agent",
        resourceId: agent.id,
        target,
        effectSummary: "Move Planner to trash.",
      }),
      displayLabel: agent.name,
      target,
      snapshot: snapshot!,
      executionScope,
    });
    await expect(getCustomAgent(agent.id, owner)).resolves.toBeUndefined();
    const restorePreview = await createTrashLifecyclePreview(
      moved.item.trashId,
      "restore",
      { executionScope },
    );
    const restored = await restoreTrashResource({ preview: restorePreview!, executionScope });
    expect(restored.restoredResourceIds[0]).not.toBe(agent.id);
    expect(restored.result.receipt.affectedResourceIds).toEqual(
      restored.restoredResourceIds,
    );
    expect(await listCustomAgents(owner)).toEqual([
      expect.objectContaining({
        id: restored.restoredResourceIds[0],
        name: expect.stringContaining("Planner (restored"),
      }),
    ]);
  });

  it.each(["mcp_connector", "openapi_connector"] as const)(
    "restores %s configuration and its complete contract set",
    async (resourceType) => {
      const executionScope = scope();
      if (resourceType === "mcp_connector") {
        const connector = mcpConnector();
        const tool = {
          id: createMcpToolId(connector.id, "search"),
          tenantId: connector.tenantId,
          connectorId: connector.id,
          connectorName: connector.name,
          name: "search",
          description: "Search records.",
          inputSchema: { type: "object" },
          riskLevel: 1 as const,
          approvalRequired: false,
          status: "active" as const,
          createdAt: connector.createdAt,
          updatedAt: connector.updatedAt,
        };
        await saveMcpConnector(connector, { executionScope });
        await saveMcpTool(tool, { executionScope });
        const snapshot = await captureRestorableResource(resourceType, connector.id, executionScope);
        const target = { kind: "mcp", connector, operationIds: [tool.id] };
        const moved = await moveRestorableResourceToTrash({
          preview: createTrashPreview({
            resourceType,
            resourceId: connector.id,
            target,
            effectSummary: "Move MCP connector to trash.",
          }),
          displayLabel: connector.name,
          target,
          snapshot: snapshot!,
          executionScope,
        });
        await expect(getMcpConnector(connector.id, { tenantId: "tenant-a" })).resolves.toBeNull();
        await restore(moved.item.trashId, executionScope);
        await expect(getMcpConnector(connector.id, { tenantId: "tenant-a" })).resolves.toMatchObject({ id: connector.id });
        await expect(listMcpTools(connector.id, { tenantId: "tenant-a" })).resolves.toHaveLength(1);
      } else {
        const connector = openApiConnector();
        const operation = {
          id: createOpenApiToolId(connector.id, "lookup"),
          tenantId: connector.tenantId,
          connectorId: connector.id,
          connectorName: connector.name,
          operationId: "lookup",
          method: "GET" as const,
          path: "/records",
          inputSchema: { type: "object" },
          responseContentTypes: ["application/json"],
          riskLevel: 1 as const,
          approvalRequired: false,
          status: "active" as const,
          createdAt: connector.createdAt,
          updatedAt: connector.updatedAt,
        };
        await saveOpenApiConnector(connector, { executionScope });
        await saveOpenApiOperation(operation, { executionScope });
        const snapshot = await captureRestorableResource(resourceType, connector.id, executionScope);
        const target = { kind: "openapi", connector, operationIds: [operation.id] };
        const moved = await moveRestorableResourceToTrash({
          preview: createTrashPreview({
            resourceType,
            resourceId: connector.id,
            target,
            effectSummary: "Move OpenAPI connector to trash.",
          }),
          displayLabel: connector.name,
          target,
          snapshot: snapshot!,
          executionScope,
        });
        await expect(getOpenApiConnector(connector.id, { tenantId: "tenant-a" })).resolves.toBeNull();
        await restore(moved.item.trashId, executionScope);
        await expect(getOpenApiConnector(connector.id, { tenantId: "tenant-a" })).resolves.toMatchObject({ id: connector.id });
        await expect(listOpenApiOperations(connector.id, { tenantId: "tenant-a" })).resolves.toHaveLength(1);
      }
    },
  );

  it("downgrades restored vault connectors until a human reconnects credentials", async () => {
    const executionScope = scope();
    const connector = mcpConnector({
      id: "vault-mcp",
      authType: "bearer_vault",
      credentialConfigured: true,
      credentialOriginMatch: true,
    });
    await saveMcpConnector(connector, { executionScope });
    const snapshot = await captureRestorableResource("mcp_connector", connector.id, executionScope);
    expect(compensationForSnapshot(snapshot!)).toMatchObject({
      kind: "equivalent_action",
      limitation: expect.stringContaining("reconnected"),
    });
    const target = { kind: "mcp", connector, operationIds: [] };
    const moved = await moveRestorableResourceToTrash({
      preview: createTrashPreview({
        resourceType: "mcp_connector",
        resourceId: connector.id,
        target,
        effectSummary: "Move vault MCP connector to trash.",
      }),
      displayLabel: connector.name,
      target,
      snapshot: snapshot!,
      executionScope,
    });
    await restore(moved.item.trashId, executionScope);
    await expect(getMcpConnector(connector.id, { tenantId: "tenant-a" }))
      .resolves.toMatchObject({ authType: "none", status: "disabled" });
  });
});

async function restore(trashId: string, executionScope: ReturnType<typeof scope>) {
  const preview = await createTrashLifecyclePreview(trashId, "restore", {
    executionScope,
  });
  await restoreTrashResource({ preview: preview!, executionScope });
  await expect(getTrashItem(trashId, { executionScope })).resolves.toMatchObject({
    state: "restored",
  });
}

function scope() {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "alice",
    executingPrincipalType: "user",
    executingPrincipalId: "alice",
    correlationId: "trash-resources:test",
    purpose: "Test resource compensation.",
  });
}

function agentInput(name: string, skillIds: string[]) {
  return {
    name,
    role: "Specialist",
    description: `Description for ${name}.`,
    instructions: `Instructions for ${name} with enough detail.`,
    persona: DEFAULT_CUSTOM_AGENT_PERSONA,
    status: "ready" as const,
    accent: "emerald" as const,
    modelPolicy: "auto" as const,
    autonomy: "governed" as const,
    approvalPolicy: "risk_based" as const,
    memoryScope: "all" as const,
    skillIds,
    toolIds: [],
  };
}

function mcpConnector(overrides: Record<string, unknown> = {}) {
  const now = "2026-09-07T10:00:00.000Z";
  return {
    id: "mcp-one",
    tenantId: "tenant-a",
    name: "MCP One",
    endpoint: "https://mcp.example.test",
    transport: "streamable_http" as const,
    authType: "none" as const,
    status: "active" as const,
    defaultRiskLevel: 1 as const,
    approvalRequired: false,
    toolCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function openApiConnector() {
  const now = "2026-09-07T10:00:00.000Z";
  return {
    id: "openapi-one",
    tenantId: "tenant-a",
    name: "OpenAPI One",
    baseUrl: "https://api.example.test",
    authType: "none" as const,
    status: "active" as const,
    defaultRiskLevel: 1 as const,
    approvalRequired: false,
    operationCount: 1,
    createdAt: now,
    updatedAt: now,
  };
}
