import { getToolExecutionStats } from "@/lib/tools/audit-store";
import { getGovernedTools } from "@/lib/tools/registry";
import { listMcpGovernedTools, listOpenApiGovernedTools } from "@/lib/connectors/governed-tools";

export const runtime = "nodejs";

export async function GET() {
  const mcpTools = await listMcpGovernedTools();
  const openApiTools = await listOpenApiGovernedTools();

  return Response.json({
    tools: [...getGovernedTools(), ...mcpTools, ...openApiTools],
    audits: await getToolExecutionStats(),
    policy: {
      riskLevels: [
        { level: 0, label: "Read-only", approvalRequired: false },
        { level: 1, label: "Low-risk reversible write", approvalRequired: false },
        { level: 2, label: "External side effect or sensitive action", approvalRequired: true },
        { level: 3, label: "High-impact or destructive action", approvalRequired: true },
      ],
      defaultBehavior: "Unknown tools are blocked. Planned tools cannot execute.",
    },
  });
}
