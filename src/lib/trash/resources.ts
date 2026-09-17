import { z } from "zod";

import {
  createCustomAgent,
  deleteAgentSkill,
  deleteCustomAgent,
  getAgentSkill,
  getCustomAgent,
  listCustomAgents,
  restoreAgentSkill,
} from "@/lib/skills/store";
import type { AgentSkill, CustomAgentDefinition } from "@/lib/skills/types";
import {
  deleteMcpConnector,
  getMcpConnector,
  listMcpTools,
  saveMcpConnector,
  saveMcpTool,
} from "@/lib/connectors/store";
import {
  deleteOpenApiConnector,
  getOpenApiConnector,
  listOpenApiOperations,
  saveOpenApiConnector,
  saveOpenApiOperation,
} from "@/lib/connectors/openapi-store";
import type { McpConnectorRecord, McpToolRecord } from "@/lib/connectors/types";
import {
  assertMcpConnectorIsSupported,
  isRemoteBrowserMcpTool,
  RETIRED_REMOTE_BROWSER_MCP_MESSAGE,
} from "@/lib/connectors/mcp-trust";
import type {
  OpenApiConnectorRecord,
  OpenApiOperationRecord,
} from "@/lib/connectors/openapi-types";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import {
  commitTrashLifecycle,
  createTrashEntry,
  createTrashLifecyclePreview,
  getTrashSnapshot,
  type TrashLifecycleResult,
} from "@/lib/trash/store";
import type {
  TrashActionPreviewV1,
  TrashItemV1,
  TrashResourceType,
} from "@/lib/trash/contracts";

const snapshotSchema = z.object({
  resourceType: z.enum([
    "custom_agent",
    "agent_skill",
    "mcp_connector",
    "openapi_connector",
  ]),
  resource: z.record(z.string(), z.unknown()),
  children: z.array(z.record(z.string(), z.unknown())).max(1_000),
  affectedResourceIds: z.array(z.string().trim().min(1).max(240)).max(256),
}).strict();

export type RestorableResourceSnapshot = Readonly<
  z.infer<typeof snapshotSchema>
>;

export async function captureRestorableResource(
  resourceType: TrashResourceType,
  resourceId: string,
  executionScope: ExecutionScope,
): Promise<RestorableResourceSnapshot | undefined> {
  const owner = exactOwner(executionScope);
  if (resourceType === "custom_agent") {
    const resource = await getCustomAgent(resourceId, owner);
    return resource
      ? snapshotSchema.parse({ resourceType, resource, children: [], affectedResourceIds: [] })
      : undefined;
  }
  if (resourceType === "agent_skill") {
    const [resource, agents] = await Promise.all([
      getAgentSkill(resourceId, owner),
      listCustomAgents(owner),
    ]);
    if (!resource || resource.builtIn) return undefined;
    const affectedResourceIds = agents
      .filter((agent) => agent.skillIds.includes(resourceId))
      .map((agent) => agent.id)
      .sort();
    return snapshotSchema.parse({
      resourceType,
      resource,
      children: [],
      affectedResourceIds,
    });
  }
  if (resourceType === "mcp_connector") {
    const [resource, children] = await Promise.all([
      getMcpConnector(resourceId, { tenantId: executionScope.tenantId }),
      listMcpTools(resourceId, { tenantId: executionScope.tenantId }),
    ]);
    return resource
      ? snapshotSchema.parse({
          resourceType,
          resource,
          children,
          affectedResourceIds: children.map((child) => child.id).sort(),
        })
      : undefined;
  }
  const [resource, children] = await Promise.all([
    getOpenApiConnector(resourceId, { tenantId: executionScope.tenantId }),
    listOpenApiOperations(resourceId, { tenantId: executionScope.tenantId }),
  ]);
  return resource
    ? snapshotSchema.parse({
        resourceType,
        resource,
        children,
        affectedResourceIds: children.map((child) => child.id).sort(),
      })
    : undefined;
}

export function compensationForSnapshot(
  snapshot: RestorableResourceSnapshot,
): TrashItemV1["compensation"] {
  if (snapshot.resourceType === "custom_agent") {
    return {
      kind: "equivalent_action",
      handlerId: "trash.compensate.custom_agent",
      limitation: "Restoration creates a new Agent identity because retired execution principals and release channels are immutable.",
    };
  }
  if (
    snapshot.resourceType === "mcp_connector" &&
    (snapshot.resource.credentialConfigured === true || snapshot.resource.authType === "bearer_vault")
  ) {
    return {
      kind: "equivalent_action",
      handlerId: "trash.compensate.mcp_connector",
      limitation: "Connector configuration and contracts can be restored, but its vault credential must be reconnected by a human.",
    };
  }
  return {
    kind: "exact_restore",
    handlerId: `trash.restore.${snapshot.resourceType}`,
    limitation: null,
  };
}

export async function moveRestorableResourceToTrash(input: {
  preview: TrashActionPreviewV1;
  displayLabel: string;
  target: unknown;
  snapshot: RestorableResourceSnapshot;
  executionScope: ExecutionScope;
}): Promise<TrashLifecycleResult> {
  const compensation = compensationForSnapshot(input.snapshot);
  const created = await createTrashEntry({
    preview: input.preview,
    displayLabel: input.displayLabel,
    target: input.target,
    snapshot: input.snapshot,
    compensation,
  }, { executionScope: input.executionScope });
  try {
    const deleted = await deleteSnapshotResource(input.snapshot, input.executionScope);
    if (!deleted) throw new Error("The resource disappeared before it could be moved to trash.");
    return created;
  } catch (error) {
    await restoreSnapshotResource(input.snapshot, input.executionScope);
    await rollbackFailedTrashMove(created.item.trashId, input.executionScope);
    throw error;
  }
}

export async function restoreTrashResource(input: {
  preview: TrashActionPreviewV1;
  executionScope: ExecutionScope;
}): Promise<Readonly<{
  result: TrashLifecycleResult;
  restoredResourceIds: readonly string[];
  limitation: string | null;
}>> {
  if (input.preview.action !== "restore" || !input.preview.trashId) {
    throw new Error("A restore preview is required.");
  }
  const stored = await getTrashSnapshot(input.preview.trashId, {
    executionScope: input.executionScope,
  });
  if (!stored) throw new Error("Restorable trash snapshot not found.");
  const snapshot = snapshotSchema.parse(stored.snapshot);
  if (snapshot.resourceType !== stored.item.resourceType) {
    throw new Error("Trash snapshot resource type does not match its item.");
  }
  const restoredResourceIds = await restoreSnapshotResource(
    snapshot,
    input.executionScope,
  );
  const result = await commitTrashLifecycle(input.preview, {
    executionScope: input.executionScope,
    affectedResourceIds: restoredResourceIds,
  });
  return {
    result,
    restoredResourceIds,
    limitation: stored.item.compensation.limitation,
  };
}

async function deleteSnapshotResource(
  snapshot: RestorableResourceSnapshot,
  executionScope: ExecutionScope,
) {
  const owner = exactOwner(executionScope);
  if (snapshot.resourceType === "custom_agent") {
    return deleteCustomAgent(String(snapshot.resource.id), owner);
  }
  if (snapshot.resourceType === "agent_skill") {
    return deleteAgentSkill(String(snapshot.resource.id), owner);
  }
  if (snapshot.resourceType === "mcp_connector") {
    return Boolean(await deleteMcpConnector(String(snapshot.resource.id), { executionScope }));
  }
  return Boolean(await deleteOpenApiConnector(String(snapshot.resource.id), { executionScope }));
}

async function restoreSnapshotResource(
  snapshot: RestorableResourceSnapshot,
  executionScope: ExecutionScope,
): Promise<string[]> {
  const owner = exactOwner(executionScope);
  if (snapshot.resourceType === "custom_agent") {
    const agent = snapshot.resource as unknown as CustomAgentDefinition;
    const original = await getCustomAgent(agent.id, owner);
    if (original) return [original.id];
    const restoredName = `${agent.name} (restored ${agent.id.slice(0, 8)})`;
    const priorEquivalent = (await listCustomAgents(owner)).find(
      (candidate) => candidate.name === restoredName,
    );
    if (priorEquivalent) return [priorEquivalent.id];
    const restored = await createCustomAgent({
      name: restoredName,
      role: agent.role,
      description: agent.description,
      instructions: agent.instructions,
      persona: agent.persona,
      status: agent.status,
      accent: agent.accent,
      modelPolicy: agent.modelPolicy,
      autonomy: agent.autonomy,
      approvalPolicy: agent.approvalPolicy,
      memoryScope: agent.memoryScope,
      skillIds: agent.skillIds,
      toolIds: agent.toolIds,
    }, owner);
    return [restored.id];
  }
  if (snapshot.resourceType === "agent_skill") {
    const skill = await restoreAgentSkill(
      snapshot.resource as unknown as AgentSkill,
      snapshot.affectedResourceIds,
      owner,
    );
    return [skill.id, ...snapshot.affectedResourceIds];
  }
  if (snapshot.resourceType === "mcp_connector") {
    const connector = snapshot.resource as unknown as McpConnectorRecord;
    assertMcpConnectorIsSupported(connector);
    if (snapshot.children.some((child) =>
      isRemoteBrowserMcpTool(child as unknown as McpToolRecord)
    )) {
      throw new Error(RETIRED_REMOTE_BROWSER_MCP_MESSAGE);
    }
    const credentialUnavailable =
      connector.credentialConfigured === true || connector.authType === "bearer_vault";
    const restored = await saveMcpConnector({
      ...connector,
      ...(credentialUnavailable
        ? {
            authType: "none" as const,
            authTokenEnv: undefined,
            credentialConfigured: false,
            credentialOriginMatch: false,
            status: "disabled" as const,
          }
        : {}),
    }, { executionScope });
    for (const child of snapshot.children) {
      await saveMcpTool(child as unknown as McpToolRecord, { executionScope });
    }
    return [restored.id, ...snapshot.affectedResourceIds];
  }
  const connector = await saveOpenApiConnector(
    snapshot.resource as unknown as OpenApiConnectorRecord,
    { executionScope },
  );
  for (const child of snapshot.children) {
    await saveOpenApiOperation(
      child as unknown as OpenApiOperationRecord,
      { executionScope },
    );
  }
  return [connector.id, ...snapshot.affectedResourceIds];
}

async function rollbackFailedTrashMove(
  trashId: string,
  executionScope: ExecutionScope,
) {
  const preview = await createTrashLifecyclePreview(trashId, "restore", {
    executionScope,
  });
  if (preview) await commitTrashLifecycle(preview, { executionScope });
}

function exactOwner(executionScope: ExecutionScope) {
  if (!executionScope.initiatingActorId) {
    throw new Error("Restorable resource operations require an actor-bound execution scope.");
  }
  return {
    tenantId: executionScope.tenantId,
    actorId: executionScope.initiatingActorId,
  };
}
