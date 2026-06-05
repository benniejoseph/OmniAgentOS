import { getMcpToolById, listMcpTools } from "@/lib/connectors/store";
import type { McpToolRecord } from "@/lib/connectors/types";
import type { ToolDefinition } from "@/lib/tools/types";

export async function listMcpGovernedTools() {
  const tools = await listMcpTools();
  return tools.map(toGovernedTool);
}

export async function getMcpGovernedTool(toolId: string) {
  const tool = await getMcpToolById(toolId);
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
