import { getOpenApiOperationById, listOpenApiOperations } from "@/lib/connectors/openapi-store";
import type { OpenApiOperationRecord } from "@/lib/connectors/openapi-types";
import { getMcpToolById, listMcpTools } from "@/lib/connectors/store";
import type { McpToolRecord } from "@/lib/connectors/types";
import type { ToolDefinition } from "@/lib/tools/types";

type TenantScopedOptions = {
  tenantId?: string;
};

export async function listMcpGovernedTools(options: TenantScopedOptions = {}) {
  const tools = await listMcpTools(undefined, options);
  return tools.map(toGovernedTool);
}

export async function getMcpGovernedTool(toolId: string, options: TenantScopedOptions = {}) {
  const tool = await getMcpToolById(toolId, options);
  return tool ? toGovernedTool(tool) : null;
}

export function toGovernedTool(tool: McpToolRecord): ToolDefinition {
  return {
    id: tool.id,
    name: `${tool.connectorName}: ${tool.title || tool.name}`,
    description: tool.description || `MCP tool ${tool.name} from ${tool.connectorName}.`,
    category: "mcp",
    status: tool.status === "active" ? "active" : "planned",
    riskLevel: tool.riskLevel,
    dryRunSupported: true,
    approvalRequired: tool.approvalRequired,
    inputSchema: tool.inputSchema,
  };
}

export async function listOpenApiGovernedTools(options: TenantScopedOptions = {}) {
  const operations = await listOpenApiOperations(undefined, options);
  return operations.map(openApiOperationToGovernedTool);
}

export async function getOpenApiGovernedTool(toolId: string, options: TenantScopedOptions = {}) {
  const operation = await getOpenApiOperationById(toolId, options);
  return operation ? openApiOperationToGovernedTool(operation) : null;
}

export function openApiOperationToGovernedTool(operation: OpenApiOperationRecord): ToolDefinition {
  return {
    id: operation.id,
    name: `${operation.connectorName}: ${operation.summary || operation.operationId}`,
    description:
      operation.description ||
      `${operation.method} ${operation.path} from ${operation.connectorName}.`,
    category: "openapi",
    status: operation.status === "active" ? "active" : "planned",
    riskLevel: operation.riskLevel,
    dryRunSupported: true,
    approvalRequired: operation.approvalRequired,
    inputSchema: operation.inputSchema,
  };
}
